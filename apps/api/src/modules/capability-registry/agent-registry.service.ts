/**
 * Agent Registry Service — first-class agent entity management.
 *
 * Version history & rollback (P2-A): every register/update appends an
 * immutable AgentVersionSnapshot (append-only, like GovernanceDecision).
 * rollback() restores a snapshot onto the live AgentDefinition and records
 * the restore itself as a new snapshot (changeType=ROLLBACK), so history is
 * never rewritten. Snapshot writes are best-effort: a snapshot failure never
 * blocks the registration itself. AgentVersionSnapshot access uses
 * `(this.prisma as any)` until the generated client catches up (same pattern
 * as ErrorPattern/KnowledgeArtifact).
 */
import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

export interface RegisterAgentDto {
  key: string;
  name: string;
  description?: string;
  category: string;
  version?: string;
  kernelType?: 'MCP' | 'REST' | 'LOCAL' | 'EXTERNAL';
  inputSchema: any;
  outputSchema: any;
  capabilities: string[];
  kernelConfig?: any;
  defaultTimeoutSec?: number;
  costPerInvocationUsd?: number;
}

@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async list(ctx: TenantContext, opts: { category?: string; status?: string } = {}) {
    const db = withTenantIsolation(this.prisma, ctx);
    return db.agentDefinition.findMany({
      where: {
        ...(opts.category ? { category: opts.category } : {}),
        ...(opts.status ? { status: opts.status as any } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getByKey(ctx: TenantContext, key: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const agent = await db.agentDefinition.findFirst({ where: { key } });
    if (!agent) throw new NotFoundException(`Agent "${key}" not found`);
    return agent;
  }

  async register(ctx: TenantContext, dto: RegisterAgentDto) {
    const db = withTenantIsolation(this.prisma, ctx);
    const existing = await db.agentDefinition.findFirst({ where: { key: dto.key } });
    if (existing) {
      const updated = await this.prisma.agentDefinition.update({
        where: { id: existing.id },
        data: {
          name: dto.name,
          description: dto.description,
          category: dto.category,
          version: dto.version ?? existing.version,
          kernelType: (dto.kernelType ?? existing.kernelType) as any,
          inputSchemaJson: dto.inputSchema,
          outputSchemaJson: dto.outputSchema,
          capabilitiesJson: dto.capabilities as any,
          kernelConfigJson: dto.kernelConfig ?? existing.kernelConfigJson,
          defaultTimeoutSec: dto.defaultTimeoutSec ?? existing.defaultTimeoutSec,
          costPerInvocationUsd: dto.costPerInvocationUsd ?? existing.costPerInvocationUsd,
          status: 'AVAILABLE',
        },
      });
      await this.snapshotVersion(ctx, updated, 'UPDATE');
      return updated;
    }
    const created = await this.prisma.agentDefinition.create({
      data: {
        tenantId: ctx.tenantId,
        key: dto.key,
        name: dto.name,
        description: dto.description,
        category: dto.category,
        version: dto.version ?? '1.0.0',
        kernelType: (dto.kernelType ?? 'LOCAL') as any,
        inputSchemaJson: dto.inputSchema,
        outputSchemaJson: dto.outputSchema,
        capabilitiesJson: dto.capabilities as any,
        kernelConfigJson: dto.kernelConfig,
        defaultTimeoutSec: dto.defaultTimeoutSec ?? 60,
        costPerInvocationUsd: dto.costPerInvocationUsd,
      },
    });
    await this.snapshotVersion(ctx, created, 'REGISTER');
    return created;
  }

  // ════════════════════════════════════════════════════════════
  //  Version history & rollback
  // ════════════════════════════════════════════════════════════

  /** List snapshots for an agent, newest first. */
  async listVersions(ctx: TenantContext, agentKey: string, limit = 50) {
    // Ensure the agent exists in this tenant (404 + tenant scoping).
    await this.getByKey(ctx, agentKey);
    return (this.prisma as any).agentVersionSnapshot.findMany({
      where: { tenantId: ctx.tenantId, agentKey },
      orderBy: { revision: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  /**
   * Restore an agent definition from a snapshot. The restore is itself
   * appended as a new snapshot (changeType=ROLLBACK) — history is append-only.
   */
  async rollback(ctx: TenantContext, agentKey: string, snapshotId: string) {
    const agent = await this.getByKey(ctx, agentKey);

    const snapshot = await (this.prisma as any).agentVersionSnapshot.findFirst({
      where: { id: snapshotId, tenantId: ctx.tenantId, agentKey },
    });
    if (!snapshot) {
      throw new NotFoundException(`Version snapshot "${snapshotId}" not found for agent "${agentKey}"`);
    }

    const snap = (snapshot.snapshotJson ?? {}) as Record<string, any>;
    if (!snap.name || !snap.category) {
      throw new BadRequestException(`Snapshot "${snapshotId}" payload is incomplete — cannot rollback`);
    }

    const restored = await this.prisma.agentDefinition.update({
      where: { id: agent.id },
      data: {
        name: snap.name,
        description: snap.description ?? null,
        category: snap.category,
        version: snap.version ?? agent.version,
        kernelType: (snap.kernelType ?? agent.kernelType) as any,
        inputSchemaJson: snap.inputSchemaJson ?? agent.inputSchemaJson,
        outputSchemaJson: snap.outputSchemaJson ?? agent.outputSchemaJson,
        capabilitiesJson: snap.capabilitiesJson ?? agent.capabilitiesJson,
        kernelConfigJson: snap.kernelConfigJson ?? agent.kernelConfigJson,
        defaultTimeoutSec: snap.defaultTimeoutSec ?? agent.defaultTimeoutSec,
        costPerInvocationUsd: snap.costPerInvocationUsd ?? agent.costPerInvocationUsd,
        status: 'AVAILABLE',
      },
    });

    await this.snapshotVersion(ctx, restored, 'ROLLBACK', snapshot.id);
    this.logger.log(
      `[agent-registry] Rolled back "${agentKey}" to snapshot ${snapshotId} (v${snapshot.version} r${snapshot.revision})`,
    );
    return restored;
  }

  /** Append an immutable snapshot of the current definition. Best-effort. */
  private async snapshotVersion(
    ctx: TenantContext,
    agent: any,
    changeType: 'REGISTER' | 'UPDATE' | 'ROLLBACK',
    rolledBackFromId?: string,
  ): Promise<void> {
    try {
      const last = await (this.prisma as any).agentVersionSnapshot.findFirst({
        where: { tenantId: ctx.tenantId, agentKey: agent.key },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      });
      const revision = (last?.revision ?? 0) + 1;

      await (this.prisma as any).agentVersionSnapshot.create({
        data: {
          tenantId: ctx.tenantId,
          agentKey: agent.key,
          version: agent.version ?? '1.0.0',
          revision,
          changeType,
          rolledBackFromId: rolledBackFromId ?? null,
          createdById: ctx.userId ?? null,
          snapshotJson: {
            name: agent.name,
            description: agent.description ?? null,
            category: agent.category,
            version: agent.version,
            kernelType: agent.kernelType,
            inputSchemaJson: agent.inputSchemaJson,
            outputSchemaJson: agent.outputSchemaJson,
            capabilitiesJson: agent.capabilitiesJson,
            kernelConfigJson: agent.kernelConfigJson ?? null,
            defaultTimeoutSec: agent.defaultTimeoutSec,
            costPerInvocationUsd: agent.costPerInvocationUsd ?? null,
          },
        },
      });
    } catch (err) {
      // Snapshot failure must never block registration (e.g. before migration).
      this.logger.warn(
        `[agent-registry] version snapshot failed for "${agent?.key}": ${(err as Error).message}`,
      );
    }
  }

  async recordInvocation(ctx: TenantContext, agentKey: string, success: boolean) {
    const db = withTenantIsolation(this.prisma, ctx);
    const agent = await db.agentDefinition.findFirst({ where: { key: agentKey } });
    if (!agent) return;
    const total = agent.totalInvocations + 1;
    const currentRate = agent.lastSuccessRate ?? 1.0;
    // Exponential moving average with alpha=0.1
    const newRate = currentRate * 0.9 + (success ? 1.0 : 0.0) * 0.1;
    await this.prisma.agentDefinition.update({
      where: { id: agent.id },
      data: {
        totalInvocations: total,
        lastInvokedAt: new Date(),
        lastSuccessRate: newRate,
        status: newRate < 0.5 ? ('DEGRADED' as any) : ('AVAILABLE' as any),
      },
    });
  }

  async setStatus(
    ctx: TenantContext,
    key: string,
    status: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'DRAINING',
  ) {
    const agent = await this.getByKey(ctx, key);
    return this.prisma.agentDefinition.update({
      where: { id: agent.id },
      data: { status: status as any },
    });
  }
}
