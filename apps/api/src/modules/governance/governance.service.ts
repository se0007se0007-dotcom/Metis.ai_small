import { Injectable, Inject, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

interface PolicyInput {
  name?: string;
  type?: string;
  isActive?: boolean;
  scope?: Record<string, unknown>;
  rules?: unknown[];
  description?: string;
  scopeLevel?: string; // 'PLATFORM' (공통) | 'TENANT'
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
    // 공통(PLATFORM) + 테넌트 정책을 함께 노출. 공통 정책은 모든 테넌트에 적용되며
    // 소유 테넌트가 아니면 읽기 전용(editable=false)으로 표시한다.
    const rows = await this.prisma.policy.findMany({
      where: { OR: [{ tenantId: ctx.tenantId }, { scopeLevel: 'PLATFORM' }] },
      orderBy: [{ scopeLevel: 'asc' }, { createdAt: 'desc' }],
    });
    const stats = await this.policyEvalStats(
      ctx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => this.toUiPolicy(r, stats[r.id], this.isPolicyEditable(ctx, r)));
  }

  /** A policy is editable only by its owning tenant; PLATFORM policies require PLATFORM_ADMIN. */
  private isPolicyEditable(ctx: TenantContext, row: any): boolean {
    if (row.tenantId !== ctx.tenantId) return false;
    if (row.scopeLevel === 'PLATFORM') return ctx.role === 'PLATFORM_ADMIN';
    return true;
  }

  /**
   * Aggregate PolicyEvaluation rows per policy so the UI can show real
   * "마지막 평가 / 위반 횟수" instead of placeholder zeros.
   * - violationCount: all-time non-PASS (FAIL+WARN) evaluations
   * - violations24h: non-PASS evaluations in the last 24h
   * - lastEvaluated: most recent evaluation timestamp
   * - evalCount: total evaluations (any result)
   */
  private async policyEvalStats(ctx: TenantContext, policyIds: string[]) {
    const out: Record<
      string,
      { evalCount: number; violationCount: number; violations24h: number; lastEvaluated: Date | null }
    > = {};
    if (policyIds.length === 0) return out;
    const ensure = (id: string) =>
      (out[id] ??= { evalCount: 0, violationCount: 0, violations24h: 0, lastEvaluated: null });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const baseWhere = { tenantId: ctx.tenantId, policyId: { in: policyIds } };
    const [totals, violAll, viol24h] = await Promise.all([
      this.prisma.policyEvaluation.groupBy({
        by: ['policyId'],
        where: baseWhere,
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.policyEvaluation.groupBy({
        by: ['policyId'],
        where: { ...baseWhere, result: { not: 'PASS' } },
        _count: { _all: true },
      }),
      this.prisma.policyEvaluation.groupBy({
        by: ['policyId'],
        where: { ...baseWhere, result: { not: 'PASS' }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    for (const t of totals) {
      const s = ensure(t.policyId);
      s.evalCount = t._count._all;
      s.lastEvaluated = t._max.createdAt ?? null;
    }
    for (const v of violAll) ensure(v.policyId).violationCount = v._count._all;
    for (const v of viol24h) ensure(v.policyId).violations24h = v._count._all;
    return out;
  }

  /** Recent evaluation history for a single policy (newest first). */
  async getPolicyViolations(
    ctx: TenantContext,
    policyId: string,
    opts: { limit?: number; onlyViolations?: boolean } = {},
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const policy = await db.policy.findFirst({ where: { id: policyId } });
    if (!policy) throw new NotFoundException('Policy not found');
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const rows = await this.prisma.policyEvaluation.findMany({
      where: {
        tenantId: ctx.tenantId,
        policyId,
        ...(opts.onlyViolations ? { result: { not: 'PASS' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      result: r.result,
      reason: r.reason ?? null,
      executionSessionId: r.executionSessionId ?? null,
      createdAt: r.createdAt,
    }));
  }

  /** Tenant-wide recent violations feed (non-PASS), for the policy screen / dashboard widget. */
  async getRecentViolations(ctx: TenantContext, opts: { days?: number; limit?: number } = {}) {
    const days = Math.max(1, Math.min(90, opts.days ?? 7));
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.policyEvaluation.findMany({
      where: { tenantId: ctx.tenantId, result: { not: 'PASS' }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { policy: { select: { id: true, name: true } } },
    });
    return {
      windowDays: days,
      total: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        policyId: r.policyId,
        policyName: r.policy?.name ?? r.policyId,
        result: r.result,
        reason: r.reason ?? null,
        executionSessionId: r.executionSessionId ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * 정책 호출/정상/위반/차단 통계 — 기간별 요약 + 정책별 분해 + 일별 시계열.
   * total=전체 평가, pass=정상(PASS), warn=경고(WARN), fail=차단(FAIL).
   */
  async getPolicyStats(ctx: TenantContext, daysInput?: number) {
    const days = Math.max(1, Math.min(90, daysInput ?? 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const policies = await this.prisma.policy.findMany({
      where: { OR: [{ tenantId: ctx.tenantId }, { scopeLevel: 'PLATFORM' }] },
      select: { id: true, name: true, scopeLevel: true },
    });
    const ids = policies.map((p) => p.id);
    const blank = () => ({ total: 0, pass: 0, warn: 0, fail: 0 });
    const bump = (m: { total: number; pass: number; warn: number; fail: number }, result: string, n: number) => {
      m.total += n;
      if (result === 'PASS') m.pass += n;
      else if (result === 'WARN') m.warn += n;
      else if (result === 'FAIL') m.fail += n;
    };

    const grouped = ids.length
      ? await this.prisma.policyEvaluation.groupBy({
          by: ['policyId', 'result'],
          where: { tenantId: ctx.tenantId, policyId: { in: ids }, createdAt: { gte: since } },
          _count: { _all: true },
        })
      : [];
    const perMap = new Map<string, { total: number; pass: number; warn: number; fail: number }>();
    for (const g of grouped) {
      const m = perMap.get(g.policyId) ?? blank();
      bump(m, g.result, g._count._all);
      perMap.set(g.policyId, m);
    }
    const perPolicy = policies
      .map((p) => ({ policyId: p.id, policyName: p.name, scopeLevel: p.scopeLevel, ...(perMap.get(p.id) ?? blank()) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);
    const overall = perPolicy.reduce(
      (a, x) => ({ total: a.total + x.total, pass: a.pass + x.pass, warn: a.warn + x.warn, fail: a.fail + x.fail }),
      blank(),
    );

    // 일별 시계열 (UTC 일 기준). 연속성을 위해 빈 날짜도 0으로 채움.
    const rows = ids.length
      ? await this.prisma.policyEvaluation.findMany({
          where: { tenantId: ctx.tenantId, policyId: { in: ids }, createdAt: { gte: since } },
          select: { createdAt: true, result: true },
          take: 50000,
        })
      : [];
    const buckets = new Map<string, { total: number; pass: number; warn: number; fail: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const k = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      buckets.set(k, blank());
    }
    for (const r of rows) {
      const k = new Date(r.createdAt).toISOString().slice(0, 10);
      const m = buckets.get(k) ?? blank();
      bump(m, r.result, 1);
      buckets.set(k, m);
    }
    const timeseries = [...buckets.entries()].map(([date, v]) => ({ date, ...v }));
    return { windowDays: days, overall, perPolicy, timeseries };
  }

  /** 정책 실행/위반 이력 — 정책·결과·기간 필터 + 페이지네이션 (별도 이력 탭용). */
  async getPolicyEvaluations(
    ctx: TenantContext,
    opts: { policyId?: string; result?: string; days?: number; page?: number; pageSize?: number } = {},
  ) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const where: any = { tenantId: ctx.tenantId };
    if (opts.policyId) where.policyId = opts.policyId;
    if (opts.result && ['PASS', 'WARN', 'FAIL'].includes(opts.result)) where.result = opts.result;
    if (opts.days) {
      const d = Math.max(1, Math.min(365, opts.days));
      where.createdAt = { gte: new Date(Date.now() - d * 24 * 60 * 60 * 1000) };
    }
    const [total, rows] = await Promise.all([
      this.prisma.policyEvaluation.count({ where }),
      this.prisma.policyEvaluation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { policy: { select: { id: true, name: true, scopeLevel: true } } },
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((r) => ({
        id: r.id,
        policyId: r.policyId,
        policyName: r.policy?.name ?? r.policyId,
        scopeLevel: r.policy?.scopeLevel ?? 'TENANT',
        result: r.result,
        reason: r.reason ?? null,
        executionSessionId: r.executionSessionId ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * 규칙 빌더 값 드롭다운용 — 실제 존재하는 키 목록을 반환.
   * 사용자가 키를 외워 입력하지 않고 목록에서 선택하도록 한다.
   */
  async getPolicyFieldOptions(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);
    const [wfs, caps] = await Promise.all([
      db.workflow.findMany({
        where: { deletedAt: null },
        select: { key: true, name: true, code: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      db.capabilityBinding.findMany({
        where: { active: true },
        select: { key: true, label: true },
        orderBy: { label: 'asc' },
        take: 500,
      }),
    ]);
    const uniq = (arr: Array<{ value: string; label: string }>) => {
      const m = new Map<string, { value: string; label: string }>();
      for (const a of arr) if (a.value && !m.has(a.value)) m.set(a.value, a);
      return [...m.values()];
    };
    return {
      workflowKey: uniq(
        wfs.map((w: any) => ({
          value: w.key,
          label: w.code ? `[${w.code}] ${w.name ?? w.key}` : (w.name ?? w.key),
        })),
      ),
      capabilityKey: uniq(
        caps.map((c: any) => ({ value: c.key, label: c.label ?? c.key })),
      ),
      action: [{ value: 'EXECUTE', label: '실행 (EXECUTE)' }],
      targetType: [{ value: 'ExecutionSession', label: '실행 세션 (ExecutionSession)' }],
    };
  }

  async createPolicy(ctx: TenantContext, dto: PolicyInput) {
    const db = withTenantIsolation(this.prisma, ctx);
    const scopeLevel = dto.scopeLevel === 'PLATFORM' ? 'PLATFORM' : 'TENANT';
    // 공통(PLATFORM) 정책은 플랫폼 관리자만 생성 가능
    if (scopeLevel === 'PLATFORM' && ctx.role !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException('공통(PLATFORM) 정책은 플랫폼 관리자만 생성할 수 있습니다.');
    }
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
        scopeLevel,
        key,
        name,
        description: dto.description ?? null,
        isActive: dto.isActive ?? true,
        ruleYaml,
        version: 1,
      },
    });
    return this.toUiPolicy(created, undefined, true);
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
    return this.toUiPolicy(updated, undefined, this.isPolicyEditable(ctx, updated));
  }

  /** Map a Policy row (ruleYaml = JSON string) to the UI-facing shape. */
  private toUiPolicy(
    row: any,
    stats?: { evalCount: number; violationCount: number; violations24h: number; lastEvaluated: Date | null },
    editable: boolean = true,
  ) {
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
      scopeLevel: row.scopeLevel ?? 'TENANT',
      editable,
      isActive: row.isActive,
      scope: parsed.scope ?? {},
      rulesJson: rules,
      rulesCount: rules.length,
      lastEvaluated: stats?.lastEvaluated ?? null,
      violationCount: stats?.violationCount ?? 0,
      violations24h: stats?.violations24h ?? 0,
      evalCount: stats?.evalCount ?? 0,
      version: row.version,
      createdAt: row.createdAt,
    };
  }
}
