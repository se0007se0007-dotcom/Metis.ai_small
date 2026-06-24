'use client';

import { AgentCategoryView } from '@/components/shared/AgentCategoryView';

export default function OperationsAgentPage() {
  return (
    <AgentCategoryView
      category="operations"
      title="운영 Agent"
      description="운영 카테고리 Agent 실행 및 이력 — 실행 가능 목록, 최근 사용, 실행 이력"
    />
  );
}
