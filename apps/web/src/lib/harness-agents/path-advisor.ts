/**
 * Path Advisor Agent for Metis.AI Builder Harness
 *
 * 워크플로우 파이프라인의 대체 설정 및 개선 사항을 제안하는 에이전트
 * - 신뢰성 개선 (재시도, 에러 핸들링, 검증)
 * - 비용 최적화 (모델 선택, API 설정)
 * - 속도 개선 (병렬 실행, 결합)
 * - 아키텍처 개선 (모니터링, 다중 채널, 캐싱)
 */

/**
 * 파이프라인 개선 제안 인터페이스
 */
export interface PathSuggestion {
  /** 제안 고유 ID */
  id: string;

  /** 제안 유형 */
  type:
    | 'replace-node'
    | 'add-node'
    | 'remove-node'
    | 'reorder'
    | 'add-branch'
    | 'change-connector'
    | 'optimize';

  /** 우선순위 (높음/중간/낮음) */
  priority: 'high' | 'medium' | 'low';

  /** 제안 제목 (한국어, 간결) */
  title: string;

  /** 제안 설명 (한국어, 상세) */
  description: string;

  /** 이 변경이 메트릭에 미치는 영향 (-100 ~ +100) */
  impact: {
    /** 신뢰성 영향 */
    reliability: number;
    /** 비용 영향 (음수 = 비용 감소) */
    cost: number;
    /** 속도 영향 (양수 = 더 빠름) */
    speed: number;
  };

  /** 대상 노드 인덱스 (선택사항) */
  targetNodeIndex?: number;

  /** 제안된 설정 (선택사항) */
  suggestedConfig?: Record<string, any>;

  /** 이유 설명 (한국어) */
  reasoning: string;
}

/**
 * 어드바이저 결과 인터페이스
 */
export interface AdvisorResult {
  /** 생성된 제안 목록 */
  suggestions: PathSuggestion[];

  /** 현재 파이프라인 점수 (0-100) */
  currentScore: {
    /** 신뢰성 (0-100) */
    reliability: number;
    /** 비용 효율성 (0-100) */
    cost: number;
    /** 속도 (0-100) */
    speed: number;
  };

  /** 높음 우선순위 제안 모두 적용 시 예상 점수 */
  potentialScore: {
    reliability: number;
    cost: number;
    speed: number;
  };

  /** 전체 조언 요약 (한국어, 1-2 문장) */
  summary: string;
}

/**
 * 파이프라인 노드 기본 인터페이스
 */
export interface PipelineNode {
  type: string;
  name: string;
  settings: Record<string, any>;
}

/**
 * 파이프라인 분석 결과 (내부 사용)
 */
interface PipelineAnalysis {
  hasRetry: boolean;
  hasErrorHandling: boolean;
  hasValidation: boolean;
  hasCheckpoint: boolean;
  hasMonitoring: boolean;
  hasMultipleChannels: boolean;
  parallelizableNodes: number[];
  combinableNodes: Array<{ from: number; to: number }>;
  expensiveModels: Array<{ nodeIndex: number; model: string }>;
  writeNodes: number[];
  emailNodes: number[];
  webSearchNodes: number[];
  aiNodes: number[];
}

/**
 * 파이프라인 분석 수행
 */
