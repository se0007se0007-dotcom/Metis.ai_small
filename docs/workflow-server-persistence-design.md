# Metis.AI 워크플로우 서버 저장 + 노드 실행 아키텍처 설계

> **문서 버전**: v1.0  
> **작성일**: 2026-04-18  
> **대상**: Phase 6 — 워크플로우 서버 영속화 + 노드 인텐트 매핑 엔진

---

## 1. 현재 상태 분석 (As-Is)

### 1.1 문제점

현재 워크플로우는 **클라이언트 메모리에서만 존재**합니다.

```
[사용자 프롬프트] → BuilderPlannerService → BuilderPlan.nodesJson (JSON blob)
                                                    ↓
                                            builder/page.tsx (React state)
                                                    ↓
                                            "저장" → wf-saved-${Date.now()} (가짜 ID)
```

| 항목             | 현재 상태                            | 문제                             |
| ---------------- | ------------------------------------ | -------------------------------- |
| 워크플로우 정의  | BuilderPlan.nodesJson (JSON blob)    | 개별 노드 쿼리 불가, 인덱싱 불가 |
| 노드 저장        | React state only                     | 브라우저 닫으면 소실             |
| 버전 관리        | 없음                                 | 롤백 불가                        |
| 동시 편집        | 없음                                 | 마지막 저장이 덮어씀             |
| 실행 연결        | workflowKey (문자열)                 | 정규화된 FK 없음                 |
| 노드→커넥터 매핑 | 프론트엔드 NODE_TYPE_CONFIG 하드코딩 | 서버에서 검증/해석 불가          |

### 1.2 기존 자산 (활용 가능)

- **BuilderRequest → BuilderPlan pipeline**: BH-1~6 전체 파이프라인 동작 중
- **WorkflowRunnerService**: DAG 토폴로지 정렬, 병렬 실행 레벨 지원
- **WorkflowNodeRouter**: 6종 런타임 (connector, agent, adapter, decision, human, skill) 디스패치
- **ConnectorService**: Governed dispatch chain (RateLimit → CircuitBreaker → PolicyGate → Dispatch)
- **builder-harness.ts**: 로컬/API 이중 모드 클라이언트

---

## 2. 목표 아키텍처 (To-Be)

### 2.1 핵심 설계 원칙

1. **노드는 의도(Intent)의 구체화**다 — 각 노드는 사용자 의도의 깊이와 유연성을 담는 실행 가능한 단위
2. **커넥터는 의도의 실현 수단**이다 — 노드가 "무엇"이면, 커넥터는 "어떻게"
3. **서버가 진실의 원천(Source of Truth)**이다 — 클라이언트는 캐시/뷰어
4. **버전은 불변(Immutable)**이다 — 수정 = 새 버전 생성

### 2.2 전체 데이터 흐름

```
[사용자 프롬프트]
    ↓
BuilderPlannerService (BH-1: Intent 분류, BH-2: 파라미터 추출)
    ↓
NodeResolutionEngine (NEW) ← CapabilityRegistry + ConnectorService
    ├── 프론트엔드 nodeType → 백엔드 capability 매핑
    ├── 커넥터 가용성 검증 (테넌트별)
    ├── 파라미터 바인딩 스키마 생성
    └── inputMapping 자동 추론
    ↓
BuilderValidationService (BH-3+4: 정책 주입 + 구조 검증)
    ↓
BuilderEvalService (BH-5: Readiness 스코어링)
    ↓
WorkflowPersistenceService (NEW)
    ├── Workflow 생성/업데이트
    ├── WorkflowNode[] 정규화 저장
    ├── WorkflowEdge[] 그래프 저장
    ├── WorkflowVersion 스냅샷
    └── OCC 버전 체크
    ↓
[저장된 워크플로우]
    ↓
WorkflowExecutionBridge (NEW)
    ├── Workflow → RunWorkflowInput 변환
    ├── WorkflowNode → execution WorkflowNode 매핑
    └── parameterBindings 런타임 해석
    ↓
WorkflowRunnerService (기존) → NodeRouter → ConnectorService/AgentDispatcher/...
```

---

## 3. 데이터베이스 스키마 설계

### 3.1 Prisma 모델

