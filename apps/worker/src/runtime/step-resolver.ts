/**
 * Step Resolver — turns an execution job into REAL, executable steps.
 *
 * Previously the worker fabricated 3–5 steps with Math.random() timing. This
 * resolver loads the actual AgentDefinition (and/or pack manifest) from the DB
 * and builds steps whose handlers do real work:
 *
 *   - LLM agent step  → real Anthropic/OpenAI call with token usage captured
 *   - REST agent step → real HTTP POST to the configured endpoint
 *   - no-op step      → deterministic, clearly-labeled placeholder used ONLY
 *                       when no agent/key is available (never random timing)
 *
 * The resolver records nothing itself; it returns step descriptors that the
 * execution-processor runs and persists (ExecutionStep + FinOpsTokenLog).
 */

import { PrismaClient } from '@metis/database';
import { callLlm, llmKeysAvailable, LlmResult } from './llm-client';
import { computeCostUsd } from './pricing';
import { buildKnowledgePreamble } from './knowledge';

export interface ResolvedStepResult {
  output: Record<string, unknown>;
  /** Present when this step performed a real LLM call (drives FinOps logging). */
  llm?: {
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

export interface ResolvedStep {
  key: string;
  type: string;
  capabilityKey?: string;
  run: (input: Record<string, unknown>) => Promise<ResolvedStepResult>;
}

export interface ResolveStepsInput {
  tenantId: string;
  capabilityKey?: string;
  workflowKey?: string;
  packInstallationId?: string;
  executionSessionId?: string;
  input?: Record<string, unknown>;
}

interface AgentLike {
  key: string;
  name: string;
  kernelType: string;
  kernelConfigJson: any;
  capabilitiesJson: any;
}

/** Build a prompt for an LLM agent step from its config + run input. */
function buildAgentPrompt(agent: AgentLike, input: Record<string, unknown>): string {
  const cfg = (agent.kernelConfigJson ?? {}) as Record<string, any>;
  const system: string =
    cfg.systemPrompt ||
    cfg.promptTemplate ||
    `You are "${agent.name}", an autonomous operations agent. ` +
      `Perform the requested task and return a concise, structured result.`;
  const inputStr = JSON.stringify(input ?? {}, null, 2);
  return `${system}\n\n## Task input\n${inputStr}\n\n## Instructions\nReturn only the result.`;
}

/**
 * Resolve the list of executable steps for a job.
 *
 * Resolution order:
 *   1. AgentDefinition matching capabilityKey or workflowKey (real agent run)
 *   2. Pack manifest declared capabilities/workflows (one real step each)
 *   3. Single deterministic no-op (last resort)
 */
export async function resolveSteps(
  prisma: PrismaClient,
  job: ResolveStepsInput,
): Promise<ResolvedStep[]> {
  const lookupKey = job.capabilityKey ?? job.workflowKey;
  let agent: AgentLike | null = null;

  if (lookupKey) {
    const found = await (prisma as any).agentDefinition
      .findFirst({
        where: { tenantId: job.tenantId, key: lookupKey, status: { not: 'UNAVAILABLE' } },
        select: {
          key: true,
          name: true,
          kernelType: true,
          kernelConfigJson: true,
          capabilitiesJson: true,
        },
      })
      .catch(() => null);
    agent = found as AgentLike | null;
  }

  // ── 1. Real agent execution ──────────────────────────────
  if (agent) {
    return [buildAgentStep(prisma, agent, job)];
  }

  // ── 2. Manifest-declared capabilities/workflows ──────────
  if (job.packInstallationId) {
    const installation = await prisma.packInstallation
      .findUnique({
        where: { id: job.packInstallationId },
        include: { packVersion: { select: { manifestJson: true } } },
      })
      .catch(() => null);
    const manifest = (installation?.packVersion?.manifestJson ?? {}) as Record<string, any>;
    const declared: string[] = job.workflowKey
      ? Array.isArray(manifest.workflows)
        ? (manifest.workflows as string[])
        : [job.workflowKey]
      : Array.isArray(manifest.capabilities)
        ? (manifest.capabilities as string[])
        : job.capabilityKey
          ? [job.capabilityKey]
          : [];

    if (declared.length > 0) {
      const keys = llmKeysAvailable();
      const canLlm = keys.anthropic || keys.openai;
      return declared.map((cap, i) => ({
        key: `${cap}:${i + 1}`,
        type: i === 0 ? 'INIT' : i === declared.length - 1 ? 'FINALIZE' : 'PROCESS',
        capabilityKey: cap,
        run: canLlm
          ? makeLlmRun(`Execute capability "${cap}".`, job.input)
          : makeNoopRun(cap),
      }));
    }
  }

  // ── 3. Deterministic last-resort no-op ───────────────────
  return [
    {
      key: `${lookupKey ?? 'default'}:noop`,
      type: 'NOOP',
      capabilityKey: job.capabilityKey,
      run: makeNoopRun(lookupKey ?? 'default'),
    },
  ];
}

function buildAgentStep(
  prisma: PrismaClient,
  agent: AgentLike,
  job: ResolveStepsInput,
): ResolvedStep {
  return {
    key: `${agent.key}:invoke`,
    type: 'AGENT_INVOKE',
    capabilityKey: job.capabilityKey,
    run: async (input) => {
      const kernel = (agent.kernelType || 'LOCAL').toUpperCase();
      const keys = llmKeysAvailable();

      // REST kernel → real HTTP call (output captured).
      if (kernel === 'REST') {
        const endpoint = (agent.kernelConfigJson ?? {})?.endpoint;
        if (endpoint) {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input ?? {}),
          }).catch((e) => {
            throw new Error(`REST agent call failed: ${e.message}`);
          });
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep raw text */
          }
          return { output: { kernel: 'REST', status: res.status, result: parsed } };
        }
      }