function analyzePipeline(nodes: PipelineNode[]): PipelineAnalysis {
  const analysis: PipelineAnalysis = {
    hasRetry: false,
    hasErrorHandling: false,
    hasValidation: false,
    hasCheckpoint: false,
    hasMonitoring: false,
    hasMultipleChannels: false,
    parallelizableNodes: [],
    combinableNodes: [],
    expensiveModels: [],
    writeNodes: [],
    emailNodes: [],
    webSearchNodes: [],
    aiNodes: [],
  };

  // 노드별 분석
  nodes.forEach((node, index) => {
    // 재시도 설정 확인
    if (node.settings?.retry?.enabled) {
      analysis.hasRetry = true;
    }

    // 에러 핸들링 (조건문 확인)
    if (node.type === 'condition' && node.name.toLowerCase().includes('error')) {
      analysis.hasErrorHandling = true;
    }

    // 검증 노드 확인
    if (node.type === 'data-transform' && node.name.toLowerCase().includes('validat')) {
      analysis.hasValidation = true;
    }

    // 체크포인트 노드 확인
    if (node.type === 'wait-approval' || node.type === 'checkpoint') {
      analysis.hasCheckpoint = true;
    }

    // 모니터링/로깅 확인
    if (node.type === 'log-monitor' || node.type === 'monitoring') {
      analysis.hasMonitoring = true;
    }

    // 쓰기 작업 노드
    if (['database-write', 'api-call', 'send', 'email', 'slack'].includes(node.type)) {
      analysis.writeNodes.push(index);
    }

    // 이메일 노드
    if (node.type === 'email') {
      analysis.emailNodes.push(index);
    }

    // 웹 검색 노드
    if (node.type === 'web-search') {
      analysis.webSearchNodes.push(index);
    }

    // AI 처리 노드
    if (node.type === 'ai-processing') {
      analysis.aiNodes.push(index);

      // 비싼 모델 감지
      const model = node.settings?.model || '';
      if (
        model.includes('gpt-4') ||
        model.includes('claude-3-opus') ||
        model.includes('claude-opus')
      ) {
        analysis.expensiveModels.push({ nodeIndex: index, model });
      }
    }
  });

  // 다중 채널 확인 (여러 발송 노드)
  const channelCount = [
    ...analysis.emailNodes,
    ...analysis.writeNodes.filter((i) => nodes[i].type === 'slack'),
  ].length;
  if (channelCount > 1) {
    analysis.hasMultipleChannels = true;
  }

  // 병렬화 가능한 노드 찾기 (인접하지 않은 같은 타입 노드)
  for (let i = 0; i < nodes.length - 2; i++) {
    if (nodes[i].type === 'data-transform' && nodes[i + 2]?.type === 'data-transform') {
      if (!analysis.parallelizableNodes.includes(i)) {
        analysis.parallelizableNodes.push(i);
      }
      if (!analysis.parallelizableNodes.includes(i + 2)) {
        analysis.parallelizableNodes.push(i + 2);
      }
    }
  }

  // 결합 가능한 노드 찾기 (연속된 data-transform + ai-processing)
  for (let i = 0; i < nodes.length - 1; i++) {
    if (nodes[i].type === 'data-transform' && nodes[i + 1].type === 'ai-processing') {
      analysis.combinableNodes.push({ from: i, to: i + 1 });
    }
  }

  return analysis;
}

/**
 * 현재 파이프라인 점수 계산
 */
function calculateCurrentScore(
  nodes: PipelineNode[],
  analysis: PipelineAnalysis,
): AdvisorResult['currentScore'] {
  let reliability = 50;
  let cost = 50;
  let speed = 50;

  // 신뢰성 점수
  if (analysis.hasRetry) reliability += 15;
  if (analysis.hasErrorHandling) reliability += 15;
  if (analysis.hasValidation) reliability += 10;
  if (analysis.hasCheckpoint) reliability += 10;
  reliability = Math.min(100, reliability);

  // 비용 점수 (낮을수록 좋음, 그래서 역순)
  if (analysis.expensiveModels.length > 0) {
    cost = Math.max(30, cost - analysis.expensiveModels.length * 10);
  }
  if (analysis.aiNodes.length > 3) {
    cost = Math.max(20, cost - 10);
  }

  // 속도 점수
  if (nodes.length <= 3) speed = 80;
  else if (nodes.length <= 5) speed = 70;
  else if (nodes.length <= 10) speed = 60;
  else speed = 40;

  if (analysis.hasCheckpoint) speed = Math.max(30, speed - 10); // 체크포인트는 속도 저하

  return { reliability, cost, speed };
}

/**
 * 신뢰성 개선 제안 생성
 */
