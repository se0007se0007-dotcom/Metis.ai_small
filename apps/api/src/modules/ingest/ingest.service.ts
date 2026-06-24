/**
 * Ingest Service — Phase 1 (Ingestion On-Ramp)
 *
 * Accepts runs from EXTERNAL agents (running outside METIS) and evaluates
 * them through the EXACT SAME engine as internal workflow nodes — the shared
 * EvaluatorService.evaluate(). This guarantees identical scoring, security
 * gates, anomaly detection, alarms (FDSAlert) and knowledge capture whether a
 * run originates from the internal PipelineEngine or an external SDK client.
 *
 * Pipeline (mirrors PipelineEngine's evaluator hook, see
 * apps/api/src/modules/workflow-nodes/pipeline-engine.ts ~line 264):
 *   1. validate the external run (agentName + input|output required)
 *   2. redact secrets from input/output/context (prompt-guard.redactSecrets)
 *   3. resolve/create an ExecutionSession (source='sdk'); idempotent by
 *      (tenantId, externalRunId) when runId is provided (upsert)
 *   4. call evaluatorService.evaluate({...}) with the SAME arg keys the
 *      internal path uses
 *
 * Phase 1 is SYNCHRONOUS (evaluate in-request). The structure here — a pure
 * per-run mapper + a single best-effort processing loop — is intentionally
 * queue-friendly: the Phase-1.5 upgrade wraps `processRun` in a BullMQ worker
 * so the HTTP request can return 202 immediately and evaluation runs async.
 *
 * @module ingest
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PRISMA_TOKEN } from '../database.module';
import { EvaluatorService } from '../evaluator/evaluator.service';
import { RuntimeGovernanceService } from '../governance/runtime-governance.service';
import { redactSecrets } from '../evaluator/prompt-guard';
import {
  AutonomyPolicy,
  AutonomyVerdict,
  evaluateAutonomyEvidence,
  HermesMeta,
} from './hermes-governance';

// ────────────────────────────────────────────────────────────
// External run shape (what the SDK / test agent POSTs)
// ────────────────────────────────────────────────────────────
export interface IngestRunInput {
  /** Optional external run id — used for idempotent upserts. */
  runId?: string;
  /** Required: name of the external agent that produced this run. */
  agentName?: string;
  /** Parent workflow / app key (denormalized onto AgentEvaluation). */
  workflowKey?: string;
  /** Step identifier within the run (defaults to 'sdk'). */
  stepKey?: string;
  /** The prompt / question / input given to the agent. */
  input?: string;
  /** The agent's response / output. */
  output?: string;
  /** Optional supporting context (RAG chunks, system prompt, etc.). */
  context?: string;
  /** Optional reference answer for accuracy scoring. */
  groundTruth?: string;
  /** Model identifier (e.g. "gpt-4o", "claude-3-5-sonnet"). */
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Wall-clock latency in milliseconds. */
  latencyMs?: number;
  /** Cost in USD, if the caller computed it. */
  costUsd?: number;
  /** Run status — maps to ExecutionStatus (default COMPLETED). */
  status?: string;

  // ── Hermes autonomy adapter (PoC) ──
  /**
   * Execution runtime this run came from:
   *   - 'internal' : produced by the in-platform PipelineEngine
   *   - 'sdk'      : a plain external SDK client (default for the on-ramp)
   *   - 'hermes'   : an AUTONOMOUS agent that may self-create skills, use
   *                  persistent memory, and fire autonomous tool calls
   * When 'hermes' AND `hermesMeta` is present, the on-ramp runs the standard
   * evaluation AND an extra autonomy-governance pass (computeAutonomyRisk).
   */
  runtime?: 'internal' | 'sdk' | 'hermes';
  /** Autonomous-agent extras (skills/memory/tool-calls) for runtime='hermes'. */
  hermesMeta?: HermesMeta;
}

