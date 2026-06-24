# Metis Agent 표준화·공통화 설계 (Agent / Sub-Agent / Ingest Key / Market)

> 작성: 전체 소스 점검 기반. 5개 의도(메인/서브 Agent 구조, 외부·내부 4Gate 일원화, 등록 중복 정리,
> Sub-Agent별 Ingest Key 추적, 스타터팩 제거)에 대한 현재상태 → 목표 → 변경안.

---

## 0. 핵심 사실 (코드 근거)

- **별도 Agent 엔티티 없음.** `Workflow` = 메인 Agent. `WorkflowNodeDef` = Sub-Agent(노드).
  - 근거: `prisma/schema.prisma` `model Workflow`(노드 `nodes WorkflowNodeDef[]`). 별도 Agent 모델 없음.
- 화면별 라벨이 달라 혼란: 빌더/마켓="워크플로우", 실행/대시보드="Agent", 커넥터관리 노드="Sub-Agent".
- **마켓·운영/개발 실행은 같은 Workflow 행**을 다른 필터로 보여줌:
  - 마켓: 상태/검색 (전부)
  - 운영/개발 실행(`/dashboard/agents?category=`): `listed=true` + `tags[0]`∈{운영/개발 별칭}
- **내부/외부 Agent의 4Gate·대시보드는 이미 동일 경로**:
  - 내부: `PipelineEngine.execute()` → 노드별 `evaluatorService.evaluate()` → `AgentEvaluation`.
  - 외부(SDK): `POST /ingest/runs` → `IngestService.ingestRuns()` → `runToEvaluateArgs()` → **같은 `evaluate()`**.
  - 둘 다 같은 4Gate(품질40·보안30·비용15·이상15) + 대시보드 + 이상탐지 + 알람 + 지식캡처.
- **Ingest API Key는 테넌트 단위만**(`model IngestApiKey`): `agentId`/`subAgentId` 없음, 수동 발급,
  키↔run 연결 없음, Team 모델 없음, 관리자 UI 없음.
- **스타터팩은 프런트 정적**(`lib/starter-workflows.ts` `STARTER_PACKS` + 마켓 탭). 백엔드 무관.

---

## 1. 메인/서브 Agent 구조 (의도 #1) — 용어·구조 표준화

### 현재
- Workflow=메인, Node=Sub-Agent인데 화면마다 라벨 상이.
- Sub-Agent는 커넥터관리에서 단독 테스트 가능(이미 구현: `execute-node` + 4Gate). Sub-Agent를 메인으로
  "승격"하는 명시적 경로는 없음(빌더에서 노드 1개짜리 워크플로를 만들면 사실상 메인 Agent).

### 목표
- 사용자 화면 전체에서 **"Agent(워크플로우)"** 일관 표기, 노드는 **"Sub-Agent"**.
- Sub-Agent → 메인 Agent 승격 액션: 커넥터관리 Sub-Agent 상세에 **"메인 Agent로 만들기"** 버튼 →
  그 노드 1개로 `POST /workflows`(tags=[category], 적절 노드) 생성 → 운영/개발에서 실행 가능.

### 변경안
- (UI) 마켓/빌더/실행 헤더·라벨 문구 통일: "워크플로우" 표기 옆에 "(=Agent)" 또는 "Agent" 우선.
- (UI) 커넥터관리 Sub-Agent 상세에 "메인 Agent로 승격" 버튼 추가 → 단일노드 워크플로 생성 API 호출.
- (무변경) 4Gate/대시보드는 이미 노드·워크플로 공통.

---

## 2. 외부/내부 Agent의 4Gate·대시보드·이력 일원화 (의도 #2)

### 현재 — 이미 대부분 충족
| 경로 | 실행 | 4Gate | 저장 | 대시보드 |
|---|---|---|---|---|
| 내부(flo) | PipelineEngine | evaluate() | AgentEvaluation/ExecutionSession | overview/agents/anomaly/trend |
| 외부(SDK) | /ingest/runs | **동일 evaluate()** | 동일 테이블 | 동일 |

