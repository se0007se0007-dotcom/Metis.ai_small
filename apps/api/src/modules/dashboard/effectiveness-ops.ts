/**
 * Effectiveness OPS metrics — PURE aggregation helpers (no NestJS/Prisma).
 *
 * MTTR (Mean Time To Resolve) and MTTD (Mean Time To Detect) are computed from
 * REAL existing tables:
 *   - MTTR  ← FDSAlert rows (resolvedAt - createdAt) for RESOLVED alerts,
 *             grouped by detailsJson.workflowKey (the agent key).
 *   - MTTD  ← ExecutionSession.latencyMs mean, used as a detection/run-latency
 *             proxy for that agent (the agent's mean time to detect/act).
 *
 * Deterministic & side-effect-free so they can be unit-tested without a DB.
 *
 * @module dashboard/effectiveness-ops
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Minimal alert row shape consumed by computeMttrByAgent. */
export interface MttrAlertRow {
  /** FDSAlertStatus — only 'RESOLVED' rows with a resolvedAt contribute to MTTR. */
  status: string;
  /** Alert raise time. */
  createdAt: Date | string;
  /** Resolution time (null when still open / not resolved). */
  resolvedAt?: Date | string | null;
  /** detailsJson carrying the agent key under workflowKey. */
  detailsJson?: { workflowKey?: string | null } | null;
}

export interface MttrAgentEntry {
  /** Mean time-to-resolve in hours across RESOLVED alerts; null when none resolved. */
  mttrHours: number | null;
  /** Count of RESOLVED alerts (with resolvedAt) for this agent. */
  resolvedCount: number;
  /** Count of alerts not yet resolved (status !== RESOLVED) for this agent. */
  openCount: number;
}

const toMs = (d: Date | string | null | undefined): number => {
  if (d == null) return NaN;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? NaN : t;
};

/**
 * Group alerts by detailsJson.workflowKey and compute MTTR + resolved/open counts.
 *
 * RESOLVED + resolvedAt present  → contributes to mttrHours and resolvedCount.
 * Anything else                  → openCount (still outstanding).
 * Returns a map keyed by workflowKey. Alerts with no workflowKey are skipped.
 */
export function computeMttrByAgent(alerts: MttrAlertRow[]): Record<string, MttrAgentEntry> {
  const out: Record<string, MttrAgentEntry> = {};
  const durations: Record<string, number[]> = {};
  const rows = Array.isArray(alerts) ? alerts : [];
  for (const a of rows) {
    const key = a?.detailsJson?.workflowKey;
    if (!key || typeof key !== 'string') continue;
    if (!out[key]) {
      out[key] = { mttrHours: null, resolvedCount: 0, openCount: 0 };
      durations[key] = [];
    }
    const resolvedAtMs = toMs(a.resolvedAt);
    const createdAtMs = toMs(a.createdAt);
    const isResolved =
      String(a.status).toUpperCase() === 'RESOLVED' &&
      !Number.isNaN(resolvedAtMs) &&
      !Number.isNaN(createdAtMs) &&
      resolvedAtMs >= createdAtMs;
    if (isResolved) {
      out[key].resolvedCount += 1;
      durations[key].push((resolvedAtMs - createdAtMs) / 3600000); // ms -> hours
    } else {
      out[key].openCount += 1;
    }
  }
  for (const key of Object.keys(out)) {
    const ds = durations[key];
    out[key].mttrHours = ds.length ? r2(ds.reduce((s, x) => s + x, 0) / ds.length) : null;
  }
  return out;
}

/**
 * MTTD proxy: mean ExecutionSession latency (ms) for one agent, in MINUTES.
 *
 * This is the agent's mean detection/run latency — how long the agent itself
 * takes to detect/act per run. Pair it with the CONFIGURED mttdTargetPct target.
 * Returns null when there are no latency samples.
 */
export function computeMttdMinutes(latenciesMs: Array<number | null | undefined>): number | null {
  const xs = (Array.isArray(latenciesMs) ? latenciesMs : [])
    .map((v) => (typeof v === 'string' ? Number(v) : v))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!xs.length) return null;
  const meanMs = xs.reduce((s, x) => s + x, 0) / xs.length;
  return r2(meanMs / 60000); // ms -> minutes
}

/**
 * Signal row consumed by computeMttdFromSignals (DETECTION signals).
 */
export interface MttdSignalRow {
  workflowKey: string;
  /** Detection latency in seconds (occurredAt → detectedAt); null when unknown. */
  detectSeconds: number | null;
}

export interface MttdSignalEntry {
  /** Mean detection time in MINUTES over rows with detectSeconds present; null when none. */
  mttdMinutes: number | null;
  /** Count of contributing DETECTION samples. */
  samples: number;
}

/**
 * MEASURED MTTD per agent from DETECTION signals.
 *
 * Group by workflowKey; mttdMinutes = avg(detectSeconds)/60 (rounded to 2dp)
 * over rows where detectSeconds != null; samples = number of such rows.
 * Pure & deterministic — no Prisma.
 */
export function computeMttdFromSignals(signals: MttdSignalRow[]): Record<string, MttdSignalEntry> {
  const out: Record<string, MttdSignalEntry> = {};
  const secs: Record<string, number[]> = {};
  const rows = Array.isArray(signals) ? signals : [];
  for (const s of rows) {
    const key = s?.workflowKey;
    if (!key || typeof key !== 'string') continue;
    if (!out[key]) {
      out[key] = { mttdMinutes: null, samples: 0 };
      secs[key] = [];
    }
    const v = typeof s.detectSeconds === 'string' ? Number(s.detectSeconds) : s.detectSeconds;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      secs[key].push(v);
      out[key].samples += 1;
    }
  }
  for (const key of Object.keys(out)) {
    const xs = secs[key];
    out[key].mttdMinutes = xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length / 60) : null;
  }
  return out;
}

