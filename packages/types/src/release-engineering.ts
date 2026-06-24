/**
 * Phase 3: Controlled Release Engineering Types
 *
 * Shared types for Replay / Shadow / Canary / Promotion / Rollback
 * across API, Worker, and Frontend.
 */

// ══════════════════════════════════════════
//  Enums
// ══════════════════════════════════════════

export type ReplayRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type ShadowPairStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type CanaryStatus = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'PROMOTED' | 'ROLLED_BACK' | 'FAILED';
export type CanaryGateResult = 'PASS' | 'FAIL' | 'WARN' | 'PENDING';
export type PromotionAction = 'PROMOTE' | 'ROLLBACK';
export type CaseVerdict = 'PASS' | 'FAIL' | 'REGRESSION' | 'IMPROVEMENT' | 'ERROR';
export type ShadowVerdict = 'MATCH' | 'DIVERGED' | 'REGRESSION' | 'IMPROVEMENT' | 'ERROR';

// ══════════════════════════════════════════
//  Comparison Metrics (mandatory)
// ══════════════════════════════════════════

export interface ComparisonMetrics {
  /** Correctness / success rate (0.0 - 1.0) */
  successRate: number;
  /** Policy violation count */
  policyViolationCount: number;
  /** Hallucination or invalid output signal count */
  invalidOutputCount: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** P99 latency in ms */
  p99LatencyMs: number;
  /** Total token / model cost in USD */
  totalCostUsd: number;
  /** Error rate (0.0 - 1.0) */
  errorRate: number;
  /** Total retry count */
  retryCount: number;
  /** Total execution count */
  totalExecutions: number;

  // ── Agent Evaluator integration ──
  /** Agent Evaluator overall quality score (0-100). Auto-populated from evaluation pipeline. */
  evalQualityScore: number;
  /** Agent Evaluator security score (0-100). Auto-populated. */
  evalSecurityScore: number;
  /** Number of anomaly events detected during canary window */
  evalAnomalyCount: number;
}

export const EMPTY_COMPARISON_METRICS: ComparisonMetrics = {
  successRate: 0,
  policyViolationCount: 0,
  invalidOutputCount: 0,
  avgLatencyMs: 0,
  p99LatencyMs: 0,
  totalCostUsd: 0,
  errorRate: 0,
  retryCount: 0,
  totalExecutions: 0,
  evalQualityScore: 100,
  evalSecurityScore: 100,
  evalAnomalyCount: 0,
};

// ══════════════════════════════════════════
//  Canary Gate Rule
// ══════════════════════════════════════════

export interface CanaryGateRule {
  /** Metric name from ComparisonMetrics */
  metric: keyof ComparisonMetrics;
  /** Comparison operator */
  operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq';
  /** Threshold value */
  threshold: number;
  /** Weight for weighted scoring (0.0 - 1.0) */
  weight: number;
  /** Whether this rule is a hard gate (fail = auto-rollback) */
  isHardGate: boolean;
}

export const DEFAULT_CANARY_GATE_RULES: CanaryGateRule[] = [
  // ── Existing rules ──
  { metric: 'successRate', operator: 'gte', threshold: 0.95, weight: 0.2, isHardGate: true },
  { metric: 'errorRate', operator: 'lte', threshold: 0.05, weight: 0.15, isHardGate: true },
  { metric: 'policyViolationCount', operator: 'eq', threshold: 0, weight: 0.1, isHardGate: true },
  { metric: 'avgLatencyMs', operator: 'lte', threshold: 5000, weight: 0.05, isHardGate: false },
  { metric: 'invalidOutputCount', operator: 'eq', threshold: 0, weight: 0.1, isHardGate: false },
  // ── Agent Evaluator quality gate — score must be >= 70 (ORB standard) ──
  { metric: 'evalQualityScore', operator: 'gte', threshold: 70, weight: 0.2, isHardGate: true },
  // ── Agent Evaluator security gate — score must be >= 60 ──
  { metric: 'evalSecurityScore', operator: 'gte', threshold: 60, weight: 0.15, isHardGate: true },
  // ── Agent Evaluator anomaly gate — no anomalies allowed ──
  { metric: 'evalAnomalyCount', operator: 'eq', threshold: 0, weight: 0.05, isHardGate: false },
];

// ══════════════════════════════════════════
//  Gate Evaluation
// ══════════════════════════════════════════

export function evaluateGateRule(rule: CanaryGateRule, actualValue: number): boolean {
  switch (rule.operator) {
    case 'lt':
      return actualValue < rule.threshold;
    case 'lte':
      return actualValue <= rule.threshold;
    case 'gt':
      return actualValue > rule.threshold;
    case 'gte':
      return actualValue >= rule.threshold;
    case 'eq':
      return actualValue === rule.threshold;
    case 'neq':
      return actualValue !== rule.threshold;
    default:
      return false;
  }
}

