/**
 * 운영 기준값(OpsReferenceConfig) 공용 기본값 + 병합 헬퍼.
 *
 * 대시보드의 ROI/공수/health/등급 계산에 쓰이는 기준값을 한 곳에서 정의한다.
 * DB(OpsReferenceConfig) 행이 없거나 일부만 있으면 이 기본값으로 보정한다.
 * tenant.service / dashboard.service 가 공통으로 사용.
 */
export interface OpsReference {
  hourlyRateUsd: number;
  workingHoursPerMonth: number;
  usdToKrw: number;
  healthDownScore: number;
  healthDownFailRate: number;
  healthDownAnomalyRate: number;
  healthDegradedScore: number;
  healthDegradedFailRate: number;
  healthDegradedAnomalyRate: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  gradeD: number;
}

export const OPS_REFERENCE_DEFAULTS: OpsReference = {
  hourlyRateUsd: 50,
  workingHoursPerMonth: 160,
  usdToKrw: 1380,
  healthDownScore: 50,
  healthDownFailRate: 0.3,
  healthDownAnomalyRate: 0.4,
  healthDegradedScore: 75,
  healthDegradedFailRate: 0.1,
  healthDegradedAnomalyRate: 0.15,
  gradeA: 90,
  gradeB: 80,
  gradeC: 70,
  gradeD: 60,
};

/** DB row(부분/누락 가능) → 기본값으로 보정된 완전한 OpsReference. */
export function mergeOpsRef(row: Record<string, any> | null | undefined): OpsReference {
  const out: any = { ...OPS_REFERENCE_DEFAULTS };
  if (row) {
    for (const k of Object.keys(OPS_REFERENCE_DEFAULTS)) {
      const v = Number(row[k]);
      if (row[k] !== null && row[k] !== undefined && Number.isFinite(v)) out[k] = v;
    }
  }
  return out as OpsReference;
}

/** 사용자 입력 patch에서 알려진 숫자 필드만 추출(검증/클램프). */
export function sanitizeOpsRefPatch(patch: Record<string, any>): Partial<OpsReference> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(OPS_REFERENCE_DEFAULTS)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < 0) continue;
    // 비율 필드는 0~1, 점수/등급은 0~100, 시급/시간은 양수
    if (k.endsWith('FailRate') || k.endsWith('AnomalyRate')) out[k] = Math.min(1, v);
    else if (k.startsWith('grade') || k.endsWith('Score')) out[k] = Math.min(100, Math.round(v));
    else if (k === 'workingHoursPerMonth') out[k] = Math.max(1, Math.round(v));
    else if (k === 'usdToKrw') out[k] = Math.max(1, Math.round(v)); // 원/달러 환율(정수)
    else out[k] = v;
  }
  return out as Partial<OpsReference>;
}
