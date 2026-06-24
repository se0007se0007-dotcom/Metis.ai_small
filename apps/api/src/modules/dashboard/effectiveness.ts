/**
 * Effectiveness & trend — PURE logic (no NestJS/Prisma imports).
 *
 * SCENARIO 2: every number here is either
 *   (a) MEASURED from execution/evaluation rows passed in, or
 *   (b) a CONFIGURED baseline/target taken from Workflow.effectivenessJson and
 *       passed through verbatim (clearly labeled as a target, never measured).
 *
 * No Math.random, no hardcoded trend arrays. Deterministic & side-effect-free
 * so it can be unit-tested without a DB.
 *
 * @module dashboard/effectiveness
 */

/** Per-agent baseline config, stored in Workflow.effectivenessJson. */
export interface EffectivenessConfig {
  /** Minutes a human would spend per run if done manually (CONFIGURED baseline). */
  manualMinutesPerRun: number;
  /** Domain label (e.g. 'security', 'ops') — passthrough. */
  domain?: string;
  /** Target coverage multiplier (CONFIGURED target, not measured). */
  coverageTargetX?: number;
  /** Target mean-time-to-detect improvement % (CONFIGURED target). */
  mttdTargetPct?: number;
  /** Human-friendly value label (e.g. '보안 사고 예방'). */
  valueLabel?: string;
  /** Optional override for the $/hour used in ROI; defaults to 50. */
  hourlyRateUsd?: number;
  /** System / platform this agent belongs to (passthrough grouping label). */
  system?: string;
}

/** Minimal row shape consumed by computeEffectiveness (MEASURED inputs). */
export interface EffectivenessInput {
  /** Total executions observed in window. */
  executions: number;
  /** Successful executions (status === SUCCEEDED). */
  successCount: number;
  /** Summed actual agent runtime, in minutes (MEASURED). */
  actualAgentMinutes: number;
  /** Summed actual cost in USD (MEASURED). */
  costUsd: number;
}

export interface EffectivenessResult {
  executions: number;
  successCount: number;
  /** CONFIGURED baseline echoed back. */
  manualMinutesPerRun: number;
  /** MEASURED: human-minutes saved converted to hours, minus actual agent hours, floored at 0. */
  timeSavedHours: number;
  /** MEASURED: total actual agent runtime in hours. */
  actualAgentHours: number;
  /** MEASURED: total cost USD. */
  costUsd: number;
  /** DERIVED: net value (timeSaved*rate - cost) and ratio. */
  roi: {
    hourlyRateUsd: number;
    laborValueUsd: number;
    netValueUsd: number;
    /** laborValueUsd / costUsd; null when cost is 0. */
    ratio: number | null;
  };
  /** CONFIGURED targets (passthrough, labeled as targets). */
  coverageTargetX: number | null;
  mttdTargetPct: number | null;
  valueLabel: string | null;
  /** MEASURED: mean actual agent runtime per execution, in minutes. */
  aiMinutesPerRun: number;
  /** DERIVED: % of manual time saved per run, clamped 0-100 (e.g. 30->10 = 66.7). */
  timeSavedPct: number;
  /** CONFIGURED: system/platform grouping label (passthrough); null when unset. */
  system: string | null;
}

const DEFAULT_HOURLY_RATE = 50;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Clamp n into [lo, hi]. Exported for unit tests. */
export const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/**
 * Compute per-agent effectiveness from MEASURED rows + CONFIGURED baseline.
 *
 * timeSavedHours = max(0, (successCount * manualMinutesPerRun)/60 - actualAgentHours)
 *   i.e. the human time the agent's successful runs replaced, net of the agent's
 *   own runtime. Floored at 0 so a slow agent never shows "negative savings".
 */
