# Metis.AI Redesign — 테스트 가이드 (Phase 0~4)

## 1. 환경 준비

```bash
cd metis-ai

# Redis + PostgreSQL 기동
docker compose -f infra/compose/docker-compose.yml up -d

# 의존성 설치
pnpm install

# 마이그레이션 + 시드
pnpm --filter database db:migrate
pnpm --filter database db:seed

# API + 웹 + 워커 동시 기동
pnpm dev
```

환경변수 (필수):

```
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://metis:metis@localhost:5432/metis
METIS_SECRET_KEY=<64 hex chars>
```

## 2. 핵심 API 시나리오

### 2.1 멀티 에이전트 미션 플로우 (R1/R2/R3 검증)

```bash
TOKEN="Bearer <your-jwt>"
BASE=http://localhost:4000/v1

# 1) 미션 생성
curl -s -X POST $BASE/missions \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "key":"test-mission-001",
    "title":"테스트 배포 검증",
    "kind":"DEPLOYMENT",
    "participants":[
      {"agent":"qa-agent","role":"validator"},
      {"agent":"canary-agent","role":"rollout"}
    ]
  }' | jq
# → 응답에 correlationId 포함 (R3 시작점)

# 2) 미션 시작 (A2A 버스에 SYSTEM 메시지 발행)
curl -s -X POST $BASE/missions/<MISSION_ID>/start \
  -H "Authorization: $TOKEN" | jq

# 3) Redis 스트림 내용 직접 확인 (R1/R2 검증)
docker exec -it metis-redis redis-cli \
  XRANGE "metis:mission:<TENANT_ID>:stream" - + COUNT 10
# → 테넌트별 파티셔닝 확인

# 4) 미션 메시지 이력 (Prisma 저장소 검증)
curl -s $BASE/missions/<MISSION_ID>/messages \
  -H "Authorization: $TOKEN" | jq '.items[] | {kind, fromAgent, naturalSummary, correlationId}'

# 5) 핸드오프 생성 (에이전트 간 작업 전달)
curl -s -X POST $BASE/missions/handoffs \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "missionId":"<MISSION_ID>",
    "fromAgent":"qa-agent",
    "toAgent":"canary-agent",
    "task":{"action":"start-5pct-rollout","version":"v1.4"}
  }' | jq

# 6) 핸드오프 수락
curl -s -X POST $BASE/missions/handoffs/<HANDOFF_ID>/accept \
  -H "Authorization: $TOKEN" | jq

# 7) 인간 개입 일시 정지
curl -s -X POST $BASE/missions/<MISSION_ID>/pause \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"비용 이상 감지"}' | jq

# 8) 결정 재개
curl -s -X POST $BASE/missions/<MISSION_ID>/resume \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"계속 진행"}' | jq

# 9) ExecutionTrace 감사 기록 확인
docker exec -it metis-postgres psql -U metis -d metis -c \
  "SELECT trace_json->>'event', trace_json->>'naturalSummary' FROM \"ExecutionTrace\" WHERE correlation_id LIKE 'mission-%' ORDER BY created_at DESC LIMIT 20;"
```

### 2.2 자율 운영 + Undo

```bash
# 1) 자율 조치 실행
curl -s -X POST $BASE/auto-actions \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "kind":"REMEDIATION",
    "targetType":"Connector",
    "targetId":"<CONN_ID>",
    "triggerReason":"지연 시간이 임계치를 초과해 자동 차단",
    "action":{"operation":"throttle","factor":0.5},
    "revertWindowSec":600
  }' | jq
# → 되돌릴 수 있는 조치 리스트에 추가됨

# 2) 10분 이내 Undo
curl -s -X POST $BASE/auto-actions/<ACTION_ID>/revert \
  -H "Authorization: $TOKEN" | jq

# 3) 10분 경과 시 → 403 (revert window 만료)
```

### 2.3 FDS (이상 감지)

```bash
# 1) 룰 목록
curl -s $BASE/fds/rules -H "Authorization: $TOKEN" | jq

# 2) 룰 평가 테스트
curl -s -X POST $BASE/fds/evaluate \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "subject":{
      "accountId":"ACC-001",
      "transactionCountPerHour":15,
      "amount":5000000
    }
  }' | jq

# 3) 알림 목록
curl -s "$BASE/fds/alerts?status=OPEN" -H "Authorization: $TOKEN" | jq

# 4) 알림 해결 (Feedback Loop)
curl -s -X POST $BASE/fds/alerts/<ALERT_ID>/resolve \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"DISMISS","comment":"오탐이었음","feedbackToModel":true}' | jq
# → 룰 가중치 자동 조정 트리거
```

### 2.4 AP Agent (3-way 매칭)

```bash
# 1) 인보이스 목록
curl -s $BASE/ap/invoices -H "Authorization: $TOKEN" | jq

# 2) OCR 파싱 시뮬레이션
curl -s -X POST $BASE/ap/invoices/<INV_ID>/parse \
  -H "Authorization: $TOKEN" | jq

# 3) 3-way 매칭 실행
curl -s -X POST $BASE/ap/invoices/<INV_ID>/match \
  -H "Authorization: $TOKEN" | jq
# → matchingResult + aiSuggestionJson 반환

# 4) 승인
curl -s -X POST $BASE/ap/invoices/<INV_ID>/approve \
  -H "Authorization: $TOKEN" | jq
```