```prisma
// ═══════════════════════════════════════════
//  워크플로우 정의 (Definition)
// ═══════════════════════════════════════════

enum WorkflowStatus {
  DRAFT          // 편집 중
  ACTIVE         // 실행 가능
  PAUSED         // 일시 중지 (스케줄 비활성화)
  ARCHIVED       // 보관 (실행 불가, 열람만)
}

model Workflow {
  id              String           @id @default(cuid())
  tenantId        String
  createdById     String           // User.id — 최초 생성자

  // 식별
  key             String           // 슬러그 (URL-friendly unique key per tenant)
  name            String           // 표시명
  description     String?          // 설명
  category        String?          // incident-response, deploy-verification, ...
  tags            String[]         // 태그 배열
  icon            String?          // 이모지 아이콘
  color           String?          // 테마 색상

  // 상태
  status          WorkflowStatus   @default(DRAFT)

  // 버전 관리
  version         Int              @default(1)    // OCC 버전 (매 저장마다 증가)
  activeVersionId String?          // 현재 활성 WorkflowVersion.id

  // 원본 추적
  builderRequestId String?         // BuilderRequest.id (빌더에서 생성된 경우)
  templateId      String?          // WorkflowTemplate.id (템플릿 기반인 경우)

  // 트리거 설정
  triggerType     String?          // manual | schedule | webhook | event
  triggerConfig   Json?            // { cron, webhookPath, eventFilter, ... }

  // 파라미터 스키마 (실행 시 주입 가능한 변수)
  parameterSchema Json?            // WorkflowParameter[] — 실행 시 사용자가 채우는 변수

  // 메타데이터
  lastExecutedAt  DateTime?
  executionCount  Int              @default(0)

  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  // Relations
  tenant          Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  nodes           WorkflowNodeDef[]
  edges           WorkflowEdge[]
  versions        WorkflowVersion[]
  drafts          WorkflowDraft[]
  executions      WorkflowExecution[]

  @@unique([tenantId, key])
  @@index([tenantId, status])
  @@index([tenantId, category])
  @@index([createdById])
}

// ═══════════════════════════════════════════
//  워크플로우 노드 (정규화)
// ═══════════════════════════════════════════

model WorkflowNodeDef {
  id              String           @id @default(cuid())
  workflowId      String

  // 식별
  nodeKey         String           // 워크플로우 내 고유 키 (e.g., "node-1", "search-cve")
  name            String           // 표시명 (sanitized)
  description     String?

  // 타입 시스템 (3-Layer)
  uiType          String           // 프론트엔드 타입: web-search, ai-processing, email-send, ...
  executionType   String           // 백엔드 런타임: connector, agent, adapter, decision, human, skill
  capability      String?          // 구체적 능력: connector:jira, agent:pentest, adapter:ocr, ...

  // 의도 메타데이터
  intentCategory  String?          // 이 노드가 수행하는 의도 범주: search, analyze, transform, notify, store, deploy, ...
  actionType      String           // read | write | execute | external-send | deploy | delete
  riskLevel       String?          // low | medium | high | critical

  // 실행 설정
  configJson      Json             // 노드별 설정 (검색 키워드, 프롬프트, SMTP 설정 등)
  inputMapping    Json?            // { "fieldName": "$.nodeKey.output.field" }
  outputKeys      String[]         // 이 노드가 생산하는 출력 키 목록

  // 파라미터 바인딩 (유연성의 핵심)
  parameterBindings Json?          // { "keywords": "{{param.searchKeywords}}", "model": "{{param.llmModel}}" }
                                   // configJson의 어떤 필드가 실행 시 파라미터로 주입 가능한지 정의

  // 커넥터 연결
  connectorId     String?          // Connector.id (테넌트에 설치된 커넥터)
  connectorKey    String?          // 커넥터 키 (jira, slack, ...)

  // DAG 구조
  executionOrder  Int              // 기본 실행 순서 (선형 호환)
  dependsOn       String[]         // 의존하는 nodeKey[] (DAG 병렬화)
  parallelGroup   String?          // 병렬 그룹 이름

  // 복원력 설정
  failureAction   String           @default("stop")  // stop | skip | retry | fallback
  retryCount      Int              @default(0)
  retryDelayMs    Int              @default(1000)
  timeoutMs       Int?             // 노드 실행 제한 시간
  fallbackNodeKey String?          // fallback 시 실행할 노드

  // 거버넌스
  policyCheckpoint Boolean         @default(false)
  humanApproval    Boolean         @default(false)

  // 시각화
  icon            String?
  color           String?
  positionX       Float?           // 캔버스 X 좌표 (향후 DAG 에디터용)
  positionY       Float?           // 캔버스 Y 좌표

  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  // Relations
  workflow        Workflow         @relation(fields: [workflowId], references: [id], onDelete: Cascade)

  @@unique([workflowId, nodeKey])
  @@index([workflowId, executionOrder])
}

// ═══════════════════════════════════════════
//  워크플로우 엣지 (그래프 연결)
// ═══════════════════════════════════════════

enum EdgeType {
  SEQUENCE       // 순차 실행 (기본)
  CONDITIONAL    // 조건부 분기
  ERROR          // 에러 시 분기
  PARALLEL       // 병렬 분기
}

model WorkflowEdge {
  id              String           @id @default(cuid())
  workflowId      String

  fromNodeKey     String           // 출발 노드 키
  toNodeKey       String           // 도착 노드 키

  edgeType        EdgeType         @default(SEQUENCE)
  condition       String?          // 조건식 (CONDITIONAL일 때): "$.result.severity === 'critical'"
  conditionLabel  String?          // 표시용 라벨: "심각도 높음", "true", "false"
  priority        Int              @default(0)  // 같은 출발점에서 여러 엣지일 때 우선순위

  createdAt       DateTime         @default(now())

  // Relations
  workflow        Workflow         @relation(fields: [workflowId], references: [id], onDelete: Cascade)

  @@unique([workflowId, fromNodeKey, toNodeKey])
  @@index([workflowId])
}

// ═══════════════════════════════════════════
//  워크플로우 버전 (불변 스냅샷)
// ═══════════════════════════════════════════

model WorkflowVersion {
  id              String           @id @default(cuid())
  workflowId      String
  versionNumber   Int              // 순차 증가

  // 스냅샷 (이 시점의 전체 워크플로우 정의)
  nodesSnapshot   Json             // WorkflowNodeDef[] 직렬화
  edgesSnapshot   Json             // WorkflowEdge[] 직렬화
  configSnapshot  Json?            // triggerConfig, parameterSchema 등

  // 변경 정보
  changeMessage   String?          // "초기 생성", "메일 수신자 변경", "조건 분기 추가"
  changedById     String           // 변경한 User.id

  // Readiness 스코어 (저장 시점)
  readinessScore  Int?             // 0-100
  readinessBand   String?          // excellent | good | fair | poor | critical

  createdAt       DateTime         @default(now())

  // Relations
  workflow        Workflow         @relation(fields: [workflowId], references: [id], onDelete: Cascade)

  @@unique([workflowId, versionNumber])
  @@index([workflowId])
}

// ═══════════════════════════════════════════
//  워크플로우 드래프트 (동시편집 OCC)
// ═══════════════════════════════════════════

model WorkflowDraft {
  id              String           @id @default(cuid())
  workflowId      String
  editorUserId    String           // 편집 중인 사용자

  // 드래프트 내용
  nodesJson       Json             // 편집 중인 노드 목록
  edgesJson       Json?            // 편집 중인 엣지 목록

  // OCC
  baseVersion     Int              // 이 드래프트가 기반한 Workflow.version

  // 잠금
  lockedAt        DateTime         @default(now())
  expiresAt       DateTime         // 잠금 만료 (기본 30분)

  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  // Relations
  workflow        Workflow         @relation(fields: [workflowId], references: [id], onDelete: Cascade)

  @@unique([workflowId, editorUserId])
  @@index([workflowId])
  @@index([expiresAt])
}

// ═══════════════════════════════════════════
//  워크플로우 실행 이력 (Workflow ↔ Execution 브릿지)
// ═══════════════════════════════════════════

model WorkflowExecution {
  id                 String           @id @default(cuid())
  workflowId         String
  workflowVersionId  String?          // 실행 시점의 버전
  executionSessionId String           @unique  // ExecutionSession.id

  // 실행 입력 파라미터 (parameterSchema에 정의된 값들의 실제 값)
  inputParameters    Json?            // { "searchKeywords": "CVE-2024", "llmModel": "claude-sonnet-4.6" }

  // 트리거 정보
  triggeredBy        String           // manual | schedule | webhook | event
  triggeredByUserId  String?

  createdAt          DateTime         @default(now())

  // Relations
  workflow           Workflow         @relation(fields: [workflowId], references: [id], onDelete: Cascade)

  @@index([workflowId])
  @@index([executionSessionId])
}
```

