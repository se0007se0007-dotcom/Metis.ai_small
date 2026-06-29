/**
 * Canary Evaluator — Phase 3 Worker
 *
 * Evaluates canary gate conditions by:
 *   1. Collecting metrics from stable and candidate executions in the current window
 *   2. Computing ComparisonMetrics
 *   3. Evaluating gate rules
 *   4. Recording results back to CanaryDeployment via API callback
 *
 * This processor runs on a delayed schedule (per window duration).
 */
import { Job } from 'bullmq';
import { PrismaClient } from '@metis/database';
import { evaluateGateRules, DEFAULT_CANARY_GATE_RULES } from '@metis/types';
import type { ComparisonMetrics, CanaryGateRule } from '@metis/types';

export interface CanaryEvaluateJobData {
  deploymentId: string;
  windowNumber: number;
  tenantId: string;
}

export async function runCanaryEvaluator(
  job: Job<CanaryEvaluateJobData>,
  prisma: PrismaClient,
): Promise<{
  deploymentId: string;
  windowNumber: number;
  gateResult: string;
  action: string;
}> {
  const { deploymentId, windowNumber, tenantId } = job.data;

  await job.updateProgress(10);

  // Load deployment
  const deployment = await prisma.canaryDeployment.findUnique({
    where: { id: deploymentId },
  });

  if (!deployment) {
    throw new Error(`Canary deployment ${deploymentId} not found`);
  }

  if (deployment.status !== 'ACTIVE') {
    console.log(
      `[canary-eval] Deployment ${deploymentId} is ${deployment.status}, skipping evaluation`,
    );
    return { deploymentId, windowNumber, gateResult: 'SKIPPED', action: 'NONE' };
  }

  await job.updateProgress(20);

  // Collect metrics for this window
  // In production: query ExecutionSession metrics for the time window
  const windowStart = new Date(Date.now() - (deployment.windowDurationMs ?? 3600000));

  // Candidate executions (those routed to candidate version)
  const candidateMetrics = await collectExecutionMetrics(
    prisma,
    tenantId,
    deployment.candidateVersionId,
    windowStart,
  );

  // Stable executions (those on stable version)
  const stableMetrics = await collectExecutionMetrics(
    prisma,
    tenantId,
    deployment.stableVersionId,
    windowStart,
  );

  await job.updateProgress(50);

  // Load gate rules
  const existingGates = await prisma.canaryGate.findMany({
    where: { deploymentId },
    orderBy: { windowNumber: 'desc' },
    take: 1,
  });
  const rules =
    (existingGates[0]?.rulesJson as unknown as CanaryGateRule[]) ?? DEFAULT_CANARY_GATE_RULES;

  // Check minimum execution threshold before gate evaluation
  if (candidateMetrics.totalExecutions < MIN_EXECUTIONS_FOR_GATE) {
    console.log(
      `[canary-eval] Deployment ${deploymentId} window ${windowNumber}: ` +
        `insufficient executions (${candidateMetrics.totalExecutions}/${MIN_EXECUTIONS_FOR_GATE}). Deferring evaluation.`,
    );

    // Record a PENDING gate with reason
    await prisma.canaryGate.create({
      data: {
        deploymentId,
        windowNumber,
        rulesJson: JSON.parse(JSON.stringify(rules)),
        result: 'PENDING',
        metricsJson: JSON.parse(JSON.stringify(candidateMetrics)),
        evaluatedAt: new Date(),
        reason: `Insufficient executions: ${candidateMetrics.totalExecutions}/${MIN_EXECUTIONS_FOR_GATE} required`,
      },
    });

    // Re-schedule evaluation for the same window after another window duration
    // (uses a different jobId to avoid dedup)
    const queue = new (await import('bullmq')).Queue('canary', {
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
    });
    await queue.add(
      'canary-evaluate',
      {
        deploymentId,
        windowNumber,
        tenantId,
      },
      {
        jobId: `canary-eval-${deploymentId}-w${windowNumber}-retry-${Date.now()}`,
        delay: deployment.windowDurationMs ?? 3600000,
        attempts: 1,
      },
    );
    await queue.close();

    return {
      deploymentId,
      windowNumber,
      gateResult: 'PENDING',
      action: 'DEFERRED_INSUFFICIENT_DATA',
    };
  }

  // Evaluate gates against candidate metrics
  const evaluation = evaluateGateRules(rules, candidateMetrics);

  await job.updateProgress(70);

  // Record gate
  const gate = await prisma.canaryGate.create({
    data: {
      deploymentId,
      windowNumber,
      rulesJson: JSON.parse(JSON.stringify(rules)),
      result: evaluation.result,
      metricsJson: JSON.parse(JSON.stringify(candidateMetrics)),
      successRate: candidateMetrics.successRate,
      errorRate: candidateMetrics.errorRate,
      policyViolationCount: candidateMetrics.policyViolationCount,
      avgLatencyMs: candidateMetrics.avgLatencyMs,
      p99LatencyMs: candidateMetrics.p99LatencyMs,
      avgCostUsd: candidateMetrics.totalCostUsd,
      retryCount: candidateMetrics.retryCount,
      invalidOutputCount: candidateMetrics.invalidOutputCount,
      evaluatedAt: new Date(),
      reason:
        evaluation.details
          .filter((d) => !d.passed)
          .map(
            (d) =>
              `${d.rule.metric}: expected ${d.rule.operator} ${d.rule.threshold}, got ${d.actual}`,
          )
          .join('; ') || 'All gates passed',
    },
  });

  // Record metric snapshot
  await prisma.canaryMetricSnapshot.create({
    data: {
      deploymentId,
      windowNumber,
      stableMetricsJson: JSON.parse(JSON.stringify(stableMetrics)),
      candidateMetricsJson: JSON.parse(JSON.stringify(candidateMetrics)),
      stableSuccessRate: stableMetrics.successRate,
      candidateSuccessRate: candidateMetrics.successRate,
      stableAvgLatencyMs: stableMetrics.avgLatencyMs,
      candidateAvgLatencyMs: candidateMetrics.avgLatencyMs,
      totalStableExecs: stableMetrics.totalExecutions,
      totalCandidateExecs: candidateMetrics.totalExecutions,
    },
  });

  await job.updateProgress(85);

  // Decision logic
  let action = 'CONTINUED';

  if (evaluation.result === 'FAIL' && deployment.autoRollbackEnabled) {
    // Auto-rollback
    await prisma.canaryDeployment.update({
      where: { id: deploymentId },
      data: {
        status: 'ROLLED_BACK',
        currentTrafficPct: 0,
        completedAt: new Date(),
        rollbackReason: `Auto-rollback at window ${windowNumber}: ${gate.reason}`,
      },
    });

    // Record rollback
    await prisma.versionPromotion.create({
      data: {
        tenantId,
        packId: deployment.packId,
        fromVersionId: deployment.candidateVersionId,
        toVersionId: deployment.stableVersionId,
        action: 'ROLLBACK',
        reason: `Canary auto-rollback at window ${windowNumber}: ${gate.reason}`,
        sourceType: 'CANARY',
        sourceId: deploymentId,
        rollbackFromVersionId: deployment.candidateVersionId,
      },
    });

    action = 'ROLLED_BACK';
    console.log(
      `[canary-eval] Deployment ${deploymentId} AUTO-ROLLED BACK at window ${windowNumber}`,
    );
  } else if (evaluation.result === 'PASS') {
    const nextTraffic = Math.min(
      deployment.currentTrafficPct + deployment.incrementStepPct,
      deployment.maxTrafficPct,
    );

    if (nextTraffic >= deployment.maxTrafficPct) {
      // Auto-promote
      await prisma.canaryDeployment.update({
        where: { id: deploymentId },
        data: {
          status: 'PROMOTED',
          currentTrafficPct: 100,
          completedAt: new Date(),
        },
      });

      await prisma.versionPromotion.create({
        data: {
          tenantId,
          packId: deployment.packId,
          fromVersionId: deployment.stableVersionId,
          toVersionId: deployment.candidateVersionId,
          action: 'PROMOTE',
          reason: `Canary auto-promotion after ${windowNumber} windows`,
          sourceType: 'CANARY',
          sourceId: deploymentId,
          decidedById: null, // automatic
        },
      });

      action = 'PROMOTED';
      console.log(
        `[canary-eval] Deployment ${deploymentId} AUTO-PROMOTED at window ${windowNumber}`,
      );
    } else {
      // Advance traffic
      await prisma.canaryDeployment.update({
        where: { id: deploymentId },
        data: {
          currentTrafficPct: nextTraffic,
          currentWindow: windowNumber + 1,
        },
      });

      // Schedule next window evaluation (H-3 fix)
      const queue = new (await import('bullmq')).Queue('canary', {
        connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
      });
      await queue.add(
        'canary-evaluate',
        {
          deploymentId,
          windowNumber: windowNumber + 1,
          tenantId,
        },
        {
          jobId: `canary-eval-${deploymentId}-w${windowNumber + 1}`,
          delay: deployment.windowDurationMs ?? 3600000,
          attempts: 1,
        },
      );
      await queue.close();

      action = `ADVANCED_TO_${nextTraffic}PCT`;
    }
  } else if (evaluation.result === 'FAIL') {
    // No auto-rollback — pause
    await prisma.canaryDeployment.update({
      where: { id: deploymentId },
      data: { status: 'PAUSED' },
    });
    action = 'PAUSED';
  }
  // WARN: continue at same traffic

  // Audit log
  await prisma.auditLog
    .create({
      data: {
        tenantId,
        actorUserId: null, // automated
        action: 'CANARY_GATE_EVALUATE' as any,
        targetType: 'CanaryGate',
        targetId: gate.id,
        correlationId: `canary-eval-${deploymentId}-w${windowNumber}`,
        metadataJson: JSON.parse(
          JSON.stringify({
            deploymentId,
            windowNumber,
            gateResult: evaluation.result,
            action,
            candidateMetrics,
            stableMetrics,
          }),
        ),
      },
    })
    .catch((e: any) => {
      console.error(`[canary-eval] Audit write failed: ${e.message}`);
    });

  await job.updateProgress(100);

  return { deploymentId, windowNumber, gateResult: evaluation.result, action };
}

