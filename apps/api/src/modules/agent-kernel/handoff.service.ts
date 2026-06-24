/**
 * Handoff Service — agent-to-agent task transfer within a mission.
 * Ensures R2 (tenant) and R3 (trace) are maintained across transfer boundaries.
 */
import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { A2ABusService } from './bus.service';

export interface CreateHandoffDto {
  missionId: string;
  fromAgent: string;
  toAgent: string;
  task: Record<string, any>;
}

@Injectable()
export class HandoffService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly bus: A2ABusService,
  ) {}

  async create(ctx: TenantContext, dto: CreateHandoffDto) {
    const db = withTenantIsolation(this.prisma, ctx);
    const mission = await db.mission.findFirst({ where: { id: dto.missionId } });
    if (!mission) throw new NotFoundException('Mission not found or access denied');

    const handoff = await db.agentHandoff.create({
      data: {
        tenantId: ctx.tenantId,
        missionId: dto.missionId,
        fromAgent: dto.fromAgent,
        toAgent: dto.toAgent,
        taskJson: dto.task as any,
        correlationId: mission.correlationId,
      },
    });

    await this.bus.publish(ctx.tenantId, dto.missionId, {
      kind: 'HANDOFF',
      fromAgent: dto.fromAgent,
      toAgent: dto.toAgent,
      subject: 'Task handoff',
      payload: { handoffId: handoff.id, task: dto.task },
      naturalSummary: `${dto.fromAgent} 에이전트가 ${dto.toAgent} 에이전트에게 작업을 전달했습니다.`,
      correlationId: mission.correlationId,
    });

    return handoff;
  }

  async accept(ctx: TenantContext, handoffId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const h = await db.agentHandoff.findFirst({ where: { id: handoffId } });
    if (!h) throw new NotFoundException('Handoff not found');
    if (h.status !== 'PENDING') throw new BadRequestException(`Cannot accept in state ${h.status}`);
    const updated = await this.prisma.agentHandoff.update({
      where: { id: handoffId },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    await this.bus.publish(ctx.tenantId, h.missionId, {
      kind: 'HANDOFF',
      fromAgent: h.toAgent,
      subject: 'Handoff accepted',
      payload: { handoffId },
      naturalSummary: `${h.toAgent} 에이전트가 작업을 인수했습니다.`,
      correlationId: h.correlationId,
    });
    return updated;
  }

  async reject(ctx: TenantContext, handoffId: string, reason: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const h = await db.agentHandoff.findFirst({ where: { id: handoffId } });
    if (!h) throw new NotFoundException('Handoff not found');
    const updated = await this.prisma.agentHandoff.update({
      where: { id: handoffId },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
    await this.bus.publish(ctx.tenantId, h.missionId, {
      kind: 'HANDOFF',
      fromAgent: h.toAgent,
      subject: 'Handoff rejected',
      payload: { handoffId, reason },
      naturalSummary: `${h.toAgent} 에이전트가 작업을 거부했습니다: ${reason}`,
      correlationId: h.correlationId,
    });
    return updated;
  }

  async complete(ctx: TenantContext, handoffId: string, result: Record<string, any>) {
    const db = withTenantIsolation(this.prisma, ctx);
    const h = await db.agentHandoff.findFirst({ where: { id: handoffId } });
    if (!h) throw new NotFoundException('Handoff not found');
    const updated = await this.prisma.agentHandoff.update({
      where: { id: handoffId },
      data: { resultJson: result as any },
    });
    await this.bus.publish(ctx.tenantId, h.missionId, {
      kind: 'RESPONSE',
      fromAgent: h.toAgent,
      toAgent: h.fromAgent,
      subject: 'Handoff task completed',
      payload: { handoffId, result },
      naturalSummary: `${h.toAgent} 에이전트가 작업을 완료했습니다.`,
      correlationId: h.correlationId,
    });
    return updated;
  }

  async listByMission(ctx: TenantContext, missionId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    return db.agentHandoff.findMany({
      where: { missionId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