/**
 * Signal row consumed by computeCoverageFromSignals (COVERAGE signals).
 */
export interface CoverageSignalRow {
  workflowKey: string;
  coveragePct: number | null;
  testsTotal: number | null;
  testsPassed: number | null;
}

export interface CoverageSignalEntry {
  /** Mean coverage % over rows with coveragePct present; null when none. */
  coveragePct: number | null;
  /** Sum of testsTotal across rows. */
  testsTotal: number;
  /** Sum of testsPassed across rows. */
  testsPassed: number;
  /** Count of contributing COVERAGE samples (rows seen for this agent). */
  samples: number;
}

/**
 * MEASURED test coverage per agent from COVERAGE signals.
 *
 * Group by workflowKey; coveragePct = avg of present coveragePct (2dp);
 * testsTotal / testsPassed = summed; samples = rows seen. Pure & deterministic.
 */
export function computeCoverageFromSignals(
  signals: CoverageSignalRow[],
): Record<string, CoverageSignalEntry> {
  const out: Record<string, CoverageSignalEntry> = {};
  const pcts: Record<string, number[]> = {};
  const rows = Array.isArray(signals) ? signals : [];
  for (const s of rows) {
    const key = s?.workflowKey;
    if (!key || typeof key !== 'string') continue;
    if (!out[key]) {
      out[key] = {
        coveragePct: null,
        testsTotal: 0,
        testsPassed: 0,
        samples: 0,
      };
      pcts[key] = [];
    }
    out[key].samples += 1;
    const tt = typeof s.testsTotal === 'string' ? Number(s.testsTotal) : s.testsTotal;
    const tp = typeof s.testsPassed === 'string' ? Number(s.testsPassed) : s.testsPassed;
    if (typeof tt === 'number' && Number.isFinite(tt) && tt >= 0) out[key].testsTotal += tt;
    if (typeof tp === 'number' && Number.isFinite(tp) && tp >= 0) out[key].testsPassed += tp;
    const cp = typeof s.coveragePct === 'string' ? Number(s.coveragePct) : s.coveragePct;
    if (typeof cp === 'number' && Number.isFinite(cp) && cp >= 0) pcts[key].push(cp);
  }
  for (const key of Object.keys(out)) {
    const xs = pcts[key];
    out[key].coveragePct = xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  }
  return out;
}

/**
 * Per-agent OPS stat row consumed by rollupSystemsOps. All counts are over the
 * dashboard window for that agent (workflowKey). securityIssueCount = rows with
 * securityRiskLevel in {high, critical}; criticalSecurityCount = the critical subset.
 */
export interface AgentOpsStat {
  workflowKey: string;
  system: string;
  executions: number;
  /** successful execution count (succeeded = executions - failedCount). */
  successfulCount: number;
  failedCount: number;
  securityIssueCount: number;
  criticalSecurityCount: number;
}

/** Per-system OPS rollup row (usage / error / security), grouped by `system`. */
export interface SystemOpsEntry {
  system: string;
  agentCount: number;
  executions: number;
  /** 0-100, successful/total * 100 (1dp); 0 when no executions. */
  successRate: number;
  failedCount: number;
  /** 0-100, failed/total * 100 (1dp); 0 when no executions. */
  errorRate: number;
  securityIssueCount: number;
  criticalSecurityCount: number;
}

/**
 * Group per-agent OPS stats into per-system usage/error/security rollups.
 *
 * - executions / failedCount / securityIssueCount / criticalSecurityCount  → summed
 * - successRate = sum(successfulCount) / sum(executions) * 100 (1dp); 0 when no execs
 * - errorRate   = sum(failedCount)     / sum(executions) * 100 (1dp); 0 when no execs
 * - agentCount  = distinct workflowKeys mapped to the system
 *
 * Pure & deterministic — no Prisma. Each stat's `system` is taken verbatim
 * (callers resolve column-or-json-or-UNASSIGNED upstream).
 */
export function rollupSystemsOps(stats: AgentOpsStat[]): Record<string, SystemOpsEntry> {
  const out: Record<string, SystemOpsEntry> = {};
  const succ: Record<string, number> = {};
  const seenKeys: Record<string, Set<string>> = {};
  const rows = Array.isArray(stats) ? stats : [];
  for (const s of rows) {
    const sys = s?.system && typeof s.system === 'string' ? s.system : '미지정';
    if (!out[sys]) {
      out[sys] = {
        system: sys,
        agentCount: 0,
        executions: 0,
        successRate: 0,
        failedCount: 0,
        errorRate: 0,
        securityIssueCount: 0,
        criticalSecurityCount: 0,
      };
      succ[sys] = 0;
      seenKeys[sys] = new Set<string>();
    }
    const e = out[sys];
    const ex = Number(s.executions) || 0;
    const sc = Number(s.successfulCount) || 0;
    const fc = Number(s.failedCount) || 0;
    e.executions += ex;
    e.failedCount += fc;
    succ[sys] += sc;
    e.securityIssueCount += Number(s.securityIssueCount) || 0;
    e.criticalSecurityCount += Number(s.criticalSecurityCount) || 0;
    if (s.workflowKey) seenKeys[sys].add(s.workflowKey);
  }
  for (const sys of Object.keys(out)) {
    const e = out[sys];
    e.agentCount = seenKeys[sys].size;
    e.successRate = e.executions ? Math.round((succ[sys] / e.executions) * 1000) / 10 : 0;
    e.errorRate = e.executions ? Math.round((e.failedCount / e.executions) * 1000) / 10 : 0;
  }
  return out;
}
