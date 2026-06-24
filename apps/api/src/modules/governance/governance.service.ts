import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

interface PolicyInput {
  name?: string;
  type?: string;
  isActive?: boolean;
  scope?: Record<string, unknown>;
  rules?: unknown[];
  description?: string;
}

@Injectable()
export class GovernanceService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * Search audit logs. Beyond exact correlationId, supports free-text (q) over
   * target/correlation/actor, plus action / targetType / date-range filters so
   * an operator can find "who did what" without knowing internal IDs.
   */
  async getAuditLogs(
    ctx: TenantContext,
    filters: {
      action?: string;
      correlationId?: string;
      q?: string;
      targetType?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const pageSize = Math.max(1, Math.min(100, filters.pageSize ?? 20));
    const page = Math.max(1, filters.page ?? 1);

    const and: any[] = [];
    if (filters.action) and.push({ action: filters.action });
    if (filters.correlationId) and.push({ correlationId: filters.correlationId });
    if (filters.targetType) and.push({ targetType: filters.targetType });
    if (filters.from || filters.to) {
      const createdAt: any = {};
      if (filters.from) createdAt.gte = new Date(filters.from);
      if (filters.to) createdAt.lte = new Date(filters.to);
      and.push({ createdAt });
    }
    const q = filters.q?.trim();
    if (q) {
      and.push({
        OR: [
          { targetType: { contains: q, mode: 'insensitive' } },
          { targetId: { contains: q, mode: 'insensitive' } },
          { correlationId: { contains: q, mode: 'insensitive' } },
          { policyResult: { contains: q, mode: 'insensitive' } },
          { actor: { is: { email: { contains: q, mode: 'insensitive' } } } },
          { actor: { is: { name: { contains: q, mode: 'insensitive' } } } },
        ],
      });
    }
    const where: any = and.length ? { AND: and } : {};

    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { actor: { select: { id: true, name: true, email: true } } },
      }),
      db.auditLog.count({ where }),
    ]);

    return { items, total, page, pageSize, hasMore: page * pageSize < total };
  }

  /** Summary facets for the audit screen: totals, action breakdown, active actors. */
  async getAuditSummary(ctx: TenantContext, days = 7) {
    const db = withTenantIsolation(this.prisma, ctx);
    const since = new Date();
    since.setDate(since.getDate() - Math.max(1, Math.min(180, days)));

    const [total, byActionRaw, recent, distinctActors] = await Promise.all([
      db.auditLog.count({ where: { createdAt: { gte: since } } }),
      db.auditLog.groupBy({
        by: ['action'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      db.auditLog.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      }),
      db.auditLog.findMany({
        where: { createdAt: { gte: since }, actorUserId: { not: null } },
        distinct: ['actorUserId'],
        select: { actorUserId: true },
      }),
    ]);

    const byAction = byActionRaw
      .map((r: any) => ({ action: r.action, count: r._count?._all ?? 0 }))
      .sort((a: any, b: any) => b.count - a.count);

    return {
      windowDays: days,
      total,
      byAction,
      activeActors: distinctActors.length,
      lastEventAt: recent[0]?.createdAt ?? null,
    };
  }

  async getPolicies(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);
    const rows = await db.policy.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toUiPolicy(r));
  }

  async createPolicy(ctx: TenantContext, dto: PolicyInput) {
    const db = withTenantIsolation(this.prisma, ctx);
    const name = (dto.name ?? '').trim() || 'Untitled Policy';
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 40) || 'policy';
    const key = `${slug}-${Date.now().toString(36)}`;
    const ruleYaml = JSON.stringify({
      type: dto.type ?? 'COMPLIANCE',
      scope: dto.scope ?? {},
      rules: Array.isArray(dto.rules) ? dto.rules : [],
    });
    const created = await db.policy.create({
      data: {
        tenantId: ctx.tenantId,
        key,
        name,
        description: dto.description ?? null,
        isActive: dto.isActive ?? true,
        ruleYaml,
        version: 1,
      },
    });
    return this.toUiPolicy(created);
  }

  async updatePolicy(ctx: TenantContext, id: string, dto: PolicyInput) {
    const db = withTenantIsolation(this.prisma, ctx);
    const existing = await db.policy.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Policy not found');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.description !== undefined) data.description = dto.description;

    if (dto.type !== undefined || dto.scope !== undefined || dto.rules !== undefined) {
      let parsed: any = {};
      try {
        parsed = JSON.parse(existing.ruleYaml || '{}');
      } catch {
        /* keep empty */
      }
      data.ruleYaml = JSON.stringify({
        type: dto.type ?? parsed.type ?? 'COMPLIANCE',
        scope: dto.scope ?? parsed.scope ?? {},
        rules: dto.rules ?? parsed.rules ?? [],
      });
      data.version = (existing.version ?? 1) + 1;
    }

    const updated = await db.policy.update({ where: { id }, data });
    return this.toUiPolicy(updated);
  }

  /** Map a Policy row (ruleYaml = JSON string) to the UI-facing shape. */
  private toUiPolicy(row: any) {
    let parsed: any = {};
    try {
      parsed = JSON.parse(row.ruleYaml || '{}');
    } catch {
      /* keep empty */
    }
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      type: parsed.type ?? 'COMPLIANCE',
      isActive: row.isActive,
      scope: parsed.scope ?? {},
      rulesJson: rules,
      rulesCount: rules.length,
      lastEvaluated: null,
      version: row.version,
      createdAt: row.createdAt,
    };
  }
}
