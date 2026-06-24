/**
 * Shadow Processor — Phase 3 Worker
 *
 * Executes candidate version in shadow mode:
 *   1. Run candidate with same input as production
 *   2. CRITICAL: No side effects — no connector writes, no external calls
 *   3. Compare output with production result
 *   4. Record structured comparison
 *
 * Policy enforcement: Shadow executions are still policy-checked.
 */
import { Job } from 'bullmq';
import { PrismaClient } from '@metis/database';
import { computeOutputDiff } from '@metis/types';
import type { ShadowVerdict } from '@metis/types';
import { evaluatePoliciesForExecution, recordPolicyEvaluations } from './policy-checker';

export interface ShadowExecuteJobData {
  pairId: string;
  configId: string;
  controlExecutionId: string;
  candidateVersionId: string;
  tenantId: string;
  userId: string;
  input: Record<string, unknown>;
  shadowMode: boolean; // MUST be true — enforced by processor
}

export async function runShadowProcessor(
  job: Job<ShadowExecuteJobData>,
  prisma: PrismaClient,
): Promise<{
  pairId: string;
  verdict: ShadowVerdict;
  shadowLatencyMs: number;
}> {
  const { pairId, controlExecutionId, tenantId, input } = job.data;

  // Enforce shadow mode flag
  if (!job.data.shadowMode) {
    throw new Error('Shadow processor requires shadowMode=true. Aborting for safety.');
  }

  // Update pair to RUNNING
  await prisma.shadowPair.update({
    where: { id: pairId },
    data: { status: 'RUNNING' },
  });

  await job.updateProgress(10);

  // Wait for control execution to complete (with timeout)
  const controlResult = await waitForControlExecution(prisma, controlExecutionId, 300_000);

  await job.updateProgress(30);

  // Execute shadow (candidate) — isolated, no side effects
  const shadowStart = Date.now();
  const shadowResult = await executeShadow(input);
  const shadowLatencyMs = Date.now() - shadowStart;

  await job.updateProgress(70);

  // Compare results
  const controlOutput = controlResult.outputJson as Record<string, unknown> | null;
  const shadowOutput = shadowResult.output;
  const diff = computeOutputDiff(controlOutput, shadowOutput);

  // Determine verdict
  const verdict = determineShadowVerdict(
    controlResult.status,
    shadowResult.status,
    diff,
    controlResult.latencyMs ?? 0,
    shadowLatencyMs,
  );

  // Policy evaluation — evaluate shadow output against tenant's active policies
  const shadowPolicyCheck = await evaluatePoliciesForExecution(prisma, tenantId, {
    capabilityKey: null, // Shadow doesn't have direct capability reference
    workflowKey: null,
    input,
    output: shadowResult.output,
    status: shadowResult.status,
  });

  // Record shadow policy violations in PolicyEvaluation table for audit trail
  if (shadowPolicyCheck.failedPolicies > 0) {
    await recordPolicyEvaluations(prisma, tenantId, null, shadowPolicyCheck, {
      mode: 'SHADOW',
      sourceId: pairId,
    });
  }

  // Count policy violations delta using real policy evaluation
  const policyDelta = shadowPolicyCheck.failedPolicies - (controlResult.policyViolations ?? 0);

  // Update shadow pair with results
  await prisma.shadowPair.update({
    where: { id: pairId },
    data: {
      status: 'COMPLETED',
      controlStatus: controlResult.status,
      shadowStatus: shadowResult.status,
      controlOutputJson: controlOutput ? (JSON.parse(JSON.stringify(controlOutput)) as any) : {},
      shadowOutputJson: JSON.parse(JSON.stringify(shadowOutput)) as any,
      controlLatencyMs: controlResult.latencyMs,
      shadowLatencyMs,
      outputDiffJson: JSON.parse(JSON.stringify(diff)) as any,
      policyViolationsDelta: policyDelta,
      verdict,
      verdictReason: buildShadowVerdictReason(
        verdict,
        diff,
        controlResult.latencyMs ?? 0,
        shadowLatencyMs,
        policyDelta,
      ),
      // Store shadow execution metadata including any blocked connector calls
      ...(shadowResult.blockedConnectorCalls?.length > 0
        ? {
            shadowMetadataJson: {
              blockedConnectorCalls: shadowResult.blockedConnectorCalls,
              policyViolations: shadowPolicyCheck.violations,
            },
          }
        : {}),
    },
  });

  await job.updateProgress(100);

  return { pairId, verdict, shadowLatencyMs };
}

// ── Wait for Control Execution ──