### 3.2 tenant-middleware.ts 추가 모델

```typescript
const TENANT_MODELS = new Set([
  // ... 기존 모델들 ...
  'Workflow',
  'WorkflowNodeDef',
  'WorkflowEdge',
  'WorkflowVersion',
  'WorkflowDraft',
  'WorkflowExecution',
]);
```

---

## 4. 노드 인텐트 해석 엔진 (Node Resolution Engine)

### 4.1 핵심 개념: 3-Layer 타입 시스템

사용자 의도가 실제 실행으로 변환되는 과정을 3단계로 분리합니다.

```
Layer 1: UI Type (프론트엔드)     Layer 2: Execution Type (런타임)     Layer 3: Capability (구체적 실현)
─────────────────────────────     ──────────────────────────────────     ─────────────────────────────────
web-search                   →   connector                          →   connector:google-search
ai-processing                →   agent                              →   agent:workflow-agent:claude-sonnet-4.6
email-send                   →   connector                          →   connector:email-smtp
slack-message                →   connector                          →   connector:slack-webhook
jira                         →   connector                          →   connector:jira:create_ticket
git-deploy                   →   connector                          →   connector:github:create_deployment
condition                    →   decision                           →   decision:json-path-eval
wait-approval                →   human                              →   human:approval-gate
data-storage                 →   adapter                            →   adapter:postgresql:insert
data-transform               →   adapter                            →   adapter:json-transform
log-monitor                  →   adapter                            →   adapter:audit-log
file-operation               →   adapter                            →   adapter:file-io:read
notification                 →   connector                          →   connector:notification:email+browser
schedule                     →   start                              →   trigger:cron
webhook                      →   start                              →   trigger:webhook-listener
api-call                     →   connector                          →   connector:generic-http:GET
pentest                      →   agent                              →   agent:pentest:8-vector
```

### 4.2 NodeResolutionRegistry