function generateReliabilitySuggestions(
  nodes: PipelineNode[],
  analysis: PipelineAnalysis,
): PathSuggestion[] {
  const suggestions: PathSuggestion[] = [];

  // 제안 1: 쓰기 노드에 재시도 추가
  if (!analysis.hasRetry && analysis.writeNodes.length > 0) {
    suggestions.push({
      id: 'retry-write-nodes',
      type: 'optimize',
      priority: 'high',
      title: '쓰기 작업에 재시도 설정 추가',
      description:
        '데이터베이스 저장, API 호출, 이메일 발송 등 쓰기 작업 실패 시 자동 재시도를 활성화하여 일시적 오류로 인한 실패를 방지합니다.',
      impact: { reliability: 20, cost: 5, speed: -2 },
      targetNodeIndex: analysis.writeNodes[0],
      suggestedConfig: {
        retry: {
          enabled: true,
          maxAttempts: 3,
          delayMs: 1000,
          backoffMultiplier: 2,
        },
      },
      reasoning:
        '네트워크 지연, 일시적 서비스 중단 등으로 인한 실패를 자동으로 복구하여 파이프라인의 신뢰성을 크게 향상시킵니다.',
    });
  }

  // 제안 2: 에러 핸들링 추가
  if (!analysis.hasErrorHandling) {
    suggestions.push({
      id: 'add-error-handling',
      type: 'add-node',
      priority: 'high',
      title: '에러 처리 분기 추가',
      description:
        'AI 처리나 API 호출 후 에러 여부를 판단하여 다른 처리 경로로 분기하는 조건 노드를 추가합니다.',
      impact: { reliability: 25, cost: 0, speed: -1 },
      suggestedConfig: {
        nodeType: 'condition',
        name: '에러 발생 여부 확인',
        condition: '{{previousNode.error}} exists',
        branches: [
          { name: '에러 발생', path: 'error-handler' },
          { name: '정상', path: 'continue' },
        ],
      },
      reasoning:
        '예상 밖의 오류 발생 시 우아한 실패(graceful failure) 처리로 파이프라인 신뢰성을 높이고 사용자 경험을 개선합니다.',
    });
  }

  // 제안 3: 이메일 검증 추가
  if (analysis.emailNodes.length > 0 && !analysis.hasValidation) {
    suggestions.push({
      id: 'validate-email',
      type: 'add-node',
      priority: 'high',
      title: '이메일 형식 검증 추가',
      description:
        '이메일 발송 전에 이메일 주소 형식을 검증하는 데이터 변환 노드를 추가하여 잘못된 주소로의 발송을 방지합니다.',
      impact: { reliability: 15, cost: 0, speed: -1 },
      targetNodeIndex: Math.max(0, analysis.emailNodes[0] - 1),
      suggestedConfig: {
        nodeType: 'data-transform',
        name: '이메일 주소 검증',
        transformations: [
          {
            field: 'email',
            operation: 'validate',
            pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
            errorBehavior: 'skip',
          },
        ],
      },
      reasoning:
        '유효하지 않은 이메일 주소로 인한 발송 실패를 사전에 차단하여 파이프라인 신뢰성을 높입니다.',
    });
  }

  // 제안 4: 긴 파이프라인에 체크포인트 추가
  if (!analysis.hasCheckpoint && nodes.length >= 5) {
    const midpoint = Math.floor(nodes.length / 2);
    suggestions.push({
      id: 'add-checkpoint',
      type: 'add-node',
      priority: 'medium',
      title: '중간 체크포인트 추가',
      description:
        '5개 이상의 노드로 구성된 길이가 긴 파이프라인의 중간 지점에 승인 대기 포인트를 추가하여 중간 결과를 검증합니다.',
      impact: { reliability: 10, cost: 0, speed: -30 },
      targetNodeIndex: midpoint,
      suggestedConfig: {
        nodeType: 'wait-approval',
        name: '결과 검증 승인 대기',
        timeout: 3600000,
      },
      reasoning:
        '중간 결과를 수동으로 검증함으로써 잘못된 처리가 파이프라인 끝까지 전파되는 것을 방지합니다.',
    });
  }

  return suggestions;
}

/**
 * 비용 최적화 제안 생성
 */
