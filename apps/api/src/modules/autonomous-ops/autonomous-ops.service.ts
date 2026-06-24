/**
 * Autonomous Operations Service — Self-Healing Loop
 *
 * Core cycle: detect → remediate → verify → (undo if requested).
 * Every auto-action is audit-traced (R3) and tenant-scoped (R2).
 * The revert window (default 10 minutes) gives humans the option to roll back.
 */
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  PrismaClient,
  withTenantIsolation,
  TenantContext,
  getSystemSessionId,
} from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { A2ABusService } from '../agent-kernel/bus.service';
import { Queue } from 'bullmq';
import { AUTO_ACTIONS_QUEUE_TOKEN } from './queue.provider';
import { EventsGatewayService } from '../events/events.gateway.service';

export type AutoActionKind =
  | 'REMEDIATION'
  | 'ROLLBACK'
  | 'ESCALATION'
  | 'QUARANTINE'
  | 'RATE_ADJUST';

export interface CreateAutoActionDto {
  missionId?: string;
  kind: AutoActionKind;
  targetType: string;
  targetId: string;
  triggerReason: string;
  triggerRuleId?: string;
  action: Record<string, any>;
  revertWindowSec?: number;
  correlationId?: string;
}

@Injectable()
export class AutonomousOpsService {
  private readonly logger = new Logger(AutonomousOpsService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(AUTO_ACTIONS_QUEUE_TOKEN) private readonly queue: Queue,
    private readonly bus: A2ABusService,
    private readonly events: EventsGatewayService,
  ) {}

  // ═══════════════════════════════════════════════
  //  Core: execute + record an autonomous action
  // ═══════════════════════════════════════════════
  async executeAction(ctx: TenantContext, dto: CreateAutoActionDto) {
    const correlationId =
      dto.correlationId ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const action = await this.prisma.autoAction.create({
      data: {
        tenantId: ctx.tenantId,
        missionId: dto.missionId,
        kind: dto.kind,
        targetType: dto.targetType,
        targetId: dto.targetId,
        triggerReason: dto.triggerReason,
        triggerRuleId: dto.triggerRuleId,
        actionJson: dto.action as any,
        revertWindowSec: dto.revertWindowSec ?? 600,
        correlationId,
      },
    });

    // Audit trace (R3) — per-tenant sentinel session FK
    const execSessionId = await getSystemSessionId(this.prisma, ctx.tenantId);
    if (execSessionId)
      await this.prisma.executionTrace
        .create({
          data: {
            executionSessionId: execSessionId,
            correlationId,
            traceJson: {
              event: 'AUTO_ACTION_EXECUTED',
              autoActionId: action.id,
              kind: dto.kind,
              targetType: dto.targetType,
              targetId: dto.targetId,
              reason: dto.triggerReason,
              revertWindowSec: action.revertWindowSec,
              timestamp: new Date().toISOString(),
            } as any,
          },
        })
        .catch(() => {});

    // If linked to mission, push an event onto the A2A bus
    if (dto.missionId) {
      await this.bus.publish(ctx.tenantId, dto.missionId, {
        kind: 'EVENT',
        fromAgent: 'autonomous-ops',
        subject: `Auto ${dto.kind.toLowerCase()} on ${dto.targetType}`,
        payload: { autoActionId: action.id, targetId: dto.targetId },
        naturalSummary: `자율 조치: ${dto.triggerReason} (${dto.revertWindowSec ?? 600}초 이내 되돌리기 가능)`,
        correlationId,
      });
    }

    this.logger.log(
      `[auto-ops] ${dto.kind} on ${dto.targetType}:${dto.targetId} tenant=${ctx.tenantId} reason="${dto.triggerReason}"`,
    );

    // Live-feed push (SSE) for /home real-time dashboard
    this.events.publish(ctx.tenantId, {
      id: action.id,
      type: 'auto-action',
      timestamp: new Date().toISOString(),
      actor: 'autonomous-ops',
      summary: `자율 조치: ${dto.triggerReason}`,
      severity: 'warning',
      payload: { kind: dto.kind, targetType: dto.targetType, targetId: dto.targetId },
      correlationId,
    });

    // Dispatch to BullMQ worker for asynchronous execution
    // The worker will apply the action, verify it, and update status.
    await this.queue
      .add(
        'execute',
        {
          tenantId: ctx.tenantId,
          autoActionId: action.id,
          kind: dto.kind,
          targetType: dto.targetType,
          targetId: dto.targetId,
          actionSpec: dto.action,
          correlationId,
        },
        {
          jobId: `auto-${action.id}`,
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400 },
          attempts: 2,
          backoff: { type: 'exponential', delay: 2000 },
        },
      )
      .catch((err) => {
        this.logger.error(`Failed to queue auto-action ${action.id}: ${err.message}`);
      });