```typescript
// apps/api/src/modules/workflow/node-resolution.registry.ts

export interface NodeResolution {
  executionType: WorkflowNodeType; // connector | agent | adapter | decision | human | skill | start
  capabilityPattern: string; // capability 문자열 패턴
  requiredConnectorKey?: string; // 필요한 커넥터 키
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  intentCategory: string; // search | analyze | transform | notify | store | deploy | ...

  // 설정 → capability 매핑 함수
  resolveCapability: (config: Record<string, any>) => string;

  // config → inputMapping 자동 추론
  inferInputMapping: (
    config: Record<string, any>,
    previousOutputKeys: string[],
  ) => Record<string, string>;

  // 파라미터화 가능한 설정 키 목록
  parameterizableKeys: string[];

  // 출력 키 정의
  defaultOutputKeys: string[];
}

export const NODE_RESOLUTION_REGISTRY: Record<string, NodeResolution> = {
  'web-search': {
    executionType: 'connector',
    capabilityPattern: 'connector:web-search',
    riskLevel: 'low',
    intentCategory: 'search',

    resolveCapability: (config) => {
      const engine = config.searchEngine?.toLowerCase() || 'google';
      return `connector:${engine}-search`;
    },

    inferInputMapping: (config, prevOutputs) => {
      // 이전 노드 출력에 'topic' 또는 'keywords'가 있으면 자동 매핑
      const mapping: Record<string, string> = {};
      if (prevOutputs.includes('topic')) {
        mapping['keywords'] = '$.previousNode.output.topic';
      }
      if (prevOutputs.includes('analysis_summary')) {
        mapping['refinedQuery'] = '$.previousNode.output.analysis_summary';
      }
      return mapping;
    },

    parameterizableKeys: ['keywords', 'maxResults', 'language', 'searchEngine'],
    defaultOutputKeys: ['search_results', 'result_count', 'source_urls'],
  },

  'ai-processing': {
    executionType: 'agent',
    capabilityPattern: 'agent:workflow-agent',
    riskLevel: 'medium',
    intentCategory: 'analyze',

    resolveCapability: (config) => {
      const model = config.model || 'claude-sonnet-4.6';
      const agentName = config.agentName || 'workflow-agent';
      return `agent:${agentName}:${model}`;
    },

    inferInputMapping: (config, prevOutputs) => {
      // AI 노드는 이전 모든 출력을 컨텍스트로 자동 수집
      const mapping: Record<string, string> = {};
      if (prevOutputs.includes('search_results')) {
        mapping['context'] = '$.previousNode.output.search_results';
      }
      if (prevOutputs.includes('file_content')) {
        mapping['sourceData'] = '$.previousNode.output.file_content';
      }
      return mapping;
    },

    parameterizableKeys: ['model', 'promptTemplate', 'temperature', 'maxTokens'],
    defaultOutputKeys: ['analysis_result', 'summary', 'recommendations', 'confidence_score'],
  },

  'email-send': {
    executionType: 'connector',
    capabilityPattern: 'connector:email-smtp',
    requiredConnectorKey: 'email-smtp',
    riskLevel: 'high',
    intentCategory: 'notify',

    resolveCapability: (config) => {
      return `connector:email-smtp:send`;
    },

    inferInputMapping: (config, prevOutputs) => {
      const mapping: Record<string, string> = {};
      // 이전 노드에서 요약이 나오면 메일 본문에 자동 매핑
      if (prevOutputs.includes('summary')) {
        mapping['body'] = '$.previousNode.output.summary';
      }
      if (prevOutputs.includes('report_html')) {
        mapping['htmlBody'] = '$.previousNode.output.report_html';
      }
      return mapping;
    },

    parameterizableKeys: ['recipientEmail', 'subject', 'body', 'cc', 'bcc'],
    defaultOutputKeys: ['message_id', 'send_status', 'timestamp'],
  },

  condition: {
    executionType: 'decision',
    capabilityPattern: 'decision:json-path-eval',
    riskLevel: 'low',
    intentCategory: 'control-flow',

    resolveCapability: (config) => {
      const evalType = config.conditionType || 'json-path';
      return `decision:${evalType}`;
    },

    inferInputMapping: (config, prevOutputs) => {
      // 조건 노드는 이전 노드의 전체 출력을 평가 대상으로
      return { evaluationTarget: '$.previousNode.output' };
    },

    parameterizableKeys: ['conditionExpression'],
    defaultOutputKeys: ['true', 'false', 'evaluation_result'],
  },

  jira: {
    executionType: 'connector',
    capabilityPattern: 'connector:jira',
    requiredConnectorKey: 'jira',
    riskLevel: 'medium',
    intentCategory: 'integrate',

    resolveCapability: (config) => {
      const action = config.action || 'create';
      return `connector:jira:${action}`;
    },

    inferInputMapping: (config, prevOutputs) => {
      const mapping: Record<string, string> = {};
      if (prevOutputs.includes('summary') && config.action === 'create') {
        mapping['description'] = '$.previousNode.output.summary';
      }
      if (prevOutputs.includes('analysis_result')) {
        mapping['issueBody'] = '$.previousNode.output.analysis_result';
      }
      return mapping;
    },

    parameterizableKeys: ['action', 'projectKey', 'issueType', 'priority', 'assignee'],
    defaultOutputKeys: ['ticket_id', 'ticket_url', 'ticket_key'],
  },

  'git-deploy': {
    executionType: 'connector',
    capabilityPattern: 'connector:git',
    requiredConnectorKey: 'github',
    riskLevel: 'critical',
    intentCategory: 'deploy',

    resolveCapability: (config) => {
      const action = config.action || 'push';
      return `connector:git:${action}`;
    },

    inferInputMapping: (_config, _prevOutputs) => ({}),

    parameterizableKeys: ['repoUrl', 'branch', 'commitMessage'],
    defaultOutputKeys: ['commit_sha', 'deploy_status', 'deploy_url'],
  },

  pentest: {
    executionType: 'agent',
    capabilityPattern: 'agent:pentest',
    riskLevel: 'medium',
    intentCategory: 'analyze',

    resolveCapability: (config) => {
      const vectors = config.enabledVectors?.length || 8;
      return `agent:pentest:${vectors}-vector`;
    },

    inferInputMapping: (config, prevOutputs) => {
      const mapping: Record<string, string> = {};
      if (prevOutputs.includes('file_content')) {
        mapping['sourceCode'] = '$.previousNode.output.file_content';
      }
      return mapping;
    },

    parameterizableKeys: ['enabledVectors', 'targetLanguage', 'severityThreshold'],
    defaultOutputKeys: ['vulnerabilities', 'severity_counts', 'pentest_report', 'risk_score'],
  },

  // ... 나머지 노드 타입도 동일 패턴으로 정의
};
```

### 4.3 의도 깊이(Intent Depth) — parameterBindings 설계

핵심 아이디어: 노드의 설정값은 **고정값**(하드코딩)과 **파라미터**(실행 시 주입)로 나뉩니다.

```typescript
// 예시: "매일 아침 CVE 검색 후 분석하여 메일 발송" 워크플로우

// Workflow.parameterSchema (실행 시 사용자가 변경 가능한 변수)
[
  { key: "searchKeywords", label: "검색 키워드", type: "string", required: true, defaultValue: "CVE-2024" },
  { key: "llmModel", label: "AI 모델", type: "select", options: ["claude-sonnet-4.6", "claude-haiku-4.5"], defaultValue: "claude-sonnet-4.6" },
  { key: "recipientEmail", label: "수신자 이메일", type: "string", required: true },
  { key: "severityThreshold", label: "심각도 임계값", type: "select", options: ["low", "medium", "high", "critical"], defaultValue: "medium" },
]

// Node "CVE 검색" — configJson + parameterBindings
{
  configJson: {
    searchEngine: "Google",        // 고정값
    maxResults: 20,                // 고정값
    language: "ko",                // 고정값
    keywords: "CVE-2024"           // 기본값 (parameterBindings로 오버라이드 가능)
  },
  parameterBindings: {
    "keywords": "{{param.searchKeywords}}"   // 실행 시 주입
  }
}

// Node "AI 분석" — configJson + parameterBindings + inputMapping
{
  configJson: {
    agentName: "workflow-agent",
    model: "claude-sonnet-4.6",
    promptTemplate: "다음 CVE 정보를 분석하고 {{param.severityThreshold}} 이상 심각도를 필터링하세요:\n\n{{input.context}}",
    temperature: 0.3,
    maxTokens: 4000
  },
  parameterBindings: {
    "model": "{{param.llmModel}}",
    "promptTemplate.severityThreshold": "{{param.severityThreshold}}"
  },
  inputMapping: {
    "context": "$.cve-search.output.search_results"  // 이전 노드 출력 자동 연결
  }
}

// Node "결과 메일 발송" — configJson + parameterBindings + inputMapping
{
  configJson: {
    subject: "[Metis.AI] CVE 분석 보고서",
    recipientEmail: "",
    html: true
  },
  parameterBindings: {
    "recipientEmail": "{{param.recipientEmail}}"
  },
  inputMapping: {
    "body": "$.ai-analysis.output.analysis_result"   // AI 분석 결과를 메일 본문에
  }
}
```

**파라미터 해석 우선순위** (실행 시):

```
1. WorkflowExecution.inputParameters   (실행 시 명시적 입력)
2. parameterBindings → Workflow.parameterSchema.defaultValue  (기본값)
3. configJson의 값  (하드코딩된 설정)
```

