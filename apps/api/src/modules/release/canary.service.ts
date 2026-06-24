/**
 * Canary Service — Phase 3: Controlled Release Engineering
 *
 * Canary deployment: gradual rollout with automated gate evaluation.
 *
 * Flow:
 *   1. Create canary deployment (stableVersion → candidateVersion)
 *   2. Start canary → initial traffic % routed to candidate
 *   3. Per-window: collect metrics → evaluate gates → promote/pause/rollback
 *   4. If all gates pass: promote candidate to stable
 *   5. If any hard gate fails: auto-rollback
 *
 * CRITICAL: Auto-rollback on threshold failure to prevent regressions.
 */
import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { DEFAULT_CANARY_GATE_RULES, evaluateGateRules } from '@metis/types';
import type {
  CreateCanaryDeploymentRequest,
  ComparisonMetrics,
  CanaryGateRule,
} from '@metis/types';
import { EvaluatorService } from '../evaluator/evaluator.service';

const CANARY_QUEUE_TOKEN = 'CANARY_QUEUE';

interface QueueLike {
  add(name: string, data: any, opts?: any): Promise<{ id?: string | null }>;
  getJob(id: string): Promise<any>;
}

@Injectable()
export class CanaryService {
  private readonly logger = new Logger(CanaryService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CANARY_QUEUE_TOKEN) private readonly canaryQueue: QueueLike,
    @Optional() private readonly evaluatorService?: EvaluatorService,
  ) {}

  // ═══════════════════════════════════════════
  //  Create Canary Deployment
  // ═══════════════════════════════════════════

  async create(ctx: TenantContext, req: CreateCanaryDeploymentRequest) {
    const db = withTenantIsolation(this.prisma, ctx);

    // M-3: Validate version IDs
    if (req.stableVersionId === req.candidateVersionId) {
      throw new BadRequestException('stableVersionId and candidateVersionId must be different');
    }

    // Validate: no active canary for same pack
    const existing = await db.canaryDeployment.findFirst({
      where: { packId: req.packId, status: { in: ['PENDING', 'ACTIVE', 'PAUSED'] } },
    });
    if (existing) {
      throw new BadRequestException(
        `Active canary deployment already exists for pack ${req.packId}: ${existing.id}. ` +
          `Complete or rollback the existing canary first.`,
      );
    }

    const deployment = await db.canaryDeployment.create({
      data: {
        tenantId: ctx.tenantId,
        name: req.name,
        packId: req.packId,
        stableVersionId: req.stableVersionId,
        candidateVersionId: req.candidateVersionId,
        initialTrafficPct: req.initialTrafficPct ?? 5,
        currentTrafficPct: 0,
        maxTrafficPct: req.maxTrafficPct ?? 100,
        incrementStepPct: req.incrementStepPct ?? 10,
        windowDurationMs: req.windowDurationMs ?? 3600000,
        workflowFilter: req.workflowFilter ?? [],
        capabilityFilter: req.capabilityFilter ?? [],
        autoRollbackEnabled: req.autoRollbackEnabled ?? true,
        status: 'PENDING',
        createdById: ctx.userId,
      },
    });

    // Create initial gate with rules
    const gateRules = req.gateRules ?? DEFAULT_CANARY_GATE_RULES;
    await db.canaryGate.create({
      data: {
        deploymentId: deployment.id,
        windowNumber: 0,
        rulesJson: gateRules,
        result: 'PENDING',
      },
    });

    await this.writeAudit(ctx, 'CANARY_START', 'CanaryDeployment', deployment.id, {
      packId: req.packId,
      stableVersionId: req.stableVersionId,
      candidateVersionId: req.candidateVersionId,
      initialTrafficPct: req.initialTrafficPct,
      gateRuleCount: gateRules.length,
    });

    return deployment;
  }

  // ═══════════════════════════════════════════
  //  Start / Advance Canary
  // ═══════════════════════════════════════════

  async start(ctx: TenantContext, deploymentId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const deployment = await db.canaryDeployment.findFirst({ where: { id: deploymentId } });
    if (!deployment) throw new NotFoundException(`Canary ${deploymentId} not found`);
    if (deployment.status !== 'PENDING') {
      throw new BadRequestException(`Canary is in "${deployment.status}" state, cannot start.`);
    }

    const updated = await db.canaryDeployment.update({
      where: { id: deploymentId },
      data: {
        status: 'ACTIVE',
        currentTrafficPct: deployment.initialTrafficPct,
        currentWindow: 1,
        startedAt: new Date(),
      },
    });

    // Schedule first gate evaluation
    await this.canaryQueue.add(
      'canary-evaluate',
      {
        deploymentId,
        windowNumber: 1,
        tenantId: ctx.tenantId,
      },
      {
        jobId: `canary-eval-${deploymentId}-w1`,
        delay: deployment.windowDurationMs,
        attempts: 1,
      },
    );

    this.logger.log(
      `Canary ${deploymentId} started: ${deployment.initialTrafficPct}% traffic to candidate`,
    );

    return updated;
  }

  // ═══════════════════════════════════════════
  //  Evaluate Gate (called by worker or manually)
  // ═══════════════════════════════════════════

  async evaluateGate(
    ctx: TenantContext,
    deploymentId: string,
    windowNumber: number,
    metrics: ComparisonMetrics,
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const deployment = await db.canaryDeployment.findFirst({
      where: { id: deploymentId },
    });
    if (!deployment) throw new NotFoundException(`Canary ${deploymentId} not found`);
    if (deployment.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Canary is in "${deployment.status}" state, cannot evaluate gate.`,
      );
    }

    // ── Auto-populate Agent Evaluator scores from recent evaluations ──
    if (this.evaluatorService) {
      try {
        const evalData = await this.evaluatorService.getRecentEvaluations(ctx.tenantId, 20);
        const evals = evalData.evaluations || [];
        if (evals.length > 0) {
          const avgQuality =
            evals.reduce((s: number, e: any) => s + (e.overallScore ?? 0), 0) / evals.length;
          const avgSecurity =
            evals.reduce((s: number, e: any) => s + (e.securityScore ?? 100), 0) / evals.length;
          const anomalyCount = evals.filter((e: any) => e.anomalyDetected).length;
          metrics.evalQualityScore = Math.round(avgQuality * 10) / 10;
          metrics.evalSecurityScore = Math.round(avgSecurity * 10) / 10;
          metrics.evalAnomalyCount = anomalyCount;
          this.logger.log(
            `Canary gate enriched with Evaluator: quality=${metrics.evalQualityScore}, ` +
              `security=${metrics.evalSecurityScore}, anomalies=${metrics.evalAnomalyCount}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Failed to enrich canary metrics with Evaluator: ${(err as Error).message}`,
        );
      }
    }

    // Get gate rules (from first gate or latest)
    const gates = await db.canaryGate.findMany({
      where: { deploymentId },
      orderBy: { windowNumber: 'desc' },
      take: 1,
    });
    const rules = (gates[0]?.rulesJson as unknown as CanaryGateRule[]) ?? DEFAULT_CANARY_GATE_RULES;

    // Evaluate
    const evaluation = evaluateGateRules(rules, metrics);

    // Record gate result
    const gate = await db.canaryGate.create({
      data: {
        deploymentId,
        windowNumber,
        rulesJson: rules,
        result: evaluation.result,
        metricsJson: metrics,
        successRate: metrics.successRate,
        errorRate: metrics.errorRate,
        policyViolationCount: metrics.policyViolationCount,
        avgLatencyMs: metrics.avgLatencyMs,
        p99LatencyMs: metrics.p99LatencyMs,
        avgCostUsd: metrics.totalCostUsd,
        retryCount: metrics.retryCount,
        invalidOutputCount: metrics.invalidOutputCount,
        evaluatedAt: new Date(),
        evaluatedById: ctx.userId,
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
    await db.canaryMetricSnapshot.create({
      data: {
        deploymentId,
        windowNumber,
        stableMetricsJson: {}, // populated by worker from stable traffic
        candidateMetricsJson: metrics,
        candidateSuccessRate: metrics.successRate,
        candidateAvgLatencyMs: metrics.avgLatencyMs,
        totalCandidateExecs: metrics.totalExecutions,
      },
    });

    await this.writeAudit(ctx, 'CANARY_GATE_EVALUATE', 'CanaryGate', gate.id, {
      deploymentId,
      windowNumber,
      result: evaluation.result,
      metrics,
    });

    // Decision: FAIL → rollback, PASS → advance or promote, WARN → continue
    if (evaluation.result === 'FAIL') {
      if (deployment.autoRollbackEnabled) {
        this.logger.warn(
          `Canary ${deploymentId} gate FAILED at window ${windowNumber} — auto-rollback`,
        );
        return this.rollback(ctx, deploymentId, gate.reason ?? 'Gate evaluation failed');
      }
      // Pause if no auto-rollback
      await db.canaryDeployment.update({
        where: { id: deploymentId },
        data: { status: 'PAUSED' },
      });
      return { gate, action: 'PAUSED', reason: 'Gate failed, manual decision required' };
    }

    if (evaluation.result === 'PASS') {
      const nextTraffic = Math.min(
        deployment.currentTrafficPct + deployment.incrementStepPct,
        deployment.maxTrafficPct,
      );

      if (nextTraffic >= deployment.maxTrafficPct) {
        // Full rollout — auto-promote
        this.logger.log(`Canary ${deploymentId} reached max traffic — promoting`);
        return this.promote(ctx, deploymentId, 'All canary gates passed at max traffic');
      }

      // Advance traffic
      await db.canaryDeployment.update({
        where: { id: deploymentId },
        data: {
          currentTrafficPct: nextTraffic,
          currentWindow: windowNumber + 1,
        },
      });

      // Schedule next evaluation
      await this.canaryQueue.add(
        'canary-evaluate',
        {
          deploymentId,
          windowNumber: windowNumber + 1,
          tenantId: ctx.tenantId,
        },
        {
          jobId: `canary-eval-${deploymentId}-w${windowNumber + 1}`,
          delay: deployment.windowDurationMs,
          attempts: 1,
        },
      );

      return { gate, action: 'ADVANCED', nextTrafficPct: nextTraffic };
    }

    // WARN — continue at same traffic, re-evaluate
    await this.canaryQueue.add(
      'canary-evaluate',
      {
        deploymentId,
        windowNumber: windowNumber + 1,
        tenantId: ctx.tenantId,
      },
      {
        jobId: `canary-eval-${deploymentId}-w${windowNumber + 1}`,
        delay: deployment.windowDurationMs,
        attempts: 1,
      },
    );

    return { gate, action: 'CONTINUED_WITH_WARNINGS' };
  }

  // ═══════════════════════════════════════════
  //  Promote
  // ═══════════════════════════════════════════

  async promote(ctx: TenantContext, deploymentId: string, reason?: string) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Atomic state transition: only update if still in ACTIVE or PAUSED state
    const updated = await db.canaryDeployment.updateMany({
      where: {
        id: deploymentId,
        tenantId: ctx.tenantId,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      data: {
        status: 'PROMOTED',
        currentTrafficPct: 100,
        completedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      // Check if deployment exists at all or was already transitioned
      const existing = await db.canaryDeployment.findFirst({ where: { id: deploymentId } });
      if (!existing) throw new NotFoundException(`Canary ${deploymentId} not found`);
      throw new BadRequestException(
        `Cannot promote canary in "${existing.status}" state (may have been concurrently modified).`,
      );
    }

    // Re-fetch for downstream data
    const deployment = await db.canaryDeployment.findFirst({ where: { id: deploymentId } });
    if (!deployment) throw new NotFoundException(`Canary ${deploymentId} not found after promote`);

    // Create promotion record
    await db.versionPromotion.create({
      data: {
        tenantId: ctx.tenantId,
        packId: deployment.packId,
        fromVersionId: deployment.stableVersionId,
        toVersionId: deployment.candidateVersionId,
        action: 'PROMOTE',
        reason: reason ?? 'Canary deployment succeeded',
        sourceType: 'CANARY',
        sourceId: deploymentId,
        decidedById: ctx.userId,
      },
    });

    await this.writeAudit(ctx, 'CANARY_PROMOTE', 'CanaryDeployment', deploymentId, {
      packId: deployment.packId,
      candidateVersionId: deployment.candidateVersionId,
      reason,
    });

    this.logger.log(`Canary ${deploymentId} PROMOTED — candidate is now stable`);

    return { deploymentId, action: 'PROMOTED', candidateVersionId: deployment.candidateVersionId };
  }

  // ═══════════════════════════════════════════
  //  Rollback
  // ═══════════════════════════════════════════

  async rollback(ctx: TenantContext, deploymentId: string, reason?: string) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Atomic state transition: only update if still in ACTIVE or PAUSED state
    const updated = await db.canaryDeployment.updateMany({
      where: {
        id: deploymentId,
        tenantId: ctx.tenantId,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      data: {
        status: 'ROLLED_BACK',
        currentTrafficPct: 0,
        completedAt: new Date(),
        rollbackReason: reason ?? 'Manual rollback',
      },
    });

    if (updated.count === 0) {
      const existing = await db.canaryDeployment.findFirst({ where: { id: deploymentId } });
      if (!existing) throw new NotFoundException(`Canary ${deploymentId} not found`);
      throw new BadRequestException(
        `Cannot rollback canary in "${existing.status}" state (may have been concurrently modified).`,
      );
    }

    // Re-fetch for downstream data
    const deployment = await db.canaryDeployment.findFirst({ where: { id: deploymentId } });
    if (!deployment) throw new NotFoundException(`Canary ${deploymentId} not found after rollback`);

    // Create rollback record
    await db.versionPromotion.create({
      data: {
        tenantId: ctx.tenantId,
        packId: deployment.packId,
        fromVersionId: deployment.candidateVersionId,
        toVersionId: deployment.stableVersionId,
        action: 'ROLLBACK',
        reason: reason ?? 'Canary rollback',
        sourceType: 'CANARY',
        sourceId: deploymentId,
        decidedById: ctx.userId,
        rollbackFromVersionId: deployment.candidateVersionId,
      },
    });

    await this.writeAudit(ctx, 'CANARY_ROLLBACK', 'CanaryDeployment', deploymentId, {
      packId: deployment.packId,
      candidateVersionId: deployment.candidateVersionId,
      reason,
    });

    this.logger.warn(`Canary ${deploymentId} ROLLED BACK — reverting to stable version`);

    return { deploymentId, action: 'ROLLED_BACK', stableVersionId: deployment.stableVersionId };
  }

  // ═══════════════════════════════════════════
  //  Read Operations
  // ═══════════════════════════════════════════

  async list(
    ctx: TenantContext,
    filters: { status?: string; packId?: string; page?: number; pageSize?: number },
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const ps = Math.min(filters.pageSize ?? 20, 100);
    const page = Math.max(filters.page ?? 1, 1);
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.packId) where.packId = filters.packId;

    const [items, total] = await Promise.all([
      db.canaryDeployment.findMany({
        where,
        include: {
          gates: { orderBy: { windowNumber: 'desc' }, take: 3 },
          _count: { select: { gates: true, metrics: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * ps,
        take: ps,
      }),
      db.canaryDeployment.count({ where }),
    ]);

    return { items, total, page, pageSize: ps, hasMore: page * ps < total };
  }

  async getById(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const deployment = await db.canaryDeployment.findFirst({
      where: { id },
      include: {
        gates: { orderBy: { windowNumber: 'asc' } },
        metrics: { orderBy: { windowNumber: 'asc' } },
      },
    });
    if (!deployment) throw new NotFoundException(`Canary ${id} not found`);
    return deployment;
  }

  /**
   * Determine if an execution should be routed to canary candidate.
   * Called from ExecutionService to implement traffic splitting.
   */
  async shouldRouteToCandidate(
    ctx: TenantContext,
    packId: string,
    workflowKey?: string,
    capabilityKey?: string,
  ): Promise<{ shouldRoute: boolean; deployment?: any }> {
    const db = withTenantIsolation(this.prisma, ctx);

    const deployment = await db.canaryDeployment.findFirst({
      where: { packId, status: 'ACTIVE' },
    });

    if (!deployment) return { shouldRoute: false };

    // Check filters
    const wfFilter = deployment.workflowFilter as string[];
    const capFilter = deployment.capabilityFilter as string[];
    if (wfFilter.length > 0 && workflowKey && !wfFilter.includes(workflowKey))
      return { shouldRoute: false };
    if (capFilter.length > 0 && capabilityKey && !capFilter.includes(capabilityKey))
      return { shouldRoute: false };

    // Traffic split decision
    const roll = Math.random() * 100;
    if (roll < deployment.currentTrafficPct) {
      return { shouldRoute: true, deployment };
    }

    return { shouldRoute: false, deployment };
  }

  // ── Aggregated Stats ──

  async getStats(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);

    const deployments = await db.canaryDeployment.findMany({
      include: { gates: true, metrics: true },
    });

    const totalDeployments = deployments.length;
    const statusCounts = {
      PENDING: deployments.filter((d: any) => d.status === 'PENDING').length,
      ACTIVE: deployments.filter((d: any) => d.status === 'ACTIVE').length,
      PAUSED: deployments.filter((d: any) => d.status === 'PAUSED').length,
      PROMOTED: deployments.filter((d: any) => d.status === 'PROMOTED').length,
      ROLLED_BACK: deployments.filter((d: any) => d.status === 'ROLLED_BACK').length,
      FAILED: deployments.filter((d: any) => d.status === 'FAILED').length,
    };

    // Aggregate gate results
    const allGates = deployments.flatMap((d: any) => d.gates ?? []);
    const gateResultCounts = {
      PASS: allGates.filter((g: any) => g.result === 'PASS').length,
      FAIL: allGates.filter((g: any) => g.result === 'FAIL').length,
      WARN: allGates.filter((g: any) => g.result === 'WARN').length,
      PENDING: allGates.filter((g: any) => g.result === 'PENDING').length,
    };

    // Traffic distribution
    const totalTrafficPct = deployments.reduce(
      (sum: number, d: any) => sum + (d.currentTrafficPct ?? 0),
      0,
    );
    const avgTrafficPct =
      deployments.length > 0 ? Math.round(totalTrafficPct / deployments.length) : 0;

    // Average latency delta across all metric snapshots
    const allMetrics = deployments.flatMap((d: any) => d.metrics ?? []);
    const latencyDeltas = allMetrics
      .filter((m: any) => m.stableAvgLatencyMs != null && m.candidateAvgLatencyMs != null)
      .map((m: any) => (m.candidateAvgLatencyMs ?? 0) - (m.stableAvgLatencyMs ?? 0));
    const avgLatencyDeltaMs =
      latencyDeltas.length > 0
        ? Math.round(
            latencyDeltas.reduce((a: number, b: number) => a + b, 0) / latencyDeltas.length,
          )
        : 0;

    return {
      totalDeployments,
      statusDistribution: statusCounts,
      gateResultDistribution: gateResultCounts,
      avgTrafficPct,
      avgLatencyDeltaMs,
      totalWindows: allGates.length,
      failureCount: gateResultCounts.FAIL,
    };
  }

  // ── Audit Helper ──

  private async writeAudit(
    ctx: TenantContext,
    action: string,
    targetType: string,
    targetId: string,
    metadata: any,
  ) {
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: action as any,
          targetType,
          targetId,
          correlationId: `release-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          metadataJson: metadata,
        },
      })
      .catch((e: any) => {
        this.logger.warn(`Audit write failed for ${action}: ${e.message}`);
      });
  }
}

export { CANARY_QUEUE_TOKEN };
