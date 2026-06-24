/**
 * LLM Reviewer / Orchestrator Agent
 * 모든 하네스 에이전트를 조율하여 포괄적인 리뷰를 생성하고, LLM 기반 검토를 시뮬레이션
 */

import { decomposeIntent, type DecompositionResult } from './intent-decomposer';
import { matchCapabilities, type CapabilityMatch } from './capability-registry';
import { validatePipeline, type PipelineValidationResult } from './data-contract';
import { advisePipeline, type AdvisorResult, type PipelineNode } from './path-advisor';

/**
 * 에이전트 신중 (Deliberation) - 각 에이전트의 의견
 */
export interface AgentDeliberation {
  agentId: 'intent' | 'template' | 'connector' | 'policy' | 'validator' | 'eval';
  phase: string; // 한국어 단계명
  messages: Array<{
    role: 'speak' | 'think' | 'decide';
    content: string; // 한국어
  }>;
  decision: string; // 한국어, 이 에이전트가 내린 결정
  confidence: number; // 0-1
  concerns: string[]; // 한국어, 우려사항들
}

/**
 * 회의 기록 - 전체 회의의 결과
 */
export interface MeetingMinutes {
  sessionId: string;
  prompt: string;
  deliberations: AgentDeliberation[];
  consensus: {
    approved: boolean;
    score: number; // 0-100
    summary: string; // 한국어
  };
  actionItems: Array<{
    agent: string;
    action: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  decomposition: DecompositionResult;
  capabilityMatches: CapabilityMatch[];
  dataCompatibility: PipelineValidationResult;
  pathSuggestions: AdvisorResult;
  timestamp: string;
}

/**
 * 세션 ID 생성
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 에이전트 회의 실행 - 전체 "회의" 조율
 * @param prompt 사용자 입력 프롬프트
 * @param nodes 현재 파이프라인의 노드들
 * @returns 회의 기록 (MeetingMinutes)
 */
export function runAgentMeeting(
  prompt: string,
  nodes: Array<{
    type: string;
    name: string;
    settings?: Record<string, any>;
  }> = [],
): MeetingMinutes {
  const sessionId = generateSessionId();
  const deliberations: AgentDeliberation[] = [];
  const nodeTypes = nodes.map((n) => n.type.toLowerCase());

  // ===== Phase 1: Intent Agent Speaks =====
  const decomposition = decomposeIntent(prompt);

  const intentDeliberation: AgentDeliberation = {
    agentId: 'intent',
    phase: '1단계 - 의도 분석',
    messages: [
      {
        role: 'think',
        content: `프롬프트를 읽어보니 "${decomposition.overallIntent}"라는 주요 요청이 보입니다.`,
      },
      {
        role: 'speak',
        content: `사용자가 요청한 의도를 분석한 결과, ${decomposition.subtasks.length}개의 하위 작업으로 분해됩니다: ${decomposition.subtasks.map((t) => `${t.label}(${t.intentType})`).join(', ')}`,
      },
      {
        role: 'think',
        content: `복잡도는 "${decomposition.complexity}"이고, 필요한 능력은 [${[...new Set(decomposition.subtasks.flatMap((s) => s.requiredCapabilities))].join(', ')}]입니다.`,
      },
    ],
    decision: `의도는 명확히 분해되었으며, ${decomposition.complexity === 'complex' ? '복잡한 파이프라인' : '상대적으로 단순한'} 구조로 판단됩니다.`,
    confidence:
      decomposition.complexity === 'simple'
        ? 0.95
        : decomposition.complexity === 'moderate'
          ? 0.85
          : 0.75,
    concerns:
      decomposition.complexity === 'complex'
        ? ['복잡한 파이프라인은 여러 단계의 검증 필요', '예상치 못한 엣지 케이스 발생 가능성']
        : [],
  };

  deliberations.push(intentDeliberation);

  // ===== Phase 2: Template Agent Speaks =====
  const nodeTypesRequired = decomposition.subtasks.map((t) => t.intentType);
  const nodeMatches = nodeTypesRequired.filter((required) =>
    nodeTypes.some((actual) => actual.includes(required)),
  );

  const templateDeliberation: AgentDeliberation = {
    agentId: 'template',
    phase: '2단계 - 템플릿 검증',
    messages: [
      {
        role: 'think',
        content: `현재 파이프라인에는 [${nodeTypes.join(', ')}] 노드들이 있습니다.`,
      },
      {
        role: 'speak',
        content:
          nodeMatches.length === nodeTypesRequired.length
            ? `의도 분석에서 필요한 모든 노드 타입이 현재 파이프라인에 있습니다.`
            : `의도 분석에서는 [${nodeTypesRequired.join(', ')}]가 필요한데, 현재 파이프라인에는 [${nodeMatches.join(', ')}]만 있습니다.`,
      },
      {
        role: 'think',
        content: `${nodes.length}개의 노드가 있고, 그 중 ${nodeMatches.length}개가 요구사항과 일치합니다.`,
      },
    ],
    decision:
      nodeMatches.length === nodeTypesRequired.length
        ? '현재 파이프라인 구조는 의도와 일치합니다.'
        : `필요한 노드 중 ${nodeTypesRequired.length - nodeMatches.length}개가 누락되었습니다.`,
    confidence:
      nodeMatches.length === nodeTypesRequired.length
        ? 0.9
        : Math.max(0.3, nodeMatches.length / nodeTypesRequired.length),
    concerns:
      nodeMatches.length < nodeTypesRequired.length
        ? nodeTypesRequired
            .filter((t) => !nodeMatches.includes(t))
            .map((t) => `${t} 타입의 노드가 필요합니다`)
        : [],
  };

  deliberations.push(templateDeliberation);

  // ===== Phase 3: Connector Agent Speaks =====
  // 모든 서브태스크의 필요 능력을 수집
  const allCapabilities = [
    ...new Set(decomposition.subtasks.flatMap((s) => s.requiredCapabilities)),
  ];
  const capabilityMatches = matchCapabilities(allCapabilities);

  const connectorMessages: AgentDeliberation['messages'] = [
    {
      role: 'think',
      content: `필요한 능력들을 분석하면: [${allCapabilities.join(', ')}]`,
    },
  ];

  const unmatchedCapabilities = capabilityMatches
    .filter((m) => !m.bestMatch)
    .map((m) => m.capability);

  const avgConfidence =
    capabilityMatches.length > 0
      ? capabilityMatches.reduce((s, m) => s + m.confidence, 0) / capabilityMatches.length
      : 0;

  connectorMessages.push({
    role: 'speak',
    content:
      unmatchedCapabilities.length === 0
        ? `모든 필요한 능력이 매칭되었습니다. 평균 매칭 신뢰도: ${(avgConfidence * 100).toFixed(0)}%`
        : `필요한 능력 중 일부가 누락되었습니다: ${unmatchedCapabilities.join(', ')}`,
  });

  const connectorConcerns: string[] = [];
  capabilityMatches.forEach((match) => {
    if (!match.bestMatch && match.alternatives.length > 0) {
      connectorConcerns.push(
        `${match.capability}을(를) 위해 ${match.alternatives[0]?.name || '적절한 커넥터'}를 연결해야 합니다`,
      );
    } else if (!match.bestMatch) {
      connectorConcerns.push(`${match.capability}에 대한 커넥터를 찾을 수 없습니다`);
    }
  });

  const connectorDeliberation: AgentDeliberation = {
    agentId: 'connector',
    phase: '3단계 - 커넥터 능력 검증',
    messages: connectorMessages,
    decision:
      unmatchedCapabilities.length === 0
        ? '필요한 모든 커넥터 능력이 사용 가능합니다.'
        : `${unmatchedCapabilities.length}개의 능력이 누락되었으며, 추가 커넥터 연결이 필요합니다.`,
    confidence: avgConfidence,
    concerns: connectorConcerns.slice(0, 3),
  };

  deliberations.push(connectorDeliberation);

  // ===== Phase 4: Policy Agent Speaks =====
  const policyMessages: AgentDeliberation['messages'] = [
    {
      role: 'think',
      content: `파이프라인의 노드 타입들을 거버넌스 관점에서 검토합니다: [${nodeTypes.join(', ')}]`,
    },
  ];

  const policyConcerns: string[] = [];

  if (nodeTypes.some((t) => t.includes('email') || t.includes('messaging'))) {
    policyMessages.push({
      role: 'speak',
      content: '외부 발송 노드가 감지되었습니다. 정책 체크포인트가 필요합니다.',
    });
    policyConcerns.push('외부 발송 노드에 정책 체크포인트 필요');
  }

  if (nodeTypes.some((t) => t.includes('database') || t.includes('storage'))) {
    policyMessages.push({
      role: 'speak',
      content: '데이터 저장소 노드가 감지되었습니다. 개인정보 처리 정책 확인이 필요합니다.',
    });
    policyConcerns.push('데이터 저장 시 개인정보 처리 정책 확인 필요');
  }

  if (nodeTypes.some((t) => t.includes('deploy'))) {
    policyMessages.push({
      role: 'speak',
      content: '배포 노드가 감지되었습니다. 반드시 승인 절차를 거쳐야 합니다.',
    });
    policyConcerns.push('배포 노드는 반드시 승인 절차 필요');
  }

  if (policyConcerns.length === 0) {
    policyMessages.push({
      role: 'speak',
      content: '보안과 규정 준수 관점에서 특별한 우려사항이 없습니다.',
    });
  }

  const policyDeliberation: AgentDeliberation = {
    agentId: 'policy',
    phase: '4단계 - 정책 및 거버넌스 검토',
    messages: policyMessages,
    decision:
      policyConcerns.length === 0
        ? '정책 준수가 확보되었습니다.'
        : `${policyConcerns.length}개의 정책 검증 항목이 필요합니다.`,
    confidence: policyConcerns.length === 0 ? 0.95 : 0.65,
    concerns: policyConcerns,
  };

  deliberations.push(policyDeliberation);

  // ===== Phase 5: Validator Agent Speaks =====
  const dataCompatibility = validatePipeline(nodeTypes);

  // pairs에서 호환성 문제를 추출
  const lowScorePairs = dataCompatibility.pairs.filter((p) => p.result.score < 50);
  const medScorePairs = dataCompatibility.pairs.filter(
    (p) => p.result.score >= 50 && p.result.score < 70,
  );
  const criticalIssues = lowScorePairs.map(
    (p) => `${p.from} → ${p.to}: 호환성 ${p.result.score}점`,
  );
  const warningIssues = medScorePairs.map((p) => `${p.from} → ${p.to}: ${p.result.reasoning}`);

  const validatorMessages: AgentDeliberation['messages'] = [
    {
      role: 'think',
      content: `${nodeTypes.length}개의 노드 간 데이터 호환성을 검증합니다.`,
    },
    {
      role: 'speak',
      content: `데이터 호환성 점수: ${dataCompatibility.overallScore}점 - ${
        dataCompatibility.isExecutable ? '실행 가능합니다' : '호환성 문제가 있습니다'
      }`,
    },
  ];

  if (criticalIssues.length > 0) {
    validatorMessages.push({
      role: 'speak',
      content: `심각한 문제 감지: ${criticalIssues[0]}`,
    });
  }

  if (warningIssues.length > 0) {
    validatorMessages.push({
      role: 'speak',
      content: `경고: ${warningIssues.slice(0, 2).join('; ')}`,
    });
  }

  const validatorDeliberation: AgentDeliberation = {
    agentId: 'validator',
    phase: '5단계 - 데이터 호환성 검증',
    messages: validatorMessages,
    decision: dataCompatibility.isExecutable
      ? '모든 노드 간 데이터 호환성이 확보되었습니다.'
      : `노드 간 데이터 호환성 문제가 있습니다: ${criticalIssues.slice(0, 2).join('; ')}`,
    confidence: dataCompatibility.overallScore / 100,
    concerns: [...criticalIssues.slice(0, 2), ...warningIssues.slice(0, 1)],
  };

  deliberations.push(validatorDeliberation);

  // ===== Phase 6: Eval Agent Speaks =====
  const pipelineNodes: PipelineNode[] = nodes.map((n) => ({
    type: n.type,
    name: n.name,
    settings: n.settings || {},
  }));
  const pathSuggestions = advisePipeline(pipelineNodes, prompt);

  const evalMessages: AgentDeliberation['messages'] = [
    {
      role: 'think',
      content: `현재 파이프라인을 전략적으로 평가하고 개선 경로를 제시합니다.`,
    },
    {
      role: 'speak',
      content: `${pathSuggestions.suggestions.slice(0, 3).length}개의 주요 개선 제안이 있습니다: ${pathSuggestions.suggestions
        .slice(0, 3)
        .map((s) => s.title)
        .join(', ')}`,
    },
    {
      role: 'speak',
      content: `전체 평가: ${pathSuggestions.summary}`,
    },
  ];

  const evalDeliberation: AgentDeliberation = {
    agentId: 'eval',
    phase: '6단계 - 전략적 평가 및 추천',
    messages: evalMessages,
    decision: `최종 추천: ${pathSuggestions.summary}`,
    confidence: pathSuggestions.suggestions.length === 0 ? 0.9 : 0.75,
    concerns: pathSuggestions.suggestions
      .filter((s) => s.priority === 'high')
      .map((s) => s.title)
      .slice(0, 3),
  };

  deliberations.push(evalDeliberation);

  // ===== Consensus Building =====
  const confidenceScores = deliberations.map((d) => d.confidence);
  const averageConfidence = confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length;

  const blockingConcerns = deliberations.filter(
    (d) => d.agentId === 'policy' && d.concerns.length > 0,
  );

  const approved =
    averageConfidence > 0.7 && blockingConcerns.length === 0 && criticalIssues.length === 0;

  const consensusScore = Math.round(
    (approved ? 80 : 50) + averageConfidence * 15 + (unmatchedCapabilities.length === 0 ? 5 : 0),
  );

  const consensusSummary = approved
    ? '파이프라인이 승인 기준을 충족합니다. 바로 실행할 수 있습니다.'
    : '파이프라인에 몇 가지 개선사항이 필요합니다. 권장 수정 후 재검토하시기 바랍니다.';

  // ===== Action Items =====
  const actionItems: MeetingMinutes['actionItems'] = [];

  if (unmatchedCapabilities.length > 0) {
    actionItems.push({
      agent: 'connector',
      action: `누락된 능력 추가: ${unmatchedCapabilities.join(', ')}`,
      priority: 'high',
    });
  }

  if (criticalIssues.length > 0) {
    actionItems.push({
      agent: 'validator',
      action: `데이터 호환성 문제 해결: ${criticalIssues[0]}`,
      priority: 'high',
    });
  }

  if (policyConcerns.length > 0) {
    actionItems.push({
      agent: 'policy',
      action: `정책 검증 체크리스트 작성 및 승인`,
      priority: 'high',
    });
  }

  pathSuggestions.suggestions.slice(0, 3).forEach((suggestion, index) => {
    actionItems.push({
      agent: 'eval',
      action: suggestion.title,
      priority: index === 0 ? 'high' : index === 1 ? 'medium' : 'low',
    });
  });

  // ===== Return Meeting Minutes =====
  return {
    sessionId,
    prompt,
    deliberations,
    consensus: {
      approved,
      score: consensusScore,
      summary: consensusSummary,
    },
    actionItems,
    decomposition,
    capabilityMatches,
    dataCompatibility,
    pathSuggestions,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 회의 기록을 사람이 읽을 수 있는 형태로 포맷팅
 */
export function formatMeetingMinutes(minutes: MeetingMinutes): string {
  let output = '';

  output += `\n========================================\n`;
  output += `     Metis.AI Builder Harness - 에이전트 회의 기록\n`;
  output += `========================================\n\n`;

  output += `세션 ID: ${minutes.sessionId}\n`;
  output += `시간: ${minutes.timestamp}\n`;
  output += `프롬프트: "${minutes.prompt}"\n\n`;

  output += `========================================\n`;
  output += `    에이전트 신중 (Deliberations)\n`;
  output += `========================================\n`;

  minutes.deliberations.forEach((deliberation) => {
    output += `\n[${deliberation.phase}]\n`;
    output += `에이전트: ${deliberation.agentId}\n`;
    output += `신뢰도: ${(deliberation.confidence * 100).toFixed(0)}%\n\n`;

    deliberation.messages.forEach((msg) => {
      const roleLabel =
        msg.role === 'speak' ? '💬 말함' : msg.role === 'think' ? '🤔 생각' : '✅ 결정';
      output += `${roleLabel}: ${msg.content}\n`;
    });

    output += `\n결정: ${deliberation.decision}\n`;

    if (deliberation.concerns.length > 0) {
      output += `우려사항: ${deliberation.concerns.join('; ')}\n`;
    }
  });

  output += `\n========================================\n`;
  output += `    합의 (Consensus)\n`;
  output += `========================================\n`;
  output += `승인 여부: ${minutes.consensus.approved ? '✅ 승인' : '❌ 미승인'}\n`;
  output += `점수: ${minutes.consensus.score}/100\n`;
  output += `요약: ${minutes.consensus.summary}\n`;

  if (minutes.actionItems.length > 0) {
    output += `\n========================================\n`;
    output += `    실행 항목 (Action Items)\n`;
    output += `========================================\n`;

    minutes.actionItems.forEach((item) => {
      const priorityLabel =
        item.priority === 'high' ? '🔴 높음' : item.priority === 'medium' ? '🟡 중간' : '🟢 낮음';
      output += `\n${priorityLabel} [${item.agent}] ${item.action}\n`;
    });
  }

  output += `\n========================================\n`;

  return output;
}