### 4.4 inputMapping — 노드 간 데이터 흐름 자동 추론

```typescript
// apps/api/src/modules/workflow/input-mapping.resolver.ts

/**
 * 워크플로우의 모든 노드에 대해 inputMapping을 자동 추론합니다.
 *
 * 규칙:
 * 1. 직전 노드의 outputKeys와 현재 노드의 configJson 필드를 매칭
 * 2. 의미적 유사성 기반 매핑 (summary → body, search_results → context, ...)
 * 3. 명시적 inputMapping이 있으면 우선
 * 4. 매핑 실패 시 경고 발생 (BuilderValidation에서 감지)
 */

const SEMANTIC_MAPPINGS: Record<string, string[]> = {
  // 출력 키 → 자동 매핑 가능한 입력 필드들
  search_results: ['context', 'sourceData', 'inputData', 'content'],
  analysis_result: ['body', 'description', 'issueBody', 'reportContent'],
  summary: ['body', 'description', 'subject_suffix', 'messageContent'],
  file_content: ['sourceCode', 'inputData', 'content', 'rawData'],
  vulnerabilities: ['findings', 'issueList', 'alertData'],
  report_html: ['htmlBody', 'body', 'content'],
  ticket_id: ['referenceId', 'relatedTicket'],
  risk_score: ['threshold_input', 'severity_input'],
};

export function autoInferInputMapping(
  currentNode: WorkflowNodeDef,
  precedingNodes: WorkflowNodeDef[],
  registry: typeof NODE_RESOLUTION_REGISTRY,
): { mapping: Record<string, string>; warnings: string[] } {
  // 이미 명시적 매핑이 있으면 그대로 사용
  if (currentNode.inputMapping && Object.keys(currentNode.inputMapping).length > 0) {
    return { mapping: currentNode.inputMapping as Record<string, string>, warnings: [] };
  }

  const resolution = registry[currentNode.uiType];
  if (!resolution) return { mapping: {}, warnings: [`Unknown node type: ${currentNode.uiType}`] };

  // 직전 노드부터 역순으로 출력 키 수집
  const availableOutputs: Array<{ nodeKey: string; outputKey: string }> = [];
  for (const prev of precedingNodes.reverse()) {
    for (const key of prev.outputKeys) {
      availableOutputs.push({ nodeKey: prev.nodeKey, outputKey: key });
    }
  }

  // resolution.inferInputMapping으로 1차 추론
  const prevOutputKeys = availableOutputs.map((o) => o.outputKey);
  const inferred = resolution.inferInputMapping(currentNode.configJson as any, prevOutputKeys);

  // 2차: 의미적 매핑으로 보완
  const warnings: string[] = [];
  for (const output of availableOutputs) {
    const semanticTargets = SEMANTIC_MAPPINGS[output.outputKey];
    if (!semanticTargets) continue;

    // configJson에 해당 필드가 비어있고, 아직 매핑되지 않았으면 자동 연결
    const config = currentNode.configJson as Record<string, any>;
    for (const target of semanticTargets) {
      if (target in config && !config[target] && !inferred[target]) {
        inferred[target] = `$.${output.nodeKey}.output.${output.outputKey}`;
      }
    }
  }

  return { mapping: inferred, warnings };
}
```

---

## 5. API 설계

### 5.1 워크플로우 CRUD API

```
POST   /api/workflows                    — 워크플로우 생성 (빌더에서 저장 or 직접 생성)
GET    /api/workflows                    — 목록 조회 (필터: status, category, tags)
GET    /api/workflows/:id                — 상세 조회 (노드, 엣지 포함)
PATCH  /api/workflows/:id                — 메타데이터 수정 (name, description, status, triggerConfig)
DELETE /api/workflows/:id                — 삭제 (Soft: ARCHIVED / Hard: 관리자만)

PUT    /api/workflows/:id/nodes          — 노드 전체 교체 (캔버스 저장) + OCC 버전 체크
PATCH  /api/workflows/:id/nodes/:nodeKey — 단일 노드 수정

GET    /api/workflows/:id/versions       — 버전 이력 조회
POST   /api/workflows/:id/versions/:vid/rollback — 특정 버전으로 롤백

POST   /api/workflows/:id/execute        — 워크플로우 실행 (inputParameters 포함)
GET    /api/workflows/:id/executions     — 실행 이력 조회

POST   /api/workflows/:id/draft          — 드래프트 생성/갱신 (OCC 잠금)
GET    /api/workflows/:id/draft          — 내 드래프트 조회
DELETE /api/workflows/:id/draft          — 드래프트 폐기
POST   /api/workflows/:id/draft/commit   — 드래프트를 정식 버전으로 커밋

POST   /api/workflows/:id/clone          — 워크플로우 복제
POST   /api/workflows/:id/export         — JSON 내보내기
POST   /api/workflows/import             — JSON 가져오기
```

### 5.2 WorkflowController 핵심 엔드포인트

```typescript
// apps/api/src/modules/workflow/workflow.controller.ts

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowController {
  // 워크플로우 저장 (빌더 파이프라인 최종 단계)
  @Post()
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('CREATE', 'Workflow')
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateWorkflowDto) {
    // 1. NodeResolutionEngine으로 각 노드의 executionType + capability 해석
    // 2. inputMapping 자동 추론
    // 3. parameterBindings 유효성 검증
    // 4. Workflow + WorkflowNodeDef[] + WorkflowEdge[] 생성
    // 5. WorkflowVersion v1 스냅샷 생성
    // 6. BuilderRequest 연결 (있는 경우)
    return this.workflowService.create(user, dto);
  }

  // 노드 전체 교체 (캔버스 저장)
  @Put(':id/nodes')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('UPDATE', 'Workflow')
  async updateNodes(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowNodesDto, // { nodes: [], edges: [], version: number, changeMessage: string }
  ) {
    // OCC: dto.version !== workflow.version → 409 Conflict
    // 1. 기존 노드/엣지 삭제
    // 2. NodeResolutionEngine으로 새 노드 해석
    // 3. 새 노드/엣지 생성
    // 4. version 증가
    // 5. WorkflowVersion 스냅샷 생성
    return this.workflowService.updateNodes(user, id, dto);
  }

  // 워크플로우 실행
  @Post(':id/execute')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'Workflow')
  async execute(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ExecuteWorkflowDto, // { inputParameters: { ... }, triggeredBy: 'manual' }
  ) {
    // 1. Workflow + WorkflowNodeDef[] 로드
    // 2. WorkflowExecutionBridge로 RunWorkflowInput 변환
    // 3. parameterBindings 해석 (inputParameters 주입)
    // 4. WorkflowRunnerService.run() 호출
    // 5. WorkflowExecution 레코드 생성
    return this.workflowService.execute(user, id, dto);
  }
}
```

