/**
 * Replay Service — Phase 3: Controlled Release Engineering
 *
 * Responsibilities:
 *   - Create replay datasets from historical executions
 *   - Manage golden task sets (curated benchmarks)
 *   - Start replay runs against candidate versions
 *   - Retrieve replay run results with comparison metrics
 *
 * Tenant isolation: ALL queries go through withTenantIsolation.
 * Policy enforcement: Replay executions are policy-checked via ExecutionService.
 * Audit: All mutating operations create AuditLog entries.
 */
import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import type {
  CreateReplayDatasetRequest,
  MarkGoldenRequest,
  StartReplayRunRequest,
  ComparisonMetrics,
  EMPTY_COMPARISON_METRICS,
} from '@metis/types';

const REPLAY_QUEUE_TOKEN = 'REPLAY_QUEUE';

interface QueueLike {
  add(name: string, data: any, opts?: any): Promise<{ id?: string | null }>;
  getJob(id: string): Promise<any>;
}

@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(REPLAY_QUEUE_TOKEN) private readonly replayQueue: QueueLike,
  ) {}

  // ═══════════════════════════════════════════
  //  Create Replay Dataset from Historical Executions
  // ═══════════════════════════════════════════

  async createDataset(ctx: TenantContext, req: CreateReplayDatasetRequest) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Build filter for historical executions
    const where: any = { status: 'SUCCEEDED' };
    if (req.filter?.workflowKey) where.workflowKey = req.filter.workflowKey;
    if (req.filter?.capabilityKey) where.capabilityKey = req.filter.capabilityKey;
    if (req.filter?.status) where.status = req.filter.status;
    if (req.filter?.dateFrom || req.filter?.dateTo) {
      where.createdAt = {};
      if (req.filter.dateFrom) where.createdAt.gte = new Date(req.filter.dateFrom);
      if (req.filter.dateTo) where.createdAt.lte = new Date(req.filter.dateTo);
    }
    if (req.filter?.packVersionId) {
      where.packInstallation = { packVersionId: req.filter.packVersionId };
    }

    // Fetch historical executions
    const limit = req.filter?.limit ?? 100;
    const executions = await db.executionSession.findMany({
      where,
      include: {
        steps: { orderBy: { startedAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });

    if (executions.length === 0) {
      throw new BadRequestException('No matching executions found for the given filter criteria.');
    }

    // Create dataset
    const dataset = await db.replayDataset.create({
      data: {
        tenantId: ctx.tenantId,
        name: req.name,
        description: req.description,
        baselineVersionId: req.baselineVersionId,
        filterJson: req.filter ?? {},
        caseCount: executions.length,
        createdById: ctx.userId,
      },
    });

    // Create replay cases from each execution
    const casesData = executions.map((exec: any) => ({
      datasetId: dataset.id,
      sourceExecutionId: exec.id,
      workflowKey: exec.workflowKey,
      capabilityKey: exec.capabilityKey,
      packVersionId: req.baselineVersionId ?? null,
      inputJson: exec.inputJson ?? {},
      expectedOutputJson: exec.outputJson ?? {},
      expectedStatus: exec.status,
      expectedLatencyMs: exec.latencyMs,
      isGolden: false,
      riskLevel: null,
      tags: [],
    }));

    await db.replayCase.createMany({ data: casesData });

    // Audit
    await this.writeAudit(ctx, 'REPLAY_DATASET_CREATE', 'ReplayDataset', dataset.id, {
      name: req.name,
      caseCount: executions.length,
      filter: req.filter,
    });

    this.logger.log(`Replay dataset "${req.name}" created: ${executions.length} cases`);

    return {
      ...dataset,
      caseCount: executions.length,
    };
  }

  // ═══════════════════════════════════════════
  //  List Datasets
  // ═══════════════════════════════════════════

  async listDatasets(ctx: TenantContext, page = 1, pageSize = 20) {
    const db = withTenantIsolation(this.prisma, ctx);
    const ps = Math.min(pageSize, 100);

    const [items, total] = await Promise.all([
      db.replayDataset.findMany({
        include: { _count: { select: { cases: true, runs: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * ps,
        take: ps,
      }),
      db.replayDataset.count(),
    ]);

    return { items, total, page, pageSize: ps, hasMore: page * ps < total };
  }

  // ═══════════════════════════════════════════
  //  Get Dataset Detail with Cases
  // ═══════════════════════════════════════════

  async getDataset(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const dataset = await db.replayDataset.findFirst({
      where: { id },
      include: {
        cases: { orderBy: { createdAt: 'asc' } },
        runs: { orderBy: { createdAt: 'desc' }, take: 10 },
        _count: { select: { cases: true, runs: true } },
      },
    });
    if (!dataset) throw new NotFoundException(`Replay dataset ${id} not found`);
    return dataset;
  }

  // ═══════════════════════════════════════════
  //  Golden Task Management
  // ═══════════════════════════════════════════

  async markGolden(ctx: TenantContext, datasetId: string, req: MarkGoldenRequest) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Verify dataset belongs to tenant
    const dataset = await db.replayDataset.findFirst({ where: { id: datasetId } });
    if (!dataset) throw new NotFoundException(`Replay dataset ${datasetId} not found`);

    // Update cases
    for (const caseId of req.caseIds) {
      await db.replayCase.updateMany({
        where: { id: caseId, datasetId },
        data: {
          isGolden: req.isGolden,
          ...(req.riskLevel !== undefined ? { riskLevel: req.riskLevel } : {}),
          ...(req.tags !== undefined ? { tags: req.tags } : {}),
        },
      });
    }

    return { updated: req.caseIds.length };
  }

  async listGoldenCases(ctx: TenantContext, datasetId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const dataset = await db.replayDataset.findFirst({ where: { id: datasetId } });
    if (!dataset) throw new NotFoundException(`Replay dataset ${datasetId} not found`);

    return db.replayCase.findMany({
      where: { datasetId, isGolden: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ═══════════════════════════════════════════
  //  Start Replay Run
  // ═══════════════════════════════════════════

  async startRun(ctx: TenantContext, req: StartReplayRunRequest) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Verify dataset exists
    const dataset = await db.replayDataset.findFirst({
      where: { id: req.datasetId },
      include: { _count: { select: { cases: true } } },
    });
    if (!dataset) throw new NotFoundException(`Replay dataset ${req.datasetId} not found`);
    if (dataset._count.cases === 0) {
      throw new BadRequestException('Dataset has no cases to replay.');
    }

    // Create replay run
    const run = await db.replayRun.create({
      data: {
        tenantId: ctx.tenantId,
        datasetId: req.datasetId,
        candidateVersionId: req.candidateVersionId,
        baselineVersionId: req.baselineVersionId ?? dataset.baselineVersionId,
        totalCases: dataset._count.cases,
        status: 'PENDING',
        triggeredById: ctx.userId,
      },
    });

    // Dispatch to BullMQ for async execution
    const job = await this.replayQueue.add(
      'replay-run',
      {
        runId: run.id,
        datasetId: req.datasetId,
        candidateVersionId: req.candidateVersionId,
        baselineVersionId: req.baselineVersionId ?? dataset.baselineVersionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      },
      {
        jobId: `replay-${run.id}`,
        attempts: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    );

    // Audit
    await this.writeAudit(ctx, 'REPLAY_RUN_START', 'ReplayRun', run.id, {
      datasetId: req.datasetId,
      candidateVersionId: req.candidateVersionId,
      totalCases: dataset._count.cases,
    });

    this.logger.log(
      `Replay run ${run.id} started: ${dataset._count.cases} cases against version ${req.candidateVersionId}`,
    );

    return { ...run, jobId: job.id };
  }

  // ═══════════════════════════════════════════
  //  Get Replay Run Results
  // ═══════════════════════════════════════════

  async getRun(ctx: TenantContext, runId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const run = await db.replayRun.findFirst({
      where: { id: runId },
      include: {
        caseResults: {
          include: {
            replayCase: {
              select: {
                id: true,
                workflowKey: true,
                capabilityKey: true,
                isGolden: true,
                riskLevel: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        dataset: { select: { id: true, name: true, caseCount: true } },
      },
    });
    if (!run) throw new NotFoundException(`Replay run ${runId} not found`);
    return run;
  }

  async listRuns(
    ctx: TenantContext,
    filters: { datasetId?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const ps = Math.min(filters.pageSize ?? 20, 100);
    const page = Math.max(filters.page ?? 1, 1);
    const where: any = {};
    if (filters.datasetId) where.datasetId = filters.datasetId;
    if (filters.status) where.status = filters.status;

    const [items, total] = await Promise.all([
      db.replayRun.findMany({
        where,
        include: { dataset: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * ps,
        take: ps,
      }),
      db.replayRun.count({ where }),
    ]);

    return { items, total, page, pageSize: ps, hasMore: page * ps < total };
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

export { REPLAY_QUEUE_TOKEN };