function generateCostOptimizationSuggestions(
  nodes: PipelineNode[],
  analysis: PipelineAnalysis,
): PathSuggestion[] {
  const suggestions: PathSuggestion[] = [];

  // 제안 5: 비싼 모델을 더 저렴한 모델로 교체
  analysis.expensiveModels.forEach((expensive) => {
    let cheaperModel = 'gpt-3.5-turbo';
    let title = 'AI 모델 최적화';
    let description = '복잡한 추론이 필요하지 않은 작업에 더 저렴한 모델을 사용합니다.';

    if (expensive.model.includes('gpt-4')) {
      cheaperModel = 'gpt-3.5-turbo';
      description =
        'GPT-4는 고정밀 분석이 필요한 경우에만 사용하고, 일반적인 처리에는 GPT-3.5-turbo를 사용하여 비용을 50-90% 절감합니다.';
    } else if (
      expensive.model.includes('claude-opus') ||
      expensive.model.includes('claude-3-opus')
    ) {
      cheaperModel = 'claude-3-haiku';
      description =
        'Claude 3 Opus는 복잡한 작업에만 사용하고, 간단한 요약/분류에는 Claude 3 Haiku를 사용하여 비용을 크게 절감합니다.';
    }

    suggestions.push({
      id: `optimize-model-${expensive.nodeIndex}`,
      type: 'replace-node',
      priority: 'high',
      title: title,
      description: description,
      impact: { reliability: -5, cost: -50, speed: 5 },
      targetNodeIndex: expensive.nodeIndex,
      suggestedConfig: {
        model: cheaperModel,
        temperature: nodes[expensive.nodeIndex].settings?.temperature || 0.7,
      },
      reasoning: `${expensive.model}에서 ${cheaperModel}로 교체하면 비용을 크게 줄이면서도 대부분의 작업에서 충분한 품질을 유지합니다.`,
    });
  });

  // 제안 6: 웹 검색 결과 수 최적화
  analysis.webSearchNodes.forEach((nodeIndex) => {
    const node = nodes[nodeIndex];
    const maxResults = node.settings?.maxResults || 10;

    if (maxResults > 5) {
      suggestions.push({
        id: `optimize-web-search-${nodeIndex}`,
        type: 'optimize',
        priority: 'medium',
        title: '웹 검색 결과 수 최적화',
        description:
          '요약(summarize)이나 분류(classify)만 필요한 경우 검색 결과를 5개 이하로 제한하여 API 비용을 절감합니다.',
        impact: { reliability: -2, cost: -30, speed: 10 },
        targetNodeIndex: nodeIndex,
        suggestedConfig: {
          maxResults: 5,
          timeout: 5000,
        },
        reasoning:
          '대부분의 요약 작업은 상위 3-5개 결과로 충분하며, 결과 수를 줄이면 검색 시간도 단축됩니다.',
      });
    }
  });

  // 제안 7: 여러 AI 호출 통합
  if (analysis.aiNodes.length > 1 && analysis.combinableNodes.length > 0) {
    suggestions.push({
      id: 'merge-ai-calls',
      type: 'optimize',
      priority: 'medium',
      title: '여러 AI 호출 통합',
      description:
        '순차적인 데이터 변환 후 AI 처리를 한 번에 수행하도록 통합하여 API 호출 횟수를 줄입니다.',
      impact: { reliability: 0, cost: -20, speed: 20 },
      suggestedConfig: {
        mergeStrategy: 'combine-prompt',
        description: '데이터 변환과 AI 처리를 하나의 프롬프트로 통합',
      },
      reasoning: 'API 호출 횟수를 줄이면 비용과 지연 시간을 동시에 감소시킬 수 있습니다.',
    });
  }

  return suggestions;
}

/**
 * 속도 개선 제안 생성
 */
function generateSpeedOptimizationSuggestions(
  nodes: PipelineNode[],
  analysis: PipelineAnalysis,
): PathSuggestion[] {
  const suggestions: PathSuggestion[] = [];

  // 제안 8: 병렬 실행
  if (analysis.parallelizableNodes.length >= 2) {
    suggestions.push({
      id: 'parallelize-nodes',
      type: 'optimize',
      priority: 'medium',
      title: '노드 병렬 실행',
      description:
        '서로 의존성이 없는 데이터 변환 노드들을 병렬로 실행하여 전체 실행 시간을 단축합니다.',
      impact: { reliability: 0, cost: 0, speed: 30 },
      suggestedConfig: {
        parallelNodes: analysis.parallelizableNodes,
        mergeStrategy: 'merge-results',
      },
      reasoning:
        '독립적인 작업은 병렬로 실행할 수 있어 전체 파이프라인 실행 시간을 크게 단축할 수 있습니다.',
    });
  }

  // 제안 9: 검색→요약→발송 패턴 최적화 (캐싱)
  const hasSearch = analysis.webSearchNodes.length > 0;
  const hasAI = analysis.aiNodes.length > 0;
  const hasSend = analysis.writeNodes.length > 0;

  if (hasSearch && hasAI && hasSend) {
    suggestions.push({
      id: 'add-cache-node',
      type: 'add-node',
      priority: 'medium',
      title: '검색 결과 캐싱 추가',
      description:
        '웹 검색 결과를 캐시하여 동일한 검색 쿼리에 대한 재검색을 방지하고 파이프라인 속도를 높입니다.',
      impact: { reliability: 0, cost: -15, speed: 25 },
      suggestedConfig: {
        nodeType: 'cache',
        name: '검색 결과 캐시',
        cacheKey: '{{ query }}',
        ttl: 3600000,
      },
      reasoning:
        '같은 쿼리로 반복 실행될 경우 캐시된 결과를 사용하여 웹 검색 API 호출을 건너뛸 수 있습니다.',
    });
  }

  return suggestions;
}