### 5.3 CreateWorkflowDto

```typescript
export class CreateWorkflowDto {
  name!: string;
  description?: string;
  category?: string;
  tags?: string[];

  // 빌더에서 오는 경우
  builderRequestId?: string;

  // 노드 정의 (프론트엔드 형식)
  nodes!: Array<{
    nodeKey: string;
    uiType: string; // web-search, ai-processing, ...
    name: string;
    description?: string;
    executionOrder: number;
    configJson: Record<string, any>;
    dependsOn?: string[];

    // 선택적 (미지정 시 NodeResolutionEngine이 자동 추론)
    capability?: string;
    inputMapping?: Record<string, string>;
    parameterBindings?: Record<string, string>;
  }>;

  // 엣지 정의
  edges?: Array<{
    fromNodeKey: string;
    toNodeKey: string;
    edgeType?: EdgeType;
    condition?: string;
    conditionLabel?: string;
  }>;

  // 트리거 설정
  triggerType?: string;
  triggerConfig?: Record<string, any>;

  // 파라미터 스키마 (실행 시 주입 가능한 변수)
  parameterSchema?: WorkflowParameter[];

  // 빌더 Readiness 결과 (있는 경우)
  readinessScore?: number;
  readinessBand?: string;
  acknowledgeWarnings?: boolean;

  // OCC (수정 시)
  version?: number;
  changeMessage?: string;
}
```

---

## 6. OCC (Optimistic Concurrency Control) 설계

### 6.1 동작 원리

```
User A: GET /workflows/abc → version: 5
User B: GET /workflows/abc → version: 5

User A: PUT /workflows/abc/nodes { version: 5, nodes: [...] }
  → Server: version === 5 ✓, 저장 성공, version → 6

User B: PUT /workflows/abc/nodes { version: 5, nodes: [...] }
  → Server: version !== 6 ✗, 409 Conflict 반환
  → Response: {
      error: "VERSION_CONFLICT",
      currentVersion: 6,
      lastChangedBy: "User A",
      lastChangedAt: "2026-04-18T10:30:00Z",
      changeMessage: "메일 수신자 변경"
    }
```

### 6.2 드래프트 시스템

긴 편집 세션에서는 OCC만으로는 불충분합니다. 드래프트 시스템을 병행합니다.

```
1. User A: POST /workflows/abc/draft
   → WorkflowDraft 생성 (baseVersion: 5, expiresAt: now + 30min)
   → 다른 사용자에게 "User A가 편집 중" 표시

2. User A: 편집 중 → PATCH /workflows/abc/draft { nodesJson: [...] }
   → 드래프트 갱신, expiresAt 리셋

3. User A: POST /workflows/abc/draft/commit
   → baseVersion === workflow.version? → 바로 커밋
   → baseVersion !== workflow.version? → 충돌 해결 필요
      → 3-way merge 시도 또는 강제 덮어쓰기 옵션 제공

4. 30분 동안 활동 없으면 → 드래프트 자동 만료 (Cron job)
```

### 6.3 충돌 해결 전략

```typescript
interface ConflictResolution {
  strategy: 'merge' | 'force-overwrite' | 'abort';

  // merge 전략: 노드 단위 3-way diff
  // - 같은 노드를 둘 다 수정 → 충돌 (수동 해결)
  // - 서로 다른 노드 수정 → 자동 병합
  // - 노드 추가/삭제는 독립적 → 자동 병합

  // force-overwrite: 내 버전으로 강제 저장 (관리자 권한)
  // abort: 내 변경 폐기, 최신 버전으로 새로고침
}
```

---

## 7. 실행 브릿지 (Workflow → Execution)

### 7.1 WorkflowExecutionBridge

```typescript
// apps/api/src/modules/workflow/workflow-execution-bridge.service.ts

@Injectable()
export class WorkflowExecutionBridge {
  /**
   * 저장된 Workflow → WorkflowRunnerService가 이해하는 RunWorkflowInput으로 변환
   */
  async buildRunInput(
    workflow: Workflow & { nodes: WorkflowNodeDef[]; edges: WorkflowEdge[] },
    inputParameters: Record<string, any>,
  ): Promise<RunWorkflowInput> {
    // 1. parameterBindings 해석
    const resolvedNodes = workflow.nodes.map((node) => {
      const config = { ...(node.configJson as Record<string, any>) };
      const bindings = (node.parameterBindings as Record<string, string>) || {};

      for (const [configKey, bindingExpr] of Object.entries(bindings)) {
        // "{{param.searchKeywords}}" → inputParameters.searchKeywords
        const paramKey = bindingExpr.replace(/\{\{param\.(.+?)\}\}/, '$1');
        if (paramKey in inputParameters) {
          config[configKey] = inputParameters[paramKey];
        } else {
          // parameterSchema의 defaultValue 사용
          const paramDef = (workflow.parameterSchema as any[])?.find((p) => p.key === paramKey);
          if (paramDef?.defaultValue !== undefined) {
            config[configKey] = paramDef.defaultValue;
          }
        }
      }

      return config;
    });

    // 2. WorkflowNodeDef[] → execution WorkflowNode[] 변환
    const executionNodes: WorkflowNode[] = workflow.nodes
      .sort((a, b) => a.executionOrder - b.executionOrder)
      .map((node, idx) => ({
        id: node.nodeKey,
        type: node.executionType as WorkflowNodeType,
        capability: node.capability || undefined,
        config: resolvedNodes[idx],
        inputMapping: (node.inputMapping as Record<string, string>) || undefined,
        dependsOn: node.dependsOn.length > 0 ? node.dependsOn : undefined,
        parallelGroup: node.parallelGroup || undefined,
      }));

    return {
      workflowKey: workflow.key,
      title: workflow.name,
      nodes: executionNodes,
      initialInput: inputParameters,
      createMission: executionNodes.some((n) => n.type === 'human' || n.type === 'agent'),
    };
  }
}
```

