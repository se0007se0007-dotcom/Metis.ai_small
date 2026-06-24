/**
 * Pattern Analysis — Phase 2.1 (pure logic)
 *
 * Analyzes a window of AgentEvaluation records and detects actionable
 * patterns, then derives policy-adjustment suggestions. Kept free of NestJS
 * and Prisma so it can be unit-tested in isolation; the service layer feeds
 * it plain rows and persists the resulting suggestions.
 *
 * Detected patterns:
 *   - repeated_security_failure : an agent repeatedly trips the security gate
 *   - quality_decline           : an agent's quality score trends downward
 *   - cost_overrun              : an agent's cost efficiency is persistently low
 *   - anomaly_surge             : anomaly rate exceeds a healthy threshold
 *
 * @module evaluator/feedback
 */

/** Minimal evaluation row shape this analyzer needs. */
export interface EvalRow {
  agentName: string | null;
  overallScore: number;
  securityScore: number | null;
  securityRiskLevel: string | null;
  qualityGrade: string | null;
  costEfficiency: number | null;
  anomalyDetected: boolean;
  createdAt: Date | string;
}

/** A single proposed change to a policy field. */
export interface ProposedChange {
  field: string;
  from: number | boolean;
  to: number | boolean;
}

/** A detected pattern + its recommended policy adjustment. */
export interface PolicySuggestionDraft {
  patternType: 'repeated_security_failure' | 'quality_decline' | 'cost_overrun' | 'anomaly_surge';
  agentName: string | null;
  severity: 'low' | 'medium' | 'high';
  title: string;
  rationale: string;
  proposedChanges: ProposedChange[];
  evidence: Record<string, unknown>;
}

/** Tunable analysis parameters (defaults reflect sensible production values). */
export interface AnalysisParams {
  /** Minimum rows for an agent before we trust any agent-specific pattern. */
  minSamplesPerAgent: number;
  /** Security failures (count) within window to flag repeated failure. */
  securityFailureThreshold: number;
  /** Anomaly rate (0-1) above which we flag an anomaly surge. */
  anomalyRateThreshold: number;
  /** Cost efficiency (0-1) below which cost is considered an overrun. */
  costEfficiencyFloor: number;
  /** Minimum downward delta in avg quality (first half → second half) to flag decline. */
  qualityDeclineDelta: number;
}

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  minSamplesPerAgent: 5,
  securityFailureThreshold: 3,
  anomalyRateThreshold: 0.3,
  costEfficiencyFloor: 0.4,
  qualityDeclineDelta: 15,
};

/** Map a quality letter grade to a 0-100 score (matches evaluator gradeMap). */
const GRADE_SCORE: Record<string, number> = { A: 95, B: 85, C: 75, D: 65, F: 30, 'N/A': 70 };

function gradeToScore(g: string | null): number {
  if (!g) return 70;
  return GRADE_SCORE[g] ?? 70;
}