// ── Metrics Collection ──

/** Minimum execution count required for gate evaluation to produce meaningful results */
const MIN_EXECUTIONS_FOR_GATE = 5;

async function collectExecutionMetrics(
  prisma: PrismaClient,
  tenantId: string,
  versionId: string,
  since: Date,
): Promise<ComparisonMetrics> {
  // Join ExecutionSession → PackInstallation to filter by version
  // PackInstallation links a PackVersion to a tenant; ExecutionSession references packInstallationId.
  const installations = await prisma.packInstallation.findMany({
    where: {
      tenantId,
      packVersionId: versionId,
    },
    select: { id: true },
  });

  const installationIds = installations.map((i: any) => i.id);

  // If no installations for this version, return zero metrics
  if (installationIds.length === 0) {
    return {
      successRate: 0,
      policyViolationCount: 0,
      invalidOutputCount: 0,
      avgLatencyMs: 0,
      p99LatencyMs: 0,
      totalCostUsd: 0,
      errorRate: 0,
      retryCount: 0,
      totalExecutions: 0,
      evalQualityScore: 0,
      evalSecurityScore: 0,
      evalAnomalyCount: 0,
    };
  }

  const sessions = await prisma.executionSession.findMany({
    where: {
      tenantId,
      packInstallationId: { in: installationIds },
      createdAt: { gte: since },
    },
    select: {
      id: true,
      status: true,
      latencyMs: true,
      costUsd: true,
    },
    take: 1000,
  });

  const total = sessions.length;

  // Zero executions → return zero metrics (NOT successRate=1.0)
  // Gate evaluation should treat insufficient data as unreliable, not healthy
  if (total === 0) {
    return {
      successRate: 0,
      policyViolationCount: 0,
      invalidOutputCount: 0,
      avgLatencyMs: 0,
      p99LatencyMs: 0,
      totalCostUsd: 0,
      errorRate: 0,
      retryCount: 0,
      totalExecutions: 0,
      evalQualityScore: 0,
      evalSecurityScore: 0,
      evalAnomalyCount: 0,
    };
  }

  const sessionIds = sessions.map((s: any) => s.id);

  // Aggregate evaluation quality/security/anomaly signals from AgentEvaluation history
  const evaluations = await prisma.agentEvaluation
    .findMany({
      where: {
        tenantId,
        executionSessionId: { in: sessionIds },
      },
      select: {
        overallScore: true,
        securityScore: true,
        anomalyDetected: true,
      },
      take: 1000,
    })
    .catch(() => [] as Array<{ overallScore: number | null; securityScore: number | null; anomalyDetected: boolean | null }>);

  const qualityScores = evaluations
    .map((e) => e.overallScore)
    .filter((v): v is number => v != null);
  const securityScores = evaluations
    .map((e) => e.securityScore)
    .filter((v): v is number => v != null);
  const evalQualityScore =
    qualityScores.length > 0
      ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
      : 100;
  const evalSecurityScore =
    securityScores.length > 0
      ? Math.round(securityScores.reduce((a, b) => a + b, 0) / securityScores.length)
      : 100;
  const evalAnomalyCount = evaluations.filter((e) => e.anomalyDetected === true).length;

  const succeeded = sessions.filter((s: any) => s.status === 'SUCCEEDED').length;
  const failed = sessions.filter((s: any) => s.status === 'FAILED').length;
  const latencies = sessions
    .filter((s: any) => s.latencyMs != null)
    .map((s: any) => s.latencyMs as number)
    .sort((a: number, b: number) => a - b);

  const totalCost = sessions.reduce((sum: number, s: any) => sum + (Number(s.costUsd) || 0), 0);

  // Count policy violations via PolicyEvaluation join
  const policyViolations = await prisma.policyEvaluation
    .count({
      where: {
        tenantId,
        executionSessionId: { in: sessionIds },
        result: 'FAIL',
      },
    })
    .catch(() => 0);

  return {
    successRate: succeeded / total,
    policyViolationCount: policyViolations as number,
    invalidOutputCount: 0, // TODO: implement output validation count
    avgLatencyMs:
      latencies.length > 0
        ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
        : 0,
    p99LatencyMs: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)] : 0,
    totalCostUsd: totalCost,
    errorRate: failed / total,
    retryCount: 0, // TODO: implement retry tracking
    totalExecutions: total,
    evalQualityScore,
    evalSecurityScore,
    evalAnomalyCount,
  };
}

export { MIN_EXECUTIONS_FOR_GATE };
