/**
 * Execution Service — Phase 2: Capability Runtime
 *
 * Responsibilities:
 *   - Create execution sessions with policy pre-check
 *   - Dispatch to BullMQ execution queue
 *   - List/Get with pagination and tenant isolation
 *   - Kill switch (cancel running execution)
 *   - Trace retrieval
 *   - Capability boundary enforcement
 */
import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { PolicyService } from '../governance/policy.service';

const EXECUTION_QUEUE_TOKEN = 'EXECUTION_QUEUE';

interface QueueLike {
  add(name: string, data: any, opts?: any): Promise<{ id?: string | null }>;
  getJob(id: string): Promise<any>;
}

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(EXECUTION_QUEUE_TOKEN) private readonly executionQueue: QueueLike,
    private readonly policyService: PolicyService,
  ) {}

  // ═══════════════════════════════════════════
  //  Create Execution (with policy enforcement)
  // ═══════════════════════════════════════════

  async create(
    ctx: TenantContext,
    data: {
      packInstallationId?: string;
      workflowKey?: string;
      capabilityKey?: string;
      input?: any;
    },
  ) {
    // 1. Validate pack installation if provided
    let installation: any = null;
    if (data.packInstallationId) {
      const db = withTenantIsolation(this.prisma, ctx);
      installation = await db.packInstallation.findUnique({
        where: { id: data.packInstallationId },
        include: {
          packVersion: {
            select: { id: true, version: true, status: true, manifestJson: true },
          },
          pack: { select: { id: true, key: true, name: true } },
        },
      });

      if (!installation) {
        throw new NotFoundException('Pack installation not found');
      }

      // 2. Capability boundary enforcement (from manifest)
      const manifest = installation.packVersion.manifestJson as Record<string, any>;
      if (data.capabilityKey && manifest?.capabilities?.length > 0) {
        const allowed = manifest.capabilities as string[];
        if (!allowed.includes(data.capabilityKey)) {
          throw new ForbiddenException(
            `Capability "${data.capabilityKey}" is not declared by pack "${installation.pack.name}". ` +
              `Allowed: ${allowed.join(', ')}`,
          );
        }
      }

      if (data.workflowKey && manifest?.workflows?.length > 0) {
        const allowed = manifest.workflows as string[];
        if (!allowed.includes(data.workflowKey)) {
          throw new ForbiddenException(
            `Workflow "${data.workflowKey}" is not declared by pack "${installation.pack.name}". ` +
              `Allowed: ${allowed.join(', ')}`,
          );
        }
      }

      // 3. Runtime constraints from manifest
      if (manifest?.runtime?.maxConcurrency) {
        const runningCount = await this.prisma.executionSession.count({
          where: {
            tenantId: ctx.tenantId,
            packInstallationId: data.packInstallationId,
            status: 'RUNNING',
          },
        });
        if (runningCount >= manifest.runtime.maxConcurrency) {
          throw new BadRequestException(
            `Max concurrency (${manifest.runtime.maxConcurrency}) reached for this pack. ` +
              `${runningCount} execution(s) currently running.`,
          );
        }
      }
    }

    // 4. Policy pre-check
    const policyResult = await this.policyService.evaluate(ctx.tenantId, {
      targetType: 'ExecutionSession',
      action: 'EXECUTE',
      metadata: {
        packInstallationId: data.packInstallationId,
        capabilityKey: data.capabilityKey,
        workflowKey: data.workflowKey,
      },
    });

    if (policyResult.result === 'FAIL') {
      throw new ForbiddenException(
        'Execution blocked by policy: ' +
          policyResult.evaluations
            .filter((e) => e.result === 'FAIL')
            .map((e) => `[${e.policyKey}] ${e.reason}`)
            .join('; '),
      );
    }

    // 5. Create execution session
    const db = withTenantIsolation(this.prisma, ctx);
    const session = await db.executionSession.create({
      data: {
        tenantId: ctx.tenantId,
        packInstallationId: data.packInstallationId,
        workflowKey: data.workflowKey,
        capabilityKey: data.capabilityKey,
        inputJson: data.input ?? {},
        triggeredById: ctx.userId,
        status: 'QUEUED',
      },
    });

    // 6. Dispatch to BullMQ
    const manifest = installation?.packVersion?.manifestJson as Record<string, any> | undefined;
    const timeoutMs = manifest?.runtime?.timeoutMs ?? 300_000; // default 5min

    const job = await this.executionQueue.add(
      'execute',
      {
        executionSessionId: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        packInstallationId: data.packInstallationId,
        capabilityKey: data.capabilityKey,
        workflowKey: data.workflowKey,
        input: data.input,
        timeoutMs,
      },
      {
        jobId: `exec-${session.id}`,
        attempts: 1, // no auto-retry for executions
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    );

    this.logger.log(
      `Execution ${session.id} queued (job: ${job.id}), policy: ${policyResult.result}`,
    );

    return {
      ...session,
      jobId: job.id,
      policyResult: policyResult.result,
      policyWarnings: policyResult.evaluations
        .filter((e) => e.result === 'WARN')
        .map((e) => `[${e.policyKey}] ${e.reason}`),
    };
  }

  // ═══════════════════════════════════════════
  //  List Executions (paginated)
  // ═══════════════════════════════════════════

  async list(
    ctx: TenantContext,
    filters: {
      status?: string;
      packInstallationId?: string;
      page?: number;
      pageSize?: number;
      /** 최근 N일만 — 대시보드 기간 버튼과 일치(생략 시 전체). */
      days?: number;
    },
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const pageSize = Math.min(filters.pageSize ?? 20, 100);
    const page = Math.max(filters.page ?? 1, 1);

    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.packInstallationId) where.packInstallationId = filters.packInstallationId;
    if (filters.days && Number.isFinite(filters.days) && filters.days > 0) {
      where.createdAt = { gte: new Date(Date.now() - filters.days * 86400000) };
    }

    const [items, total] = await Promise.all([
      db.executionSession.findMany({
        where,
        include: {
          steps: {
            select: { id: true, stepKey: true, stepType: true, status: true },
            orderBy: { startedAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.executionSession.count({ where }),
    ]);

    return { items, total, page, pageSize, hasMore: page * pageSize < total };
  }

  // ═══════════════════════════════════════════
  //  Get Execution Detail
  // ═══════════════════════════════════════════

  async getById(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const session = await db.executionSession.findFirst({
      where: { id },
      include: {
        steps: { orderBy: { startedAt: 'asc' } },
        traces: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!session) throw new NotFoundException(`Execution ${id} not found`);
    return session;
  }

  // ═══════════════════════════════════════════
  //  Get Trace
  // ═══════════════════════════════════════════

  async getTrace(ctx: TenantContext, executionId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const session = await db.executionSession.findFirst({ where: { id: executionId } });
    if (!session) throw new NotFoundException(`Execution ${executionId} not found`);

    return db.executionTrace.findMany({
      where: { executionSessionId: executionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ═══════════════════════════════════════════
  //  Kill Switch — Cancel Running Execution
  // ═══════════════════════════════════════════

  async kill(ctx: TenantContext, executionId: string, reason?: string) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Verify execution exists and belongs to tenant
    const session = await db.executionSession.findFirst({
      where: { id: executionId },
    });

    if (!session) throw new NotFoundException(`Execution ${executionId} not found`);

    if (!['QUEUED', 'RUNNING'].includes(session.status)) {
      throw new BadRequestException(
        `Cannot cancel execution in status "${session.status}". Only QUEUED or RUNNING can be cancelled.`,
      );
    }

    // Atomic conditional update — prevents race condition
    // Only updates if status is still QUEUED or RUNNING
    const existingOutput = (session.outputJson as Record<string, unknown>) ?? {};
    const { count } = await db.executionSession.updateMany({
      where: {
        id: executionId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      data: {
        status: 'CANCELLED',
        endedAt: new Date(),
      },
    });

    if (count === 0) {
      // Status changed between read and update — another process handled it
      throw new BadRequestException(
        `Execution ${executionId} status changed concurrently. Refresh and try again.`,
      );
    }

    // Merge cancellation info into outputJson (preserving existing data)
    await db.executionSession.update({
      where: { id: executionId },
      data: {
        outputJson: {
          ...existingOutput,
          cancelledReason: reason ?? 'Manual kill switch activated',
          cancelledAt: new Date().toISOString(),
          cancelledBy: ctx.userId,
        },
      },
    });

    // Try to remove/abort the BullMQ job
    const jobId = `exec-${executionId}`;
    try {
      const job = await this.executionQueue.getJob(jobId);
      if (job) {
        const state = await job.getState?.();
        if (state === 'waiting' || state === 'delayed') {
          await job.remove?.();
        } else if (state === 'active') {
          // For active jobs, set cancellation flag for worker to pick up
          await this.setCancellationFlag(db, executionId);
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to remove BullMQ job ${jobId}: ${err.message}`);
    }

    // Create trace entry for the cancellation
    await db.executionTrace
      .create({
        data: {
          executionSessionId: executionId,
          correlationId: `kill-${Date.now()}`,
          traceJson: {
            event: 'KILL_SWITCH',
            reason: reason ?? 'Manual kill switch',
            cancelledBy: ctx.userId,
            timestamp: new Date().toISOString(),
          },
        },
      })
      .catch((e: any) => {
        this.logger.warn(`Failed to write kill switch trace for ${executionId}: ${e.message}`);
      });

    this.logger.warn(`Execution ${executionId} cancelled by ${ctx.userId}: ${reason ?? 'manual'}`);

    // Re-fetch the updated session to return
    return db.executionSession.findFirst({ where: { id: executionId } });
  }

  // ═══════════════════════════════════════════
  //  Execution Stats (for dashboard)
  // ═══════════════════════════════════════════

  async getStats(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);

    const [total, running, succeeded, failed, cancelled, avgLatency] = await Promise.all([
      db.executionSession.count(),
      db.executionSession.count({ where: { status: 'RUNNING' } }),
      db.executionSession.count({ where: { status: 'SUCCEEDED' } }),
      db.executionSession.count({ where: { status: 'FAILED' } }),
      db.executionSession.count({ where: { status: 'CANCELLED' } }),
      db.executionSession.aggregate({ _avg: { latencyMs: true }, where: { status: 'SUCCEEDED' } }),
    ]);

    return {
      total,
      running,
      succeeded,
      failed,
      cancelled,
      queued: total - running - succeeded - failed - cancelled,
      avgLatencyMs: Math.round(avgLatency._avg.latencyMs ?? 0),
      successRate: total > 0 ? Math.round((succeeded / total) * 100) : 0,
    };
  }

  // ── Helpers ──

  private async setCancellationFlag(db: any, executionId: string): Promise<void> {
    // Merge cancellation flag into existing outputJson (preserving data)
    // Worker checks this flag between steps
    const session = await db.executionSession.findFirst({
      where: { id: executionId },
      select: { outputJson: true },
    });
    const existing = (session?.outputJson as Record<string, unknown>) ?? {};

    await db.executionSession.update({
      where: { id: executionId },
      data: {
        outputJson: {
          ...existing,
          _cancellationRequested: true,
          _cancelledAt: new Date().toISOString(),
        },
      },
    });
  }
}

export { EXECUTION_QUEUE_TOKEN };