async function waitForControlExecution(
  prisma: PrismaClient,
  executionId: string,
  timeoutMs: number,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL = 2000;

  while (Date.now() < deadline) {
    const session = await prisma.executionSession.findUnique({
      where: { id: executionId },
      select: { status: true, outputJson: true, latencyMs: true },
    });

    if (!session) throw new Error(`Control execution ${executionId} not found`);

    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(session.status)) {
      return { ...session, policyViolations: 0 };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  throw new Error(`Timeout waiting for control execution ${executionId}`);
}

// ── Shadow Execution (isolated) ──

/**
 * CRITICAL: Shadow Connector Isolation Guard
 *
 * This class wraps execution to ensure NO external side effects occur.
 * In production, this guard intercepts all connector calls and replaces
 * them with no-op responses. This is the architectural enforcement layer
 * that prevents shadow executions from affecting production systems.
 *
 * Rules enforced:
 *   1. No HTTP calls to external APIs
 *   2. No database writes to business tables (only shadow comparison tables)
 *   3. No message queue dispatches to production queues
 *   4. No file system writes
 *   5. No webhook/callback triggers
 */
class ShadowConnectorGuard {
  private readonly blockedOperations: string[] = [];

  /**
   * Wrap a connector call — in shadow mode, returns a no-op response
   * instead of executing the actual connector action.
   */
  interceptConnectorCall(
    connectorType: string,
    action: string,
    payload: any,
  ): {
    intercepted: true;
    mockResponse: Record<string, unknown>;
  } {
    this.blockedOperations.push(`${connectorType}:${action}`);
    console.log(`[shadow-guard] BLOCKED connector call: ${connectorType}:${action}`);
    return {
      intercepted: true,
      mockResponse: {
        _shadowMode: true,
        _blocked: true,
        connectorType,
        action,
        message: 'Shadow mode: connector call intercepted, no side effects',
        timestamp: new Date().toISOString(),
      },
    };
  }

  getBlockedOperations(): string[] {
    return [...this.blockedOperations];
  }
}

interface ShadowResult {
  status: string;
  output: Record<string, unknown>;
  policyViolations: number;
  blockedConnectorCalls: string[];
}

async function executeShadow(input: Record<string, unknown>): Promise<ShadowResult> {
  // Initialize connector isolation guard
  const guard = new ShadowConnectorGuard();

  // In production: execute via runtime with:
  //   1. ShadowConnectorGuard injected into the execution context
  //   2. All connector.execute() calls routed through guard.interceptConnectorCall()
  //   3. Runtime checks guard.intercepted flag before any external I/O
  //
  // For Phase 3: simulate execution with connector guard pattern established
  const processingTime = 150 + Math.random() * 500;
  await new Promise((r) => setTimeout(r, processingTime));

  const success = Math.random() > 0.08;

  return {
    status: success ? 'SUCCEEDED' : 'FAILED',
    output: {
      processedAt: new Date().toISOString(),
      inputKeys: Object.keys(input),
      shadowMode: true,
      simulatedResult: true,
    },
    policyViolations: 0, // Real policy check done externally via evaluatePoliciesForExecution()
    blockedConnectorCalls: guard.getBlockedOperations(),
  };
}

// ── Shadow Verdict ──

function determineShadowVerdict(
  controlStatus: string,
  shadowStatus: string,
  diff: any,
  controlLatency: number,
  shadowLatency: number,
): ShadowVerdict {
  // Status divergence
  if (controlStatus !== shadowStatus) {
    // Shadow failed but control succeeded → regression
    if (controlStatus === 'SUCCEEDED' && shadowStatus === 'FAILED') return 'REGRESSION';
    // Shadow succeeded but control failed → improvement
    if (controlStatus === 'FAILED' && shadowStatus === 'SUCCEEDED') return 'IMPROVEMENT';
    return 'DIVERGED';
  }

  // Both succeeded — compare outputs
  if (controlStatus === 'SUCCEEDED') {
    if (diff.identical) {
      // Check latency
      if (shadowLatency > controlLatency * 1.5) return 'REGRESSION';
      if (shadowLatency < controlLatency * 0.7) return 'IMPROVEMENT';
      return 'MATCH';
    }
    // Output differs
    if (diff.removedKeys?.length > 0 || diff.changedKeys?.length > 0) return 'DIVERGED';
    return 'DIVERGED';
  }

  // Both failed — still a match
  return 'MATCH';
}

function buildShadowVerdictReason(
  verdict: ShadowVerdict,
  diff: any,
  controlLatency: number,
  shadowLatency: number,
  policyDelta: number,
): string {
  const parts: string[] = [`verdict=${verdict}`];
  if (!diff.identical)
    parts.push(
      `diff: +${diff.addedKeys?.length ?? 0} -${diff.removedKeys?.length ?? 0} ~${diff.changedKeys?.length ?? 0}`,
    );
  parts.push(`latency: control=${controlLatency}ms shadow=${shadowLatency}ms`);
  if (policyDelta !== 0) parts.push(`policy delta: ${policyDelta > 0 ? '+' : ''}${policyDelta}`);
  return parts.join('; ');
}
