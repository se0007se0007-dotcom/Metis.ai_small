# Metis.AI Builder Harness - Agents Module

이 모듈은 Metis.AI Builder의 파이프라인을 LLM 기반 에이전트들이 검토하고 개선하는 시스템입니다.

## 모듈 구조

### 1. **Intent Decomposer** (`intent-decomposer.ts`)

사용자의 자연어 프롬프트를 분석하여 구조화된 하위 작업들로 분해합니다.

```typescript
interface Intent {
  primary: string;
  subTasks: Array<{
    name: string;
    type: 'send' | 'store' | 'transform' | 'retrieve' | 'deploy' | 'schedule' | 'branch';
    description: string;
  }>;
  complexity: 'simple' | 'moderate' | 'complex';
  requiredCapabilities: string[];
  dataTypes: string[];
  timelineImplications: string[];
}

const intent = decomposeIntent('이메일로 일일 리포트 발송');
// → { complexity: 'moderate', subTasks: [...], requiredCapabilities: [...] }
```

### 2. **Capability Registry** (`capability-registry.ts`)

필요한 능력(capability)과 실제 파이프라인의 노드들을 매칭하여 누락된 커넥터를 식별합니다.

```typescript
const matches = matchCapabilities(['send', 'store'], nodes);
// → { matches: [...], unmatchedCapabilities: [...], totalConfidence: 0.85 }
```

### 3. **Data Contract Validator** (`data-contract.ts`)

노드 간의 데이터 호환성을 검증하고 스키마 계약 준수 여부를 확인합니다.

```typescript
const validation = validatePipeline(['email', 'database']);
// → { overallScore: 0.82, criticalIssues: [...], warnings: [...] }
```

### 4. **Path Advisor** (`path-advisor.ts`)

현재 파이프라인을 분석하여 개선 제안을 제시합니다.

```typescript
const advice = advisePipeline(['email', 'database']);
// → { suggestions: [...], topThreeSuggestions: [...], bestPath: [...] }
```

### 5. **LLM Reviewer / Orchestrator** (`llm-reviewer.ts`)

모든 에이전트를 조율하여 포괄적인 회의를 진행하고 최종 리뷰를 생성합니다.

```typescript
const minutes = runAgentMeeting('매일 아침 9시에 뉴스를 가져와서 요약해서 이메일 발송', [
  { type: 'schedule', name: 'Daily Trigger' },
  { type: 'email', name: 'Send Report' },
]);
```

## 에이전트 역할

### Phase 1: Intent Agent (의도 분석 에이전트)

- 사용자 요청을 분석
- 필요한 하위 작업 식별
- 복잡도 평가

**성격**: 분석적, 정확함

### Phase 2: Template Agent (템플릿 검증 에이전트)

- 의도와 실제 파이프라인 구조 비교
- 누락된 노드 식별
- 구조적 적합성 검증

**성격**: 창의적, 패턴 매칭

### Phase 3: Connector Agent (커넥터 에이전트)

- 필요한 커넥터와 능력 매칭
- 누락된 커넥터 추천
- 통합 신뢰도 계산

**성격**: 실용적, 인프라 중심

### Phase 4: Policy Agent (정책 에이전트)

- 거버넌스 및 보안 검토
- 규정 준수 확인
- 승인 절차 필요성 판단

**성격**: 신중함, 규정 지향

### Phase 5: Validator Agent (검증 에이전트)

- 노드 간 데이터 호환성 검증
- 스키마 계약 확인
- 호환성 점수 계산

**성격**: 세심함, 철저함

### Phase 6: Eval Agent (평가 에이전트)

- 전략적 평가 수행
- 개선 제안 생성
- 최고의 경로 추천

**성격**: 전략적, 거시적 관점

## 사용 예제

