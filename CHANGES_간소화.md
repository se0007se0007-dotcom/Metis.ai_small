# Metis.AI 간소화버전 — 변경 내역

원본 `metis-ai`를 복사해 **요건 위주로 메뉴·화면을 정리**한 버전입니다.
환경파일(`.env`, `.env.example`), 실행 스크립트(`start-metis.bat` 등), 빌드 설정은 **원본과 동일**합니다.

> 복사 시 제외: `node_modules`, `.git`, `dist`, `.next`, `.turbo`, `coverage` (재설치 필요: `pnpm install`)

---

## 1. 메뉴(SideNav) 구조 — 단순화 결과

| 그룹 | 메뉴 | 비고 |
|------|------|------|
| Home | 대시보드 | 유지 |
| Agent Execution | Agent 실행 | 탭: 현황 / 운영 / 개발 / **AI 활동 로그(신규 이동)** |
| Governance | 정책 | 유지 (하위 평가Gate·정책제안 탭 제거) |
| Governance | 성과·KPI | 유지 |
| Governance | **심사·승격** | ORB 심사 + 거버넌스 심사·승격을 **한 메뉴(탭)로 통합** |
| Governance | 런타임 거버넌스 | 유지 |
| 운영지식관리 | 지식 자산 / Agent 오류 패턴 관리 | 유지 (Knowledge Pipeline 삭제) |
| Orchestration | 워크플로우 빌더 / 템플릿 마켓 / 커넥터 관리 | 유지 (실행 모니터링 삭제 → AI 활동 로그로 통합) |
| Insights | FinOps / **Agent 품질평가/테스트** / 리스크·이상 | 평가·테스트 → 이름 변경 / Hermes Lab 삭제 |
| 시스템 | 사용자 관리 | 유지 |

**삭제된 메뉴**: AI 활동 로그(거버넌스→Agent로 이동), Evidence Pack, 커넥터 모니터링, 평가 정책, 정책 제안, Knowledge Pipeline, 실행 모니터링, Hermes Lab, Release Hub.

---

## 2. Agent 실행
- **탭 변경**: `현황 / 운영 / 개발 / AI 활동 로그` (← 기존 품질·공통, 편의 탭 삭제)
- **편의 Agent → 운영으로 이동**: `seed-agents.ts`의 `category: 'utility'` → `'operations'`, 백엔드 카테고리 필터(`dashboard.service.ts`)에서 utility 태그를 operations에 합산 (기존 DB도 즉시 반영)
- **AI 활동 로그 탭 신규**: 거버넌스의 감사 로그(`governance/audit`)를 `agent/activity`로 이동. 기간 검색 + 누가·언제·무엇을·결과 컬럼 + **25건 페이징** 그대로 보유
- **실행 이력 페이징**: `AgentCategoryView`의 실행 이력 표에 **15건/페이지** 페이징 추가

## 3. 거버넌스
- **AI 활동 로그**: Agent 실행 탭으로 이동(위 참조)
- **정책**: 유지. 하위 SubTabs(평가 Gate / 정책 제안) 제거
- **Evidence Pack**: **화면만 삭제**. ⚠️ 백엔드(`EvidencePackService`)는 **유지** — 런타임 거버넌스가 의존하므로 삭제 시 빌드 깨짐
- **성과·KPI**: 유지
- **ORB 심사 + 거버넌스 심사·승격**: **한 메뉴(심사·승격)로 통합**, 두 화면을 상단 탭으로 전환 (한 화면에서 심사·승격 진행)
- **런타임 거버넌스**: **유지**(요청). 평가 게이트(점수 측정)와 **중복 아님** — 런타임 거버넌스는 그 점수로 판정→자동 차단→후속 중단까지 실행하는 통제 엔진
- **커넥터 모니터링**: 삭제

## 4. 운영지식관리
- 지식 자산 / Agent 오류 패턴 관리: 유지
- **Knowledge Pipeline**: 삭제 (지식 아티팩트 부재로 의미 없음)

## 5. 오케스트레이션
- 워크플로우 빌더 / 템플릿 마켓 / 커넥터 관리: 유지
- **실행 모니터링**: 삭제 → Agent 실행의 **AI 활동 로그**에서 통합 확인

## 6. Insights
- **평가·테스트 → "Agent 품질평가/테스트"** 로 이름 변경 (메뉴 + 화면 제목)
- **Hermes Lab**: 삭제

## 7. Release
- Release Hub / Canary / Shadow / Replay / Promotions: **전부 삭제** (메뉴·화면)

## 8. 사용자 역할 — 6개 → 3개
- **관리자(ADMIN)** ← PLATFORM_ADMIN / TENANT_ADMIN
- **운영·개발(OPERATOR)** ← OPERATOR / DEVELOPER
- **뷰어(VIEWER)** ← VIEWER / AUDITOR (임원 등 대시보드 열람)
- SideNav `isVisible()`에서 백엔드 6역할을 3그룹으로 매핑 적용