### 7.2 커넥터 가용성 검증 (실행 전)

```typescript
/**
 * 워크플로우 실행 전, 모든 노드가 참조하는 커넥터가 테넌트에 설치/활성화 상태인지 확인
 */
async validateConnectorAvailability(
  ctx: TenantContext,
  nodes: WorkflowNodeDef[],
): Promise<{ valid: boolean; missingConnectors: string[] }> {

  const requiredConnectors = nodes
    .filter(n => n.connectorKey)
    .map(n => n.connectorKey!);

  const uniqueKeys = [...new Set(requiredConnectors)];

  const installedConnectors = await this.prisma.connector.findMany({
    where: { tenantId: ctx.tenantId, key: { in: uniqueKeys }, status: 'ACTIVE' },
    select: { key: true },
  });

  const installedKeys = new Set(installedConnectors.map(c => c.key));
  const missing = uniqueKeys.filter(k => !installedKeys.has(k));

  return { valid: missing.length === 0, missingConnectors: missing };
}
```

---

## 8. 프론트엔드 통합

### 8.1 빌더 저장 흐름 변경

```typescript
// apps/web/src/app/(authenticated)/orchestration/builder/page.tsx — 저장 함수 개선

async function handleSaveWorkflow() {
  const templateNodes = builderNodesToTemplateNodes(nodes);

  // 1. Harness 실행 (로컬 or API)
  const harnessResult = await runHarnessViaApi(
    templateNodes,
    matchedTemplate,
    connectorGaps,
    userPrompt,
  );

  if (!harnessResult.canSave && !acknowledgeWarnings) {
    // 차단 오류 표시
    return;
  }

  // 2. 워크플로우 서버 저장 (NEW)
  const response = await api.post('/workflows', {
    name: workflowName,
    description: workflowDescription,
    category: harnessResult.requestId ? undefined : detectedCategory,
    builderRequestId: harnessResult.requestId,

    nodes: nodes.map((n, idx) => ({
      nodeKey: n.id,
      uiType: n.type,
      name: n.name,
      executionOrder: idx + 1,
      configJson: n.settings,
      dependsOn: n.dependsOn || [],
      // capability, inputMapping, parameterBindings → 서버가 자동 추론
    })),

    edges: edges.map((e) => ({
      fromNodeKey: e.from,
      toNodeKey: e.to,
      edgeType: e.type || 'SEQUENCE',
      condition: e.condition,
      conditionLabel: e.label,
    })),

    triggerType: nodes[0]?.type === 'schedule' ? 'schedule' : 'manual',
    triggerConfig: nodes[0]?.type === 'schedule' ? nodes[0].settings : undefined,

    readinessScore: harnessResult.readinessScore.overall,
    readinessBand: harnessResult.readinessScore.band,
    acknowledgeWarnings,
  });

  // 3. 성공 → 워크플로우 상세 페이지로 이동
  router.push(`/orchestration/workflows/${response.id}`);
}
```

### 8.2 워크플로우 실행 흐름

```typescript
// 실행 버튼 클릭 시
async function handleExecuteWorkflow(workflowId: string, inputParameters: Record<string, any>) {
  const result = await api.post(`/workflows/${workflowId}/execute`, {
    inputParameters,
    triggeredBy: 'manual',
  });

  // SSE 구독으로 실시간 진행 상황 표시
  const eventSource = new EventSource(`/api/executions/${result.executionSessionId}/stream`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateNodeExecutionStatus(data.nodeId, data.status, data.output);
  };
}
```

### 8.3 OCC 충돌 UI

```typescript
// 저장 시 409 Conflict 처리
async function handleSaveNodes() {
  try {
    await api.put(`/workflows/${workflowId}/nodes`, {
      nodes: currentNodes,
      edges: currentEdges,
      version: localVersion, // 마지막으로 로드한 버전
      changeMessage: '노드 설정 변경',
    });
  } catch (error) {
    if (error.status === 409) {
      // 충돌 다이얼로그 표시
      showConflictDialog({
        currentVersion: error.data.currentVersion,
        lastChangedBy: error.data.lastChangedBy,
        lastChangedAt: error.data.lastChangedAt,
        options: [
          { label: '최신 버전으로 새로고침', action: 'reload' },
          { label: '내 변경으로 덮어쓰기', action: 'force', requireAdmin: true },
          { label: '차이점 비교', action: 'diff' },
        ],
      });
    }
  }
}
```

---

## 9. 마이그레이션 전략

### 9.1 BuilderPlan → Workflow 마이그레이션

기존에 `BuilderPlan.nodesJson`으로 저장된 데이터를 새 구조로 마이그레이션합니다.

