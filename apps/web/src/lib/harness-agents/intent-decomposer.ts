/**
 * Intent Decomposition Agent — Metis.AI Builder Harness
 *
 * 자연어 프롬프트를 구조화된 서브태스크로 분해하는 에이전트
 * Natural Language → Intent Type Mapping → Dependency Chain → Task Decomposition
 *
 * 설계 원칙:
 * 1. Rule-based NLP (LLM 불필요) - 확장성을 위해 LLM 백엔드 교체 가능하도록 설계
 * 2. 한국어 입력 지원 및 한국어 설명 제공
 * 3. 타입 안정성 - 모든 반환값 완전히 타입화
 * 4. 명시적 추론 과정 - 각 분해 결정마다 이유 기록
 *
 * 예시:
 * "아침 9시에 호랑이 관련 기사들을 검색해서 요약하여 내 개인메일로 발송"
 * → 4개 서브태스크: schedule → collect → process → deliver
 * → 각 단계마다 reasoning 포함
 */

/**
 * Intent 유형 — 각 작업의 핵심 기능에 따른 분류
 */
export type IntentType =
  | 'collect' // 검색, 크롤링, 수집
  | 'process' // 분석, 요약, 처리
  | 'transform' // 변환, 정리, 필터, 포맷
  | 'deliver' // 발송, 전달, 알림
  | 'store' // 저장, 기록, 아카이빙
  | 'monitor' // 모니터, 감시, 추적
  | 'schedule' // 스케줄, 예약, 반복
  | 'approve'; // 승인, 검토, 승인 요청

/**
 * 서브태스크 인터페이스
 * 분해된 각 작업 단위의 구조
 */
export interface SubTask {
  /** 서브태스크 고유 ID (0부터 시작하는 시퀀스) */
  id: string;

  /** 사용자 친화적 라벨 (한국어) */
  label: string;

  /** 작업의 의도 유형 */
  intentType: IntentType;

  /** 이 작업을 실행하기 위해 필요한 능력(capability) */
  requiredCapabilities: string[];

  /** 의존성: 이 작업 이전에 완료되어야 할 업스트림 서브태스크 ID들 */
  inputFrom: string[];

  /** 이 분해가 올바른지에 대한 신뢰도 (0.0 ~ 1.0) */
  confidence: number;
}

/**
 * 분해 결과 인터페이스
 * Intent decomposition의 전체 출력
 */
export interface DecompositionResult {
  /** 분해된 서브태스크 배열 */
  subtasks: SubTask[];

  /** 원본 프롬프트에서 추출한 전체 의도 설명 */
  overallIntent: string;

  /** 복잡도 판정 (1-2 tasks=simple, 3-4=moderate, 5+=complex) */
  complexity: 'simple' | 'moderate' | 'complex';

  /** 각 분해 결정마다의 이유 설명 배열 (한국어) */
  reasoning: string[];
}

/**
 * ────────────────────────────────────────────────────────────────
 * 핵심 알고리즘: Rule-based Intent Detection
 * ────────────────────────────────────────────────────────────────
 */

