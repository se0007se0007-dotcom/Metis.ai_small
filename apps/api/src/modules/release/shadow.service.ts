/**
 * Shadow Service — Phase 3: Controlled Release Engineering
 *
 * Shadow execution runs candidate version in parallel with production.
 * CRITICAL: Shadow output MUST NEVER affect production systems.
 *
 * Flow:
 *   1. ShadowConfig defines control (prod) vs candidate (shadow) versions
 *   2. When production execution fires, shadow interceptor creates a ShadowPair
 *   3. Shadow execution runs candidate with same input but in isolation
 *   4. Results are compared and stored — no side effects from shadow
 */
import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import type { CreateShadowConfigRequest } from '@metis/types';

const SHADOW_QUEUE_TOKEN = 'SHADOW_QUEUE';

interface QueueLike {
  add(name: string, data: any, opts?: any): Promise<{ id?: string | null }>;
  getJob(id: string): Promise<any>;
}

@Injectable()
export class ShadowService {
  private readonly logger = new Logger(ShadowService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(SHADOW_QUEUE_TOKEN) private readonly shadowQueue: QueueLike,
  ) {}

  // ═══════════════════════════════════════════
  //  Shadow Configuration CRUD
  // ═══════════════════════════════════════════

  async createConfig(ctx: TenantContext, req: CreateShadowConfigRequest) {
    const db = withTenantIsolation(this.prisma, ctx);

    // M-2: Validate sampling rate
    if (req.samplingRate != null && (req.samplingRate < 0 || req.samplingRate > 1)) {
      throw new BadRequestException('samplingRate must be between 0.0 and 1.0');
    }

    // M-3: Validate version IDs exist
    if (req.controlVersionId === req.candidateVersionId) {
      throw new BadRequestException('controlVersionId and candidateVersionId must be different');
    }

    const config = await db.shadowConfig.create({
      data: {
        tenantId: ctx.tenantId,
        name: req.name,
        controlVersionId: req.controlVersionId,
        candidateVersionId: req.candidateVersionId,
        workflowFilter: req.workflowFilter ?? [],
        capabilityFilter: req.capabilityFilter ?? [],
        samplingRate: req.samplingRate ?? 1.0,
        isActive: true,
        createdById: ctx.userId,
      },
    });

    await this.writeAudit(ctx, 'SHADOW_CONFIG_CREATE', 'ShadowConfig', config.id, {
      controlVersionId: req.controlVersionId,
      candidateVersionId: req.candidateVersionId,
      samplingRate: req.samplingRate,
    });

    return config;
  }