function isSecurityFailure(row: EvalRow): boolean {
  const lvl = (row.securityRiskLevel ?? '').toLowerCase();
  return lvl === 'critical' || lvl === 'high';
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/** Clamp a number into [min, max]. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Group rows by agentName ("__unknown__" bucket for null). */
export function groupByAgent(rows: EvalRow[]): Map<string, EvalRow[]> {
  const map = new Map<string, EvalRow[]>();
  for (const r of rows) {
    const key = r.agentName ?? '__unknown__';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}

/** Sort rows ascending by createdAt (stable on ties). */
function sortByTime(rows: EvalRow[]): EvalRow[] {
  return [...rows].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * Analyze evaluation rows for a single tenant and produce suggestion drafts.
 *
 * @param rows    Evaluation rows (any time order; sorted internally)
 * @param policy  Current resolved policy values relevant to suggestions
 * @param params  Analysis thresholds (defaults provided)
 */
export function analyzeEvaluations(
  rows: EvalRow[],
  policy: {
    securityCriticalCap: number;
    securityHighCap: number;
    qualityHardGateMin: number;
    securityWeight: number;
    qualityWeight: number;
    llmJudgeEnabled: boolean;
  },
  params: AnalysisParams = DEFAULT_ANALYSIS_PARAMS,
): PolicySuggestionDraft[] {
  const drafts: PolicySuggestionDraft[] = [];
  if (!Array.isArray(rows) || rows.length === 0) return drafts;

  const byAgent = groupByAgent(rows);

  for (const [agentKey, agentRowsRaw] of byAgent) {
    const agentRows = sortByTime(agentRowsRaw);
    const agentName = agentKey === '__unknown__' ? null : agentKey;
    if (agentRows.length < params.minSamplesPerAgent) continue;

    // ── 1) repeated security failure ──
    const secFailures = agentRows.filter(isSecurityFailure).length;
    if (secFailures >= params.securityFailureThreshold) {
      // Tighten the security caps (lower cap = stricter) by 10, floored at 20.
      const newCritical = clamp(policy.securityCriticalCap - 10, 20, 100);
      const changes: ProposedChange[] = [];
      if (newCritical < policy.securityCriticalCap) {
        changes.push({
          field: 'securityCriticalCap',
          from: policy.securityCriticalCap,
          to: newCritical,
        });
      }
      const severity: PolicySuggestionDraft['severity'] =
        secFailures >= params.securityFailureThreshold * 2 ? 'high' : 'medium';
      drafts.push({
        patternType: 'repeated_security_failure',
        agentName,
        severity,
        title: `${agentName ?? '에이전트'} 보안 Gate ${secFailures}회 실패 — 보안 기준 강화 권고`,
        rationale:
          `최근 분석 구간에서 ${agentName ?? '해당 에이전트'}가 보안 Gate를 ${secFailures}회 ` +
          `(critical/high) 실패했습니다. securityCriticalCap을 ${policy.securityCriticalCap}→${newCritical}로 ` +
          `낮춰 위험 응답의 종합 점수 상한을 더 강하게 제한할 것을 권고합니다.`,
        proposedChanges: changes,
        evidence: { securityFailures: secFailures, sampleSize: agentRows.length },
      });
    }

    // ── 2) quality decline (first half vs second half) ──
    if (agentRows.length >= Math.max(6, params.minSamplesPerAgent)) {
      const mid = Math.floor(agentRows.length / 2);
      const firstAvg = avg(agentRows.slice(0, mid).map((r) => gradeToScore(r.qualityGrade)));
      const secondAvg = avg(agentRows.slice(mid).map((r) => gradeToScore(r.qualityGrade)));
      const delta = firstAvg - secondAvg;
      if (delta >= params.qualityDeclineDelta) {
        // Raise the quality hard gate so degraded quality is penalized harder.
        const newGate = clamp(policy.qualityHardGateMin + 5, 0, 90);
        const changes: ProposedChange[] = [];
        if (newGate > policy.qualityHardGateMin) {
          changes.push({
            field: 'qualityHardGateMin',
            from: policy.qualityHardGateMin,
            to: newGate,
          });
        }
        drafts.push({
          patternType: 'quality_decline',
          agentName,
          severity: delta >= params.qualityDeclineDelta * 2 ? 'high' : 'medium',
          title: `${agentName ?? '에이전트'} 품질 점수 하락 추세 (${firstAvg.toFixed(0)}→${secondAvg.toFixed(0)})`,
          rationale:
            `품질 평균이 전반부 ${firstAvg.toFixed(1)}점에서 후반부 ${secondAvg.toFixed(1)}점으로 ` +
            `${delta.toFixed(1)}점 하락했습니다. qualityHardGateMin을 ${policy.qualityHardGateMin}→${newGate}로 ` +
            `높여 저품질 응답을 더 엄격히 차단할 것을 권고합니다. LLM Judge가 꺼져 있다면 활성화도 검토하세요.`,
          proposedChanges:
            changes.length > 0
              ? changes
              : policy.llmJudgeEnabled
                ? []
                : [{ field: 'llmJudgeEnabled', from: false, to: true }],
          evidence: {
            firstHalfAvg: round1(firstAvg),
            secondHalfAvg: round1(secondAvg),
            delta: round1(delta),
            sampleSize: agentRows.length,
          },
        });
      }
    }

    // ── 3) cost overrun ──
    const costVals = agentRows
      .map((r) => r.costEfficiency)
      .filter((v): v is number => typeof v === 'number');
    if (costVals.length >= params.minSamplesPerAgent) {
      const costAvg = avg(costVals);
      if (costAvg < params.costEfficiencyFloor) {
        drafts.push({
          patternType: 'cost_overrun',
          agentName,
          severity: costAvg < params.costEfficiencyFloor / 2 ? 'high' : 'low',
          title: `${agentName ?? '에이전트'} 비용 효율 저조 (평균 ${(costAvg * 100).toFixed(0)}%)`,
          rationale:
            `비용 효율 평균이 ${(costAvg * 100).toFixed(0)}%로 기준(${(params.costEfficiencyFloor * 100).toFixed(0)}%) ` +
            `미만입니다. 라우팅 tier 하향 또는 캐시 활성화 검토가 필요합니다. (정책 자동 변경은 제안하지 않음)`,
          proposedChanges: [],
          evidence: { costEfficiencyAvg: round2(costAvg), sampleSize: costVals.length },
        });
      }
    }
  }

  // ── 4) tenant-wide anomaly surge ──
  const anomalyRate = rows.filter((r) => r.anomalyDetected).length / rows.length;
  if (anomalyRate >= params.anomalyRateThreshold) {
    drafts.push({
      patternType: 'anomaly_surge',
      agentName: null,
      severity: anomalyRate >= params.anomalyRateThreshold * 1.5 ? 'high' : 'medium',
      title: `이상 탐지율 급증 (${(anomalyRate * 100).toFixed(0)}%)`,
      rationale:
        `전체 평가의 ${(anomalyRate * 100).toFixed(0)}%에서 이상이 감지되었습니다. ` +
        `LLM Judge 평가 빈도를 높여 정밀 점검을 권고합니다(적응형 샘플링과 연계).`,
      proposedChanges: policy.llmJudgeEnabled
        ? []
        : [{ field: 'llmJudgeEnabled', from: false, to: true }],
      evidence: { anomalyRate: round2(anomalyRate), totalSamples: rows.length },
    });
  }

  return drafts;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