/** 각 Intent 유형에 매핑되는 한국어 키워드 */
const INTENT_KEYWORDS: Record<IntentType, string[]> = {
  collect: [
    '검색',
    '크롤링',
    '수집',
    '조회',
    '찾기',
    '스크래핑',
    '구하기',
    '다운로드',
    '가져오기',
    '조회',
    '뉴스',
    '기사',
    '정보',
  ],
  process: [
    '분석',
    '요약',
    '처리',
    '정리',
    '계산',
    '분석하',
    '판단',
    '검토',
    '평가',
    '분석',
    '예측',
    '추출',
  ],
  transform: [
    '변환',
    '변경',
    '수정',
    '정리',
    '필터',
    '포맷',
    '정렬',
    '그룹',
    '분류',
    '포맷팅',
    '마크다운',
    'CSV',
    'JSON',
  ],
  deliver: [
    '발송',
    '전달',
    '알림',
    '공유',
    '보내',
    '전송',
    '메일',
    '이메일',
    '슬랙',
    '텔레그램',
    '메시지',
    '게시',
    '공시',
  ],
  store: ['저장', '기록', '저장하', '보관', '아카이빙', '데이터베이스', 'DB', '클라우드', '백업'],
  monitor: ['모니터', '감시', '추적', '지켜보', '관찰', '모니터링', '감시', '확인', '체크'],
  schedule: [
    '스케줄',
    '예약',
    '반복',
    '매일',
    '매주',
    '매월',
    '주기',
    '시간',
    '아침',
    '저녁',
    '자정',
    '매',
    '마다',
    '일정',
  ],
  approve: ['승인', '검토', '검증', '확인', '승인요청', '승인하', '승인받', '결재'],
};

/** 각 Capability와 그 설명 */
const CAPABILITY_MAP: Record<string, string> = {
  'web-search': '웹 검색 API (Google, Bing)',
  'news-api': 'News API 데이터소스',
  'rss-feed': 'RSS 피드 파싱',
  'llm-summarize': 'LLM 기반 요약',
  'llm-analyze': 'LLM 기반 분석',
  'data-format': '데이터 포맷 변환',
  'email-smtp': '이메일 SMTP 발송',
  'slack-api': 'Slack API 연동',
  webhook: 'Webhook 호출',
  database: '데이터베이스 저장',
  'file-storage': '파일 스토리지 (S3, GCS)',
  'cron-scheduler': 'Cron 스케줄러',
  'approval-workflow': '승인 워크플로우',
  'content-filter': '콘텐츠 필터링',
};

/**
 * ────────────────────────────────────────────────────────────────
 * 내부 헬퍼 함수들
 * ────────────────────────────────────────────────────────────────
 */

/**
 * 프롬프트를 단어 단위로 토큰화 (한국어/영어 모두 지원)
 */
