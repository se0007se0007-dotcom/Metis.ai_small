# Connector Runtime & Governance 테스트 가이드

## 1. 서버 시작

```bash
cd metis-ai

# 의존성 설치
pnpm install

# DB 마이그레이션 + 시드
pnpm --filter database db:migrate
pnpm --filter database db:seed

# API 서버 시작 (포트 4000)
pnpm --filter api dev

# 웹 서버 시작 (포트 3000)
pnpm --filter web dev
```

## 2. 시드된 커넥터 목록

| key              | name                  | type       | status  |
| ---------------- | --------------------- | ---------- | ------- |
| slack-webhook    | Slack 알림            | WEBHOOK    | ACTIVE  |
| jira-api         | Jira 연동             | REST_API   | ACTIVE  |
| mcp-filesystem   | MCP Filesystem Server | MCP_SERVER | PENDING |
| mcp-brave-search | MCP Brave Search      | MCP_SERVER | PENDING |
| mcp-postgres     | MCP PostgreSQL        | MCP_SERVER | PENDING |
| langflow-agent   | LangFlow Agent        | AGENT      | PENDING |
| github-webhook   | GitHub Webhook        | WEBHOOK    | ACTIVE  |

## 3. API 테스트 (cURL)

### 3.1 커넥터 목록 조회

```bash
curl -s http://localhost:4000/v1/connectors \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.2 MCP 서버 시작

```bash
# mcp-filesystem 커넥터 ID로 교체
curl -s -X POST http://localhost:4000/v1/connectors/<ID>/start \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.3 MCP 도구 목록 조회

```bash
curl -s http://localhost:4000/v1/connectors/<ID>/tools \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.4 스키마 디스커버리

```bash
curl -s -X POST http://localhost:4000/v1/connectors/<ID>/discover \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.5 테스트 파이프라인 실행

```bash
curl -s -X POST http://localhost:4000/v1/connectors/<ID>/test \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.6 Governed Invoke (통합 호출)

```bash
curl -s -X POST http://localhost:4000/v1/connectors/invoke \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "connectorKey": "slack-webhook",
    "actionType": "ACTION_INVOKE",
    "method": "send_message",
    "payload": { "channel": "#general", "text": "Hello from Metis!" },
    "executionSessionId": "test-session-001"
  }' | jq
```

### 3.7 거버넌스 오버뷰

```bash
curl -s http://localhost:4000/v1/connectors/governance/overview \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.8 호출 로그 조회

```bash
curl -s "http://localhost:4000/v1/connectors/governance/call-logs?limit=20" \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.9 Rate Limit 상태

```bash
curl -s http://localhost:4000/v1/connectors/governance/rate-limits \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.10 Circuit Breaker 상태

```bash
curl -s http://localhost:4000/v1/connectors/governance/circuits \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.11 수명주기 상태

```bash
curl -s http://localhost:4000/v1/connectors/governance/lifecycle \
  -H "Authorization: Bearer <TOKEN>" | jq
```

### 3.12 MCP 서버 중지/재시작

```bash
curl -s -X POST http://localhost:4000/v1/connectors/<ID>/stop \
  -H "Authorization: Bearer <TOKEN>" | jq

curl -s -X POST http://localhost:4000/v1/connectors/<ID>/restart \
  -H "Authorization: Bearer <TOKEN>" | jq
```

## 4. 웹 UI 테스트

### 4.1 커넥터 관리 (ConnectorHub)

- URL: `http://localhost:3000/orchestration/connectors`
- 기능:
  - 커넥터 목록 조회 (타입별 필터)
  - 새 커넥터 등록 (MCP_SERVER 선택 시 command/args 입력 폼)
  - 상세 패널에서 Start/Stop/Restart 버튼
  - Test Pipeline 실행 (단계별 결과 표시)
  - MCP Tools 조회 (MCP_SERVER 타입인 경우)
  - Schema Discovery 실행
  - Governed Invoke 모달 (method + payload JSON 입력)

### 4.2 거버넌스 모니터링 대시보드

- URL: `http://localhost:3000/governance/monitoring`
- 탭:
  - **Overview**: 총 호출, 성공률, 평균 응답시간, 비용, 에러 수 + 시계열 차트
  - **Circuit Breakers**: 커넥터별 서킷 상태 (closed/open/half-open)
  - **Rate Limits**: 토큰 잔여, 분당/시간당 사용량
  - **Call Logs**: 호출 이력 (필터: 커넥터, 성공/실패)
  - **Lifecycle**: MCP 서버 연결 상태, 도구 수

## 5. 구현된 기능 체크리스트

### Phase 1-2 (기반)

- [x] Runtime Dispatcher (MCP/REST/Webhook 프로토콜 디스패치)
- [x] MCP Client (JSON-RPC 2.0 stdio/SSE)
- [x] Schema Discovery (MCP tools/list)
- [x] Secrets Manager (AES-256-GCM 암호화)
- [x] Lifecycle Manager (start/stop/restart + auto-restart)
- [x] Test Pipeline (5단계: 설정검증, 네트워크, 인증, 스키마, 호출)
- [x] Connector UI (ConnectorHub 페이지)

### Phase 3 (거버넌스)

- [x] Rate Limiter (Token Bucket + 분당/시간당 제한)
- [x] Call Logger (비용 추적 포함)
- [x] Policy Engine ↔ Connector 통합 (GovernedDispatcher 체인)
- [x] Multi-tenant 격리 (tenantId 기반)

### Phase 4 (안정성)

- [x] Circuit Breaker (3-상태: closed/open/half-open)
- [x] Governance Monitoring Dashboard
- [x] 시드 데이터 (MCP/Agent/Webhook/REST 커넥터)

## 6. 파일 구조

```
apps/api/src/modules/connector/
├── connector-runtime.ts     # 핵심 런타임 (9개 클래스)
├── connector.service.ts     # 서비스 (CRUD + Governed Invoke)
├── connector.controller.ts  # 컨트롤러 (모든 API 엔드포인트)
└── connector.module.ts      # NestJS 모듈 (프로바이더 등록)

apps/web/src/app/(authenticated)/
├── orchestration/connectors/page.tsx  # ConnectorHub UI
└── governance/monitoring/page.tsx     # Governance Dashboard UI

apps/web/src/lib/
├── api-hooks.ts             # TanStack Query 훅 (신규 10개 추가)
└── api-client.ts            # HTTP 클라이언트

prisma/
└── seed.ts                  # 시드 데이터 (7개 커넥터)
```
