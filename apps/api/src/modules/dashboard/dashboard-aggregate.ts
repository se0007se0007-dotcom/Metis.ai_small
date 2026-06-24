/**
 * Dashboard aggregation — pure logic.
 *
 * Hierarchy mapping (per metis.flo):
 *   main agent = Workflow      (identified by workflowKey)
 *   sub agent  = Workflow node (identified by stepKey / nodeType)
 *
 * Aggregates raw ExecutionSession + AgentEvaluation rows into the three
 * dashboard axes the home screen summarizes:
 *   1) KPI    — total executions, success rate, avg latency, monthly cost, anomalies
 *   2) Quality— avg overall score, avg accuracy, hallucination, grade distribution
 *   3) Health — per-main-agent healthy/degraded/down rollup
 *
 * Pure & deterministic (no NestJS/Prisma) for unit testing. The service layer
 * feeds it plain rows.
 *
 * @module dashboard
 */

import {
  computeEffectiveness,
  computeTrend,
  EffectivenessConfig,
  EffectivenessResult,
  TrendResult,
} from './effectiveness';
import { OpsReference, OPS_REFERENCE_DEFAULTS } from '../../common/ops-reference.defaults';

/** Minimal execution row. */
export interface ExecRow {
  workflowKey: string | null;
  status: string; // QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED/BLOCKED
  costUsd?: number | null; // Decimal serialized to number
  latencyMs?: number | null;
  createdAt: Date | string;
}

/** Minimal evaluation row (sub-agent grained). */
export interface EvalRow {
  workflowKey?: string | null; // resolved from session join (may be null)
  stepKey: string;
  nodeType?: string | null;
  agentName?: string | null;
  overallScore: number;
  accuracyScore?: number | null;
  hallucationRate?: number | null;
  securityScore?: number | null;
  securityRiskLevel?: string | null;
  anomalyDetected: boolean;
  estimatedCostUsd?: number | null;
  executionTimeMs?: number | null;
  qualityGrade?: string | null;
  createdAt: Date | string;
}

export interface KpiSummary {
  totalExecutions: number;
  successRate: number; // 0-100
  avgLatencyMs: number;
  monthlyCostUsd: number;
  anomalyCount: number;
}

export interface QualitySummary {
  avgOverallScore: number; // 0-100
  avgAccuracy: number; // 0-100
  avgHallucinationRate: number; // 0-100
  gradeDistribution: Record<string, number>; // A/B/C/D/F counts
  evaluatedCount: number;
}

export type HealthState = 'healthy' | 'degraded' | 'down' | 'idle';

export interface SubAgentRollup {
  stepKey: string;
  nodeType: string | null;
  agentName: string | null;
  evaluations: number;
  avgScore: number;
  anomalyCount: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  health: HealthState;
  worstSecurityRisk: string | null;
}

export interface MainAgentRollup {
  workflowKey: string;
  /** ADD-only: Workflow display name, decorated in DashboardService.getOverview. */
  name?: string;
  /** ADD-only: human-facing agent code (e.g. "DEV-003"), decorated in getOverview. */
  code?: string | null;
  executions: number;
  successRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  avgScore: number;
  anomalyCount: number;
  health: HealthState;
  subAgents: SubAgentRollup[];
  /** SCENARIO 2: per-agent quality/security/cost/success trend (real, current vs previous window). */
  trend: TrendResult | null;
  /** SCENARIO 2: per-agent effectiveness (measured savings/ROI + configured targets). */
  effectiveness: EffectivenessResult | null;
}

export interface HealthSummary {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  idle: number;
}

/** One day of aggregated metrics for the executive trend charts. */
export interface DailyPoint {
  date: string; // YYYY-MM-DD
  executions: number;
  successRate: number; // 0-100
  costUsd: number;
  avgScore: number; // 0-100 (quality)
  anomalies: number;
}

/** Map of workflowKey -> configured effectiveness baseline (Workflow.effectivenessJson). */
export type EffectivenessConfigMap = Record<string, EffectivenessConfig>;

/** Tenant-level rollup of per-agent effectiveness (SCENARIO 2). */
export interface EffectivenessSummary {
  agentsWithConfig: number;
  totalTimeSavedHours: number;
  totalLaborValueUsd: number;
  totalCostUsd: number;
  totalNetValueUsd: number;
  /** laborValue / cost across all configured agents; null when cost is 0. */
  roiRatio: number | null;
  /** Avg quality deltaPct across agents that have a measurable trend; null when none. */
  avgQualityDeltaPct: number | null;
  avgSecurityDeltaPct: number | null;
  avgCostDeltaPct: number | null;
}