function tokenizePrompt(prompt: string): string[] {
  // 공백과 구두점으로 분리
  return prompt
    .toLowerCase()
    .replace(/[\s,.\-()]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * 한국어 자모 단위 분해 (형태소 분석 대신 간단한 버전)
 * 예: "검색해서" → "검색"
 */
function normalizeKoreanToken(token: string): string {
  // 자주 붙는 조사/어미 제거
  return token
    .replace(/하(여|고|면|니|네|다)$/, '')
    .replace(/하$/, '')
    .replace(/(이|를|을|과|와|도|만|의)$/, '')
    .replace(/(었|아|았)$/, '');
}

/**
 * Intent 유형별로 키워드 매칭 수행 및 신뢰도 계산
 */
function detectIntentFromTokens(
  tokens: string[],
): Array<{ intentType: IntentType; confidence: number }> {
  const results: Array<{ intentType: IntentType; confidence: number }> = [];
  const normalizedTokens = tokens.map(normalizeKoreanToken);

  for (const [intentType, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let maxConfidence = 0;

    for (const keyword of keywords) {
      // 원본 토큰과 정규화된 토큰 모두 확인
      if (
        tokens.includes(keyword.toLowerCase()) ||
        normalizedTokens.includes(keyword.toLowerCase())
      ) {
        // 정확한 매칭: 높은 신뢰도
        maxConfidence = Math.max(maxConfidence, 0.95);
      } else {
        // 부분 매칭 확인
        for (const token of normalizedTokens) {
          if (keyword.includes(token) && token.length > 1) {
            maxConfidence = Math.max(maxConfidence, 0.7);
          }
        }
      }
    }

    if (maxConfidence > 0) {
      results.push({
        intentType: intentType as IntentType,
        confidence: maxConfidence,
      });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * 프롬프트에서 시간 표현 추출 (스케줄링 필요 여부 판단)
 */
function hasTimeExpression(prompt: string): boolean {
  const timePatterns = [
    /아침|오전|오후|저녁|밤|자정|정오|새벽/,
    /매일|매주|매월|매년|반복/,
    /\d+시/,
    /마다|주기/,
  ];

  return timePatterns.some((pattern) => pattern.test(prompt));
}

/**
 * Intent 유형에 따른 필수 Capability 매핑
 */
function getCapabilitiesForIntent(intentType: IntentType): string[] {
  const capabilityMap: Record<IntentType, string[]> = {
    collect: ['web-search', 'news-api', 'rss-feed'],
    process: ['llm-summarize', 'llm-analyze'],
    transform: ['data-format', 'content-filter'],
    deliver: ['email-smtp', 'slack-api', 'webhook'],
    store: ['database', 'file-storage'],
    monitor: ['webhook', 'cron-scheduler'],
    schedule: ['cron-scheduler'],
    approve: ['approval-workflow'],
  };

  return capabilityMap[intentType] || [];
}

/**
 * 의도 유형 시퀀스를 예상하는 순서대로 정렬
 * 전형적인 워크플로우 순서: schedule → collect → process → transform → deliver/store
 */
function orderIntentsByDependency(intents: IntentType[]): IntentType[] {
  const intentOrder: IntentType[] = [
    'schedule',
    'approve',
    'collect',
    'process',
    'transform',
    'store',
    'deliver',
    'monitor',
  ];

  // 중복 제거
  const uniqueIntents = Array.from(new Set(intents));

  return uniqueIntents.sort((a, b) => {
    const indexA = intentOrder.indexOf(a);
    const indexB = intentOrder.indexOf(b);
    return (indexA >= 0 ? indexA : 999) - (indexB >= 0 ? indexB : 999);
  });
}

/**
 * 의도 유형별 라벨 생성
 */
function generateLabelForIntent(intentType: IntentType, index: number): string {
  const labels: Record<IntentType, string> = {
    collect: '데이터 수집',
    process: '데이터 처리',
    transform: '데이터 변환',
    deliver: '결과 전달',
    store: '데이터 저장',
    monitor: '모니터링 설정',
    schedule: '스케줄 설정',
    approve: '승인 요청',
  };

  return `${index + 1}. ${labels[intentType]}`;
}

/**
 * ────────────────────────────────────────────────────────────────
 * 주요 함수: Intent Decomposition
 * ────────────────────────────────────────────────────────────────
 */

/**
 * 자연어 프롬프트를 구조화된 서브태스크로 분해
 *
 * @param prompt 한국어 자연언어 입력
 * @returns 분해된 서브태스크와 메타데이터
 *
 * 예시:
 * decomposeIntent("아침 9시에 호랑이 관련 기사들을 검색해서 요약하여 내 개인메일로 발송")
 * →
 * {
 *   subtasks: [
 *     { id: "0", label: "1. 스케줄 설정", intentType: "schedule", ... },
 *     { id: "1", label: "2. 데이터 수집", intentType: "collect", ... },
 *     { id: "2", label: "3. 데이터 처리", intentType: "process", ... },
 *     { id: "3", label: "4. 결과 전달", intentType: "deliver", ... }
 *   ],
 *   overallIntent: "검색, 요약, 발송 작업을 정기적으로 실행",
 *   complexity: "moderate",
 *   reasoning: [
 *     "'아침 9시에' → 반복 스케줄 필요 (cron-scheduler)",
 *     "'호랑이 관련 기사들을 검색' → 웹 검색 수집 (web-search)",
 *     ...
 *   ]
 * }
 */
export function decomposeIntent(prompt: string): DecompositionResult {
  const tokens = tokenizePrompt(prompt);
  const reasoning: string[] = [];

  // 1. 토큰 기반 Intent 감지
  const detectedIntents = detectIntentFromTokens(tokens);

  if (detectedIntents.length > 0) {
    reasoning.push(
      `감지된 의도: ${detectedIntents.map((di) => `${di.intentType}(${(di.confidence * 100).toFixed(0)}%)`).join(', ')}`,
    );
  } else {
    reasoning.push('키워드 기반 의도 감지 실패 - 기본값으로 collect 사용');
    detectedIntents.push({ intentType: 'collect', confidence: 0.5 });
  }

  // 2. 스케줄 필요 여부 확인
  const needsScheduling = hasTimeExpression(prompt);
  if (needsScheduling) {
    if (!detectedIntents.some((di) => di.intentType === 'schedule')) {
      detectedIntents.push({ intentType: 'schedule', confidence: 0.85 });
      reasoning.push(
        `시간 표현 감지 ("${extractTimeExpressions(prompt).join('", "')}") → 스케줄링 필요`,
      );
    }
  }

  // 3. 승인 필요 여부 확인
  const needsApproval = prompt.includes('승인') || prompt.includes('검토');
  if (needsApproval && !detectedIntents.some((di) => di.intentType === 'approve')) {
    detectedIntents.push({ intentType: 'approve', confidence: 0.9 });
    reasoning.push('승인 키워드 감지 → 승인 워크플로우 추가');
  }

  // 4. Intent 유형 순서대로 정렬
  const intentTypes = detectedIntents.map((di) => di.intentType);
  const orderedIntents = orderIntentsByDependency(intentTypes);

  // 5. SubTask 배열 생성
  const subtasks: SubTask[] = orderedIntents.map((intentType, index) => {
    const matchedIntent = detectedIntents.find((di) => di.intentType === intentType);
    const confidence = matchedIntent?.confidence || 0.6;
    const capabilities = getCapabilitiesForIntent(intentType);

    // 의존성: 이전 모든 태스크가 순차적으로 의존
    const inputFrom = index > 0 ? [String(index - 1)] : [];

    return {
      id: String(index),
      label: generateLabelForIntent(intentType, index),
      intentType,
      requiredCapabilities: capabilities,
      inputFrom,
      confidence,
    };
  });

  // 6. 각 태스크별 상세 reasoning 추가
  for (const subtask of subtasks) {
    const matchedIntent = detectedIntents.find((di) => di.intentType === subtask.intentType);
    const capText = subtask.requiredCapabilities
      .slice(0, 2)
      .join(', ')
      .concat(subtask.requiredCapabilities.length > 2 ? ', ...' : '');

    if (matchedIntent && matchedIntent.confidence > 0.5) {
      reasoning.push(
        `"${subtask.intentType}" → 필수 능력: ${capText} (신뢰도: ${(matchedIntent.confidence * 100).toFixed(0)}%)`,
      );
    }
  }

  // 7. 복잡도 판정
  let complexity: 'simple' | 'moderate' | 'complex';
  if (subtasks.length <= 2) {
    complexity = 'simple';
  } else if (subtasks.length <= 4) {
    complexity = 'moderate';
  } else {
    complexity = 'complex';
  }
  reasoning.push(`복잡도 판정: ${complexity} (${subtasks.length}개 작업)`);

  // 8. 전체 의도 요약
  const mainIntents = detectedIntents
    .filter((di) => di.intentType !== 'schedule' && di.intentType !== 'approve')
    .map((di) => di.intentType);
  const overallIntent = `${mainIntents.length > 0 ? mainIntents.join(', ') : '작업'} 실행${needsScheduling ? ' (정기적)' : ''}`;

  return {
    subtasks,
    overallIntent,
    complexity,
    reasoning,
  };
}

/**
 * 프롬프트에서 시간 표현 추출 (reasoning에 사용)
 */
function extractTimeExpressions(prompt: string): string[] {
  const patterns = [/\d+시/g, /아침|오전|오후|저녁|밤|자정|정오|새벽/g, /매일|매주|매월|매년/g];

  const matches: string[] = [];
  for (const pattern of patterns) {
    const found = prompt.match(pattern);
    if (found) {
      matches.push(...found);
    }
  }
  return matches;
}

/**
 * ────────────────────────────────────────────────────────────────
 * 유틸리티 함수들 (필요시 외부 호출용)
 * ────────────────────────────────────────────────────────────────
 */

/**
 * Capability에 대한 설명 조회
 */
export function getCapabilityDescription(capability: string): string {
  return CAPABILITY_MAP[capability] || `알 수 없는 기능: ${capability}`;
}

/**
 * Intent 유형의 한국어 이름
 */
export function getIntentLabel(intentType: IntentType): string {
  const labels: Record<IntentType, string> = {
    collect: '데이터 수집',
    process: '데이터 처리',
    transform: '데이터 변환',
    deliver: '결과 전달',
    store: '데이터 저장',
    monitor: '모니터링',
    schedule: '스케줄',
    approve: '승인',
  };

  return labels[intentType];
}

/**
 * 서브태스크를 사람이 읽을 수 있는 형식으로 포맷팅
 */
export function formatSubTaskForDisplay(subtask: SubTask): string {
  const intentLabel = getIntentLabel(subtask.intentType);
  const capabilitiesText = subtask.requiredCapabilities.map((cap) => `[${cap}]`).join(', ');
  const dependencyText =
    subtask.inputFrom.length > 0
      ? ` (의존성: 작업 ${subtask.inputFrom.map((id) => `#${id}`).join(', ')})`
      : '';
  const confidenceText =
    subtask.confidence < 0.8 ? ` ⚠️ 신뢰도: ${(subtask.confidence * 100).toFixed(0)}%` : '';

  return `${subtask.label} - ${intentLabel}${dependencyText}${confidenceText}\n필수 능력: ${capabilitiesText}`;
}

/**
 * 전체 분해 결과를 사람이 읽을 수 있는 형식으로 포맷팅
 */
export function formatDecompositionForDisplay(result: DecompositionResult): string {
  const header = `\n=== Intent Decomposition Result ===\n`;
  const intent = `Intent: ${result.overallIntent}\nComplexity: ${result.complexity}\n`;
  const subtasksList = result.subtasks.map((st) => formatSubTaskForDisplay(st)).join('\n---\n');
  const reasoningSection = `\n=== Reasoning ===\n${result.reasoning.map((r) => `• ${r}`).join('\n')}`;

  return `${header}${intent}${subtasksList}${reasoningSection}`;
}

/**
 * ────────────────────────────────────────────────────────────────
 * 확장을 위한 훅: LLM 백엔드로 교체 가능
 * ────────────────────────────────────────────────────────────────
 */

/**
 * LLM 기반 분해를 위한 인터페이스 (향후 구현)
 *
 * 사용 예:
 * const llmDecompose = createLLMDecomposer(openai_client);
 * const result = await llmDecompose("복잡한 프롬프트...");
 */
export interface IntentDecomposerBackend {
  decompose(prompt: string): Promise<DecompositionResult>;
  isAvailable(): boolean;
}

/**
 * 데코레이터 패턴: Rule-based decomposer를 LLM과 함께 사용
 * LLM이 실패하면 rule-based 버전으로 fallback
 */
export function createHybridDecomposer(
  llmBackend?: IntentDecomposerBackend,
): (prompt: string) => Promise<DecompositionResult> {
  return async (prompt: string) => {
    // LLM이 사용 가능하고 신뢰도가 높으면 사용
    if (llmBackend?.isAvailable?.()) {
      try {
        const result = await llmBackend.decompose(prompt);
        return result;
      } catch (error) {
        console.warn('LLM decomposition failed, falling back to rule-based', error);
      }
    }

    // Fallback: Rule-based decomposition
    return decomposeIntent(prompt);
  };
}