## 3. 웹 UI 테스트 경로

| URL                   | 화면                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `/home`               | **Command Center** (역할별 AI Insight + Action Queue + Live Feed + KPI) |
| `/missions`           | 미션 목록 + 새 미션 생성                                                |
| `/missions/{id}`      | **Mission Timeline** (에이전트 간 메시지 + 인간 개입 버튼)              |
| `/workspaces/ap`      | **AP 워크스페이스** (Side-by-Side 매칭 뷰)                              |
| `/workspaces/risk`    | **Risk 워크스페이스** (FDS 알림 + Similar Cases)                        |
| `/workspaces/ops`     | **IT Ops** (자율 조치 + 활성 미션)                                      |
| `/insights/finops`    | FinOps (**What-If 시뮬레이터 + 예측**)                                  |
| `/insights/anomalies` | 통합 이상 감지 (FDS + Circuit + Rate Limit + Canary)                    |
| `/platform/release`   | 릴리스 엔지니어링 허브                                                  |
| `/platform/agents`    | 에이전트 레지스트리                                                     |

## 4. 리스크 해소 검증 포인트

### R1: Redis Streams 안정 인터페이스

```bash
# 컨슈머 그룹 확인
docker exec -it metis-redis redis-cli \
  XINFO GROUPS "metis:mission:<TENANT_ID>:stream"
```

→ 컨슈머 그룹이 테넌트별로 분리됨. MessageBus 인터페이스 기반이므로 향후 Kafka/NATS 전환 시 구현체만 교체 가능.

### R2: 테넌트 격리

```bash
# 다른 테넌트 토큰으로 조회 시 404 반환 확인
curl -s $BASE/missions/<OTHER_TENANT_MISSION_ID> \
  -H "Authorization: Bearer <THIS_TENANT_TOKEN>"
# → 404 Not Found
```

→ Prisma `withTenantIsolation` + Redis 키 파티셔닝 이중 방어.

### R3: 감사 추적

```sql
-- 한 correlationId로 전체 플로우 추적
SELECT trace_json->>'event' as event,
       trace_json->>'naturalSummary' as summary,
       created_at
  FROM "ExecutionTrace"
 WHERE correlation_id = '<CORR_ID>'
 ORDER BY created_at;
```

→ Mission 생성 → A2A 메시지 → 핸드오프 → 자율 조치 → 인간 개입까지 모두 하나의 correlationId로 연결.

## 5. 구현된 주요 기능

### Phase 0: Agent Kernel

- [x] Redis Streams 기반 A2A Bus (`metis:mission:{tenantId}:stream`)
- [x] MessageBus 추상 인터페이스 (Redis 이외 브로커 전환 대비)
- [x] Mission CRUD + 6-상태 라이프사이클
- [x] AgentHandoff (PENDING/ACCEPTED/REJECTED/EXPIRED)
- [x] 모든 메시지는 Prisma + ExecutionTrace 이중 저장

### Phase 1: UX 재설계

- [x] 6그룹 23항목 신규 IA (목적·역할 중심)
- [x] 역할별 Command Center (`/home`)
- [x] 공용 컴포넌트 7종 (InspectorPanel, EventFeed, ActionQueue, AIInsightCard, CommandPalette, AgentTimeline, SideBySideDiff)

### Phase 2: 자율 운영

- [x] AutoAction 라이프사이클 (EXECUTED → VERIFIED / REVERTED / FAILED)
- [x] Undo 메커니즘 (기본 10분 grace window)
- [x] Mission Timeline UI (타임라인 + 인간 개입 인라인)

### Phase 3: 도메인 에이전트

- [x] FDS Rule Engine (9개 조건 연산자 + AND/OR 로직 + 가중치)
- [x] FDS Alert 라이프사이클 + Feedback Loop
- [x] AP Agent 3-way Matching (Invoice vs PO vs GR)
- [x] AP 7-상태 워크플로우

### Phase 4: Insights

- [x] FinOps What-If 시뮬레이터 (TTL/Tier/토큰예산 슬라이더)
- [x] FinOps 월말 예측 비용 + 절감 추천
- [x] 통합 Anomalies 대시보드 (FDS + Circuit + Rate + Canary)

## 6. 알려진 제한사항

- **What-If 시뮬레이터**: 현재 프론트엔드 수식 기반 (백엔드 ML 모델 필요)
- **FDS ML 스코어**: 목업 (amount 패턴 기반) — 실전용으로 별도 모델 학습 필요
- **AP OCR**: 실제 OCR 연동 없음 (시뮬레이션) — Tesseract/AWS Textract 연동 필요
- **AgentRegistry 백엔드**: UI만 존재 — 실제 에이전트 메타데이터 API 미구현

## 7. 다음 단계 권장

1. **BullMQ 워커 연동**: AutonomousOps 감지 → 조치 → 검증을 워커에서 비동기 실행
2. **SSE 엔드포인트**: `/events/stream` 구현해 `/home` Live Feed 실시간화
3. **FDS ML 훅**: `anomaly.service.mlScore()` 자리에 실제 모델 호출 연결
4. **OCR 실연동**: AP parseInvoice를 Tesseract/Textract로 교체
