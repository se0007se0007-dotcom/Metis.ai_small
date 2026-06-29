'use client';

/**
 * 운영 기준값(프런트 공용) — 월 근무시간/시급을 기준정보에서 1회 로드해 캐시.
 *
 * 대시보드의 MM(맨먼스) 환산 등 표시 계산에서 하드코딩(160) 대신 이 값을 쓴다.
 *   const { } = useOpsRef();   // 컴포넌트 최상단에서 1회 — 로드되면 재렌더
 *   ... / mmHours()            // 분모로 사용 (모듈 캐시 읽기)
 */

import { useState, useEffect } from 'react';
import { api } from '@/lib/api-client';

let _mmHours = 160;
let _hourlyRate = 50;
let _usdToKrw = 1380;
let inflight: Promise<void> | null = null;

function prime(): Promise<void> {
  if (!inflight) {
    inflight = api
      .get<{ workingHoursPerMonth?: number; hourlyRateUsd?: number; usdToKrw?: number }>(
        '/tenants/current/ops-reference',
      )
      .then((r) => {
        if (r?.workingHoursPerMonth && r.workingHoursPerMonth > 0) _mmHours = r.workingHoursPerMonth;
        if (r?.hourlyRateUsd && r.hourlyRateUsd > 0) _hourlyRate = r.hourlyRateUsd;
        if (r?.usdToKrw && r.usdToKrw > 0) _usdToKrw = r.usdToKrw;
      })
      .catch(() => {
        /* 기준정보 미조회 시 기본값(160/50/1380) 유지 */
      });
  }
  return inflight;
}

/** 월 근무시간(MM 환산 분모). 로드 전엔 기본 160. */
export const mmHours = (): number => _mmHours || 160;
/** 기본 시급(USD). 로드 전엔 기본 50. */
export const hourlyRate = (): number => _hourlyRate || 50;
/** 원/달러 환율. 로드 전엔 기본 1380. */
export const usdToKrw = (): number => _usdToKrw || 1380;

/**
 * USD 비용 → 원화 표시 문자열. 기준정보 환율로 환산.
 *   krw(0.0123)   → "₩17"
 *   krw(12.3, { decimals: 0 })  → "₩16,974"
 *   krw(1234.5)   → "₩1,703,610"
 * opts.decimals: 원 단위 소수 자릿수(기본 0). opts.sign: false면 ₩ 기호 생략.
 */
export function krw(
  usd: number | null | undefined,
  opts?: { decimals?: number; sign?: boolean },
): string {
  const n = Number(usd);
  if (!Number.isFinite(n)) return opts?.sign === false ? '0' : '₩0';
  const won = n * (_usdToKrw || 1380);
  const decimals = opts?.decimals ?? 0;
  const body = won.toLocaleString('ko-KR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return opts?.sign === false ? body : `₩${body}`;
}

/** 컴포넌트에서 호출 — 기준정보를 로드하고, 로드되면 재렌더를 유발. */
export function useOpsRef(): { mmHours: number; hourlyRate: number; usdToKrw: number } {
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    prime().then(() => {
      if (alive) bump((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { mmHours: _mmHours, hourlyRate: _hourlyRate, usdToKrw: _usdToKrw };
}
