# Next Steps 통합 테스트 가이드

이전 리포트에서 제시된 **5대 다음 단계**가 모두 구현되었습니다.

## 구현된 다음 단계

| 항목                                         | 상태 | 파일                                                                    |
| -------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| BullMQ 워커 연동 (AutonomousOps 비동기 실행) | ✅   | `apps/worker/src/processors/autonomous-ops-processor.ts`                |
| SSE 엔드포인트 (Home Live Feed 실시간화)     | ✅   | `apps/api/src/modules/events/` + `apps/web/src/lib/use-event-stream.ts` |
| FinOps 예측 백엔드 (What-If 실제 로직)       | ✅   | `apps/api/src/modules/finops/finops-prediction.service.ts`              |
| FDS ML 어댑터 인터페이스                     | ✅   | `apps/api/src/modules/fds/adapters/`                                    |
| OCR 어댑터 인터페이스 (AP)                   | ✅   | `apps/api/src/modules/ap-agent/adapters/`                               |

## 추가 수정 사항

| 항목                         | 내용                                         |
| ---------------------------- | -------------------------------------------- |
| `/workspaces/dev` 페이지     | 기존 SideNav에 참조되었으나 누락 → 신규 생성 |
| bus.service.ts 레이스 컨디션 | `stop()`이 `loopPromise`를 await하도록 수정  |
| 중복 escaped 경로 정리       | `apps/web/src/app/\(authenticated\)` 제거    |
| `.bak` 파일 정리             | SideBySideDiff.tsx.bak 제거                  |
| JWT Guard 쿼리 파라미터      | SSE EventSource용 `?access_token=` 허용      |

---

## 1. BullMQ 워커 (AutonomousOps 비동기 실행)

### 흐름

```
API: POST /auto-actions
  → AutonomousOpsService.executeAction()
  → Prisma 저장 (status: EXECUTED)
  → BullMQ queue.add('execute', payload)
  → EventsGateway.publish() (SSE로 Home에 즉시 표시)
  → 응답 반환

Worker (별도 프로세스):
  → Queue 'auto-actions' 소비
  → runAutonomousOpsProcessor()
  → 실제 적용 (Connector 설정 변경, 격리, 비율 조정 등)
  → Prisma 업데이트 (status: VERIFIED or FAILED)
  → ExecutionTrace 기록
```

### 테스트

```bash
# 1. 워커 실행
cd metis-ai
pnpm --filter worker dev

# 2. 자율 조치 트리거
curl -s -X POST $BASE/auto-actions \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "kind":"RATE_ADJUST",
    "targetType":"Connector",
    "targetId":"<CONN_ID>",
    "triggerReason":"지연 과다",
    "action":{"factor":0.5},
    "revertWindowSec":600
  }' | jq

# 3. 워커 로그 확인 — 다음과 비슷한 출력이 나와야 함
# [auto-ops:auto-abc123] Executing RATE_ADJUST on Connector:xyz...
# [auto-ops:auto-abc123] Verified in 127ms

# 4. BullMQ 상태 직접 조회
docker exec -it metis-redis redis-cli LLEN bull:auto-actions:completed
# → 1 이상이어야 함
```

---

## 2. SSE Live Feed

### 흐름

```
API 측:
  - GET /events/stream?access_token=<JWT>
  - Content-Type: text/event-stream
  - EventsGatewayService.publish(tenantId, event) 호출 시 즉시 전달
  - RedisBridgeService가 A2ABus + Redis pub/sub과 연결 (다중 프로세스 대응)

프론트엔드:
  - useEventStream() 훅이 자동 연결
  - 지수 백오프로 재연결 (최대 5회)
  - /home의 "실시간 피드" 섹션에 LIVE 표시
```

### 테스트

```bash
# 1. 로그인 후 액세스 토큰 획득
TOKEN_VAL=$(curl -s -X POST $BASE/auth/login \
  -d '{"email":"operator@metis.ai","password":"metis1234"}' \
  -H "Content-Type: application/json" | jq -r .accessToken)

# 2. SSE 스트림 수신 (30초간)
timeout 30 curl -N "$BASE/events/stream?access_token=$TOKEN_VAL" \
  -H "Accept: text/event-stream"

# 3. 다른 터미널에서 이벤트 발행 (PLATFORM_ADMIN 필요)
curl -s -X POST $BASE/events/publish \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"system",
    "actor":"tester",
    "summary":"테스트 이벤트",
    "severity":"info"
  }' | jq

# → 1단계 터미널에서 즉시 수신 확인

# 4. 웹 UI: /home 접속
# → 우측 "실시간 피드" 상단에 "LIVE" 녹색 점 표시
# → 자율 조치 / 미션 메시지 등 실시간 표시
```

