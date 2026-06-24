/**
 * Mission Service — orchestrates multi-agent collaboration missions.
 *
 * Resolves R2 (tenant isolation via withTenantIsolation) and
 *          R3 (correlationId propagated to every bus publish + ExecutionTrace).
 */
import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  PrismaClient,
  withTenantIsolation,
  TenantContext,
  getSystemSessionId,
} from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { A2ABusService } from './bus.service';

export interface MissionParticipant {
  agent: string; // agent identifier (e.g. 'qa-agent', 'canary-agent')
  role: string; // 'planner' | 'executor' | 'verifier' | ...
  optional?: boolean;
}

export interface CreateMissionDto {
  /** Optional — auto-generated from title when omitted. */
  key?: string;
  title: string;
  description?: string;
  kind: string;
  /** Accepts structured participants OR plain agent-id strings from the UI. */
  participants: Array<MissionParticipant | string>;
  plannedSteps?: Record<string, any>;
  context?: Record<string, any>;
}

/** Build a URL-safe unique key from a title (+ short random suffix). */
function generateMissionKey(title: string): string {
  const base =
    (title || 'mission')
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'mission';
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Normalize participants: accept strings ('qa-agent') or objects ({agent, role}). */
function normalizeParticipants(
  raw: Array<MissionParticipant | string> | undefined,
): MissionParticipant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      if (typeof p === 'string') {
        const agent = p.trim();
        return agent ? { agent, role: 'participant' } : null;
      }
      if (p && typeof p === 'object' && p.agent) {
        return { agent: p.agent, role: p.role || 'participant', optional: p.optional };
      }
      return null;
    })
    .filter((p): p is MissionParticipant => p !== null);
}

@Injectable()
export class MissionService {
  private readonly logger = new Logger(MissionService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly bus: A2ABusService,
  ) {}

