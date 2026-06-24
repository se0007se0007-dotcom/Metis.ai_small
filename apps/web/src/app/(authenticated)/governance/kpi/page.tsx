'use client';

/**
 * /governance/kpi — 성과·KPI(/governance/effectiveness)와 기능이 중복되어
 * 단일 화면으로 통합 (사용자 피드백: 동일 탭 기능 중복). 기존 링크/북마크
 * 호환을 위해 리다이렉트만 유지한다.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function KpiRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/governance/effectiveness');
  }, [router]);
  return <div className="p-10 text-center text-xs text-gray-400">성과·KPI 화면으로 이동 중…</div>;
}