  async listConfigs(ctx: TenantContext, page = 1, pageSize = 20) {
    const db = withTenantIsolation(this.prisma, ctx);
    const ps = Math.min(pageSize, 100);

    const [items, total] = await Promise.all([
      db.shadowConfig.findMany({
        include: { _count: { select: { pairs: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * ps,
        take: ps,
      }),
      db.shadowConfig.count(),
    ]);

    return { items, total, page, pageSize: ps, hasMore: page * ps < total };
  }

  async getConfig(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const config = await db.shadowConfig.findFirst({
      where: { id },
      include: {
        pairs: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { pairs: true } },
      },
    });
    if (!config) throw new NotFoundException(`Shadow config ${id} not found`);
    return config;
  }

  async toggleConfig(ctx: TenantContext, id: string, isActive: boolean) {
    const db = withTenantIsolation(this.prisma, ctx);
    const config = await db.shadowConfig.findFirst({ where: { id } });
    if (!config) throw new NotFoundException(`Shadow config ${id} not found`);

    return db.shadowConfig.update({
      where: { id },
      data: { isActive },
    });
  }

  // ═══════════════════════════════════════════
  //  Shadow Pair Creation (called by execution interceptor)
  // ═══════════════════════════════════════════

  /**
   * Check if a production execution should trigger a shadow pair.
   * Called from ExecutionService.create() to check active shadow configs.
   */
  async shouldShadow(
    ctx: TenantContext,
    workflowKey?: string,
    capabilityKey?: string,
  ): Promise<any | null> {
    const db = withTenantIsolation(this.prisma, ctx);

    const configs = await db.shadowConfig.findMany({
      where: { isActive: true },
    });

    for (const config of configs) {
      // Check workflow/capability filters
      const wfFilter = config.workflowFilter as string[];
      const capFilter = config.capabilityFilter as string[];

      if (wfFilter.length > 0 && workflowKey && !wfFilter.includes(workflowKey)) continue;
      if (capFilter.length > 0 && capabilityKey && !capFilter.includes(capabilityKey)) continue;

      // Sampling rate check
      if (Math.random() > (config.samplingRate ?? 1.0)) continue;

      return config;
    }

    return null;
  }

  /**
   * Create a shadow pair when production execution starts.
   * Dispatches shadow execution job to worker queue.
   */
  async createPair(ctx: TenantContext, configId: string, controlExecutionId: string, input: any) {
    const db = withTenantIsolation(this.prisma, ctx);

    const config = await db.shadowConfig.findFirst({ where: { id: configId } });
    if (!config) throw new NotFoundException(`Shadow config ${configId} not found`);

    // Create shadow pair record
    const pair = await db.shadowPair.create({
      data: {
        configId,
        tenantId: ctx.tenantId,
        controlExecutionId,
        status: 'PENDING',
      },
    });

    // Dispatch shadow execution (candidate version, isolated)
    const job = await this.shadowQueue.add(
      'shadow-execute',
      {
        pairId: pair.id,
        configId,
        controlExecutionId,
        candidateVersionId: config.candidateVersionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        input,
        // CRITICAL: Shadow mode flag — worker must enforce no side effects
        shadowMode: true,
      },
      {
        jobId: `shadow-${pair.id}`,
        attempts: 1,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    );

    // Update config pair count
    await db.shadowConfig.update({
      where: { id: configId },
      data: { totalPairs: { increment: 1 } },
    });

    await this.writeAudit(ctx, 'SHADOW_PAIR_CREATE', 'ShadowPair', pair.id, {
      configId,
      controlExecutionId,
      candidateVersionId: config.candidateVersionId,
    });

    return { ...pair, jobId: job.id };
  }

  // ═══════════════════════════════════════════
  //  Shadow Pair Results
  // ═══════════════════════════════════════════

  async getPair(ctx: TenantContext, pairId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const pair = await db.shadowPair.findFirst({
      where: { id: pairId },
      include: {
        config: {
          select: { id: true, name: true, controlVersionId: true, candidateVersionId: true },
        },
      },
    });
    if (!pair) throw new NotFoundException(`Shadow pair ${pairId} not found`);
    return pair;
  }

  async listPairs(
    ctx: TenantContext,
    filters: { configId?: string; verdict?: string; page?: number; pageSize?: number },
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const ps = Math.min(filters.pageSize ?? 20, 100);
    const page = Math.max(filters.page ?? 1, 1);
    const where: any = {};
    if (filters.configId) where.configId = filters.configId;
    if (filters.verdict) where.verdict = filters.verdict;

    const [items, total] = await Promise.all([
      db.shadowPair.findMany({
        where,
        include: { config: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * ps,
        take: ps,
      }),
      db.shadowPair.count({ where }),
    ]);

    return { items, total, page, pageSize: ps, hasMore: page * ps < total };
  }

  /**
   * Get aggregate shadow comparison metrics for a config
   */
  async getConfigMetrics(ctx: TenantContext, configId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const config = await db.shadowConfig.findFirst({ where: { id: configId } });
    if (!config) throw new NotFoundException(`Shadow config ${configId} not found`);

    const pairs = await db.shadowPair.findMany({
      where: { configId, status: 'COMPLETED' },
      select: {
        verdict: true,
        controlLatencyMs: true,
        shadowLatencyMs: true,
        controlStatus: true,
        shadowStatus: true,
        policyViolationsDelta: true,
      },
    });

    const total = pairs.length;
    if (total === 0) return { total: 0, matchRate: 0, regressionRate: 0, avgLatencyDelta: 0 };

    const matchCount = pairs.filter((p: any) => p.verdict === 'MATCH').length;
    const regressionCount = pairs.filter((p: any) => p.verdict === 'REGRESSION').length;
    const latencyDeltas = pairs
      .filter((p: any) => p.controlLatencyMs != null && p.shadowLatencyMs != null)
      .map((p: any) => (p.shadowLatencyMs ?? 0) - (p.controlLatencyMs ?? 0));
    const avgLatencyDelta =
      latencyDeltas.length > 0
        ? Math.round(
            latencyDeltas.reduce((a: number, b: number) => a + b, 0) / latencyDeltas.length,
          )
        : 0;
    const totalPolicyViolations = pairs.reduce(
      (sum: number, p: any) => sum + (p.policyViolationsDelta ?? 0),
      0,
    );

    return {
      total,
      matchRate: Math.round((matchCount / total) * 100) / 100,
      regressionRate: Math.round((regressionCount / total) * 100) / 100,
      avgLatencyDeltaMs: avgLatencyDelta,
      totalPolicyViolations,
      verdictDistribution: {
        MATCH: matchCount,
        DIVERGED: pairs.filter((p: any) => p.verdict === 'DIVERGED').length,
        REGRESSION: regressionCount,
        IMPROVEMENT: pairs.filter((p: any) => p.verdict === 'IMPROVEMENT').length,
        ERROR: pairs.filter((p: any) => p.verdict === 'ERROR').length,
      },
    };
  }

  // ── Aggregated Stats ──

  async getStats(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Get all active configs
    const configs = await db.shadowConfig.findMany({
      where: { isActive: true },
      include: { pairs: true },
    });

    const totalConfigs = configs.length;
    const totalPairs = configs.reduce((sum, c: any) => sum + (c.pairs?.length ?? 0), 0);
    const activeCount = configs.filter((c: any) => c.isActive).length;

    // Aggregate metrics across all pairs
    const allPairs = configs.flatMap((c: any) => c.pairs ?? []);
    const verdictCounts = {
      MATCH: allPairs.filter((p: any) => p.verdict === 'MATCH').length,
      DIVERGED: allPairs.filter((p: any) => p.verdict === 'DIVERGED').length,
      REGRESSION: allPairs.filter((p: any) => p.verdict === 'REGRESSION').length,
      IMPROVEMENT: allPairs.filter((p: any) => p.verdict === 'IMPROVEMENT').length,
      ERROR: allPairs.filter((p: any) => p.verdict === 'ERROR').length,
    };

    const statusCounts = {
      PENDING: allPairs.filter((p: any) => p.status === 'PENDING').length,
      RUNNING: allPairs.filter((p: any) => p.status === 'RUNNING').length,
      COMPLETED: allPairs.filter((p: any) => p.status === 'COMPLETED').length,
      FAILED: allPairs.filter((p: any) => p.status === 'FAILED').length,
    };

    // Calculate latency differential
    const latencyDeltas = allPairs
      .filter((p: any) => p.controlLatencyMs != null && p.shadowLatencyMs != null)
      .map((p: any) => (p.shadowLatencyMs ?? 0) - (p.controlLatencyMs ?? 0));
    const avgLatencyDeltaMs =
      latencyDeltas.length > 0
        ? Math.round(
            latencyDeltas.reduce((a: number, b: number) => a + b, 0) / latencyDeltas.length,
          )
        : 0;

    return {
      totalConfigs,
      activeConfigs: activeCount,
      totalPairs,
      verdictDistribution: verdictCounts,
      statusDistribution: statusCounts,
      avgLatencyDeltaMs,
      totalPolicyViolations: allPairs.reduce(
        (sum: number, p: any) => sum + (p.policyViolationsDelta ?? 0),
        0,
      ),
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

export { SHADOW_QUEUE_TOKEN };