export interface IngestRunResult {
  runId: string | null;
  sessionId: string | null;
  status: 'evaluated' | 'error';
  error?: string;
  evaluation?: {
    overallScore: number;
    securityRiskLevel: string;
    anomalyDetected: boolean;
    costUsd: number;
    tokensUsed: number;
  };
  /**
   * Autonomy-governance result — present only for runtime='hermes' runs that
   * carried hermesMeta. Sits ALONGSIDE `evaluation` so the UI can show
   * "standard eval + autonomy governance" for a self-improving agent.
   */
  autonomy?: AutonomyVerdict;
  /**
   * Patent 1: runtime governance verdict for this external run. SDK callers
   * are expected to honor BLOCK / QUARANTINE / REQUIRE_APPROVAL decisions.
   */
  governance?: {
    decision: string;
    severity: string;
    reasons: string[];
    autoAction: string;
  };
}

// ────────────────────────────────────────────────────────────
// Pure helpers (exported for unit testing — no DB, no NestJS)
// ────────────────────────────────────────────────────────────

/** Validate a single external run. Returns an error string, or null if valid. */
export function validateRun(run: IngestRunInput): string | null {
  if (!run || typeof run !== 'object') return 'run must be an object';
  if (!run.agentName || typeof run.agentName !== 'string' || !run.agentName.trim()) {
    return 'agentName is required';
  }
  const hasInput = typeof run.input === 'string' && run.input.length > 0;
  const hasOutput = typeof run.output === 'string' && run.output.length > 0;
  if (!hasInput && !hasOutput) {
    return 'at least one of input or output is required';
  }
  return null;
}

/**
 * Map an external run + resolved session to the EXACT evaluate() arg object
 * used by the internal PipelineEngine path. This is the single source of
 * truth for the on-ramp → evaluator contract (unit-tested).
 *
 * NOTE: tokensUsed = tokensIn + tokensOut (only when at least one provided);
 * executionTimeMs = latencyMs; stepKey/nodeType default to 'sdk'.
 */
export function runToEvaluateArgs(run: IngestRunInput, sessionId: string, tenantId: string) {
  const tokensIn = typeof run.tokensIn === 'number' ? run.tokensIn : undefined;
  const tokensOut = typeof run.tokensOut === 'number' ? run.tokensOut : undefined;
  let tokensUsed: number | undefined;
  if (tokensIn !== undefined || tokensOut !== undefined) {
    tokensUsed = (tokensIn ?? 0) + (tokensOut ?? 0);
  }

  return {
    tenantId,
    executionSessionId: sessionId,
    stepKey: run.stepKey ?? 'sdk',
    nodeType: 'sdk',
    agentName: run.agentName,
    workflowKey: run.workflowKey,
    input: run.input,
    output: run.output,
    context: run.context,
    groundTruth: run.groundTruth,
    model: run.model,
    tokensUsed,
    executionTimeMs: run.latencyMs,
    estimatedCostUsd: run.costUsd,
  };
}

/** Derive the idempotency key tuple from a run. Null externalRunId = create-only. */
export function idempotencyKey(
  tenantId: string,
  run: IngestRunInput,
): { tenantId: string; externalRunId: string | null } {
  const externalRunId =
    typeof run.runId === 'string' && run.runId.trim().length > 0 ? run.runId.trim() : null;
  return { tenantId, externalRunId };
}