  async list(ctx: TenantContext, status?: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    return db.mission.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async getById(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const mission = await db.mission.findFirst({ where: { id } });
    if (!mission) throw new NotFoundException(`Mission ${id} not found`);
    return mission;
  }

  async create(ctx: TenantContext, dto: CreateMissionDto) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Key: use provided one (must be unique) or auto-generate from the title.
    // The UI does not send a key, so previously every create collided on
    // key="undefined" → "Mission key undefined already exists".
    let key = dto.key?.trim() || generateMissionKey(dto.title);
    const existing = await db.mission.findFirst({ where: { key } });
    if (existing) {
      if (dto.key?.trim()) {
        throw new BadRequestException(`Mission key "${key}" already exists`);
      }
      key = generateMissionKey(dto.title); // regenerate on the rare auto-key collision
    }

    const participants = normalizeParticipants(dto.participants);
    const correlationId = `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const mission = await db.mission.create({
      data: {
        tenantId: ctx.tenantId,
        key,
        title: dto.title,
        description: dto.description,
        kind: dto.kind,
        participants: participants as any,
        plannedStepsJson: (dto.plannedSteps ?? {}) as any,
        contextJson: (dto.context ?? {}) as any,
        correlationId,
        createdByUserId: ctx.userId,
      },
    });

    // R3: initial audit trace (per-tenant sentinel session FK)
    const auditSessionId = await getSystemSessionId(this.prisma, ctx.tenantId);
    if (auditSessionId)
      await this.prisma.executionTrace
        .create({
          data: {
            executionSessionId: auditSessionId,
            correlationId,
            traceJson: {
              event: 'MISSION_CREATED',
              missionId: mission.id,
              key,
              kind: dto.kind,
              participants,
              createdBy: ctx.userId,
              timestamp: new Date().toISOString(),
            } as any,
          },
        })
        .catch(() => {});

    // System message into the mission
    await this.bus.publish(ctx.tenantId, mission.id, {
      kind: 'SYSTEM',
      fromAgent: 'system',
      subject: 'Mission created',
      payload: { participants, kind: dto.kind },
      naturalSummary: `미션 "${dto.title}"이 생성되었습니다. 참여 에이전트: ${participants.map((p) => p.agent).join(', ') || '없음'}`,
      correlationId,
    });

    return mission;
  }

  async start(ctx: TenantContext, id: string) {
    const mission = await this.getById(ctx, id);
    if (mission.status !== 'PLANNING') {
      throw new BadRequestException(`Cannot start mission in state ${mission.status}`);
    }
    const updated = await this.prisma.mission.update({
      where: { id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await this.bus.publish(ctx.tenantId, id, {
      kind: 'SYSTEM',
      fromAgent: 'system',
      subject: 'Mission started',
      payload: { startedAt: updated.startedAt },
      naturalSummary: '미션이 실행 상태로 전환되었습니다.',
      correlationId: mission.correlationId,
    });
    return updated;
  }

  async pauseForHuman(ctx: TenantContext, id: string, reason: string) {
    const mission = await this.getById(ctx, id);
    const updated = await this.prisma.mission.update({
      where: { id },
      data: { status: 'WAITING_HUMAN', humanInterventionsCount: { increment: 1 } },
    });
    await this.bus.publish(ctx.tenantId, id, {
      kind: 'SYSTEM',
      fromAgent: 'system',
      subject: 'Human intervention requested',
      payload: { reason },
      naturalSummary: `미션이 사람의 개입을 기다리는 상태로 전환되었습니다. 사유: ${reason}`,
      correlationId: mission.correlationId,
    });
    return updated;
  }

  /**
   * Resume a paused (WAITING_HUMAN) mission with a human decision.
   *
   * Reconstructed (no original source). Models on pauseForHuman: transitions
   * the mission back to RUNNING, records the decision on the bus, returns the
   * updated mission.
   */
  async resume(ctx: TenantContext, id: string, decision: string) {
    const mission = await this.getById(ctx, id);
    if (mission.status !== 'WAITING_HUMAN') {
      throw new BadRequestException(`Cannot resume mission in state ${mission.status}`);
    }
    const updated = await this.prisma.mission.update({
      where: { id },
      data: { status: 'RUNNING' },
    });
    await this.bus.publish(ctx.tenantId, id, {
      kind: 'HUMAN_INTERVENTION',
      fromAgent: 'human',
      subject: 'Human decision',
      payload: { decision, decidedBy: ctx.userId },
      naturalSummary: `사람의 결정으로 미션이 재개되었습니다. 결정: ${decision}`,
      correlationId: mission.correlationId,
    });
    return updated;
  }

  /**
   * Complete a mission with a terminal status and optional summary.
   *
   * Reconstructed (no original source). Sets the terminal MissionStatus and
   * endedAt, folds the summary into contextJson, publishes a SYSTEM message,
   * and returns the updated mission.
   */
  async complete(
    ctx: TenantContext,
    id: string,
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'ROLLED_BACK',
    summary?: string,
  ) {
    const mission = await this.getById(ctx, id);
    const mergedContext = {
      ...((mission.contextJson as Record<string, any>) ?? {}),
      ...(summary ? { completionSummary: summary } : {}),
    };
    const updated = await this.prisma.mission.update({
      where: { id },
      data: {
        status: status as any,
        endedAt: new Date(),
        contextJson: mergedContext as any,
      },
    });
    await this.bus.publish(ctx.tenantId, id, {
      kind: 'SYSTEM',
      fromAgent: 'system',
      subject: 'Mission completed',
      payload: { status, summary },
      naturalSummary: `미션이 ${status} 상태로 종료되었습니다.${summary ? ` ${summary}` : ''}`,
      correlationId: mission.correlationId,
    });
    return updated;
  }

  /**
   * Return the mission's message history (most-recent-first capped at `limit`).
   *
   * Reconstructed (no original source). Reads the AgentMessage model via the
   * tenant-isolated client, mirroring how other reads resolve the DB.
   */
  async getMessages(ctx: TenantContext, id: string, limit = 200) {
    await this.getById(ctx, id); // tenant-scope + existence check
    const db = withTenantIsolation(this.prisma, ctx);
    return db.agentMessage.findMany({
      where: { missionId: id },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