      // LOCAL / default kernel → real LLM call when a key exists.
      if (keys.anthropic || keys.openai) {
        const model =
          (agent.kernelConfigJson ?? {})?.model ||
          (keys.anthropic ? 'claude-sonnet-4-6' : 'gpt-4o');
        // P3-3: ground the agent in curated operational knowledge (same
        // preamble the API workflow path injects). Empty string when none.
        const knowledge = await buildKnowledgePreamble(prisma, {
          tenantId: job.tenantId,
          workflowKey: job.workflowKey ?? null,
          capabilityKey: job.capabilityKey ?? null,
          executionSessionId: job.executionSessionId ?? null,
          agentName: agent.key,
        });
        const llm: LlmResult = await callLlm({
          model,
          prompt: knowledge + buildAgentPrompt(agent, input),
          maxTokens: (agent.kernelConfigJson ?? {})?.maxTokens ?? 1024,
        });
        const costUsd = computeCostUsd(
          llm.model,
          llm.usage.promptTokens,
          llm.usage.completionTokens,
        );
        return {
          output: { kernel: 'LOCAL', agent: agent.key, response: llm.text },
          llm: {
            model: llm.model,
            provider: llm.provider,
            promptTokens: llm.usage.promptTokens,
            completionTokens: llm.usage.completionTokens,
            totalTokens: llm.usage.totalTokens,
            costUsd,
          },
        };
      }

      // No key → deterministic no-op (honest, not fabricated).
      return makeNoopRun(agent.key)(input);
    },
  };
}

function makeLlmRun(
  instruction: string,
  jobInput: Record<string, unknown> | undefined,
): (input: Record<string, unknown>) => Promise<ResolvedStepResult> {
  return async (input) => {
    const keys = llmKeysAvailable();
    const model = keys.anthropic ? 'claude-sonnet-4-6' : 'gpt-4o';
    const llm = await callLlm({
      model,
      prompt: `${instruction}\n\nInput:\n${JSON.stringify(input ?? jobInput ?? {}, null, 2)}`,
      maxTokens: 1024,
    });
    const costUsd = computeCostUsd(llm.model, llm.usage.promptTokens, llm.usage.completionTokens);
    return {
      output: { response: llm.text },
      llm: {
        model: llm.model,
        provider: llm.provider,
        promptTokens: llm.usage.promptTokens,
        completionTokens: llm.usage.completionTokens,
        totalTokens: llm.usage.totalTokens,
        costUsd,
      },
    };
  };
}

function makeNoopRun(
  label: string,
): (input: Record<string, unknown>) => Promise<ResolvedStepResult> {
  return async (input) => ({
    output: {
      noop: true,
      reason: 'No agent handler or LLM key available — step executed as deterministic no-op.',
      capability: label,
      receivedInputKeys: Object.keys(input ?? {}),
      processedAt: new Date().toISOString(),
    },
  });
}