export function computeEffectiveness(
  input: EffectivenessInput,
  config: EffectivenessConfig,
  /** 운영 기준값의 조직 기본 시급(USD). Agent별 override 없을 때 사용. */
  defaultHourlyRate: number = DEFAULT_HOURLY_RATE,
): EffectivenessResult {
  const executions = Math.max(0, Math.floor(input?.executions ?? 0));
  const successCount = Math.max(0, Math.floor(input?.successCount ?? 0));
  const actualAgentMinutes = Math.max(0, Number(input?.actualAgentMinutes ?? 0) || 0);
  const costUsd = Math.max(0, Number(input?.costUsd ?? 0) || 0);

  const manualMinutesPerRun = Math.max(0, Number(config?.manualMinutesPerRun ?? 0) || 0);
  const fallbackRate = Number(defaultHourlyRate) > 0 ? Number(defaultHourlyRate) : DEFAULT_HOURLY_RATE;
  const hourlyRateUsd =
    Number(config?.hourlyRateUsd) > 0 ? Number(config.hourlyRateUsd) : fallbackRate;

  const actualAgentHours = r2(actualAgentMinutes / 60);
  // MEASURED: mean actual agent runtime per execution (minutes).
  const aiMinutesPerRun = executions > 0 ? r2(actualAgentMinutes / executions) : 0;
  // DERIVED: per-run % saved vs the configured manual baseline (30min->10min = 66.7).
  const timeSavedPct =
    manualMinutesPerRun > 0 && executions > 0
      ? r1(clamp(((manualMinutesPerRun - aiMinutesPerRun) / manualMinutesPerRun) * 100, 0, 100))
      : 0;
  const humanHoursReplaced = (successCount * manualMinutesPerRun) / 60;
  const timeSavedHours = r2(Math.max(0, humanHoursReplaced - actualAgentMinutes / 60));

  const laborValueUsd = r2(timeSavedHours * hourlyRateUsd);
  const netValueUsd = r2(laborValueUsd - costUsd);
  const ratio = costUsd > 0 ? r2(laborValueUsd / costUsd) : null;

  return {
    executions,
    successCount,
    manualMinutesPerRun,
    timeSavedHours,
    actualAgentHours,
    costUsd: r2(costUsd),
    roi: { hourlyRateUsd, laborValueUsd, netValueUsd, ratio },
    coverageTargetX:
      config?.coverageTargetX != null && Number.isFinite(Number(config.coverageTargetX))
        ? Number(config.coverageTargetX)
        : null,
    mttdTargetPct:
      config?.mttdTargetPct != null && Number.isFinite(Number(config.mttdTargetPct))
        ? Number(config.mttdTargetPct)
        : null,
    valueLabel: config?.valueLabel ?? null,
    aiMinutesPerRun,
    timeSavedPct,
    system: typeof config?.system === 'string' && config.system ? config.system : null,
  };
}

/** Two equal windows of MEASURED series, current vs immediately-preceding. */
export interface TrendSeries {
  current: TrendWindow;
  previous: TrendWindow;
}
export interface TrendWindow {
  overallScore: number[];
  securityScore: number[];
  costPerRun: number[];
  /** 0-100 success rate for the window (already aggregated). */
  successRate: number;
}

export type TrendDirection = 'up' | 'down' | 'flat';

export interface MetricTrend {
  current: number;
  previous: number;
  /** % change vs previous; null when previous is 0 (can't divide). */
  deltaPct: number | null;
  direction: TrendDirection;
}

export interface TrendResult {
  quality: MetricTrend; // up = improving
  security: MetricTrend; // up = improving
  cost: MetricTrend; // down = improving (costInverted)
  success: MetricTrend; // up = improving
  /** Reminder: for cost, direction 'down' is the GOOD direction. */
  costImprovingDirection: 'down';
}

const mean = (xs: number[]): number =>
  Array.isArray(xs) && xs.length ? xs.reduce((s, x) => s + (Number(x) || 0), 0) / xs.length : 0;

function metricTrend(current: number, previous: number): MetricTrend {
  const c = Number.isFinite(current) ? current : 0;
  const p = Number.isFinite(previous) ? previous : 0;
  const deltaPct = p !== 0 ? r1(((c - p) / Math.abs(p)) * 100) : null;
  let direction: TrendDirection = 'flat';
  // Use a small epsilon so float noise doesn't read as a trend.
  const eps = 1e-9;
  if (c - p > eps) direction = 'up';
  else if (p - c > eps) direction = 'down';
  return { current: r2(c), previous: r2(p), deltaPct, direction };
}

/**
 * Compute per-metric trend (current window vs previous equal window).
 *
 * quality/security/success: direction 'up' = improving.
 * cost: 'down' = improving (see costImprovingDirection).
 * Empty series are safe (treated as 0).
 */
export function computeTrend(series: TrendSeries): TrendResult {
  const cur = series?.current ?? {
    overallScore: [],
    securityScore: [],
    costPerRun: [],
    successRate: 0,
  };
  const prev = series?.previous ?? {
    overallScore: [],
    securityScore: [],
    costPerRun: [],
    successRate: 0,
  };

  return {
    quality: metricTrend(mean(cur.overallScore), mean(prev.overallScore)),
    security: metricTrend(mean(cur.securityScore), mean(prev.securityScore)),
    cost: metricTrend(mean(cur.costPerRun), mean(prev.costPerRun)),
    success: metricTrend(Number(cur.successRate) || 0, Number(prev.successRate) || 0),
    costImprovingDirection: 'down',
  };
}