/**
 * 아키텍처 개선 제안 생성
 */
function generateArchitectureImprovementSuggestions(
  nodes: PipelineNode[],
  analysis: PipelineAnalysis,
  prompt: string,
): PathSuggestion[] {
  const suggestions: PathSuggestion[] = [];

  // 제안 10: 모니터링/로깅 추가
  if (!analysis.hasMonitoring) {
    suggestions.push({
      id: 'add-monitoring',
      type: 'add-node',
      priority: 'medium',
      title: '모니터링/로깅 추가',
      description:
        '파이프라인의 실행 결과, 성능 지표, 에러 정보를 로깅하여 문제 진단과 성능 분석을 용이하게 합니다.',
      impact: { reliability: 5, cost: 2, speed: -1 },
      suggestedConfig: {
        nodeType: 'log-monitor',
        name: '파이프라인 로깅',
        logLevel: 'info',
        fields: ['timestamp', 'nodeId', 'duration', 'status', 'error'],
      },
      reasoning:
        '로깅을 통해 파이프라인 실행 흐름을 추적하고 문제 발생 시 빠르게 원인을 파악할 수 있습니다.',
    });
  }

  // 제안 11: 백업 알림 채널 추가
  if (
    (analysis.emailNodes.length > 0 || analysis.writeNodes.length > 0) &&
    !analysis.hasMultipleChannels
  ) {
    const hasEmail = analysis.emailNodes.length > 0;
    const suggestedBackup = hasEmail ? 'Slack' : 'Gmail';

    suggestions.push({
      id: 'add-backup-channel',
      type: 'add-node',
      priority: 'medium',
      title: `백업 알림 채널 추가 (${suggestedBackup})`,
      description: '주 발송 채널이 실패한 경우를 대비하여 대체 알림 채널을 추가합니다.',
      impact: { reliability: 10, cost: 3, speed: 0 },
      suggestedConfig: {
        nodeType: 'condition',
        name: '발송 성공 여부 확인',
        branches: [
          {
            name: '성공',
            path: 'continue',
          },
          {
            name: '실패',
            path: suggestedBackup.toLowerCase(),
          },
        ],
      },
      reasoning: `${suggestedBackup}을 백업 채널로 추가하면 주 채널 장애 시에도 중요한 알림을 전달할 수 있습니다.`,
    });
  }

  // 제안 12: 이메일 발송자 교체 (Gmail → SendGrid)
  if (
    analysis.emailNodes.length > 0 &&
    nodes.some(
      (n) => n.type === 'email' && (n.name.includes('Gmail') || n.settings?.connector === 'gmail'),
    )
  ) {
    suggestions.push({
      id: 'replace-email-connector',
      type: 'change-connector',
      priority: 'low',
      title: '이메일 커넥터 최적화 (SendGrid)',
      description:
        '대량 이메일 발송이 필요한 경우 Gmail 대신 SendGrid를 사용하면 더 나은 전달성(deliverability)과 분석 기능을 제공합니다.',
      impact: { reliability: 10, cost: 5, speed: 5 },
      targetNodeIndex: analysis.emailNodes[0],
      suggestedConfig: {
        connector: 'sendgrid',
        settings: {
          apiKey: '${SENDGRID_API_KEY}',
          from: 'noreply@yourdomain.com',
          trackOpens: true,
          trackClicks: true,
        },
      },
      reasoning:
        'SendGrid는 이메일 전달률이 높고 대량 발송 시 속도가 빠르며, 상세한 분석 정보를 제공합니다.',
    });
  }

  // 프롬프트 길이에 따른 제안
  if (prompt.length > 2000) {
    suggestions.push({
      id: 'optimize-prompt',
      type: 'optimize',
      priority: 'low',
      title: '프롬프트 최적화',
      description: '프롬프트 길이를 줄여서 토큰 사용량을 감소시키고 AI 처리 비용을 절감합니다.',
      impact: { reliability: -2, cost: -15, speed: 5 },
      suggestedConfig: {
        recommendedLength: '500-1000 characters',
      },
      reasoning:
        '불필요한 설명을 제거하고 핵심만 남기면 토큰 사용량을 줄이면서도 결과 품질을 유지할 수 있습니다.',
    });
  }

  return suggestions;
}