```typescript
// prisma/migrations/migration-builder-to-workflow.ts

async function migrateBuilderPlansToWorkflows(prisma: PrismaClient) {
  const savedRequests = await prisma.builderRequest.findMany({
    where: { status: 'SAVED' },
    include: { plan: true, evalResult: true },
  });

  for (const req of savedRequests) {
    if (!req.plan) continue;
    const nodes = req.plan.nodesJson as TemplateNode[];

    // 1. Workflow 생성
    const workflow = await prisma.workflow.create({
      data: {
        tenantId: req.tenantId,
        createdById: req.userId,
        key: `migrated-${req.id.slice(-8)}`,
        name: req.plan.templateName || '마이그레이션된 워크플로우',
        status: 'ACTIVE',
        builderRequestId: req.id,
        templateId: req.plan.templateId,
      },
    });

    // 2. 노드 생성
    for (const [idx, node] of nodes.entries()) {
      await prisma.workflowNodeDef.create({
        data: {
          workflowId: workflow.id,
          nodeKey: node.id,
          name: node.name,
          uiType: node.type,
          executionType: resolveExecutionType(node.type),
          capability: resolveCapability(node),
          intentCategory: resolveIntentCategory(node),
          actionType: node.actionType,
          configJson: node.settings || {},
          outputKeys: node.outputKeys || [],
          executionOrder: idx + 1,
          dependsOn: [],
          failureAction: node.failureAction || 'stop',
          retryCount: node.retryCount || 0,
          policyCheckpoint: !!node.policyCheckpoint,
          humanApproval: !!node.humanApproval,
          connectorKey: node.connectorKey,
          icon: node.icon,
          color: node.color,
        },
      });
    }

    // 3. 순차 엣지 생성
    for (let i = 0; i < nodes.length - 1; i++) {
      await prisma.workflowEdge.create({
        data: {
          workflowId: workflow.id,
          fromNodeKey: nodes[i].id,
          toNodeKey: nodes[i + 1].id,
          edgeType: 'SEQUENCE',
        },
      });
    }

    // 4. 초기 버전 스냅샷
    await prisma.workflowVersion.create({
      data: {
        workflowId: workflow.id,
        versionNumber: 1,
        nodesSnapshot: nodes as any,
        edgesSnapshot: [] as any,
        changeMessage: 'BuilderPlan 마이그레이션',
        changedById: req.userId,
        readinessScore: req.evalResult?.overallScore,
        readinessBand: req.evalResult?.band?.toLowerCase(),
      },
    });
  }
}
```

### 9.2 파일 변경 범위

```
새로 생성:
  prisma/schema.prisma                               — 6개 모델 추가
  apps/api/src/modules/workflow/                      — 새 모듈 디렉토리
    ├── workflow.module.ts
    ├── workflow.controller.ts
    ├── workflow.service.ts
    ├── workflow-execution-bridge.service.ts
    ├── node-resolution.registry.ts
    ├── input-mapping.resolver.ts
    ├── dto/create-workflow.dto.ts
    ├── dto/update-workflow-nodes.dto.ts
    ├── dto/execute-workflow.dto.ts
    └── migration/migrate-builder-to-workflow.ts
  apps/web/src/lib/workflow-api.ts                    — 워크플로우 CRUD 클라이언트
  apps/web/src/stores/workflow.ts                     — Zustand 워크플로우 스토어

수정:
  apps/api/src/app.module.ts                          — WorkflowModule 등록
  packages/database/src/tenant-middleware.ts           — 6개 모델 추가
  apps/api/src/modules/builder/builder-eval.service.ts — save() → WorkflowService.create() 호출
  apps/web/src/app/(authenticated)/orchestration/builder/page.tsx — 저장/실행 흐름 변경
  apps/web/src/lib/builder-harness.ts                 — builderApi.save() → workflowApi.create()
```

---

## 10. 설계 리뷰

### 10.1 Principal Engineer 관점

| 항목        | 평가                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------- |
| 정규화 수준 | 적절 — WorkflowNodeDef 개별 행이지만 configJson은 여전히 JSON (스키마리스 설정의 유연성 유지) |
| 쿼리 성능   | @@index(tenantId, status), @@index(workflowId, executionOrder) 로 주요 패턴 커버              |
| 확장성      | parameterBindings가 노드 설정의 동적 주입을 지원하여 워크플로우 재사용성 확보                 |
| 하위 호환   | BuilderPlan → Workflow 마이그레이션으로 기존 데이터 보존                                      |
| 기술 부채   | NODE_RESOLUTION_REGISTRY가 하드코딩이지만, 향후 DB 기반 CapabilityBinding으로 전환 가능       |

### 10.2 Security / Governance 관점

| 항목          | 조치                                                                 |
| ------------- | -------------------------------------------------------------------- |
| 멀티테넌시    | tenant-middleware.ts에 6개 모델 추가, 모든 쿼리에 tenantId 자동 주입 |
| RBAC          | OPERATOR 이상만 워크플로우 생성/수정/실행, VIEWER는 조회만           |
| OCC           | version 필드 + 409 Conflict로 동시 수정 데이터 손실 방지             |
| 감사          | @Audit 데코레이터로 모든 CUD 작업 기록                               |
| 파라미터 검증 | parameterBindings는 `{{param.*}}` 패턴만 허용, 임의 코드 실행 불가   |
| 커넥터 검증   | 실행 전 테넌트 소유 커넥터 존재 + ACTIVE 상태 확인                   |

### 10.3 SaaS Operations 관점

| 항목          | 조치                                                                  |
| ------------- | --------------------------------------------------------------------- |
| 드래프트 정리 | 만료된 드래프트 자동 삭제 (Cron job, 30분 TTL)                        |
| 버전 스토리지 | WorkflowVersion.nodesSnapshot은 JSON — 대규모 워크플로우 시 압축 고려 |
| 실행 이력     | WorkflowExecution → ExecutionSession FK로 워크플로우별 실행 통계 가능 |
| 스케줄 트리거 | triggerConfig.cron으로 Bull/BullMQ 큐 등록 (Phase 7에서 구현)         |
| 모니터링      | workflow.executionCount, lastExecutedAt으로 활성 워크플로우 대시보드  |

---

## 11. 구현 우선순위

| 단계       | 작업                                | 예상 복잡도 |
| ---------- | ----------------------------------- | ----------- |
| **Step 1** | Prisma 스키마 추가 + 마이그레이션   | 중          |
| **Step 2** | WorkflowModule (CRUD + OCC)         | 중          |
| **Step 3** | NodeResolutionRegistry              | 중          |
| **Step 4** | WorkflowExecutionBridge             | 중          |
| **Step 5** | builder-eval.service.ts save() 연결 | 저          |
| **Step 6** | 프론트엔드 저장/실행 흐름 변경      | 중          |
| **Step 7** | OCC + 드래프트 시스템               | 고          |
| **Step 8** | 마이그레이션 스크립트               | 저          |
| **Step 9** | 통합 테스트                         | 중          |
