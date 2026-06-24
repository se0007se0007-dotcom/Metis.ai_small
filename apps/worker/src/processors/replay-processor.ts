/**
 * Replay Processor — Phase 3 Worker
 *
 * Runs all cases in a replay dataset against a candidate version.
 * For each case:
 *   1. Execute candidate with recorded input (isolated from production)
 *   2. Compare output against baseline expected output
 *   3. Record structured comparison result
 *   4. Policy-check candidate execution
 *
 * CRITICAL: Replay executions must NOT write to production connectors.
 */
import { Job } from 'bullmq';
import { PrismaClient } from '@metis/database';
import { computeOutputDiff, EMPTY_COMPARISON_METRICS } from '@metis/types';
import type { ComparisonMetrics, CaseVerdict, OutputDiff } from '@metis/types';
import { evaluatePoliciesForExecution, recordPolicyEvaluations } from './policy-checker';

export interface ReplayRunJobData {
  runId: string;
  datasetId: string;
  candidateVersionId: string;
  baselineVersionId?: string;
  tenantId: string;
  userId: string;
}

export async function runReplayProcessor(
  job: Job<ReplayRunJobData>,
  prisma: PrismaClient,
): Promise<{
  runId: string;
  status: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  errorCases: number;
  metrics: ComparisonMetrics;
}> {
  const { runId, datasetId, tenantId } = job.data;

  // Mark run as RUNNING
  await prisma.replayRun.update({
    where: { id: runId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  await job.updateProgress(5);

  // Load all cases
  const cases = await prisma.replayCase.findMany({
    where: { datasetId },
    orderBy: { createdAt: 'asc' },
  });

  const totalCases = cases.length;
  let passedCases = 0;
  let failedCases = 0;
  let errorCases = 0;

  // Accumulate metrics
  const latencies: number[] = [];
  let totalCostUsd = 0;
  let policyViolations = 0;
  let invalidOutputCount = 0;
  let retryCount = 0;

  for (let i = 0; i < totalCases; i++) {
    const replayCase = cases[i];

    // M-1: Check for cancellation between cases
    if (i > 0 && i % 10 === 0) {
      const run = await prisma.replayRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (run?.status === 'CANCELLED') {
        console.log(`[replay] Run ${runId} cancelled at case ${i}/${totalCases}`);
        break;
      }
    }

    try {
      // Execute candidate version with recorded input
      // In production: dispatch to execution runtime with sandbox flag
      const startTime = Date.now();
      const executionResult = await simulateCandidateExecution(
        replayCase.inputJson as Record<string, unknown>,
        replayCase.capabilityKey,
        replayCase.workflowKey,
      );
      const latencyMs = Date.now() - startTime;
      latencies.push(latencyMs);

      // Compare outputs
      const expectedOutput = replayCase.expectedOutputJson as Record<string, unknown> | null;
      const actualOutput = executionResult.output;
      const diff = computeOutputDiff(expectedOutput, actualOutput);

      // Policy evaluation — evaluate candidate output against tenant's active policies
      const policyCheck = await evaluatePoliciesForExecution(prisma, tenantId, {
        capabilityKey: replayCase.capabilityKey,
        workflowKey: replayCase.workflowKey,
        input: replayCase.inputJson as Record<string, unknown>,
        output: actualOutput,
        status: executionResult.status,
        costUsd: executionResult.costUsd,
        latencyMs,
      });

      // Record policy violations in PolicyEvaluation table for audit trail
      if (policyCheck.failedPolicies > 0) {
        await recordPolicyEvaluations(prisma, tenantId, null, policyCheck, {
          mode: 'REPLAY',
          sourceId: runId,
        });
      }

      // Determine verdict — policy violations count as regression
      const statusMatch = executionResult.status === (replayCase.expectedStatus ?? 'SUCCEEDED');
      const actualPolicyViolations = policyCheck.failedPolicies;
      const verdict =
        actualPolicyViolations > 0
          ? ('REGRESSION' as CaseVerdict) // Policy violation = automatic regression
          : determineVerdict(statusMatch, diff, latencyMs, replayCase.expectedLatencyMs);

      // Record case result
      await prisma.replayCaseResult.create({
        data: {
          runId,
          caseId: replayCase.id,
          actualStatus: executionResult.status,
          actualOutputJson: JSON.parse(JSON.stringify(actualOutput)) as any,
          actualLatencyMs: latencyMs,
          actualCostUsd: executionResult.costUsd ?? 0,
          statusMatch,
          outputDiffJson: JSON.parse(JSON.stringify(diff)) as any,
          latencyDeltaMs: replayCase.expectedLatencyMs
            ? latencyMs - replayCase.expectedLatencyMs
            : null,
          policyViolations: actualPolicyViolations,
          retryCount: executionResult.retryCount ?? 0,
          verdict,
          verdictReason:
            actualPolicyViolations > 0
              ? `Policy violations: ${policyCheck.violations.map((v) => v.policyName).join(', ')}`
              : buildVerdictReason(
                  verdict,
                  statusMatch,
                  diff,
                  latencyMs,
                  replayCase.expectedLatencyMs,
                ),
        },
      });

      // Accumulate
      if (verdict === 'PASS' || verdict === 'IMPROVEMENT') passedCases++;
      else if (verdict === 'FAIL' || verdict === 'REGRESSION') failedCases++;
      else errorCases++;

      totalCostUsd += executionResult.costUsd ?? 0;
      policyViolations += actualPolicyViolations; // Use real policy check, not simulation
      retryCount += executionResult.retryCount ?? 0;
      if (executionResult.invalidOutput) invalidOutputCount++;
    } catch (error: any) {
      // Record error case
      await prisma.replayCaseResult.create({
        data: {
          runId,
          caseId: replayCase.id,
          actualStatus: 'ERROR',
          verdict: 'ERROR',
          verdictReason: error.message,
        },
      });
      errorCases++;
    }

    // Update progress
    await job.updateProgress(5 + Math.round(((i + 1) / totalCases) * 90));
  }

  // Compute aggregate metrics
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const metrics: ComparisonMetrics = {
    successRate: totalCases > 0 ? passedCases / totalCases : 0,
    policyViolationCount: policyViolations,
    invalidOutputCount,
    avgLatencyMs:
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
    p99LatencyMs:
      sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] : 0,
    totalCostUsd,
    errorRate: totalCases > 0 ? (failedCases + errorCases) / totalCases : 0,
    retryCount,
    totalExecutions: totalCases,
  };

  // Update run with final results
  await prisma.replayRun.update({
    where: { id: runId },
    data: {
      status: errorCases === totalCases ? 'FAILED' : 'COMPLETED',
      passedCases,
      failedCases,
      errorCases,
      metricsJson: JSON.parse(JSON.stringify(metrics)) as any,
      completedAt: new Date(),
    },
  });

  await job.updateProgress(100);

  return { runId, status: 'COMPLETED', totalCases, passedCases, failedCases, errorCases, metrics };
}

// ── Candidate Execution Simulation ──

interface CandidateResult {
  status: string;
  output: Record<string, unknown>;
  costUsd?: number;
  policyViolations?: number;
  retryCount?: number;
  invalidOutput?: boolean;
}

async function simulateCandidateExecution(
  input: Record<string, unknown>,
  capabilityKey?: string | null,
  workflowKey?: string | null,
): Promise<CandidateResult> {
  // In production: dispatch to execution runtime with sandbox/replay flag
  // For Phase 3: simulate execution with slight variations
  const processingTime = 100 + Math.random() * 400;
  await new Promise((r) => setTimeout(r, processingTime));

  // Simulate with 90% success rate
  const success = Math.random() > 0.1;

  return {
    status: success ? 'SUCCEEDED' : 'FAILED',
    output: {
      processedAt: new Date().toISOString(),
      capability: capabilityKey,
      workflow: workflowKey,
      inputKeys: Object.keys(input),
      simulatedResult: true,
    },
    costUsd: Math.random() * 0.01,
    policyViolations: Math.random() > 0.95 ? 1 : 0,
    retryCount: Math.random() > 0.9 ? 1 : 0,
    invalidOutput: Math.random() > 0.98,
  };
}

// ── Verdict Determination ──

function determineVerdict(
  statusMatch: boolean,
  diff: OutputDiff,
  actualLatency: number,
  expectedLatency?: number | null,
): CaseVerdict {
  if (!statusMatch) return 'REGRESSION';

  if (diff.identical) {
    // Check latency regression (>50% slower)
    if (expectedLatency && actualLatency > expectedLatency * 1.5) return 'REGRESSION';
    // Check latency improvement (>30% faster)
    if (expectedLatency && actualLatency < expectedLatency * 0.7) return 'IMPROVEMENT';
    return 'PASS';
  }

  // Output changed — might be regression or improvement
  const significantChanges = diff.changedKeys.length + diff.removedKeys.length;
  if (significantChanges > 0) return 'REGRESSION';

  // Only additions (might be improvement)
  if (diff.addedKeys.length > 0 && diff.removedKeys.length === 0) return 'IMPROVEMENT';

  return 'FAIL';
}

function buildVerdictReason(
  verdict: CaseVerdict,
  statusMatch: boolean,
  diff: OutputDiff,
  actualLatency: number,
  expectedLatency?: number | null,
): string {
  const parts: string[] = [];
  if (!statusMatch) parts.push('Status mismatch');
  if (!diff.identical)
    parts.push(
      `Output diff: +${diff.addedKeys.length} -${diff.removedKeys.length} ~${diff.changedKeys.length}`,
    );
  if (expectedLatency && actualLatency > expectedLatency * 1.5)
    parts.push(`Latency regression: ${actualLatency}ms vs ${expectedLatency}ms`);
  if (parts.length === 0) parts.push('All checks passed');
  return parts.join('; ');
}