- 즉 외부 agent도 Ingest 키로 run을 보내면 metis 안에서 4Gate 통과 + 대시보드·이력에 남음.

### 보강 필요
- **출처(source) 가시화**: `ExecutionSession.source`(internal/sdk)를 대시보드·이력에 표기(현재 저장은 되나
  화면 노출 약함) → "이 Agent는 외부 연동/내부 생성" 배지.
- **외부 'api-call' 노드 경로**: AgentRegisterModal `mode:external`은 uiType `api-call` 노드 → 파이프라인이
  외부 URL 호출. `api-call` 실행기가 실제 동작/4Gate 평가되는지 점검(현재 passthrough 가능성) → 실행기 보강 대상.

---

## 3. Agent 등록 vs metis.flo 중복 정리 (의도 #3) — flo로 통합

### 현재 (중복 확인됨)
- `AgentRegisterModal`(실행 화면 "+ Agent 등록"): `POST /workflows`(단일노드 퀵폼) **+** `POST /orb/governance-reviews`(자동).
- 빌더/마켓: `POST /workflows`만(ORB 수동).
- 즉 **같은 Workflow 생성** + 차이는 (a) 퀵 단일폼 (b) ORB 자동제출 (c) tags `quick-register`,`mode:*`.

### 목표 — metis.flo(빌더/마켓) 단일 진입으로 표준화
- "Agent 생성"은 **metis.flo 한 곳**에서. 외부 agent 연동도 flo의 한 모드로 흡수.
- 실행 화면의 "+ Agent 등록"은 제거하거나 **flo의 빠른생성으로 리다이렉트**(중복 UI 제거).

### 변경안 (택1, 권장 B)
- A. 실행 화면 "+ Agent 등록" 버튼 제거 → "metis.flo에서 만들기"로 링크.
- **B(권장)**: 등록 모달을 **공통 컴포넌트**로 두되 진입점을 flo(빌더/마켓)로 이동. flo 안에 탭/버튼:
  - "AI 노드형"(mode:llm), "외부 연동형"(mode:external/api-call), "SDK형"(mode:sdk + Ingest 키 발급).
  - 생성 후 ORB 심사 자동제출은 **체크박스 옵션**으로 통일(둘 다 동일 동작).
- 결과: 사용자 머릿속 모델 = "agent는 flo에서 만든다. 외부든 내부든. 만들면 4Gate 받고 대시보드에 뜬다."

---

## 4. Sub-Agent별 Ingest API Key 추적 체계 (의도 #4) — 신규 구축(마이그레이션 동반)

### 현재 (큰 공백)
- `IngestApiKey`: **테넌트 단위만**. agent/sub-agent 연결 없음. 키↔run 추적 없음. 관리자 표 없음. Team 없음.
- run의 `agentName`은 본문 자유입력 → 키로 강제/검증 안 됨. `ExecutionSession.agentMetaJson`에만 JSON 저장.

### 목표
- 외부·내부 메인 Agent와 **Sub-Agent별로 Ingest 키 발급** → "어느 Sub-Agent가 많이 호출됐나/문제인가"를
  키 기준으로 추적. 관리자 현황표에서 **테넌트·팀·Sub-Agent·기타 그룹**별 집계.

### 변경안 (스키마 → API → 추적 → 관리자 UI)

