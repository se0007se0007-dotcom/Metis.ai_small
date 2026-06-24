'use client';

/**
 * Agent 실행 공유 레이아웃 — 제목·설명·탭을 모든 하위 페이지에서 같은 위치에
 * 고정해 탭 전환 시 아래 콘텐츠만 바뀌도록 한다 (시선 흔들림 제거).
 * ※ Agent 등록은 기준정보 → 「Agent 기준정보」 화면으로 이동했습니다(정의/마스터 관리).
 */

import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-10">
      <PageHeader
        title="Agent 실행"
        description="전체 Agent의 현황·실행 추이·이상을 한눈에 — 카테고리 탭에서 개별 실행/이력 확인"
      />
      <SubTabs
        items={[
          { label: '현황', href: '/agent/overview' },
          { label: '운영', href: '/agent/operations' },
          { label: '개발', href: '/agent/development' },
          { label: 'AI 활동 로그', href: '/agent/activity' },
        ]}
      />
      {children}
    </div>
  );
}