---

## 3. FinOps What-If 예측 (백엔드)

### 새 엔드포인트

```bash
# 3.1 월말 비용 예측
curl -s $BASE/finops/predict/monthly \
  -H "Authorization: $TOKEN" | jq
# 응답:
# {
#   "currentMonthActual": 1234.56,
#   "projectedMonthTotal": 4120.80,
#   "previousMonthTotal": 3850.00,
#   "monthOverMonthPct": 7.04,
#   "daysElapsed": 9,
#   "totalDays": 30,
#   "confidence": 0.30,
#   "method": "linear_extrapolation"
# }

# 3.2 What-If 시뮬레이션
curl -s -X POST $BASE/finops/simulate \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "cacheTTLMultiplier": 2.0,
    "tierDowngrade": 3,
    "skillTokenBudgetMultiplier": 0.5
  }' | jq
# 응답에 baselineMonthlyCost, simulatedMonthlyCost, savings, savingsPct, breakdown 포함

# 3.3 추천 목록
curl -s $BASE/finops/recommendations \
  -H "Authorization: $TOKEN" | jq
# → 최대 5건의 행동 가능한 추천

# 3.4 추천 적용
curl -s -X POST $BASE/finops/recommendations/rec-001/apply \
  -H "Authorization: $TOKEN" | jq
```

### 웹 UI

`/insights/finops` → "예측" 탭 → 슬라이더로 What-If 실시간 확인. "추천" 탭에서 [적용] 버튼.

---

## 4. FDS ML 어댑터 (플러그 가능)

### 어댑터 전환

`apps/api/src/modules/fds/fds.module.ts`에서 한 줄만 변경:

```typescript
// 기본 (Heuristic)
{ provide: 'FDS_ML_ADAPTER', useClass: HeuristicMLAdapter }

// OpenAI로 전환
{ provide: 'FDS_ML_ADAPTER', useClass: OpenAIMLAdapter }

// 자체 HTTP ML 서비스
{
  provide: 'FDS_ML_ADAPTER',
  useFactory: (cfg: ConfigService) => new HttpModelAdapter({
    endpoint: cfg.get('FDS_ML_ENDPOINT'),
    modelName: 'custom-xgboost-v2',
    apiKey: cfg.get('FDS_ML_KEY'),
  }),
  inject: [ConfigService],
}
```

### 테스트

```bash
# FDS 평가 테스트 (어댑터가 호출됨)
curl -s -X POST $BASE/fds/evaluate \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "subject":{
      "accountId":"ACC-001",
      "amount": 50000000,
      "transactionCountPerHour": 15
    }
  }' | jq
# → 응답에 modelName, confidence, latencyMs 포함 (어댑터 메타)
```

---

## 5. OCR 어댑터 (AP Agent)

### 어댑터 전환

`apps/api/src/modules/ap-agent/ap-agent.module.ts`:

```typescript
// 기본 (Mock — 개발용)
{ provide: 'OCR_ADAPTER', useClass: MockOCRAdapter }

// Tesseract (오픈소스)
{ provide: 'OCR_ADAPTER', useClass: TesseractOCRAdapter }

// AWS Textract (프로덕션)
{
  provide: 'OCR_ADAPTER',
  useFactory: (cfg: ConfigService) => new TextractOCRAdapter({
    region: cfg.get('AWS_REGION'),
    accessKey: cfg.get('AWS_ACCESS_KEY_ID'),
    secretKey: cfg.get('AWS_SECRET_ACCESS_KEY'),
  }),
  inject: [ConfigService],
}
```

### 테스트

```bash
# 인보이스 OCR 파싱 (어댑터 경유)
curl -s -X POST $BASE/ap/invoices/<INV_ID>/parse \
  -H "Authorization: $TOKEN" | jq
# → parsedJson, ocrConfidence, 적용된 어댑터 정보 응답
```

---

## 6. E2E 시나리오 — 모든 다음 단계가 함께 작동