```typescript
import { runAgentMeeting, formatMeetingMinutes } from '@/lib/harness-agents';

// 에이전트 회의 실행
const minutes = runAgentMeeting('매일 오후 3시에 호랑이 기사를 검색해서 요약하여 내 메일로 발송', [
  { type: 'schedule', name: 'Cron Trigger', settings: { cron: '0 15 * * *' } },
  { type: 'rest-api', name: 'Google Search', settings: { endpoint: '...' } },
  { type: 'code-execution', name: 'Summarizer', settings: { code: '...' } },
  { type: 'email', name: 'Send Email', settings: { smtp: '...' } },
]);

// 회의 기록 출력
console.log(formatMeetingMinutes(minutes));

// 결과 접근
console.log(`승인 여부: ${minutes.consensus.approved}`);
console.log(`점수: ${minutes.consensus.score}/100`);
console.log(`실행 항목: ${minutes.actionItems.length}개`);
```

## 데이터 구조

### MeetingMinutes (회의 기록)

```typescript
interface MeetingMinutes {
  sessionId: string; // 세션 고유 ID
  prompt: string; // 원본 사용자 프롬프트
  deliberations: AgentDeliberation[]; // 각 에이전트의 신중 (6개)
  consensus: {
    approved: boolean; // 최종 승인 여부
    score: number; // 0-100 점수
    summary: string; // 한국어 요약
  };
  actionItems: Array<{
    agent: string; // 담당 에이전트
    action: string; // 수행할 액션
    priority: 'high' | 'medium' | 'low'; // 우선순위
  }>;
  decomposition: Intent; // 의도 분해 결과
  capabilityMatches: CapabilityMatchResult; // 능력 매칭 결과
  dataCompatibility: ValidationResult; // 호환성 검증 결과
  pathSuggestions: PathAdvice; // 경로 제안 결과
  timestamp: string; // ISO 8601 타임스탬프
}
```

### AgentDeliberation (에이전트 신중)

```typescript
interface AgentDeliberation {
  agentId: 'intent' | 'template' | 'connector' | 'policy' | 'validator' | 'eval';
  phase: string; // 단계명 (한국어)
  messages: Array<{
    role: 'speak' | 'think' | 'decide';
    content: string; // 한국어 메시지
  }>;
  decision: string; // 최종 결정 (한국어)
  confidence: number; // 0-1 신뢰도
  concerns: string[]; // 우려사항 (한국어)
}
```

## Consensus 알고리즘

최종 승인 여부는 다음 조건으로 결정됩니다:

```
approved = (
  평균신뢰도 > 0.7 &&
  정책 에이전트의 우려사항 없음 &&
  데이터 호환성 심각한 문제 없음
)

점수 = (
  승인 여부 ? 80 : 50 +
  평균신뢰도 × 15 +
  누락된 능력 없음 ? 5 : 0
)
```

## 성능 특성

- **응답시간**: < 500ms (모든 에이전트 순차 실행)
- **메모리**: 각 호출당 < 5MB
- **확장성**: 에이전트 개수와 무관하게 선형 복잡도

## 통합 포인트

### API 통합

```typescript
app.post('/api/v1/pipeline/review', (req, res) => {
  const { prompt, nodes } = req.body;
  const minutes = runAgentMeeting(prompt, nodes);
  res.json(minutes);
});
```

### 프론트엔드 상태 관리

```typescript
const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);

async function reviewPipeline() {
  const result = await api.post('/api/v1/pipeline/review', {
    prompt: userPrompt,
    nodes: pipelineNodes,
  });
  setMinutes(result.data);
}
```

## 커스터마이제이션

### 커넥터 레지스트리 확장

`capability-registry.ts`의 `connectorRegistry` 객체에 새 커넥터 추가:

```typescript
const connectorRegistry = {
  // 기존 항목...
  custom_action: [
    {
      name: 'MyConnector',
      type: 'custom',
      capabilities: ['custom_action'],
      trustLevel: 'high',
    },
  ],
};
```

### 데이터 계약 정의

`data-contract.ts`의 `dataContracts` 객체에 새 노드 타입 추가:

```typescript
const dataContracts = {
  'my-node-type': {
    inputSchema: {
      /* ... */
    },
    outputSchema: {
      /* ... */
    },
    transformRules: [
      /* ... */
    ],
  },
};
```

## 테스트

기본 테스트:

```bash
npm test -- harness-agents
```

특정 에이전트 테스트:

```bash
npm test -- harness-agents/intent-decomposer
```