export function evaluateGateRules(
  rules: CanaryGateRule[],
  metrics: ComparisonMetrics | null | undefined,
): {
  result: CanaryGateResult;
  details: Array<{ rule: CanaryGateRule; passed: boolean; actual: number }>;
} {
  // Safety: null/undefined metrics → FAIL (cannot evaluate without data)
  if (!metrics) {
    return {
      result: 'FAIL',
      details: (rules ?? []).map((rule) => ({ rule, passed: false, actual: NaN })),
    };
  }

  // Safety: empty rules → FAIL (no rules means no quality gates, which is unsafe)
  if (!rules || rules.length === 0) {
    return { result: 'FAIL', details: [] };
  }

  const details = rules.map((rule) => {
    const actual = metrics[rule.metric];
    // null/undefined/NaN metric value → treat as failed
    if (actual == null || Number.isNaN(actual)) {
      return { rule, passed: false, actual: actual ?? NaN };
    }
    const passed = evaluateGateRule(rule, actual);
    return { rule, passed, actual };
  });

  const hardGateFailed = details.some((d) => d.rule.isHardGate && !d.passed);
  if (hardGateFailed) return { result: 'FAIL', details };

  const softFailed = details.some((d) => !d.rule.isHardGate && !d.passed);
  if (softFailed) return { result: 'WARN', details };

  return { result: 'PASS', details };
}

// ══════════════════════════════════════════
//  Output Diff
// ══════════════════════════════════════════

export interface OutputDiff {
  identical: boolean;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  changeDetails: Array<{ key: string; expected: unknown; actual: unknown }>;
}

export function computeOutputDiff(
  expected: Record<string, unknown> | null | undefined,
  actual: Record<string, unknown> | null | undefined,
): OutputDiff {
  const exp = expected ?? {};
  const act = actual ?? {};
  const expKeys = Object.keys(exp);
  const actKeys = Object.keys(act);

  const addedKeys = actKeys.filter((k) => !expKeys.includes(k));
  const removedKeys = expKeys.filter((k) => !actKeys.includes(k));
  const commonKeys = expKeys.filter((k) => actKeys.includes(k));
  const changedKeys: string[] = [];
  const changeDetails: OutputDiff['changeDetails'] = [];

  for (const key of commonKeys) {
    if (JSON.stringify(exp[key]) !== JSON.stringify(act[key])) {
      changedKeys.push(key);
      changeDetails.push({ key, expected: exp[key], actual: act[key] });
    }
  }

  return {
    identical: addedKeys.length === 0 && removedKeys.length === 0 && changedKeys.length === 0,
    addedKeys,
    removedKeys,
    changedKeys,
    changeDetails,
  };
}

// ══════════════════════════════════════════
//  Audit Actions (Phase 3)
// ══════════════════════════════════════════

export type Phase3AuditAction =
  | 'REPLAY_DATASET_CREATE'
  | 'REPLAY_RUN_START'
  | 'SHADOW_CONFIG_CREATE'
  | 'SHADOW_PAIR_CREATE'
  | 'CANARY_START'
  | 'CANARY_GATE_EVALUATE'
  | 'CANARY_PROMOTE'
  | 'CANARY_ROLLBACK'
  | 'VERSION_PROMOTE'
  | 'VERSION_ROLLBACK';

// ══════════════════════════════════════════
//  Request/Response Types
// ══════════════════════════════════════════

export interface CreateReplayDatasetRequest {
  name: string;
  description?: string;
  baselineVersionId?: string;
  filter?: {
    workflowKey?: string;
    capabilityKey?: string;
    packVersionId?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
    limit?: number;
  };
}

export interface MarkGoldenRequest {
  caseIds: string[];
  isGolden: boolean;
  riskLevel?: string;
  tags?: string[];
}

export interface StartReplayRunRequest {
  datasetId: string;
  candidateVersionId: string;
  baselineVersionId?: string;
}

export interface CreateShadowConfigRequest {
  name: string;
  controlVersionId: string;
  candidateVersionId: string;
  workflowFilter?: string[];
  capabilityFilter?: string[];
  samplingRate?: number;
}

export interface CreateCanaryDeploymentRequest {
  name: string;
  packId: string;
  stableVersionId: string;
  candidateVersionId: string;
  initialTrafficPct?: number;
  maxTrafficPct?: number;
  incrementStepPct?: number;
  windowDurationMs?: number;
  workflowFilter?: string[];
  capabilityFilter?: string[];
  autoRollbackEnabled?: boolean;
  gateRules?: CanaryGateRule[];
}

export interface PromotionRequest {
  packId: string;
  fromVersionId: string;
  toVersionId: string;
  action: PromotionAction;
  reason?: string;
  sourceType?: 'CANARY' | 'MANUAL' | 'REPLAY';
  sourceId?: string;
  isEmergency?: boolean;
}