    return action;
  }

  // ═══════════════════════════════════════════════
  //  Verify — post-action check
  // ═══════════════════════════════════════════════
  async verify(ctx: TenantContext, actionId: string, result: Record<string, any>) {
    const db = withTenantIsolation(this.prisma, ctx);
    const action = await db.autoAction.findFirst({ where: { id: actionId } });
    if (!action) throw new NotFoundException(`AutoAction ${actionId} not found`);

    const updated = await this.prisma.autoAction.update({
      where: { id: actionId },
      data: {
        status: 'VERIFIED',
        verificationJson: result as any,
      },
    });

    const verifySessionId = await getSystemSessionId(this.prisma, ctx.tenantId);
    if (verifySessionId)
      await this.prisma.executionTrace
        .create({
          data: {
            executionSessionId: verifySessionId,
            correlationId: action.correlationId,
            traceJson: {
              event: 'AUTO_ACTION_VERIFIED',
              autoActionId: actionId,
              result,
              timestamp: new Date().toISOString(),
            } as any,
          },
        })
        .catch(() => {});

    return updated;
  }

  // ═══════════════════════════════════════════════
  //  Revert (Undo) — inside grace window only
  // ═══════════════════════════════════════════════
  async revert(ctx: TenantContext, actionId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const action = await db.autoAction.findFirst({ where: { id: actionId } });
    if (!action) throw new NotFoundException(`AutoAction ${actionId} not found`);
    if (action.status === 'REVERTED') {
      throw new BadRequestException('Action already reverted');
    }

    const ageSec = (Date.now() - new Date(action.createdAt).getTime()) / 1000;
    if (ageSec > action.revertWindowSec) {
      throw new ForbiddenException(
        `Revert window expired (${Math.floor(ageSec)}s elapsed, limit ${action.revertWindowSec}s). Create a compensating mission instead.`,
      );
    }

    const updated = await this.prisma.autoAction.update({
      where: { id: actionId },
      data: {
        status: 'REVERTED',
        revertedAt: new Date(),
        revertedByUserId: ctx.userId,
      },
    });

    const revertSessionId = await getSystemSessionId(this.prisma, ctx.tenantId);
    if (revertSessionId)
      await this.prisma.executionTrace
        .create({
          data: {
            executionSessionId: revertSessionId,
            correlationId: action.correlationId,
            traceJson: {
              event: 'AUTO_ACTION_REVERTED',
              autoActionId: actionId,
              revertedBy: ctx.userId,
              elapsedSec: Math.floor(ageSec),
              timestamp: new Date().toISOString(),
            } as any,
          },
        })
        .catch(() => {});

    if (action.missionId) {
      await this.bus.publish(ctx.tenantId, action.missionId, {
        kind: 'HUMAN_INTERVENTION',
        fromAgent: ctx.userId || 'human',
        subject: 'Auto-action reverted',
        payload: { autoActionId: actionId },
        naturalSummary: `사용자가 자율 조치를 되돌렸습니다 (${Math.floor(ageSec)}초 경과).`,
        correlationId: action.correlationId,
      });
    }

    return updated;
  }

  // ═══════════════════════════════════════════════
  //  Query helpers
  // ═══════════════════════════════════════════════
  async list(
    ctx: TenantContext,
    opts: { status?: string; targetType?: string; hours?: number; limit?: number } = {},
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.targetType) where.targetType = opts.targetType;
    if (opts.hours) {
      where.createdAt = { gte: new Date(Date.now() - opts.hours * 3600 * 1000) };
    }
    return db.autoAction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 100,
    });
  }

  async getById(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const action = await db.autoAction.findFirst({ where: { id } });
    if (!action) throw new NotFoundException(`AutoAction ${id} not found`);
    return action;
  }

  /** Summary statistics for governance/home dashboard. */
  async summary(ctx: TenantContext, hours = 24) {
    const db = withTenantIsolation(this.prisma, ctx);
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const actions = await db.autoAction.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const a of actions) {
      byKind[a.kind] = (byKind[a.kind] || 0) + 1;
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    }
    return {
      total: actions.length,
      windowHours: hours,
      byKind,
      byStatus,
    };
  }
}
