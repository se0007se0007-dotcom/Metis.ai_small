# METIS.AI 전체 소스 정적 분석 리포트

**일자**: 2026-05-30
**범위**: apps/api(187 ts) · apps/web(91 ts/tsx) · apps/worker(12 ts) · packages — 약 79,000 LOC
**방법**: Prisma 스키마 전 모델 필드 ↔ 모든 create/update/upsert 호출부 대조, 프론트 null-safety/hooks/SSR 점검, 죽은 코드 탐지 (병렬 서브에이전트 2 + 직접 점검)

---

## 1. 수정 완료 (HIGH/MED)

| 심각도      | 위치                                                | 문제                                                                                     | 조치                                               |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| HIGH        | api `finops-prediction.service.ts:246`              | `executionTrace.create`가 필수 FK `executionSessionId` 누락 → 시뮬레이션마다 silent 실패 | AuditLog 기록으로 교체 (감사 이벤트의 올바른 sink) |
| HIGH        | api `finops-prediction.service.ts:473`              | 권고-적용 경로의 동일 `executionTrace.create` 누락 버그                                  | 깨진 trace 제거(상단 AuditLog가 이미 기록)         |
| HIGH        | web `knowledge/registry/page.tsx:48`                | `setInstallations(data.items)` 무방비 → items 없으면 `.filter/.map` 크래시               | `Array.isArray(data?.items) ? ... : []`            |
| HIGH        | web `knowledge/registry/page.tsx:93,98,103,188~206` | `i.packVersion.status`, `i.pack.sourceType` 등 조인 필드 무방비 접근                     | 전부 옵셔널 체이닝 + 기본값                        |
| MED         | web `knowledge/patterns/page.tsx:53`                | `data.items.forEach` (items 없을 수 있음)                                                | 가드된 `items` 변수로 순회                         |
| MED         | web `missions/[id]/page.tsx:412,428`                | `mission.participants.map/.length` 무방비                                                | `(mission.participants ?? [])`                     |
| MED         | web `orchestration/market/page.tsx:118,133`         | `JSON.parse(localStorage...)` try/catch 없음 → 손상 데이터 시 페이지 깨짐                | `readStoredWorkflows()` 안전 파서로 교체           |
| LOW         | web `insights/evaluator/page.tsx:777,896,942`       | `gatesApplied.includes/.join` 일부 무방비(형제 코드는 `?.` 사용)                         | `(ev.gatesApplied ?? [])` 일관화                   |
| LOW         | web `insights/finops/page.tsx:346`                  | `stats.hourlyTrend.length` 무방비                                                        | `stats.hourlyTrend?.length ?? 0`                   |
| (이전 세션) | api `agent-simulator.service.ts`                    | `executionStep.create` 스키마에 없는 필드 사용                                           | Phase 5에서 수정 완료                              |
| (이전 세션) | api `policy-feedback.service.ts:172`                | `updatedPolicy` 타입 `null` 고정 TS2322                                                  | Phase 5에서 수정 완료                              |
| (이전 세션) | web `governance/orb/page.tsx`                       | mandatoryChecks null `.every` 크래시 + 백엔드 형태 불일치                                | 이전 수정 완료                                     |
| (이전 세션) | web `governance/evaluation-policy/page.tsx`         | PUT에 읽기전용 `id` 포함 → 400                                                           | 이전 수정 완료                                     |

## 2. 권고만 (삭제 보류 — 에러 아님)

| 종류              | 위치                                                               | 내용                                                                                                                                               | 권고                                                                             |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 죽은 코드         | web `lib/api-hooks.ts` (1018줄)                                    | React Query 훅 레이어 전체가 어디서도 import 안 됨. 헤더에 "migration in progress"라 적혀 있으나 모든 페이지는 `api.get` 직접 호출                 | 마이그레이션 완료하거나 파일 삭제 (약 1000줄 정리)                               |
| 죽은 코드         | web `components/shared/` 7개                                       | `AIInsightCard, ActionQueue, CommandPalette, EventFeed, InspectorPanel, MetricComparisonCard, SearchToolbar` — 어디서도 import 안 됨               | 사용처 연결 또는 삭제                                                            |
| 잠재 결함(저위험) | api agent-kernel/autonomous-ops/ap-agent의 `executionTrace.create` | 존재하지 않는 placeholder `executionSessionId`('system-bus' 등) 사용 → FK 위반이나 모두 `.catch`로 감싸져 silent no-op. 감사 trace가 조용히 누락됨 | 시스템 액터용 sentinel ExecutionSession seed, 또는 FK 완화, 또는 AuditLog로 전환 |

> 죽은 코드는 런타임 에러를 내지 않으므로 이번엔 삭제하지 않았습니다(되돌리기 비용·동적 참조 누락 위험). 삭제를 원하시면 진행하겠습니다.

## 3. 점검 후 "정상" 확인

- **백엔드 Prisma 쓰기 154개 호출부**: finops-prediction 2건 외 전부 스키마 필드와 일치. 컨트롤러 36개 모두 모듈에 등록됨. EvaluatorModule은 CapabilityRegistry/WorkflowNodes/Release 모듈을 통해 transitively 로드되어 라우트 활성.
- **프론트 hooks 규칙**: early-return 앞에 hooks 배치 — 위반 없음.
- **SSR/window 접근**: login/home/TopNav/api-client/workflow-\* 모두 `typeof window/document` 가드 있음.
- **`(this.prisma as any)` 캐스트**: 생성 타입 지연 대응용 의도된 패턴 — 이슈 아님.
- **워커**(main.ts): 6개 큐, graceful shutdown, unhandledRejection/uncaughtException 핸들러 정상. AuditLog 쓰기는 모두 유효 필드.
- **`hallucationRate`**: 스키마의 (오타지만) 실제 컬럼명이고 코드가 정확히 일치 — 변경 불필요.

## 4. 자기 검토 (3-view)

- **수석 엔지니어**: silent-fail 패턴(try/catch로 삼켜진 깨진 쓰기)이 가장 위험했음 — 에러 없이 데이터만 누락되어 발견이 늦음. finops 2건을 동작하는 AuditLog로 교체해 감사 추적 복구.
- **보안/거버넌스**: 감사 trace 누락(executionTrace/finops)은 거버넌스 결함 — 수정으로 시뮬레이션·권고적용이 이제 감사 로그에 남음.
- **SaaS 운영**: 프론트 크래시 위험(레지스트리/미션/마켓)이 운영자 화면을 깨뜨릴 수 있었음 — 전부 방어 처리.