배포 롤아웃 중 비용 이상이 자동 감지되어 자율 조치 → 되돌리기까지 한 번에 검증:

```bash
# 1. 배포 미션 생성
MISSION_ID=$(curl -s -X POST $BASE/missions \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "key":"e2e-test-001",
    "title":"E2E 테스트 배포",
    "kind":"DEPLOYMENT",
    "participants":[
      {"agent":"canary-agent","role":"rollout"},
      {"agent":"finops-agent","role":"cost-monitor"}
    ]
  }' | jq -r .id)

# 2. Home 페이지 열고 SSE 연결 확인 (브라우저)
# → /home → "실시간 피드" 우측 상단 "LIVE" 표시

# 3. 미션 시작 (A2A 버스에 메시지 발행 → SSE 즉시 전달)
curl -s -X POST $BASE/missions/$MISSION_ID/start -H "Authorization: $TOKEN"

# 4. FinOps 예측으로 비용 이상 감지 시뮬레이션
curl -s -X POST $BASE/finops/simulate \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"tierDowngrade":0}' | jq '.simulatedMonthlyCost'

# 5. 자율 조치 트리거 (BullMQ로 워커에 dispatch)
AUTO_ID=$(curl -s -X POST $BASE/auto-actions \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"missionId\":\"$MISSION_ID\",
    \"kind\":\"RATE_ADJUST\",
    \"targetType\":\"Connector\",
    \"targetId\":\"<CONN_ID>\",
    \"triggerReason\":\"비용 이상 감지\",
    \"action\":{\"factor\":0.5}
  }" | jq -r .id)
# → Home 실시간 피드에 "자율 조치: 비용 이상 감지" 즉시 표시

# 6. 워커 로그 확인 — 조치 적용 / 검증 완료

# 7. 10분 이내 되돌리기
curl -s -X POST $BASE/auto-actions/$AUTO_ID/revert -H "Authorization: $TOKEN"

# 8. 감사 추적 확인 — 전체 플로우가 하나의 correlationId로 연결
docker exec -it metis-postgres psql -U metis -d metis -c \
  "SELECT trace_json->>'event', trace_json->>'naturalSummary'
     FROM \"ExecutionTrace\"
    WHERE trace_json->>'missionId' = '$MISSION_ID'
       OR correlation_id LIKE '%$AUTO_ID%'
    ORDER BY created_at;"
```

이 하나의 시나리오가 모든 리스크 해소 + 다음 단계 기능을 동시에 검증합니다.

## 7. 아키텍처 최종 상태

```
┌─────────────────────────────────────────────────────────────────┐
│ Web (/home)                                                     │
│   ├─ useEventStream() ──SSE(/events/stream)──► API             │
│   └─ 30s polling (KPI fallback)                                │
└─────────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌────────────────────┐    ┌──────────────────────────────────────┐
│ API (NestJS)       │    │ API 내부 이벤트 흐름                  │
│   ├─ events        │    │                                      │
│   │  └─ SSE stream │◄──►│  A2ABus ─┐                          │
│   ├─ agent-kernel  │    │  AutoOps ├─► EventsGateway ─► SSE    │
│   ├─ autonomous-   │    │  FDS    ─┘       │                   │
│   │   ops (+ queue)│    │                  └─► RingBuffer (100)│
│   ├─ ap-agent      │    │                                      │
│   ├─ fds           │    │  RedisBridge ◄──► metis:events:{tid} │
│   └─ finops        │    │  (cross-process)                     │
│      └─ prediction │    └──────────────────────────────────────┘
└────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Redis (Streams + Pub/Sub + BullMQ)                             │
│  ├─ metis:mission:{tenantId}:stream   ← A2A messages           │
│  ├─ metis:events:{tenantId}            ← Cross-process events   │
│  └─ bull:auto-actions:*                ← Worker job queue       │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Worker (BullMQ)                                                 │
│   └─ auto-actions queue                                         │
│       └─ runAutonomousOpsProcessor()                            │
│           ├─ applyRemediation / Rollback / Quarantine / ...    │
│           ├─ 검증                                                │
│           └─ Prisma 업데이트 + ExecutionTrace                   │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Adapters (플러그 가능)                                           │
│  ├─ FDS: Heuristic | OpenAI | HttpModel                         │
│  └─ OCR: Mock | Tesseract | Textract                            │
└─────────────────────────────────────────────────────────────────┘
```