/**
 * 파이프라인 분석 및 개선 제안 생성
 *
 * @param nodes 파이프라인 노드 배열
 * @param prompt 현재 파이프라인의 프롬프트/설정
 * @returns 개선 제안과 점수가 포함된 AdvisorResult
 */
export function advisePipeline(nodes: PipelineNode[], prompt: string = ''): AdvisorResult {
  // 파이프라인 분석
  const analysis = analyzePipeline(nodes);

  // 현재 점수 계산
  const currentScore = calculateCurrentScore(nodes, analysis);

  // 제안 생성
  const reliabilitySuggestions = generateReliabilitySuggestions(nodes, analysis);
  const costSuggestions = generateCostOptimizationSuggestions(nodes, analysis);
  const speedSuggestions = generateSpeedOptimizationSuggestions(nodes, analysis);
  const architectureSuggestions = generateArchitectureImprovementSuggestions(
    nodes,
    analysis,
    prompt,
  );

  // 모든 제안 통합 및 정렬 (우선순위별)
  const allSuggestions = [
    ...reliabilitySuggestions,
    ...costSuggestions,
    ...speedSuggestions,
    ...architectureSuggestions,
  ];

  // 우선순위 기준으로 정렬 (high → medium → low)
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  allSuggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // 제안 수 제한 (5-10개)
  const suggestions = allSuggestions.slice(0, 10);

  // 높은 우선순위 제안 적용 시 예상 점수 계산
  const highPrioritySuggestions = suggestions.filter((s) => s.priority === 'high');
  const potentialScore = {
    reliability: Math.min(
      100,
      currentScore.reliability +
        highPrioritySuggestions.reduce((sum, s) => sum + s.impact.reliability, 0),
    ),
    cost: Math.min(
      100,
      Math.max(
        0,
        currentScore.cost + highPrioritySuggestions.reduce((sum, s) => sum + s.impact.cost, 0),
      ),
    ),
    speed: Math.min(
      100,
      currentScore.speed + highPrioritySuggestions.reduce((sum, s) => sum + s.impact.speed, 0),
    ),
  };

  // 요약 생성
  let summary = '';
  if (highPrioritySuggestions.length > 0) {
    const topArea =
      potentialScore.reliability > potentialScore.cost &&
      potentialScore.reliability > potentialScore.speed
        ? '신뢰성'
        : potentialScore.cost > potentialScore.speed
          ? '비용'
          : '속도';
    summary = `${highPrioritySuggestions.length}개의 우선 개선 사항을 적용하면 특히 ${topArea} 면에서 파이프라인을 크게 개선할 수 있습니다.`;
  } else {
    summary = '현재 파이프라인이 잘 구성되어 있으나 추가 최적화 기회가 있습니다.';
  }

  return {
    suggestions,
    currentScore,
    potentialScore,
    summary,
  };
}

/**
 * 특정 제안의 영향도를 문자열로 표현
 */
export function formatImpactDescription(impact: PathSuggestion['impact']): string {
  const parts: string[] = [];

  if (impact.reliability !== 0) {
    const sign = impact.reliability > 0 ? '+' : '';
    parts.push(`신뢰성 ${sign}${impact.reliability}`);
  }

  if (impact.cost !== 0) {
    const sign = impact.cost > 0 ? '+' : '';
    parts.push(`비용 ${sign}${impact.cost}%`);
  }

  if (impact.speed !== 0) {
    const sign = impact.speed > 0 ? '+' : '';
    parts.push(`속도 ${sign}${impact.speed}%`);
  }

  return parts.join(' · ');
}

/**
 * 점수 해석
 */
export function interpretScore(score: number): '위험' | '낮음' | '중간' | '높음' | '최적' {
  if (score >= 90) return '최적';
  if (score >= 75) return '높음';
  if (score >= 60) return '중간';
  if (score >= 40) return '낮음';
  return '위험';
}
