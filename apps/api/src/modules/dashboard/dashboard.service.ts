/**
 * Dashboard Service — DB-backed aggregation for the home dashboard.
 *
 * Loads recent ExecutionSession + AgentEvaluation rows for a tenant, joins the
 * workflowKey (main agent) onto evaluations via executionSessionId, and feeds
 * the pure aggregator. Also surfaces the agent launcher list (workflows) and a
 * recent-execution summary.
 *
 * @module dashboard
 */
import { Injectable, Inject, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  aggregateDashboard,
  isAgentNode,
  ExecRow,
  EvalRow,
  DashboardAggregate,
  EffectivenessConfigMap,
} from './dashboard-aggregate';
import { EffectivenessConfig } from './effectiveness';
import { mergeOpsRef, OpsReference } from '../../common/ops-reference.defaults';
import {
  computeMttrByAgent,
  computeMttdMinutes,
  computeMttdFromSignals,
  computeCoverageFromSignals,
  rollupSystemsOps,
  AgentOpsStat,
  MttrAlertRow,
  MttrAgentEntry,
} from './effectiveness-ops';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /** Full dashboard overview (3 axes + main-agent rollups). */
  async getOverview(
    tenantId: string,
    days = 30,
    filters: { workflowKey?: string; agentName?: string; teamId?: string } = {},
  ): Promise<
    DashboardAggregate & {
      window: { days: number; since: string };
    }
  > {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const since = new Date();
    since.setDate(since.getDate() - days);

    // 팀 필터 — 팀 소속(Agent 생성자의 팀)인 워크플로우 키 집합으로 좁힌다.
    // teamId가 있는데 해당 팀 Agent가 0개면 빈 집합([]) → 모든 집계가 0이 된다(정상).
    const teamKeys = filters.teamId
      ? await this.resolveTeamWorkflowKeys(resolvedTenantId, filters.teamId)
      : undefined;

    // 메인 Agent(workflowKey) / Sub-Agent(agentName) 필터 — 대시보드 전체가 해당 범위로 좁혀짐.
    const f = {
      workflowKey: filters.workflowKey?.trim() || undefined,
      agentName: filters.agentName?.trim() || undefined,
      workflowKeys: teamKeys,
    };

    const [execs, evals, effConfigs, registeredAgents, opsRef] = await Promise.all([
      this.loadExecRows(resolvedTenantId, since, f),
      this.loadEvalRows(resolvedTenantId, since, f),
      this.loadEffectivenessConfigs(resolvedTenantId),
      this.loadRegisteredAgents(resolvedTenantId),
      this.loadOpsReference(resolvedTenantId),
    ]);

    // 운영 기준값(시급·health 임계값·등급)을 집계에 주입 → 대시보드 ROI/health/등급이 기준정보 기반.
    const agg = aggregateDashboard(execs, evals, effConfigs, registeredAgents, opsRef);

    // ADD-only: decorate each per-workflow rollup + utilization entry with the
    // Workflow display name AND human-facing code (e.g. "DEV-003"). Best-effort,
    // tenant-scoped; never mutates the shape of existing fields.
    const result: any = { ...agg, window: { days, since: since.toISOString() } };
    try {
      const metaRows = await (this.prisma as any).workflow.findMany({
        where: { tenantId: resolvedTenantId, deletedAt: null },
        select: { key: true, name: true, code: true },
        take: 1000,
      });
      const metaByKey = new Map<string, { name: string | null; code: string | null }>();
      for (const r of metaRows) {
        metaByKey.set(r.key, {
          name: typeof r.name === 'string' ? r.name : null,
          code: typeof r.code === 'string' ? r.code : null,
        });
      }
      // 팀 라벨(IngestApiKey 기반) — 메인 Agent에 부착(품질/성과 그룹핑용).
      const teamByKey = await this.loadTeamByWorkflowKey(resolvedTenantId);
      if (Array.isArray(result.mainAgents)) {
        for (const m of result.mainAgents) {
          const meta = metaByKey.get(m.workflowKey);
          m.name = meta?.name ?? m.workflowKey;
          m.code = meta?.code ?? null;
          m.team = teamByKey.get(m.workflowKey) ?? '미지정 팀';
        }
      }
      if (result.utilization) {
        for (const list of [result.utilization.mostUsed, result.utilization.leastUsed]) {
          if (!Array.isArray(list)) continue;
          for (const u of list) {
            const meta = metaByKey.get(u.workflowKey);
            // name already populated by buildUtilization; only add code.
            u.code = meta?.code ?? null;
          }
        }
      }
    } catch (err) {
      this.logger.warn(`getOverview code decoration failed: ${(err as Error).message}`);
    }
    return result;
  }

  /**
   * 활용 시스템 상세 — 활용되는(window 내 실행이 있는) Agent를 시스템/팀/테넌트로 그룹핑.
   *  - PLATFORM_ADMIN: 전 테넌트 교차 집계. 그 외: 본인 테넌트만(테넌트 차원=본인 1개).
   *  - 팀은 Workflow.createdBy(User)의 소속 팀 기준(없으면 '미지정 팀').
   *  - adhoc-/nodetest- 워크플로우는 제외(운영 KPI와 동일 정의).
   */
  async getSystemUsage(user: { tenantId: string; role?: string }, days = 30): Promise<any> {
    const isPlatform = user.role === 'PLATFORM_ADMIN';
    const since = new Date();
    since.setDate(since.getDate() - days);
    const resolvedTenantId = await this.resolveTenantId(user.tenantId);
    const p = this.prisma as any;

    const emptyPayload = {
      scope: isPlatform ? 'platform' : 'tenant',
      summary: { agentCount: 0, systemCount: 0, teamCount: 0, tenantCount: 0, totalExecutions: 0 },
      bySystem: [],
      byTeam: [],
      byTenant: [],
      window: { days, since: since.toISOString() },
    };

    try {
      // 1) 활용 Agent = window 내 실행이 있는 (tenantId, workflowKey)
      const execWhere: any = { createdAt: { gte: since }, workflowKey: { not: null } };
      if (!isPlatform) execWhere.tenantId = resolvedTenantId;
      const grouped = await p.executionSession.groupBy({
        by: ['tenantId', 'workflowKey'],
        where: execWhere,
        _count: { _all: true },
      });
      const used = (grouped as any[]).filter((g) => {
        const k = String(g.workflowKey ?? '');
        return k && !k.startsWith('adhoc-') && !k.startsWith('nodetest-');
      });
      if (used.length === 0) return emptyPayload;

      const execByTk = new Map<string, number>();
      for (const g of used) execByTk.set(`${g.tenantId}::${g.workflowKey}`, g._count?._all ?? 0);

      // 2) Workflow 메타(system) 로드
      const tenantIds = [...new Set(used.map((u) => u.tenantId))];
      const keys = [...new Set(used.map((u) => u.workflowKey))];
      const wfs = await p.workflow.findMany({
        where: { tenantId: { in: tenantIds }, key: { in: keys }, deletedAt: null },
        select: { tenantId: true, key: true, system: true },
      });
      const wfByTk = new Map<string, any>();
      for (const w of wfs) wfByTk.set(`${w.tenantId}::${w.key}`, w);

      // 3) 팀 — IngestApiKey(agentKey=workflow.key, teamId)로 (tenant,agentKey)→팀명 매핑
      const ikeys = await p.ingestApiKey.findMany({
        where: { tenantId: { in: tenantIds }, agentKey: { not: null } },
        select: { tenantId: true, agentKey: true, team: { select: { name: true } } },
        take: 10000,
      });
      const teamByTk = new Map<string, string>();
      for (const k of ikeys) {
        const tk = `${k.tenantId}::${k.agentKey}`;
        if (!teamByTk.has(tk)) teamByTk.set(tk, k.team?.name || '미지정 팀');
      }

      // 4) 테넌트명
      const tenants = await p.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
      });
      const tenantNameById = new Map<string, string>();
      for (const t of tenants) tenantNameById.set(t.id, t.name);

      // 5) 그룹 누적
      type G = { agentCount: number; executions: number };
      const bySystem = new Map<string, G>();
      const byTeam = new Map<string, G>();
      const byTenant = new Map<string, G>();
      const add = (m: Map<string, G>, key: string, execs: number) => {
        const g = m.get(key) ?? { agentCount: 0, executions: 0 };
        g.agentCount += 1;
        g.executions += execs;
        m.set(key, g);
      };
      let totalExecutions = 0;
      for (const u of used) {
        const tk = `${u.tenantId}::${u.workflowKey}`;
        const execs = execByTk.get(tk) ?? 0;
        totalExecutions += execs;
        const wf = wfByTk.get(tk);
        const system = (wf?.system && String(wf.system).trim()) || '미지정';
        const team = teamByTk.get(tk) || '미지정 팀';
        const tenant = tenantNameById.get(u.tenantId) || u.tenantId;
        add(bySystem, system, execs);
        add(byTeam, team, execs);
        add(byTenant, tenant, execs);
      }

      const toSorted = (m: Map<string, G>, labelKey: string) =>
        [...m.entries()]
          .map(([name, g]) => ({
            [labelKey]: name,
            agentCount: g.agentCount,
            executions: g.executions,
          }))
          .sort((a: any, b: any) => b.agentCount - a.agentCount || b.executions - a.executions);

      return {
        scope: isPlatform ? 'platform' : 'tenant',
        summary: {
          agentCount: used.length,
          systemCount: bySystem.size,
          teamCount: byTeam.size,
          tenantCount: byTenant.size,
          totalExecutions,
        },
        bySystem: toSorted(bySystem, 'system'),
        byTeam: toSorted(byTeam, 'team'),
        byTenant: toSorted(byTenant, 'tenant'),
        window: { days, since: since.toISOString() },
      };
    } catch (err) {
      this.logger.warn(`getSystemUsage failed: ${(err as Error).message}`);
      return emptyPayload;
    }
  }

  /**
   * SCENARIO 2: load each workflow's CONFIGURED effectiveness baseline
   * (Workflow.effectivenessJson) into a {workflowKey: config} map. These are
   * baseline/target values, NOT measured — the aggregate labels them as such.
   */
  /** 운영 기준값(OpsReferenceConfig) 로드 — 행/테이블/클라이언트 없으면 기본값(절대 크래시 금지). */
  private async loadOpsReference(tenantId: string): Promise<OpsReference> {
    const model = (this.prisma as any).opsReferenceConfig;
    if (!model || typeof model.findUnique !== 'function') return mergeOpsRef(null);
    const row = await model.findUnique({ where: { tenantId } }).catch(() => null);
    return mergeOpsRef(row);
  }

  private async loadEffectivenessConfigs(tenantId: string): Promise<EffectivenessConfigMap> {
    const out: EffectivenessConfigMap = {};
    try {
      const rows = await (this.prisma as any).workflow.findMany({
        where: { tenantId, deletedAt: null },
        select: { key: true, effectivenessJson: true },
        take: 1000,
      });
      for (const r of rows) {
        const raw = r?.effectivenessJson;
        if (!raw || typeof raw !== 'object') continue;
        const mm = Number((raw as any).manualMinutesPerRun);
        if (!Number.isFinite(mm) || mm <= 0) continue; // need a baseline to compute savings
        const cfg: EffectivenessConfig = {
          manualMinutesPerRun: mm,
          domain: typeof (raw as any).domain === 'string' ? (raw as any).domain : undefined,
          coverageTargetX: Number.isFinite(Number((raw as any).coverageTargetX))
            ? Number((raw as any).coverageTargetX)
            : undefined,
          mttdTargetPct: Number.isFinite(Number((raw as any).mttdTargetPct))
            ? Number((raw as any).mttdTargetPct)
            : undefined,
          valueLabel:
            typeof (raw as any).valueLabel === 'string' ? (raw as any).valueLabel : undefined,
          hourlyRateUsd: Number.isFinite(Number((raw as any).hourlyRateUsd))
            ? Number((raw as any).hourlyRateUsd)
            : undefined,
          system: typeof (raw as any).system === 'string' ? (raw as any).system : undefined,
        };
        out[r.key] = cfg;
      }
    } catch (err) {
      this.logger.warn(`loadEffectivenessConfigs failed: ${(err as Error).message}`);
    }
    return out;
  }

  /**
   * SCENARIO 4: registered-agent {workflowKey, name} list. Threaded into the
   * aggregate so the utilization ranking shows real names AND so registered-but-
   * unused (0-execution) agents still surface in the "least used" list.
   */
  private async loadRegisteredAgents(
    tenantId: string,
  ): Promise<Array<{ workflowKey: string; name: string }>> {
    try {
      const rows = await (this.prisma as any).workflow.findMany({
        where: { tenantId, deletedAt: null },
        select: { key: true, name: true },
        take: 1000,
      });
      return rows.map((r: any) => ({ workflowKey: r.key, name: r.name ?? r.key }));
    } catch (err) {
      this.logger.warn(`loadRegisteredAgents failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * SCENARIO 2 + OPS: per-agent + per-system effectiveness.
   *
   * Merges:
   *   - measured savings/ROI + per-run %saved (computeEffectiveness, via overview),
   *   - MTTR per agent (computeMttrByAgent over FDSAlert resolvedAt-createdAt),
   *   - MTTD proxy per agent (computeMttdMinutes over ExecutionSession.latencyMs),
   *   - agent display metadata (name/category from Workflow, system/domain/valueLabel
   *     from Workflow.effectivenessJson),
   * then rolls everything up by `system`.
   *
   * All numbers are REAL (measured) or CONFIGURED targets passed through verbatim.
   */
  async getEffectiveness(
    tenantId: string,
    days = 30,
    filters: { workflowKey?: string; agentName?: string; teamId?: string } = {},
  ): Promise<any> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [agg, alerts, workflowMeta, effSignals, execCounts, securityCounts, teamByKey] =
      await Promise.all([
        // 팀 필터는 getOverview에서 mainAgents를 좁히므로 effectiveness 전체에 파급된다.
        this.getOverview(tenantId, days, filters),
        this.loadMttrAlerts(resolvedTenantId, since),
        this.loadWorkflowMeta(resolvedTenantId),
        this.loadEffectivenessSignals(resolvedTenantId, since),
        this.loadExecCountsByAgent(resolvedTenantId, since),
        this.loadSecurityCountsByAgent(resolvedTenantId, since),
        this.loadTeamByWorkflowKey(resolvedTenantId),
      ]);

    // MEASURED MTTD + coverage per agent key (from EffectivenessSignal rows).
    const mttdSignals = computeMttdFromSignals(
      effSignals
        .filter((r) => r.kind === 'DETECTION')
        .map((r) => ({ workflowKey: r.workflowKey, detectSeconds: r.detectSeconds ?? null })),
    );
    const coverageSignals = computeCoverageFromSignals(
      effSignals
        .filter((r) => r.kind === 'COVERAGE')
        .map((r) => ({
          workflowKey: r.workflowKey,
          coveragePct: r.coveragePct ?? null,
          testsTotal: r.testsTotal ?? null,
          testsPassed: r.testsPassed ?? null,
        })),
    );

    // MTTR per agent key (RESOLVED resolvedAt-createdAt avg hours + resolved/open counts).
    const mttrByAgent = computeMttrByAgent(alerts);

    // MTTD proxy per agent key: mean ExecutionSession.latencyMs (minutes).
    const latByAgent = await this.loadLatenciesByAgent(resolvedTenantId, since);

    const UNASSIGNED = '미지정';

    const agents = agg.mainAgents
      .filter((m) => m.effectiveness)
      .map((m) => {
        const eff = m.effectiveness!;
        const meta = workflowMeta.get(m.workflowKey);
        const system = eff.system ?? meta?.system ?? UNASSIGNED;
        const mttr: MttrAgentEntry = mttrByAgent[m.workflowKey] ?? {
          mttrHours: null,
          resolvedCount: 0,
          openCount: 0,
        };
        // MTTD: prefer the MEASURED signal value; fall back to the latency proxy.
        const sigMttd = mttdSignals[m.workflowKey];
        const proxyMttdMinutes = computeMttdMinutes(latByAgent.get(m.workflowKey) ?? []);
        const hasSignalMttd = !!sigMttd && sigMttd.mttdMinutes != null && sigMttd.samples > 0;
        const mttdActualMinutes = hasSignalMttd ? sigMttd!.mttdMinutes : proxyMttdMinutes;
        const mttdSource: 'signal' | 'latency-proxy' | null = hasSignalMttd
          ? 'signal'
          : proxyMttdMinutes != null
            ? 'latency-proxy'
            : null;
        const mttdSamples = hasSignalMttd ? sigMttd!.samples : 0;
        // Coverage: MEASURED from COVERAGE signals.
        const cov = coverageSignals[m.workflowKey];
        return {
          workflowKey: m.workflowKey,
          name: meta?.name ?? m.workflowKey,
          code: meta?.code ?? null,
          system,
          team: teamByKey.get(m.workflowKey) ?? '미지정 팀',
          domain: meta?.domain ?? null,
          valueLabel: eff.valueLabel,
          category: meta?.category ?? null,
          executions: m.executions,
          successRate: m.successRate,
          manualMinutesPerRun: eff.manualMinutesPerRun,
          aiMinutesPerRun: eff.aiMinutesPerRun,
          timeSavedPct: eff.timeSavedPct,
          timeSavedHours: eff.timeSavedHours,
          roi: eff.roi,
          mttd: {
            targetPct: eff.mttdTargetPct ?? null,
            actualMinutes: mttdActualMinutes,
            source: mttdSource,
            samples: mttdSamples,
          },
          mttr: {
            actualHours: mttr.mttrHours,
            resolvedCount: mttr.resolvedCount,
            openCount: mttr.openCount,
          },
          // MEASURED coverage object (replaces bare coverageTargetX; legacy kept).
          coverage: {
            targetX: eff.coverageTargetX ?? null,
            actualPct: cov?.coveragePct ?? null,
            testsTotal: cov?.testsTotal ?? 0,
            testsPassed: cov?.testsPassed ?? 0,
            samples: cov?.samples ?? 0,
          },
          coverageTargetX: eff.coverageTargetX,
          trend: m.trend,
          // OPS error/security per-agent enrichment (cheap; ADD-only).
          failedCount: execCounts.get(m.workflowKey)?.failed ?? 0,
          errorRate: (() => {
            const c = execCounts.get(m.workflowKey);
            return c && c.total ? Math.round((c.failed / c.total) * 1000) / 10 : 0;
          })(),
          securityIssueCount: securityCounts.get(m.workflowKey)?.securityIssueCount ?? 0,
          criticalSecurityCount: securityCounts.get(m.workflowKey)?.criticalSecurityCount ?? 0,
        };
      });

    // ── summary ──
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const totalTimeSavedHours = r2(agents.reduce((s, a) => s + (a.timeSavedHours || 0), 0));
    const pctVals = agents.map((a) => a.timeSavedPct).filter((x) => Number.isFinite(x));
    const avgTimeSavedPct = pctVals.length
      ? r1(pctVals.reduce((s, x) => s + x, 0) / pctVals.length)
      : 0;
    const totalNetValueUsd = r2(agents.reduce((s, a) => s + (a.roi?.netValueUsd || 0), 0));
    const mttrVals = agents
      .map((a) => a.mttr.actualHours)
      .filter((x): x is number => x != null && Number.isFinite(x));
    const avgMttrHours = mttrVals.length
      ? r2(mttrVals.reduce((s, x) => s + x, 0) / mttrVals.length)
      : null;
    const resolvedAlertCount = agents.reduce((s, a) => s + a.mttr.resolvedCount, 0);
    const openAlertCount = agents.reduce((s, a) => s + a.mttr.openCount, 0);
    const systemSet = new Set(agents.map((a) => a.system));

    const summary = {
      totalTimeSavedHours,
      avgTimeSavedPct,
      totalNetValueUsd,
      roiRatio: agg.effectiveness.roiRatio,
      avgMttrHours,
      resolvedAlertCount,
      openAlertCount,
      systemCount: systemSet.size,
      mttdSampleCount: agents.reduce((acc, a) => acc + (a.mttd?.samples || 0), 0),
      coverageSampleCount: agents.reduce((acc, a) => acc + (a.coverage?.samples || 0), 0),
    };

    // ── bySystem rollup ──
    const sysMap = new Map<
      string,
      {
        agentCount: number;
        totalTimeSavedHours: number;
        pcts: number[];
        totalNetValueUsd: number;
        mttrs: number[];
      }
    >();
    for (const a of agents) {
      let g = sysMap.get(a.system);
      if (!g) {
        g = { agentCount: 0, totalTimeSavedHours: 0, pcts: [], totalNetValueUsd: 0, mttrs: [] };
        sysMap.set(a.system, g);
      }
      g.agentCount += 1;
      g.totalTimeSavedHours += a.timeSavedHours || 0;
      if (Number.isFinite(a.timeSavedPct)) g.pcts.push(a.timeSavedPct);
      g.totalNetValueUsd += a.roi?.netValueUsd || 0;
      if (a.mttr.actualHours != null && Number.isFinite(a.mttr.actualHours))
        g.mttrs.push(a.mttr.actualHours);
    }
    // OPS rollup (usage/error/security) by system via the pure helper. The
    // agent->system map is resolved above (column-first, then json, then UNASSIGNED).
    const opsStats: AgentOpsStat[] = agents.map((a) => ({
      workflowKey: a.workflowKey,
      system: a.system,
      executions: a.executions,
      successfulCount: Math.max(0, a.executions - (a.failedCount || 0)),
      failedCount: a.failedCount || 0,
      securityIssueCount: a.securityIssueCount || 0,
      criticalSecurityCount: a.criticalSecurityCount || 0,
    }));
    const opsBySystem = rollupSystemsOps(opsStats);

    const bySystem = Array.from(sysMap.entries())
      .map(([system, g]) => {
        const ops = opsBySystem[system] ?? {
          executions: 0,
          successRate: 0,
          failedCount: 0,
          errorRate: 0,
          securityIssueCount: 0,
          criticalSecurityCount: 0,
        };
        return {
          system,
          agentCount: g.agentCount,
          totalTimeSavedHours: r2(g.totalTimeSavedHours),
          avgTimeSavedPct: g.pcts.length
            ? r1(g.pcts.reduce((s, x) => s + x, 0) / g.pcts.length)
            : 0,
          totalNetValueUsd: r2(g.totalNetValueUsd),
          avgMttrHours: g.mttrs.length
            ? r2(g.mttrs.reduce((s, x) => s + x, 0) / g.mttrs.length)
            : null,
          // OPS enrichment (usage / error / security).
          executions: ops.executions,
          successRate: ops.successRate,
          failedCount: ops.failedCount,
          errorRate: ops.errorRate,
          securityIssueCount: ops.securityIssueCount,
          criticalSecurityCount: ops.criticalSecurityCount,
        };
      })
      .sort(
        (x, y) => y.totalTimeSavedHours - x.totalTimeSavedHours || x.system.localeCompare(y.system),
      );

    return { window: agg.window, summary, agents, bySystem };
  }

  /**
   * Load EffectivenessSignal rows (MEASURED MTTD / coverage source data) for the
   * tenant + window. Tenant-scoped, best-effort (returns [] when the table is
   * missing pre-`db push`). Fed into computeMttdFromSignals / computeCoverageFromSignals.
   */
  private async loadEffectivenessSignals(
    tenantId: string,
    since: Date,
  ): Promise<
    Array<{
      kind: string;
      workflowKey: string;
      detectSeconds: number | null;
      coveragePct: number | null;
      testsTotal: number | null;
      testsPassed: number | null;
    }>
  > {
    try {
      const rows = await (this.prisma as any).effectivenessSignal.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: {
          kind: true,
          workflowKey: true,
          detectSeconds: true,
          coveragePct: true,
          testsTotal: true,
          testsPassed: true,
        },
        take: 10000,
      });
      return rows.map((r: any) => ({
        kind: String(r.kind),
        workflowKey: r.workflowKey,
        detectSeconds: r.detectSeconds ?? null,
        coveragePct: r.coveragePct ?? null,
        testsTotal: r.testsTotal ?? null,
        testsPassed: r.testsPassed ?? null,
      }));
    } catch (err) {
      this.logger.warn(`loadEffectivenessSignals failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Load FDSAlert rows (with resolvedAt + detailsJson) for MTTR computation.
   * detailsJson.workflowKey is the agent key. Tenant-scoped, windowed.
   */
  private async loadMttrAlerts(tenantId: string, since: Date): Promise<MttrAlertRow[]> {
    try {
      const rows = await (this.prisma as any).fDSAlert.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: { status: true, createdAt: true, resolvedAt: true, detailsJson: true },
        take: 5000,
      });
      return rows.map((r: any) => ({
        status: r.status,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt ?? null,
        detailsJson: r.detailsJson ?? null,
      }));
    } catch (err) {
      this.logger.warn(`loadMttrAlerts failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Load per-agent ExecutionSession latencies (ms) for the MTTD proxy.
   * Returns a map workflowKey -> latencyMs[].
   */
  private async loadLatenciesByAgent(
    tenantId: string,
    since: Date,
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    try {
      const rows = await (this.prisma as any).executionSession.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: { workflowKey: true, latencyMs: true },
        take: 10000,
      });
      for (const r of rows) {
        const k = r?.workflowKey;
        if (!k || typeof k !== 'string') continue;
        if (r.latencyMs == null) continue;
        if (!out.has(k)) out.set(k, []);
        out.get(k)!.push(Number(r.latencyMs));
      }
    } catch (err) {
      this.logger.warn(`loadLatenciesByAgent failed: ${(err as Error).message}`);
    }
    return out;
  }

  /**
   * Per-agent execution usage/error counts over the window.
   * Returns map workflowKey -> { total, failed }. status==='FAILED' => failed.
   * Tenant-scoped, best-effort.
   */
  private async loadExecCountsByAgent(
    tenantId: string,
    since: Date,
  ): Promise<Map<string, { total: number; failed: number }>> {
    const out = new Map<string, { total: number; failed: number }>();
    try {
      const rows = await (this.prisma as any).executionSession.groupBy({
        by: ['workflowKey', 'status'],
        where: { tenantId, createdAt: { gte: since }, workflowKey: { not: null } },
        _count: { _all: true },
      });
      for (const r of rows) {
        const k = r?.workflowKey;
        if (!k || typeof k !== 'string') continue;
        const n = Number(r?._count?._all ?? 0);
        if (!out.has(k)) out.set(k, { total: 0, failed: 0 });
        const e = out.get(k)!;
        e.total += n;
        if (String(r.status).toUpperCase() === 'FAILED') e.failed += n;
      }
    } catch (err) {
      this.logger.warn(`loadExecCountsByAgent failed: ${(err as Error).message}`);
    }
    return out;
  }

  /**
   * Per-agent security-issue counts from AgentEvaluation over the window.
   * Returns map workflowKey -> { securityIssueCount (high|critical), criticalSecurityCount }.
   * Tenant-scoped, best-effort.
   */
  private async loadSecurityCountsByAgent(
    tenantId: string,
    since: Date,
  ): Promise<Map<string, { securityIssueCount: number; criticalSecurityCount: number }>> {
    const out = new Map<string, { securityIssueCount: number; criticalSecurityCount: number }>();
    try {
      const rows = await (this.prisma as any).agentEvaluation.findMany({
        where: {
          tenantId,
          createdAt: { gte: since },
          workflowKey: { not: null },
          securityRiskLevel: { in: ['high', 'critical'] },
          NOT: { workflowKey: { startsWith: 'nodetest-' } }, // 테스트 평가 제외
        },
        select: { workflowKey: true, securityRiskLevel: true },
        take: 20000,
      });
      for (const r of rows) {
        const k = r?.workflowKey;
        if (!k || typeof k !== 'string') continue;
        if (!out.has(k)) out.set(k, { securityIssueCount: 0, criticalSecurityCount: 0 });
        const e = out.get(k)!;
        e.securityIssueCount += 1;
        if (String(r.securityRiskLevel).toLowerCase() === 'critical') e.criticalSecurityCount += 1;
      }
    } catch (err) {
      this.logger.warn(`loadSecurityCountsByAgent failed: ${(err as Error).message}`);
    }
    return out;
  }

  /**
   * Workflow display metadata for the effectiveness table: name + category
   * (tags[0]) from the Workflow row, plus system/domain echoed from
   * effectivenessJson. Keyed by workflowKey.
   */
  private async loadWorkflowMeta(tenantId: string): Promise<
    Map<
      string,
      {
        name: string;
        code: string | null;
        category: string | null;
        system: string | null;
        domain: string | null;
      }
    >
  > {
    const out = new Map<
      string,
      {
        name: string;
        code: string | null;
        category: string | null;
        system: string | null;
        domain: string | null;
      }
    >();
    try {
      const rows = await (this.prisma as any).workflow.findMany({
        where: { tenantId, deletedAt: null },
        select: {
          key: true,
          name: true,
          code: true,
          tags: true,
          system: true,
          effectivenessJson: true,
        },
        take: 1000,
      });
      for (const r of rows) {
        const raw = (
          r?.effectivenessJson && typeof r.effectivenessJson === 'object' ? r.effectivenessJson : {}
        ) as any;
        // Prefer the promoted Workflow.system column; fall back to effectivenessJson.system.
        const sys =
          typeof r.system === 'string' && r.system
            ? r.system
            : typeof raw.system === 'string'
              ? raw.system
              : null;
        out.set(r.key, {
          name: r.name ?? r.key,
          code: typeof r.code === 'string' ? r.code : null,
          category: Array.isArray(r.tags) && r.tags.length ? String(r.tags[0]) : null,
          system: sys,
          domain: typeof raw.domain === 'string' ? raw.domain : null,
        });
      }
    } catch (err) {
      this.logger.warn(`loadWorkflowMeta failed: ${(err as Error).message}`);
    }
    return out;
  }

  /**
   * SCENARIO 4 (PART B): list the SUB-AGENT nodes (WorkflowNodeDef) across the
   * tenant's listed, non-deleted workflows so the connector menu reflects the
   * actual workflow sub-agents (not just static node types).
   *
   * Returns a flat node list AND a deduped-by-node view that groups the same
   * logical node (nodeKey+uiType+name) across the workflows it appears in.
   */
  async getNodes(tenantId: string): Promise<{
    nodes: Array<{
      workflowKey: string;
      workflowName: string;
      nodeKey: string;
      uiType: string;
      name: string;
      executionOrder: number;
    }>;
    grouped: Array<{
      nodeKey: string;
      uiType: string;
      name: string;
      count: number;
      workflows: Array<{ workflowKey: string; workflowName: string }>;
      // 실제 실행(execute-node)용 — 대표 인스턴스의 설정/카테고리.
      category: string;
      settings: Record<string, any>;
    }>;
    totalNodes: number;
    totalWorkflows: number;
  }> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const p = this.prisma as any;
    try {
      const workflows = await p.workflow.findMany({
        where: { tenantId: resolvedTenantId, deletedAt: null, listed: true },
        select: {
          key: true,
          name: true,
          nodes: {
            select: {
              nodeKey: true,
              uiType: true,
              name: true,
              executionOrder: true,
              configJson: true,
            },
            orderBy: { executionOrder: 'asc' },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 500,
      });

      const nodes: Array<{
        workflowKey: string;
        workflowName: string;
        nodeKey: string;
        uiType: string;
        name: string;
        executionOrder: number;
        configJson: Record<string, any>;
      }> = [];
      for (const w of workflows) {
        for (const n of w.nodes ?? []) {
          nodes.push({
            workflowKey: w.key,
            workflowName: w.name ?? w.key,
            nodeKey: n.nodeKey,
            uiType: n.uiType,
            name: n.name,
            executionOrder: n.executionOrder ?? 0,
            configJson: (n.configJson as Record<string, any>) ?? {},
          });
        }
      }

      // Group/dedup by logical node (nodeKey + uiType + name).
      const groupMap = new Map<
        string,
        {
          nodeKey: string;
          uiType: string;
          name: string;
          count: number;
          workflows: Array<{ workflowKey: string; workflowName: string }>;
          category: string;
          settings: Record<string, any>;
        }
      >();
      for (const n of nodes) {
        const id = `${n.nodeKey}|${n.uiType}|${n.name}`;
        let g = groupMap.get(id);
        if (!g) {
          const cfg = n.configJson ?? {};
          g = {
            nodeKey: n.nodeKey,
            uiType: n.uiType,
            name: n.name,
            count: 0,
            workflows: [],
            // 대표 인스턴스 기준 카테고리/설정 — execute-node 해석에 사용.
            category: typeof cfg.stepCategory === 'string' ? cfg.stepCategory : '',
            settings: cfg,
          };
          groupMap.set(id, g);
        }
        g.count += 1;
        if (!g.workflows.some((x) => x.workflowKey === n.workflowKey)) {
          g.workflows.push({ workflowKey: n.workflowKey, workflowName: n.workflowName });
        }
      }
      const grouped = Array.from(groupMap.values()).sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name),
      );

      return {
        nodes,
        grouped,
        totalNodes: nodes.length,
        totalWorkflows: workflows.length,
      };
    } catch (err) {
      this.logger.warn(`getNodes failed: ${(err as Error).message}`);
      return { nodes: [], grouped: [], totalNodes: 0, totalWorkflows: 0 };
    } finally {
      // no-op (keeps try/finally balanced for the early return below)
    }
  }

  /**
   * Sub-Agent 단독 실행(테스트) 4게이트 평가 이력 — isTest=true 평가만 조회한다.
   * 운영 대시보드와 분리된 'Sub-Agent 평가 이력' 화면용.
   */
  async getNodeTestHistory(
    tenantId: string,
    agentName?: string,
    limit = 20,
  ): Promise<{
    rows: Array<{
      id: string;
      agentName: string | null;
      nodeType: string;
      overallScore: number;
      qualityGrade: string | null;
      securityScore: number | null;
      securityRiskLevel: string | null;
      costEfficiency: number | null;
      estimatedCostUsd: number | null;
      anomalyDetected: boolean;
      createdAt: Date;
    }>;
  }> {
    try {
      const resolvedTenantId = await this.resolveTenantId(tenantId);
      // 테스트/단독 실행 평가만(workflowKey='nodetest-*').
      const where: any = { tenantId: resolvedTenantId, workflowKey: { startsWith: 'nodetest-' } };
      if (agentName) where.agentName = agentName;
      const rows = await (this.prisma as any).agentEvaluation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          agentName: true,
          nodeType: true,
          overallScore: true,
          qualityGrade: true,
          securityScore: true,
          securityRiskLevel: true,
          costEfficiency: true,
          estimatedCostUsd: true,
          anomalyDetected: true,
          createdAt: true,
        },
      });
      return { rows };
    } catch (err) {
      this.logger.warn(`getNodeTestHistory failed: ${(err as Error).message}`);
      return { rows: [] };
    }
  }

  /**
   * Agent launcher list — workflows (main agents) with quick status.
   * @param category optional filter: matches a workflow tag (e.g. 'operations',
   *                 'development'). Tag match is case-insensitive; also accepts
   *                 a few Korean aliases. When omitted, returns all.
   */
  async getAgents(
    tenantId: string,
    days = 30,
    category?: string,
    includeUnlisted = false,
    teamId?: string,
  ): Promise<{ items: any[] }> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);

    let workflows: any[] = [];
    try {
      // SCENARIO 3 catalog gate: the user-facing Ops.AI category list shows ONLY
      // ORB-approved (listed=true) workflows. Admin dashboards pass
      // includeUnlisted=true to still see everything.
      const where: any = { tenantId: resolvedTenantId, deletedAt: null };
      if (!includeUnlisted) where.listed = true;
      if (teamId) where.createdBy = { teamId }; // 팀 필터(생성자 소속 팀)

      workflows = await (this.prisma as any).workflow.findMany({
        where,
        select: {
          key: true,
          code: true,
          name: true,
          status: true,
          listed: true,
          description: true,
          tags: true,
          updatedAt: true,
          effectivenessJson: true,
          nodes: {
            select: { name: true, uiType: true, nodeKey: true, configJson: true },
            orderBy: { executionOrder: 'asc' },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 500,
      });
    } catch (err) {
      this.logger.warn(`getAgents workflow query failed: ${(err as Error).message}`);
    }

    if (category) {
      // 간소화버전: 편의(utility) 탭 폐지 → utility 태그 Agent는 운영(operations)에 합산
      const aliases: Record<string, string[]> = {
        operations: ['operations', 'operation', 'ops', '운영', 'utility', 'util', '편의'],
        development: ['development', 'dev', '개발'],
      };
      const wanted = aliases[category.toLowerCase()] ?? [category.toLowerCase()];
      workflows = workflows.filter((w) => {
        const tags = (Array.isArray(w.tags) ? w.tags : []).map((t: string) =>
          String(t).toLowerCase(),
        );
        return tags.some((t: string) => wanted.includes(t));
      });
    }

    const agg = await this.getOverview(tenantId, days);
    const byKey = new Map(agg.mainAgents.map((m) => [m.workflowKey, m]));

    const items = workflows.map((w) => {
      const roll = byKey.get(w.key);
      const subs = Array.isArray(w.nodes) ? w.nodes : [];
      return {
        key: w.key,
        code: w.code ?? null,
        name: w.name,
        status: w.status,
        listed: w.listed ?? true,
        description: w.description ?? '',
        tags: Array.isArray(w.tags) ? w.tags : [],
        updatedAt: w.updatedAt,
        // 외부 전용 실행 화면 URL(있으면 클릭 시 새 탭으로 그 화면을 연다).
        launchUrl:
          w.effectivenessJson && typeof w.effectivenessJson === 'object'
            ? ((w.effectivenessJson as any).launchUrl ?? null)
            : null,
        // 메인+서브 한눈에: Sub-Agent(노드) 수 + 목록.
        subAgentCount: subs.length,
        subAgents: subs.map((n: any) => {
          const cfg = n.configJson && typeof n.configJson === 'object' ? (n.configJson as any) : {};
          // 기준정보에서 등록한 노드는 kind='agent' 로 명시; 그 외엔 uiType 으로 분류.
          const isAgent = cfg.kind === 'agent' ? true : isAgentNode(n.uiType);
          return {
            name: n.name,
            uiType: n.uiType,
            nodeKey: n.nodeKey,
            launchUrl: cfg.launchUrl ?? null,
            isAgent,
          };
        }),
        health: roll?.health ?? 'idle',
        executions: roll?.executions ?? 0,
        successRate: roll?.successRate ?? 0,
        avgScore: roll?.avgScore ?? 0,
        anomalyCount: roll?.anomalyCount ?? 0,
      };
    });
    return { items };
  }

  /**
   * Recent execution history, optionally filtered to a set of workflow keys
   * (e.g. all 'operations' agents). Used by the per-category Agent pages.
   */
  async getExecutionHistory(
    tenantId: string,
    opts: { workflowKeys?: string[]; limit?: number; days?: number; triggeredById?: string } = {},
  ): Promise<{ items: any[] }> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const since = new Date();
    since.setDate(since.getDate() - (opts.days ?? 30));
    const where: any = { tenantId: resolvedTenantId, createdAt: { gte: since } };
    if (opts.workflowKeys && opts.workflowKeys.length)
      where.workflowKey = { in: opts.workflowKeys };
    // Personalization: restrict to the requesting user's own runs when asked.
    if (opts.triggeredById) where.triggeredById = opts.triggeredById;
    try {
      const rows = await (this.prisma as any).executionSession.findMany({
        where,
        select: {
          id: true,
          workflowKey: true,
          capabilityKey: true,
          status: true,
          costUsd: true,
          latencyMs: true,
          startedAt: true,
          endedAt: true,
          createdAt: true,
          triggeredById: true,
        },
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(500, opts.limit ?? 100)),
      });
      return {
        items: rows.map((r: any) => ({
          id: r.id,
          workflowKey: r.workflowKey ?? null,
          capabilityKey: r.capabilityKey ?? null,
          status: r.status,
          costUsd: r.costUsd != null ? Number(r.costUsd) : null,
          latencyMs: r.latencyMs ?? null,
          createdAt: r.createdAt,
          triggeredById: r.triggeredById ?? null,
        })),
      };
    } catch (err) {
      this.logger.warn(`getExecutionHistory failed: ${(err as Error).message}`);
      return { items: [] };
    }
  }

  /** Single main agent detail with sub-agent (node) rollups. */
  async getAgentDetail(tenantId: string, workflowKey: string, days = 30): Promise<any> {
    const agg = await this.getOverview(tenantId, days);
    const main = agg.mainAgents.find((m) => m.workflowKey === workflowKey);
    return { workflowKey, found: !!main, detail: main ?? null, window: agg.window };
  }

  /**
   * Full detail for a single execution: session + per-step (sub-agent)
   * evaluations (quality / security / cost / error / runtime), related policy
   * alarms, active policies, and related knowledge. Powers the rich execution
   * history detail popup.
   */
  async getExecutionDetail(tenantId: string, sessionId: string): Promise<any> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const p = this.prisma as any;

    const session = await p.executionSession.findFirst({
      where: { id: sessionId, tenantId: resolvedTenantId },
      select: {
        id: true,
        workflowKey: true,
        capabilityKey: true,
        status: true,
        costUsd: true,
        latencyMs: true,
        startedAt: true,
        endedAt: true,
        completedAt: true,
        createdAt: true,
        triggeredById: true,
        correlationId: true,
      },
    });
    if (!session) return { found: false };

    const [steps, evals, alerts, workflow, knowledge] = await Promise.all([
      p.executionStep
        .findMany({
          where: { executionSessionId: sessionId },
          select: {
            stepKey: true,
            stepType: true,
            capabilityKey: true,
            status: true,
            latencyMs: true,
            errorMessage: true,
            startedAt: true,
            endedAt: true,
          },
          orderBy: { startedAt: 'asc' },
        })
        .catch(() => []),
      p.agentEvaluation
        .findMany({
          where: { executionSessionId: sessionId },
          select: {
            stepKey: true,
            nodeType: true,
            agentName: true,
            overallScore: true,
            qualityGrade: true,
            accuracyScore: true,
            hallucationRate: true,
            responseQuality: true,
            securityScore: true,
            securityRiskLevel: true,
            inputThreatCount: true,
            outputLeakageCount: true,
            toolChainRisk: true,
            anomalyDetected: true,
            anomalyEvents: true,
            estimatedCostUsd: true,
            executionTimeMs: true,
            tokensUsed: true,
            costEfficiency: true,
            latencyGrade: true,
            recommendations: true,
          },
        })
        .catch(() => []),
      p.fDSAlert
        .findMany({
          where: { tenantId: resolvedTenantId, subjectId: session.workflowKey ?? '__none__' },
          select: {
            severity: true,
            status: true,
            summary: true,
            score: true,
            createdAt: true,
            detailsJson: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
        .catch(() => []),
      session.workflowKey
        ? p.workflow
            .findFirst({
              where: { tenantId: resolvedTenantId, key: session.workflowKey },
              select: { name: true, tags: true, description: true },
            })
            .catch(() => null)
        : null,
      p.knowledgeArtifact
        .findMany({
          // exclude auth/credential artifacts — they are not domain knowledge
          where: {
            tenantId: resolvedTenantId,
            category: { notIn: ['AUTH', 'CREDENTIAL', 'auth', 'credential'] },
          },
          select: { title: true, category: true, status: true },
          take: 5,
          orderBy: { updatedAt: 'desc' },
        })
        .catch(() => []),
    ]);

    // Active governance policies (정책) for context.
    let policies: Array<{ name: string; type: string }> = [];
    try {
      const rows = await p.policy.findMany({
        where: { tenantId: resolvedTenantId, isActive: true },
        select: { name: true, ruleYaml: true },
        take: 20,
      });
      policies = rows.map((r: any) => {
        let type = 'COMPLIANCE';
        try {
          type = JSON.parse(r.ruleYaml || '{}').type ?? type;
        } catch {
          /* keep default */
        }
        return { name: r.name, type };
      });
    } catch {
      /* ignore */
    }

    // Filter alerts to those correlated with this session when possible.
    const relatedAlerts = (alerts as any[]).filter((a) => {
      const d = a.detailsJson || {};
      return !d.workflowKey || d.workflowKey === session.workflowKey;
    });

    return {
      found: true,
      session: {
        ...session,
        costUsd: session.costUsd != null ? Number(session.costUsd) : null,
        workflowName: workflow?.name ?? session.workflowKey,
        category: Array.isArray(workflow?.tags) ? workflow!.tags[0] : null,
      },
      steps: steps as any[],
      evaluations: (evals as any[]).map((e) => ({
        ...e,
        accuracyScore: e.accuracyScore != null ? Math.round(e.accuracyScore * 100) : null,
        hallucationRate: e.hallucationRate != null ? Math.round(e.hallucationRate * 100) : null,
        estimatedCostUsd: e.estimatedCostUsd != null ? Number(e.estimatedCostUsd) : null,
      })),
      alerts: relatedAlerts,
      policies,
      knowledge: knowledge as any[],
    };
  }

  // ── private loaders ──

  /**
   * workflowKey → 팀명. 팀 귀속은 IngestApiKey(agentKey=workflow.key, teamId)로 결정한다.
   * (Agent는 팀에 배정된 Ingest 키로 실행을 보고하므로 그 키의 팀이 곧 Agent의 팀.)
   * 매핑 없는 워크플로우는 '미지정 팀'.
   */
  private async loadTeamByWorkflowKey(tenantId: string): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      const rows = await (this.prisma as any).ingestApiKey.findMany({
        where: { tenantId, agentKey: { not: null } },
        select: { agentKey: true, team: { select: { name: true } } },
        take: 5000,
      });
      for (const r of rows) {
        if (r.agentKey && !m.has(r.agentKey)) m.set(r.agentKey, r.team?.name || '미지정 팀');
      }
    } catch (err) {
      this.logger.warn(`loadTeamByWorkflowKey failed: ${(err as Error).message}`);
    }
    return m;
  }

  /** 팀(= 팀에 배정된 Ingest 키)에 연결된 workflowKey 집합. 빈 배열이면 해당 팀 Agent 없음. */
  private async resolveTeamWorkflowKeys(tenantId: string, teamId: string): Promise<string[]> {
    try {
      const rows = await (this.prisma as any).ingestApiKey.findMany({
        where: { tenantId, teamId, agentKey: { not: null } },
        select: { agentKey: true },
        take: 5000,
      });
      return [...new Set(rows.map((r: any) => r.agentKey).filter(Boolean))] as string[];
    } catch (err) {
      this.logger.warn(`resolveTeamWorkflowKeys failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async loadExecRows(
    tenantId: string,
    since: Date,
    filters: { workflowKey?: string; agentName?: string; workflowKeys?: string[] } = {},
  ): Promise<ExecRow[]> {
    try {
      const where: any = { tenantId, createdAt: { gte: since } };
      if (filters.workflowKey) where.workflowKey = filters.workflowKey;
      else if (filters.workflowKeys) where.workflowKey = { in: filters.workflowKeys };
      const rows = await (this.prisma as any).executionSession.findMany({
        where,
        select: {
          workflowKey: true,
          status: true,
          costUsd: true,
          latencyMs: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });
      return rows
        .filter((r: any) => !String(r.workflowKey ?? '').startsWith('adhoc-'))
        .map((r: any) => ({
          workflowKey: r.workflowKey ?? null,
          status: r.status,
          costUsd: r.costUsd != null ? Number(r.costUsd) : null,
          latencyMs: r.latencyMs ?? null,
          createdAt: r.createdAt,
        }));
    } catch (err) {
      this.logger.warn(`loadExecRows failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async loadEvalRows(
    tenantId: string,
    since: Date,
    filters: { workflowKey?: string; agentName?: string; workflowKeys?: string[] } = {},
  ): Promise<EvalRow[]> {
    try {
      const where: any = {
        tenantId,
        createdAt: { gte: since },
        NOT: { workflowKey: { startsWith: 'nodetest-' } },
      };
      if (filters.workflowKey) where.workflowKey = filters.workflowKey;
      else if (filters.workflowKeys) where.workflowKey = { in: filters.workflowKeys };
      if (filters.agentName) where.agentName = filters.agentName;
      const evals = await (this.prisma as any).agentEvaluation.findMany({
        where,
        select: {
          executionSessionId: true,
          workflowKey: true,
          stepKey: true,
          nodeType: true,
          agentName: true,
          overallScore: true,
          accuracyScore: true,
          hallucationRate: true,
          securityScore: true,
          securityRiskLevel: true,
          anomalyDetected: true,
          estimatedCostUsd: true,
          executionTimeMs: true,
          qualityGrade: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });

      // Prefer the denormalized workflowKey; fall back to a session join only
      // for older rows written before the column existed.
      const missing = evals.filter((e: any) => !e.workflowKey);
      const keyBySession = new Map<string, string | null>();
      if (missing.length) {
        const sessionIds = Array.from(
          new Set(missing.map((e: any) => e.executionSessionId).filter(Boolean)),
        );
        if (sessionIds.length) {
          const sessions = await (this.prisma as any).executionSession.findMany({
            where: { id: { in: sessionIds } },
            select: { id: true, workflowKey: true },
          });
          for (const s of sessions) keyBySession.set(s.id, s.workflowKey ?? null);
        }
      }

      return evals
        .map((e: any) => ({
          workflowKey: e.workflowKey ?? keyBySession.get(e.executionSessionId) ?? null,
          stepKey: e.stepKey,
          nodeType: e.nodeType ?? null,
          agentName: e.agentName ?? null,
          overallScore: typeof e.overallScore === 'number' ? e.overallScore : 0,
          accuracyScore: e.accuracyScore ?? null,
          hallucationRate: e.hallucationRate ?? null,
          securityScore: e.securityScore ?? null,
          securityRiskLevel: e.securityRiskLevel ?? null,
          anomalyDetected: !!e.anomalyDetected,
          estimatedCostUsd: e.estimatedCostUsd ?? null,
          executionTimeMs: e.executionTimeMs ?? null,
          qualityGrade: e.qualityGrade ?? null,
          createdAt: e.createdAt,
        }))
        .filter((r: EvalRow) => !String(r.workflowKey ?? '').startsWith('adhoc-'));
    } catch (err) {
      this.logger.warn(`loadEvalRows failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Real counts for the left-nav badges (replaces hardcoded numbers).
   * Agent category counts reuse getAgents() so they match the agent screens
   * exactly; the rest are live row counts. Every count fails soft to 0.
   */
  async getNavCounts(tenantId: string): Promise<{
    agentOps: number; agentDev: number; agentQa: number; agentUtil: number;
    auditLogs: number; policies: number; knowledgeArtifacts: number; errorPatterns: number;
  }> {
    const rid = await this.resolveTenantId(tenantId).catch(() => tenantId);
    const safe = async (fn: () => Promise<number>) => {
      try { return await fn(); } catch { return 0; }
    };
    const agentCount = (cat: string) =>
      this.getAgents(tenantId, 365, cat).then((r: any) => (r?.items?.length ?? 0)).catch(() => 0);

    const [agentOps, agentDev, agentQa, agentUtil, auditLogs, policies, knowledgeArtifacts, errorPatterns] =
      await Promise.all([
        agentCount('operations'),
        agentCount('development'),
        agentCount('qa'),
        agentCount('utility'),
        safe(() => (this.prisma as any).auditLog.count({ where: { tenantId: rid } })),
        safe(() => (this.prisma as any).policy.count({ where: { tenantId: rid } })),
        safe(() => (this.prisma as any).knowledgeArtifact.count({ where: { tenantId: rid } })),
        safe(() => (this.prisma as any).errorPattern.count({ where: { tenantId: rid } })),
      ]);

    return { agentOps, agentDev, agentQa, agentUtil, auditLogs, policies, knowledgeArtifacts, errorPatterns };
  }

  private async resolveTenantId(tenantId: string): Promise<string> {
    // C-3 fix: validate the JWT tenantId exists. NEVER fall back to another
    // tenant (that would be a cross-tenant data breach). Throw instead.
    const tenant = await (this.prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (tenant) return tenant.id;
    throw new ForbiddenException('Invalid tenant');
  }
}