## 9. 전체 리스트 페이징 (기본 10개)
- 공용 훅/컴포넌트 신규: `components/shared/usePagination.tsx` (`usePagination(items, 10)` + `<Pager p={…}/>`)
- `DataTable`에 페이징 내장(기본 10) → 이걸 쓰는 표 자동 적용
- 적용된 주요 데이터 목록: 사용자 관리 · 오류 패턴 · 커넥터 · 성과·KPI(Agent별) · 런타임 판정 · 정책 · ORB 심사목록 · 이상 목록 · FinOps 토큰로그 · Agent 품질평가(품질/리스크) · Agent 실행 테스트 이력 · Agent 실행 이력(15→10) · AI 활동 로그(25→10)
- 데이터/필터 변경 시 1페이지로 자동 복귀. 3~4행짜리 요약표는 의도적으로 제외.

## 10. 실제 Agent 연동 설정 (TopNav 우측 상단, 관리자 전용)
- `components/shell/IngestConnectModal.tsx` 신규 + TopNav에 "연동 설정" 버튼
- 기능: ① Ingest API Key 발급(`POST /ingest/keys`, 평문 1회 표시) ② 발급 키 목록(`GET /ingest/keys`) ③ 발급 키가 박힌 Python SDK 연결 스니펫(복사) ④ 빠른 테스트(`POST /ingest/test-run`)로 input/output 즉시 평가
- 외부 Agent base_url = `http://localhost:4000` (web은 `/api`→`/v1` 프록시 경유). 백엔드 권한(TENANT_ADMIN/PLATFORM_ADMIN)과 버튼 노출 조건 일치 확인.
- 정식 거버넌스 경로(워크플로우 등록→ORB 심사·승격)는 기존 `심사·승격` 화면 사용.

## 11. Agent 빠른 등록 (Agent 실행 우측 상단 "+ Agent 등록")
- `components/shared/AgentRegisterModal.tsx` 신규 + `agent/layout.tsx` 헤더에 버튼(전 Agent 탭 공통)
- 실행 방식 3종 → 최소 워크플로우 노드 자동 구성:
  - **LLM 프롬프트형**: 시스템 프롬프트 + 모델 → `ai-processing` 노드 (Metis가 직접 실행)
  - **외부 엔드포인트형**: URL + 인증 헤더 → `api-call` 노드 (Metis가 외부 호출)
  - **SDK 트레이스형**: `passthrough` 노드 + external 표시 (외부 로컬 실행, 연동설정에서 키 발급)
- 흐름: `POST /workflows`(최소 노드 + `[카테고리, quick-register, mode:*]` 태그) → `POST /orb/governance-reviews`(임시등록) → **ORB 심사·승격 통과 시 "Agent 실행" 목록에 노출**
- 권한 보강: `POST /workflows`·`/orb/governance-reviews` @Roles에 관리자(TENANT_ADMIN/PLATFORM_ADMIN) 추가 → 등록 버튼 노출 역할 전부 등록 가능
- 비고: 빠른 등록은 최소 노드만 만들고, 상세 분기·정책은 `워크플로우 빌더`에서 보강 가능. 노드 config가 스키마 검증에 미달하면 모달에 오류 표시(안전).
- **YAML/매니페스트 탭 추가**: 폼 등록 외에 "YAML/매니페스트" 탭에서 **표준 예시 템플릿**(내장)을 붙여넣거나 `.yaml/.yml` 파일 업로드로 등록 가능. 의존성 없는 경량 파서로 평면 매니페스트(name·mode·category·model/prompt·endpoint…)를 읽어 폼과 동일한 경로(POST /workflows → ORB)로 등록. 개발/대량/CI 친화. (기존 pack import는 URL 소스 방식이라 별개로 백엔드에 보존)

---

## 삭제 화면 처리 방식 (중요)
이 작업 환경에서는 파일 영구 삭제(`rm`)가 차단되어, 삭제 대상 화면 폴더를
앱 라우팅 밖의 **`_removed_screens/`** 로 이동했습니다. (Next.js는 `app/` 밖을 라우팅하지 않으므로 메뉴/화면에서 제거된 상태)
→ 완전 삭제를 원하면 본인 PC에서 `metis간소화버전/_removed_screens/` 폴더를 삭제하세요.

## 백엔드 보존 안내
프론트(메뉴·화면) 중심으로 정리했고, **NestJS 백엔드 모듈은 빌드 안정성을 위해 보존**했습니다.
(미연결 = 미노출. 예: Evidence Pack·Release·Connector 모니터링 백엔드는 남아있으나 화면 없음)

## 남은 권장 작업 (선택)
1. **역할 enum 정식 축소**: Prisma `Role` enum을 3개로 줄이려면 마이그레이션 + 전 코드 350+ 참조 수정 필요 (현재는 UI 매핑으로 3그룹 표현)
2. 미사용 백엔드 모듈(Release/Connector 모니터링 등) 정식 제거 — `app.module.ts`에서 import 해제 후 빌드 확인
3. `_removed_screens/` 영구 삭제
4. 다른 긴 목록(ORB 심사 목록, 지식 자산 등) 추가 페이징
5. `pnpm install` 후 `tsc`/빌드로 최종 확인
