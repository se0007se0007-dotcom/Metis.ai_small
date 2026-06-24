/**
 * Policy Alarm — pure logic (Phase 2.3 표준 로깅 + 정책 알람).
 *
 * Given an evaluation outcome and the active policy thresholds, decide which
 * alarms (if any) should be raised. The service layer persists the resulting
 * alarms as FDSAlert rows. Pure & deterministic for unit testing.
 *
 * @module evaluator/feedback
 */

export interface AlarmInput {
  workflowKey?: string | null;
  stepKey?: string | null;
  agentName?: string | null;
  overallScore: number; // 0-100
  securityRiskLevel?: string | null; // low/medium/high/critical
  anomalyDetected: boolean;
  qualityGrade?: string | null; // A..F
}

export interface AlarmPolicy {
  /** overall below this → 품질 위반 알람 */
  qualityHardGateMin: number; // e.g. 50
  /** raise security alarm at/above this risk */
  securityAlarmLevel?: 'high' | 'critical'; // default 'high'
}

export interface AlarmDraft {
  /** severity for FDSAlert (LOW/MEDIUM/HIGH/CRITICAL) */
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** category of the violated policy */
  category: 'security' | 'quality' | 'anomaly';
  /** 0-1 risk score for FDSAlert.score */
  score: number;
  summary: string;
}

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Decide alarms for one evaluation outcome.
 * Returns [] when nothing violates policy.
 */
export function evaluateAlarms(input: AlarmInput, policy: AlarmPolicy): AlarmDraft[] {
  const out: AlarmDraft[] = [];
  const who = input.agentName || input.workflowKey || input.stepKey || 'agent';
  const alarmLevel = policy.securityAlarmLevel ?? 'high';
  const minRank = RISK_RANK[alarmLevel];

  // ── Security policy violation ──
  const risk = (input.securityRiskLevel ?? '').toLowerCase();
  if (risk && RISK_RANK[risk] !== undefined && RISK_RANK[risk] >= minRank) {
    const critical = risk === 'critical';
    out.push({
      severity: critical ? 'CRITICAL' : 'HIGH',
      category: 'security',
      score: critical ? 0.95 : 0.8,
      summary: `[보안] ${who} — 보안 위험 ${risk.toUpperCase()} 감지 (정책 위반)`,
    });
  }

  // ── Quality hard-gate violation ──
  if (input.overallScore < policy.qualityHardGateMin) {
    const severe = input.overallScore < policy.qualityHardGateMin / 2;
    out.push({
      severity: severe ? 'HIGH' : 'MEDIUM',
      category: 'quality',
      score: Math.max(0, Math.min(1, (policy.qualityHardGateMin - input.overallScore) / 100 + 0.4)),
      summary: `[품질] ${who} — 종합점수 ${input.overallScore} < 기준 ${policy.qualityHardGateMin} (품질 정책 위반)`,
    });
  }

  // ── Anomaly surge ──
  if (input.anomalyDetected) {
    out.push({
      severity: 'MEDIUM',
      category: 'anomaly',
      score: 0.6,
      summary: `[이상] ${who} — 이상 패턴 감지`,
    });
  }

  return out;
}