**(A) 스키마 (`prisma/schema.prisma`)**
```prisma
model Team {                      // 신규: 테넌트 하위 그룹
  id String @id @default(cuid())
  tenantId String
  name String
  tenant Tenant @relation(...)
  @@unique([tenantId, name])
}

model IngestApiKey {             // 필드 추가
  // ...기존(tenantId, name, prefix, hashedKey, scopes, env, lastUsedAt, revokedAt)...
  teamId        String?          // 팀 그룹
  agentKey      String?          // 메인 Agent(workflow.key) 연결 (선택)
  subAgentKey   String?          // Sub-Agent(nodeKey|uiType) 연결 (선택)
  agentName     String?          // 표시/매칭용
  allowedAgentNames String[] @default([])  // 본문 agentName 허용목록(스푸핑 방지)
  // 집계 캐시(옵션)
  callCount     Int @default(0)
  lastRunAt     DateTime?
}

model IngestKeyUsage {           // 신규: 키↔run 추적 로그(또는 ExecutionSession에 ingestKeyId 컬럼)
  id String @id @default(cuid())
  tenantId String
  ingestKeyId String
  agentName String?
  subAgentKey String?
  ts DateTime @default(now())
  costUsd Float?
  status String?
}
```
- 또는 경량안: `ExecutionSession`에 `ingestKeyId String?` 컬럼만 추가하고, 집계는 그 위에서 쿼리.

**(B) 생성/연결 (`ingest-key.service.ts`, 등록 흐름)**
- Agent(외부/내부) 생성 시 **자동 키 발급** 옵션: 메인 Agent 키 + (요청 시) Sub-Agent별 키.
- `POST /ingest/keys`에 `teamId/agentKey/subAgentKey/allowedAgentNames` 입력 허용.

**(C) 검증/귀속 (`ingest-key.guard.ts`, `ingest.service.ts`)**
- guard가 `ingestKeyId`를 request에 부착(이미 함) → ingest 처리 시 `ExecutionSession.ingestKeyId` 기록.
- 본문 `agentName`이 키의 `allowedAgentNames`에 없으면 거부(옵션).
- 게이트웨이/원장 귀속(x-metis-agent, run_id)과 키를 연결.

**(D) 관리자 현황표 (신규 화면 + 엔드포인트)**
- `GET /admin/ingest-keys/overview` → 키별: 소속(테넌트/팀/Agent/Sub-Agent), 호출수(24h/7d/누적),
  마지막 사용, 비용, 4Gate 평균, 상태(활성/폐기).
- 그룹 집계: 테넌트별 / 팀별 / Sub-Agent별 / env별.
- UI: `app/(authenticated)/admin/ingest-keys/page.tsx` — 표 + 필터 + 키 생성/폐기/회전.

**주의**: (A) 스키마 변경은 **DB 마이그레이션(db push)** 필요 → 운영 중 적용은 start-metis.bat 재기동 시.
사용자 합류(승인) 후 단계적용 권장.

---

## 5. 마켓 스타터팩 제거 (의도 #5) — 반영 완료

- 마켓 페이지에서 "Starter Packs" 탭 제거(이번 반영). 잔여 정적 데이터(`STARTER_PACKS`, 렌더 블록)는
  dead code로 남아 화면 미노출 → 후속에서 `lib/starter-workflows.ts` 및 렌더/모달 완전 삭제 권장
  (단 `WORKFLOW_TEMPLATES`/`INTENT_PATTERNS`가 빌더 NL 생성에 쓰이는지 확인 후 분리 삭제).

---

## 6. 단계별 실행 계획 (권장 순서)

1. **즉시(완료/저위험)**: 스타터팩 탭 제거(완료), 용어 라벨 통일(텍스트), Sub-Agent "메인 Agent 승격" 버튼.
2. **중간(마이그레이션 無)**: 실행 화면 "+ Agent 등록" → flo 통합/리다이렉트, source(internal/sdk) 배지,
   `api-call` 외부노드 실행기 보강.
3. **대형(마이그레이션 有)**: Ingest Key 스키마 확장(Team/agent/subAgent/usage) → 자동발급 → 귀속 →
   관리자 현황표. ← 설계 확정·승인 후 일괄 적용(재기동 1회).

## 7. 테스트 전략
- 단위: 새 키 발급/검증, ingest run→키 귀속, 관리자 집계 쿼리.
- 통합: 외부 SDK run → 4Gate → 대시보드/키 현황표 반영 일치.
- 회귀: 기존 워크플로 실행·대시보드·노드 테스트 무영향(타입체크 0 에러 유지).