/** SCENARIO 4: one agent's utilization ranking entry (real execution data). */
export interface UtilizationEntry {
  workflowKey: string;
  name: string;
  /** ADD-only: human-facing agent code (e.g. "DEV-003"), decorated in getOverview. */
  code?: string | null;
  executions: number;
  successRate: number; // 0-100
  avgScore: number; // 0-100
}

/** SCENARIO 4: agent-utilization ranking (most-used / least-used Top 3). */
export interface Utilization {
  mostUsed: UtilizationEntry[];
  leastUsed: UtilizationEntry[];
}

export interface DashboardAggregate {
  kpi: KpiSummary;
  quality: QualitySummary;
  health: HealthSummary;
  mainAgents: MainAgentRollup[];
  timeseries: DailyPoint[];
  /** SCENARIO 2: tenant-level effectiveness summary. */
  effectiveness: EffectivenessSummary;
  /** SCENARIO 4: agent-utilization ranking (most/least used, real data). */
  utilization: Utilization;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Health from score + anomalies + recent failures. */
function deriveHealth(
  avgScore: number,
  anomalyRate: number,
  failRate: number,
  count: number,
  ref: OpsReference = OPS_REFERENCE_DEFAULTS,
): HealthState {
  if (count === 0) return 'idle';
  if (avgScore < ref.healthDownScore || failRate > ref.healthDownFailRate || anomalyRate > ref.healthDownAnomalyRate)
    return 'down';
  if (
    avgScore < ref.healthDegradedScore ||
    failRate > ref.healthDegradedFailRate ||
    anomalyRate > ref.healthDegradedAnomalyRate
  )
    return 'degraded';
  return 'healthy';
}

/** Map quality grade letter; derive from overallScore when absent. */
function gradeOf(row: EvalRow, ref: OpsReference = OPS_REFERENCE_DEFAULTS): string {
  if (row.qualityGrade && 'ABCDF'.includes(row.qualityGrade)) return row.qualityGrade;
  const s = row.overallScore;
  return s >= ref.gradeA ? 'A' : s >= ref.gradeB ? 'B' : s >= ref.gradeC ? 'C' : s >= ref.gradeD ? 'D' : 'F';
}

/**
 * Build the full dashboard aggregate from execution + evaluation rows.
 *
 * @param execs  ExecutionSession rows (status/cost/latency/workflowKey)
 * @param evals  AgentEvaluation rows (joined workflowKey + stepKey)
 */
export function aggregateDashboard(
  execs: ExecRow[],
  evals: EvalRow[],
  effectivenessConfigs: EffectivenessConfigMap = {},
  /** SCENARIO 4: registered-agent name + key list so the ranking shows names and
   *  zero-execution (registered-but-unused) agents surface in leastUsed. */
  registeredAgents: Array<{ workflowKey: string; name: string }> = [],
  /** 운영 기준값(시급·health 임계값·등급 컷오프). 미지정 시 코드 기본값. */
  opsRef: OpsReference = OPS_REFERENCE_DEFAULTS,
): DashboardAggregate {
  const E = Array.isArray(execs) ? execs : [];
  const V = Array.isArray(evals) ? evals : [];
  const cfgMap = effectivenessConfigs ?? {};

  // SCENARIO 2: window midpoint splits each agent's rows into previous|current
  // halves so trends are current-vs-immediately-preceding (real, not faked).
  const ts = (d: Date | string): number => {
    const t = new Date(d).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  const allTimes = [...E.map((e) => ts(e.createdAt)), ...V.map((v) => ts(v.createdAt))].filter(
    (t) => t > 0,
  );
  const minT = allTimes.length ? Math.min(...allTimes) : 0;
  const maxT = allTimes.length ? Math.max(...allTimes) : 0;
  const midT = minT + (maxT - minT) / 2;

  // ── KPI ──
  const total = E.length;
  const succeeded = E.filter((e) => e.status === 'SUCCEEDED').length;
  const failed = E.filter((e) => e.status === 'FAILED' || e.status === 'BLOCKED').length;
  const latencies = E.map((e) => num(e.latencyMs)).filter((x): x is number => x != null);
  const costs = E.map((e) => num(e.costUsd)).filter((x): x is number => x != null);
  const anomalyCount = V.filter((v) => v.anomalyDetected).length;
  const kpi: KpiSummary = {
    totalExecutions: total,
    successRate: total ? r1((succeeded / total) * 100) : 0,
    avgLatencyMs: Math.round(avg(latencies)),
    monthlyCostUsd: r2(costs.reduce((s, x) => s + x, 0)),
    anomalyCount,
  };

  // ── Quality ──
  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const v of V) grades[gradeOf(v, opsRef)] = (grades[gradeOf(v, opsRef)] ?? 0) + 1;
  const quality: QualitySummary = {
    avgOverallScore: r1(avg(V.map((v) => v.overallScore))),
    avgAccuracy: r1(
      avg(V.map((v) => num(v.accuracyScore)).filter((x): x is number => x != null)) * 100,
    ),
    avgHallucinationRate: r1(
      avg(V.map((v) => num(v.hallucationRate)).filter((x): x is number => x != null)) * 100,
    ),
    gradeDistribution: grades,
    evaluatedCount: V.length,
  };

  // ── Per-main-agent rollup (group by workflowKey) ──
  const mainKeys = new Set<string>();
  for (const e of E) if (e.workflowKey) mainKeys.add(e.workflowKey);
  for (const v of V) if (v.workflowKey) mainKeys.add(v.workflowKey);

  const mainAgents: MainAgentRollup[] = [];
  for (const key of mainKeys) {
    const mExecs = E.filter((e) => e.workflowKey === key);
    const mEvals = V.filter((v) => v.workflowKey === key);
    const mTotal = mExecs.length;
    const mSucc = mExecs.filter((e) => e.status === 'SUCCEEDED').length;
    const mFail = mExecs.filter((e) => e.status === 'FAILED' || e.status === 'BLOCKED').length;
    const mLat = mExecs.map((e) => num(e.latencyMs)).filter((x): x is number => x != null);
    const mCost = mExecs.map((e) => num(e.costUsd)).filter((x): x is number => x != null);
    const mScore = avg(mEvals.map((v) => v.overallScore));
    const mAnomaly = mEvals.filter((v) => v.anomalyDetected).length;
    const failRate = mTotal ? mFail / mTotal : 0;
    const anomalyRate = mEvals.length ? mAnomaly / mEvals.length : 0;

    // sub-agents grouped by stepKey
    const subMap = new Map<string, EvalRow[]>();
    for (const v of mEvals) {
      if (!subMap.has(v.stepKey)) subMap.set(v.stepKey, []);
      subMap.get(v.stepKey)!.push(v);
    }
    const RISK_ORDER = ['low', 'medium', 'high', 'critical'];
    const subAgents: SubAgentRollup[] = [];
    for (const [stepKey, rows] of subMap) {
      const sScore = avg(rows.map((r) => r.overallScore));
      const sAnomaly = rows.filter((r) => r.anomalyDetected).length;
      const sCost = rows.map((r) => num(r.estimatedCostUsd)).filter((x): x is number => x != null);
      const sLat = rows.map((r) => num(r.executionTimeMs)).filter((x): x is number => x != null);
      const worstRisk =
        rows
          .map((r) => (r.securityRiskLevel ?? '').toLowerCase())
          .filter((x) => RISK_ORDER.includes(x))
          .sort((a, b) => RISK_ORDER.indexOf(b) - RISK_ORDER.indexOf(a))[0] ?? null;
      subAgents.push({
        stepKey,
        nodeType: rows[0]?.nodeType ?? null,
        agentName: rows[0]?.agentName ?? null,
        evaluations: rows.length,
        avgScore: r1(sScore),
        anomalyCount: sAnomaly,
        avgCostUsd: r2(avg(sCost)),
        avgLatencyMs: Math.round(avg(sLat)),
        health: deriveHealth(sScore, rows.length ? sAnomaly / rows.length : 0, 0, rows.length, opsRef),
        worstSecurityRisk: worstRisk,
      });
    }
    subAgents.sort((a, b) => a.avgScore - b.avgScore); // worst first (problem구간 우선)

    // ── SCENARIO 2: per-agent trend (current vs previous window halves) ──
    const half = (rows: { createdAt: Date | string }[], wantCurrent: boolean) =>
      maxT > minT
        ? rows.filter((r) => (wantCurrent ? ts(r.createdAt) >= midT : ts(r.createdAt) < midT))
        : wantCurrent
          ? rows
          : [];
    const curExecs = half(mExecs, true) as ExecRow[];
    const prevExecs = half(mExecs, false) as ExecRow[];
    const curEvals = half(mEvals, true) as EvalRow[];
    const prevEvals = half(mEvals, false) as EvalRow[];
    const winRate = (xs: ExecRow[]) => {
      const t = xs.length;
      const ok = xs.filter((e) => e.status === 'SUCCEEDED').length;
      return t ? r1((ok / t) * 100) : 0;
    };
    const costPerRun = (xs: ExecRow[]) => {
      const cs = xs.map((e) => num(e.costUsd)).filter((x): x is number => x != null);
      return cs.length ? cs : [];
    };
    const secScores = (vs: EvalRow[]) =>
      vs.map((v) => num(v.securityScore)).filter((x): x is number => x != null);
    const trend: TrendResult | null =
      mExecs.length || mEvals.length
        ? computeTrend({
            current: {
              overallScore: curEvals.map((v) => v.overallScore),
              securityScore: secScores(curEvals),
              costPerRun: costPerRun(curExecs),
              successRate: winRate(curExecs),
            },
            previous: {
              overallScore: prevEvals.map((v) => v.overallScore),
              securityScore: secScores(prevEvals),
              costPerRun: costPerRun(prevExecs),
              successRate: winRate(prevExecs),
            },
          })
        : null;

    // ── SCENARIO 2: per-agent effectiveness (measured + configured baseline) ──
    const cfg = cfgMap[key];
    let effectiveness: EffectivenessResult | null = null;
    if (cfg) {
      // actual agent minutes = summed session latency (ms) -> minutes
      const actualAgentMinutes = mLat.reduce((sum, ms) => sum + ms, 0) / 60000;
      effectiveness = computeEffectiveness(
        {
          executions: mTotal,
          successCount: mSucc,
          actualAgentMinutes,
          costUsd: mCost.reduce((sumC, x) => sumC + x, 0),
        },
        cfg,
        opsRef.hourlyRateUsd,
      );
    }

    mainAgents.push({
      workflowKey: key,
      executions: mTotal,
      successRate: mTotal ? r1((mSucc / mTotal) * 100) : 0,
      avgLatencyMs: Math.round(avg(mLat)),
      totalCostUsd: r2(mCost.reduce((s, x) => s + x, 0)),
      avgScore: r1(mScore),
      anomalyCount: mAnomaly,
      health: deriveHealth(mScore, anomalyRate, failRate, mTotal || mEvals.length, opsRef),
      subAgents,
      trend,
      effectiveness,
    });
  }
  mainAgents.sort((a, b) => {
    const order = { down: 0, degraded: 1, healthy: 2, idle: 3 };
    return order[a.health] - order[b.health]; // unhealthy first
  });

  // ── Health summary ──
  const health: HealthSummary = {
    total: mainAgents.length,
    healthy: mainAgents.filter((m) => m.health === 'healthy').length,
    degraded: mainAgents.filter((m) => m.health === 'degraded').length,
    down: mainAgents.filter((m) => m.health === 'down').length,
    idle: mainAgents.filter((m) => m.health === 'idle').length,
  };

  // ── Daily time-series (executive trend charts) ──
  const timeseries = buildTimeseries(E, V);

  // ── SCENARIO 2: tenant-level effectiveness summary ──
  const effective = mainAgents.filter((m) => m.effectiveness);
  const totalTimeSavedHours = r2(
    effective.reduce((sum, m) => sum + (m.effectiveness!.timeSavedHours || 0), 0),
  );
  const totalLaborValueUsd = r2(
    effective.reduce((sum, m) => sum + (m.effectiveness!.roi.laborValueUsd || 0), 0),
  );
  const totalCostEff = r2(effective.reduce((sum, m) => sum + (m.effectiveness!.costUsd || 0), 0));
  const totalNetValueUsd = r2(totalLaborValueUsd - totalCostEff);
  const avgDelta = (sel: (t: TrendResult) => number | null): number | null => {
    const vals = mainAgents
      .map((m) => (m.trend ? sel(m.trend) : null))
      .filter((x): x is number => x != null);
    return vals.length ? r1(vals.reduce((s, x) => s + x, 0) / vals.length) : null;
  };
  const effectiveness: EffectivenessSummary = {
    agentsWithConfig: effective.length,
    totalTimeSavedHours,
    totalLaborValueUsd,
    totalCostUsd: totalCostEff,
    totalNetValueUsd,
    roiRatio: totalCostEff > 0 ? r2(totalLaborValueUsd / totalCostEff) : null,
    avgQualityDeltaPct: avgDelta((t) => t.quality.deltaPct),
    avgSecurityDeltaPct: avgDelta((t) => t.security.deltaPct),
    avgCostDeltaPct: avgDelta((t) => t.cost.deltaPct),
  };

  // ── SCENARIO 4: agent-utilization ranking (real execution data) ──
  // Build the candidate pool: every registered agent (so unused agents with 0
  // executions surface) PLUS any agent seen in execution rows. Counts/quality
  // come straight from the per-main-agent rollup; registered-but-unrun agents
  // get zeroed entries.
  const utilization = buildUtilization(mainAgents, registeredAgents);

  return { kpi, quality, health, mainAgents, timeseries, effectiveness, utilization };
}

/** Bucket execution + evaluation rows by calendar day (ascending). */
function buildTimeseries(E: ExecRow[], V: EvalRow[]): DailyPoint[] {
  const dayKey = (d: Date | string) => {
    const dt = new Date(d);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  };
  type Bucket = { exec: ExecRow[]; evl: EvalRow[] };
  const buckets = new Map<string, Bucket>();
  const ensure = (k: string) => {
    if (!buckets.has(k)) buckets.set(k, { exec: [], evl: [] });
    return buckets.get(k)!;
  };
  for (const e of E) {
    const k = dayKey(e.createdAt);
    if (k) ensure(k).exec.push(e);
  }
  for (const v of V) {
    const k = dayKey(v.createdAt);
    if (k) ensure(k).evl.push(v);
  }

  return Array.from(buckets.keys())
    .sort()
    .map((date) => {
      const b = buckets.get(date)!;
      const t = b.exec.length;
      const succ = b.exec.filter((e) => e.status === 'SUCCEEDED').length;
      const costs = b.exec.map((e) => num(e.costUsd)).filter((x): x is number => x != null);
      return {
        date,
        executions: t,
        successRate: t ? r1((succ / t) * 100) : 0,
        costUsd: r2(costs.reduce((s, x) => s + x, 0)),
        avgScore: r1(avg(b.evl.map((v) => v.overallScore))),
        anomalies: b.evl.filter((v) => v.anomalyDetected).length,
      };
    });
}

/**
 * SCENARIO 4 — pure, deterministic utilization ranking.
 *
 * mostUsed  = top 3 agents by executions (desc).
 * leastUsed = bottom 3 REGISTERED agents by executions (asc), INCLUDING agents
 *             with 0 executions so "unused" agents surface.
 * Tie-break: stable, by workflowKey (ascending) so output is deterministic.
 *
 * @param mainAgents      per-main-agent rollups (carry execution counts/quality)
 * @param registeredAgents all registered agents (key+name) — ensures zero-run
 *                         agents are candidates and supplies display names.
 */
export function buildUtilization(
  mainAgents: Array<{
    workflowKey: string;
    executions: number;
    successRate: number;
    avgScore: number;
  }>,
  registeredAgents: Array<{ workflowKey: string; name: string }> = [],
): Utilization {
  const nameMap = new Map<string, string>();
  for (const a of registeredAgents) {
    if (a && a.workflowKey) nameMap.set(a.workflowKey, a.name ?? a.workflowKey);
  }

  // Index rollups by key for O(1) lookup.
  const rollByKey = new Map<
    string,
    { executions: number; successRate: number; avgScore: number }
  >();
  for (const m of mainAgents) {
    rollByKey.set(m.workflowKey, {
      executions: m.executions ?? 0,
      successRate: m.successRate ?? 0,
      avgScore: m.avgScore ?? 0,
    });
  }

  // Candidate pool = union of registered keys and keys seen in rollups.
  const keys = new Set<string>();
  for (const a of registeredAgents) if (a && a.workflowKey) keys.add(a.workflowKey);
  for (const m of mainAgents) keys.add(m.workflowKey);

  const pool: UtilizationEntry[] = Array.from(keys).map((key) => {
    const roll = rollByKey.get(key);
    return {
      workflowKey: key,
      name: nameMap.get(key) ?? key,
      executions: roll?.executions ?? 0,
      successRate: roll?.successRate ?? 0,
      avgScore: roll?.avgScore ?? 0,
    };
  });

  // mostUsed: executions desc, stable tie-break by workflowKey asc.
  const mostUsed = [...pool]
    .sort((a, b) => b.executions - a.executions || a.workflowKey.localeCompare(b.workflowKey))
    .slice(0, 3);

  // leastUsed: executions asc (0 first), stable tie-break by workflowKey asc.
  const leastUsed = [...pool]
    .sort((a, b) => a.executions - b.executions || a.workflowKey.localeCompare(b.workflowKey))
    .slice(0, 3);

  return { mostUsed, leastUsed };
}