/** Map a free-form status string to a Prisma ExecutionStatus value. */
export function normalizeStatus(status?: string): string {
  // Map external/client status strings to the ExecutionStatus enum
  // (QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED | BLOCKED).
  const s = (status ?? '').toUpperCase();
  if (s === 'FAILED' || s === 'ERROR') return 'FAILED';
  if (s === 'RUNNING' || s === 'IN_PROGRESS') return 'RUNNING';
  if (s === 'QUEUED' || s === 'PENDING') return 'QUEUED';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  if (s === 'BLOCKED') return 'BLOCKED';
  // COMPLETED / SUCCESS / SUCCEEDED / DONE / OK / (default) → SUCCEEDED
  return 'SUCCEEDED';
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly evaluatorService: EvaluatorService,
    @Optional() private readonly runtimeGovernance?: RuntimeGovernanceService,
  ) {}

  /**
   * Ingest a batch of external runs. Each run is processed best-effort —
   * one bad run never fails the batch. When opts.wait is true the evaluation
   * summary is returned inline (synchronous Phase-1 behavior).
   */
  async ingestRuns(
    tenantId: string,
    runs: IngestRunInput[],
    opts: {
      wait?: boolean;
      ingestKeyId?: string | null;
      keyScope?: { allowedAgentNames?: string[]; subAgentKey?: string | null };
    } = {},
  ): Promise<{
    accepted: number;
    rejected: Array<{ index: number; error: string }>;
    results: IngestRunResult[];
  }> {
    const rejected: Array<{ index: number; error: string }> = [];
    const results: IngestRunResult[] = [];
    let accepted = 0;
    const allowed = opts.keyScope?.allowedAgentNames ?? [];

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const validationError = validateRun(run);
      if (validationError) {
        rejected.push({ index: i, error: validationError });
        results.push({
          runId: run?.runId ?? null,
          sessionId: null,
          status: 'error',
          error: validationError,
        });
        continue;
      }
      // 키 scope에 agentName 허용목록이 있으면 본문 agentName을 강제(스푸핑 방지).
      if (allowed.length > 0 && run.agentName && !allowed.includes(run.agentName)) {
        const error = `이 키는 agentName=${run.agentName} 호출이 허용되지 않습니다(허용: ${allowed.join(', ')}).`;
        rejected.push({ index: i, error });
        results.push({ runId: run.runId ?? null, sessionId: null, status: 'error', error });
        continue;
      }
      try {
        const res = await this.processRun(tenantId, run, opts.wait === true, opts.ingestKeyId);
        accepted++;
        results.push(res);
      } catch (err) {
        const error = (err as Error).message;
        this.logger.warn(`Ingest run ${i} failed: ${error}`);
        rejected.push({ index: i, error });
        results.push({
          runId: run.runId ?? null,
          sessionId: null,
          status: 'error',
          error,
        });
      }
    }

    return { accepted, rejected, results };
  }

  /**
   * Process a single validated run: redact → resolve session → evaluate.
   * Intentionally self-contained so Phase-1.5 can enqueue it as a job.
   */
  private async processRun(
    tenantId: string,
    run: IngestRunInput,
    wait: boolean,
    ingestKeyId?: string | null,
  ): Promise<IngestRunResult> {
    // 1) Redact secrets from any free text BEFORE it touches the engine/DB.
    const safeInput = run.input ? redactSecrets(run.input) : run.input;
    const safeOutput = run.output ? redactSecrets(run.output) : run.output;
    const safeContext = run.context ? redactSecrets(run.context) : run.context;
    const safeRun: IngestRunInput = {
      ...run,
      input: safeInput,
      output: safeOutput,
      context: safeContext,
    };

    // 2) Resolve / create the ExecutionSession (idempotent by externalRunId).
    const session = await this.resolveSession(tenantId, safeRun, ingestKeyId);

    // 3) Evaluate through the SAME EvaluatorService the PipelineEngine uses.
    //    Autonomous (Hermes) runs get the SAME standard evaluation as every
    //    other run — autonomy governance is layered ON TOP, never instead.
    const args = runToEvaluateArgs(safeRun, session.id, tenantId);
    const evalResult = await this.evaluatorService.evaluate(args as any);

    // 3.5) Runtime governance (Patent 1, 종속청구항 2): external SDK runs go
    //      through the SAME profiler → 5-gate → decision → FDS alert → auto
    //      action → evidence pack path as internal pipeline nodes. For SDK
    //      runs the node already executed remotely, so a blocking decision is
    //      returned to the caller (governance.decision) instead of halting a
    //      local pipeline. Best-effort: never fails ingestion.
    let governance:
      | { decision: string; severity: string; reasons: string[]; autoAction: string }
      | undefined;
    if (this.runtimeGovernance) {
      const governed = await this.runtimeGovernance.evaluateStep({
        ctx: {
          tenantId,
          executionSessionId: session.id,
          workflowKey: safeRun.workflowKey,
          nodeKey: safeRun.stepKey ?? 'sdk',
          executionType: safeRun.runtime === 'hermes' ? 'hermes' : 'sdk',
          modelId: safeRun.model,
          output: safeRun.output,
          tokensUsed: (safeRun.tokensIn ?? 0) + (safeRun.tokensOut ?? 0),
          executionTimeMs: safeRun.latencyMs,
        },
        evaluation: evalResult,
      });
      if (governed) {
        governance = {
          decision: governed.decision.decision,
          severity: governed.decision.severity,
          reasons: governed.decision.reasons,
          autoAction: governed.autoAction.autoAction,
        };
      }
    }

    // 4) Autonomy governance (Hermes only). Computed from the autonomous-agent
    //    extras and, when material, persisted as a governance alert so a
    //    self-improving agent stays observable/governable.
    let autonomy: AutonomyVerdict | undefined;
    if (safeRun.runtime === 'hermes' && safeRun.hermesMeta) {
      // Per-agent allowlist policy: inline (Lab) takes precedence, else loaded
      // from the Workflow's effectivenessJson (allowedTools / allowedDomains).
      const policy =
        safeRun.hermesMeta.policy ?? (await this.loadAgentPolicy(tenantId, safeRun.workflowKey));
      // Evidence-based: inspects tool args/targets, skill code, memory content
      // (SSRF, dangerous code, secrets, injection, policy) — real risk, not just counts.
      autonomy = evaluateAutonomyEvidence({ ...safeRun.hermesMeta, sessionId: session.id }, policy);
      await this.maybeRaiseAutonomyAlert(tenantId, session.id, safeRun, autonomy);
    }

    return {
      runId: safeRun.runId ?? null,
      sessionId: session.id,
      status: 'evaluated',
      evaluation: wait
        ? {
            overallScore: evalResult.overallScore,
            securityRiskLevel: evalResult.security.securityRiskLevel,
            anomalyDetected: evalResult.anomaly.anomalyDetected,
            costUsd: evalResult.cost?.costUsd ?? 0,
            tokensUsed: (safeRun.tokensIn ?? 0) + (safeRun.tokensOut ?? 0),
          }
        : undefined,
      // Autonomy block is returned whenever it was computed (Hermes runs),
      // independent of `wait`, so the UI always sees the governance verdict.
      autonomy,
      // Patent 1: runtime governance verdict for this external run — the SDK
      // caller is expected to honor BLOCK / QUARANTINE / REQUIRE_APPROVAL.
      governance,
    };
  }

  /**
   * Best-effort: write an FDSAlert for a high-autonomy Hermes run so it shows
   * up in the governance/FDS surfaces. Triggered when the autonomy level is
   * high|critical OR the agent self-created at least one new skill. Failure to
   * write the alert NEVER fails the run (autonomy data is already returned).
   */
  /**
   * Load the per-agent autonomy allowlist from the Workflow's effectivenessJson
   * (allowedTools / allowedDomains). Returns undefined when no workflow/policy.
   * Best-effort: a lookup failure must never block ingestion.
   */
  private async loadAgentPolicy(
    tenantId: string,
    workflowKey?: string | null,
  ): Promise<AutonomyPolicy | undefined> {
    if (!workflowKey) return undefined;
    try {
      const wf = await (this.prisma as any).workflow.findFirst({
        where: { tenantId, key: workflowKey, deletedAt: null },
        select: { effectivenessJson: true },
      });
      const ej =
        wf?.effectivenessJson && typeof wf.effectivenessJson === 'object'
          ? (wf.effectivenessJson as Record<string, any>)
          : null;
      if (!ej) return undefined;
      const allowedTools = Array.isArray(ej.allowedTools) ? ej.allowedTools : undefined;
      const allowedDomains = Array.isArray(ej.allowedDomains) ? ej.allowedDomains : undefined;
      if (!allowedTools && !allowedDomains) return undefined;
      return { allowedTools, allowedDomains };
    } catch (err) {
      this.logger.warn(`loadAgentPolicy failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async maybeRaiseAutonomyAlert(
    tenantId: string,
    sessionId: string,
    run: IngestRunInput,
    autonomy: AutonomyVerdict,
  ): Promise<void> {
    const order = ['low', 'medium', 'high', 'critical'];
    // Alert severity = the WORSE of the surface level and the evidence-verified level.
    const effLevel =
      order.indexOf(autonomy.verifiedRiskLevel) > order.indexOf(autonomy.autonomyRiskLevel)
        ? autonomy.verifiedRiskLevel
        : autonomy.autonomyRiskLevel;
    const shouldAlert =
      autonomy.findings.length > 0 ||
      effLevel === 'high' ||
      effLevel === 'critical' ||
      autonomy.newSkillCount > 0;
    if (!shouldAlert) return;

    const severity =
      effLevel === 'critical'
        ? 'CRITICAL'
        : effLevel === 'high'
          ? 'HIGH'
          : effLevel === 'medium'
            ? 'MEDIUM'
            : 'LOW';
    const agentName = run.agentName ?? 'unknown-agent';

    try {
      await (this.prisma as any).fDSAlert.create({
        data: {
          tenantId,
          severity,
          status: 'OPEN',
          subjectType: 'AgentAutonomy',
          subjectId: sessionId,
          score: autonomy.autonomyRiskScore / 100,
          summary:
            autonomy.findings.length > 0
              ? `[자율성·검증] ${agentName} 실제 위험 ${autonomy.verifiedRiskLevel} — ${autonomy.findings
                  .slice(0, 3)
                  .map((f) => f.reason)
                  .join(' / ')}`
              : `[자율성] ${agentName} 자율성 리스크 ${autonomy.autonomyRiskLevel} — ${autonomy.signals.join(', ')}`,
          detailsJson: {
            category: 'autonomy',
            workflowKey: run.workflowKey ?? null,
            agentName,
            ...autonomy,
          },
          correlationId: `hermes-${sessionId}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Autonomy alert write failed for session ${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Resolve an ExecutionSession for the run. When the caller supplied a runId
   * we upsert on (tenantId, externalRunId) for idempotency; otherwise create.
   */
  private async resolveSession(
    tenantId: string,
    run: IngestRunInput,
    ingestKeyId?: string | null,
  ): Promise<{ id: string }> {
    const { externalRunId } = idempotencyKey(tenantId, run);
    const status = normalizeStatus(run.status);
    const now = new Date();
    const startedAt = run.latencyMs ? new Date(now.getTime() - run.latencyMs) : now;
    // runtime: ingest default is 'sdk'; a Hermes adapter sets 'hermes'.
    const runtime = run.runtime === 'hermes' || run.runtime === 'internal' ? run.runtime : 'sdk';
    // ExecutionSession has no agentName column — stash agentName into
    // agentMetaJson so GET /ingest/recent can show it without a join, and
    // carry the Hermes extras for the autonomy view.
    const agentMetaJson: any = {
      agentName: run.agentName ?? null,
      ...(run.hermesMeta ?? {}),
    };
    const baseData: any = {
      tenantId,
      source: 'sdk',
      runtime,
      agentMetaJson,
      ingestKeyId: ingestKeyId ?? null, // 키별/Sub-Agent별 추적 귀속
      workflowKey: run.workflowKey ?? null,
      status,
      startedAt,
      endedAt: now,
      completedAt: status === 'SUCCEEDED' ? now : null,
      latencyMs: typeof run.latencyMs === 'number' ? Math.round(run.latencyMs) : null,
      costUsd: typeof run.costUsd === 'number' ? run.costUsd : null,
    };

    if (externalRunId) {
      const session = await (this.prisma as any).executionSession.upsert({
        where: { tenantId_externalRunId: { tenantId, externalRunId } },
        update: {
          status,
          endedAt: now,
          completedAt: status === 'SUCCEEDED' ? now : null,
          latencyMs: baseData.latencyMs,
          costUsd: baseData.costUsd,
          workflowKey: baseData.workflowKey,
          runtime: baseData.runtime,
          agentMetaJson: baseData.agentMetaJson,
        },
        create: { ...baseData, externalRunId },
        select: { id: true },
      });
      return session;
    }

    const session = await (this.prisma as any).executionSession.create({
      data: baseData,
      select: { id: true },
    });
    return session;
  }

  /**
   * Recent ingested ExecutionSessions for the Lab "recent runs + compare"
   * list. Tenant-scoped, optionally filtered by runtime. For each session we
   * join the LATEST AgentEvaluation (by createdAt) to surface the standard
   * evaluation summary, and derive agentName from agentMetaJson (set at
   * ingest) falling back to the evaluation row's agentName.
   */
  async getRecent(
    tenantId: string,
    opts: { runtime?: string; limit?: number } = {},
  ): Promise<{
    items: Array<{
      id: string;
      runtime: string;
      externalRunId: string | null;
      agentName: string | null;
      workflowKey: string | null;
      status: string;
      latencyMs: number | null;
      createdAt: Date;
      agentMetaJson: any;
      evaluation: {
        overallScore: number;
        securityRiskLevel: string | null;
        anomalyDetected: boolean;
      } | null;
    }>;
  }> {
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    const where: any = { tenantId };
    if (opts.runtime === 'internal' || opts.runtime === 'sdk' || opts.runtime === 'hermes') {
      where.runtime = opts.runtime;
    }

    const sessions = await (this.prisma as any).executionSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        runtime: true,
        externalRunId: true,
        workflowKey: true,
        status: true,
        latencyMs: true,
        createdAt: true,
        agentMetaJson: true,
      },
    });

    const items: Array<{
      id: string;
      runtime: string;
      externalRunId: string | null;
      agentName: string | null;
      workflowKey: string | null;
      status: string;
      latencyMs: number | null;
      createdAt: Date;
      agentMetaJson: any;
      evaluation: {
        overallScore: number;
        securityRiskLevel: string | null;
        anomalyDetected: boolean;
      } | null;
    }> = [];
    for (const sess of sessions) {
      // Latest evaluation for this session (standard eval summary).
      const evalRow = await (this.prisma as any).agentEvaluation.findFirst({
        where: { tenantId, executionSessionId: sess.id },
        orderBy: { createdAt: 'desc' },
        select: {
          overallScore: true,
          securityRiskLevel: true,
          anomalyDetected: true,
          agentName: true,
        },
      });

      const metaName =
        sess.agentMetaJson && typeof sess.agentMetaJson === 'object'
          ? (sess.agentMetaJson as any).agentName
          : null;

      items.push({
        id: sess.id,
        runtime: sess.runtime ?? 'internal',
        externalRunId: sess.externalRunId ?? null,
        agentName: metaName ?? evalRow?.agentName ?? null,
        workflowKey: sess.workflowKey ?? null,
        status: sess.status,
        latencyMs: sess.latencyMs ?? null,
        createdAt: sess.createdAt,
        agentMetaJson: sess.agentMetaJson ?? null,
        evaluation: evalRow
          ? {
              overallScore: evalRow.overallScore,
              securityRiskLevel: evalRow.securityRiskLevel ?? null,
              anomalyDetected: evalRow.anomalyDetected,
            }
          : null,
      });
    }

    return { items };
  }
}
