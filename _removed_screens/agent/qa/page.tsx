'use client';

import { AgentCategoryView } from '@/components/shared/AgentCategoryView';

export default function QaAgentPage() {
  return (
    <AgentCategoryView
      category="qa"
      title="품질/공통 Agent"
      description="품질/공통 카테고리 Agent 실행 및 이력 — 실행 가능 목록, 최근 사용, 실행 이력"
    />
  );
}
