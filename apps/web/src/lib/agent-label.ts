/**
 * Agent 표시 이름 표준 — 전 화면 공통.
 *
 * 표준 형식: `[코드] 이름`  (예: "[OPS-001] 테스트 자동화 Agent")
 *  - code 가 없으면 이름만
 *  - 이름도 없으면 workflowKey → key 순으로 폴백
 *
 * 메인 Agent(Workflow) / Sub-Agent(노드) 어디서나 이 함수를 써서
 * 화면마다 이름이 제각각 보이지 않도록 일관성을 보장한다.
 */
export interface AgentLabelInput {
  code?: string | null;
  name?: string | null;
  key?: string | null;
  workflowKey?: string | null;
}

export function agentDisplayName(a?: AgentLabelInput | null): string {
  const nm = a?.name ?? a?.workflowKey ?? a?.key ?? '—';
  return a?.code ? `[${a.code}] ${nm}` : nm;
}

/** 코드만 별도로 필요할 때 (배지 등). 없으면 빈 문자열. */
export function agentCode(a?: AgentLabelInput | null): string {
  return a?.code ?? '';
}
