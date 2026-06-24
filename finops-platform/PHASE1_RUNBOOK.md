# FinOps 통합 Phase 1 — 실행·검증 런북 (비파괴)

목표: FinOps 게이트웨이/대시보드를 metis와 **나란히** 띄우고, metis의 **gpt 경로**를 게이트웨이로 통과시켜
**실제 절감/현황이 대시보드에 도는지** 확인. (claude 경로·기존 화면 정리는 Phase 2)

---

## 0. 이번에 자동 적용된 것
- 소스: `metis-ai/finops-platform/` (게이트웨이·컨트롤플레인·시뮬·테스트에이전트)
- 배선: `metis-ai/.env` 에 `OPENAI_BASE_URL=http://localhost:8400/v1` 추가됨
  → metis의 **gpt 모델 LLM 호출이 게이트웨이를 경유**합니다.
- **통합 기동**: `start-metis.bat` 안에 FinOps 기동/종료가 **통합**됨 (상단 `set START_FINOPS=1` 토글; 0이면 metis만)
- 단독 런처(선택): `metis-ai/start-finops.bat` (FinOps만 따로 띄울 때)

## 1. 기동 순서 (이제 한 번에)
1. **`start-metis.bat` 더블클릭** — FinOps 게이트웨이(8400)+대시보드(8500)를 **먼저 자동 기동**하고
   (metis DB 설정 중에 venv가 빌드됨), 이어서 metis API/Worker/Frontend가 올라옵니다.
   - 최초 1회는 FinOps venv 설치로 1~2분 추가 소요 (Python 3.10+ 필요)
   - 종료: 런처 창에서 아무 키 → metis + FinOps(8400/8500/8600) 모두 정리
2. metis만 띄우려면 `start-metis.bat` 상단 `set "START_FINOPS=1"` → `0` 으로.

> 롤백(직결 복귀): `metis-ai/.env`의 `OPENAI_BASE_URL=...8400/v1` 줄 삭제.

> **기동 방식 = Docker** (호스트 Python 불필요). `start-metis.bat`이 `finops-platform/docker-compose.yml`로
> control-plane(8500)+gateway(8400)를 `up -d`. 최초 1회 이미지 빌드로 수 분 소요(이후 캐시).
> Docker Desktop이 실행 중이어야 합니다(이미 postgres/redis용으로 사용 중).
> **대시보드는 metis 안에 임베드**됨 → 좌측 **Insights ▸ FinOps** 메뉴(별도 :8500 접속 불필요).

## 2. 스모크 테스트 (절감/대시보드 확인)
1. metis 로그인 → **Agent 실행 → "+ Agent 등록" → 폼 등록**
   - 실행 방식 **LLM 프롬프트형**, **모델 gpt-5**(또는 gpt-4o), 프롬프트 아무거나
   - 등록 → ORB 심사·승격(테스트면 바로 승격) → 실행
   - (또는 기존 gpt 기반 워크플로우/플래너를 실행해도 됨)
2. metis 좌측 **Insights ▸ FinOps** 화면(임베드 대시보드) 확인:
   - **개요**: 비용·**절감 구성**(캐시/prefix/라우팅/스킬패커) 패널에 수치 반영
   - **개발자 뷰**: 해당 run의 스텝별 비용 워터폴
   - **운영 뷰**: 예산 게이지
   - 같은 프롬프트를 2번째 실행하면 **시맨틱 캐시 적중 → LLM 호출 스킵 → 절감액 증가**가 보이면 성공
     (단, 캐시는 "에이전트 정책" 화면에서 해당 에이전트 캐시 ON이어야 함 — 기본 OFF 안전값)

> 실제 OpenAI 키 크레딧이 없으면 게이트웨이가 **mock 폴백**으로 동작합니다.
> 이 경우에도 비용·절감 회계와 대시보드는 동일하게 채워져 **흐름 검증**이 됩니다.

## 3. 합격 기준 (Phase 1 Exit)
- [ ] metis gpt 호출이 게이트웨이 로그에 보인다
- [ ] 대시보드 개요/개발자/운영 뷰에 그 호출의 비용이 즉시 뜬다
- [ ] 동일 입력 재실행 시 캐시 적중으로 절감액이 늘어난다(캐시 ON 에이전트)
- [ ] 예산 한도(운영 뷰/budgets)를 낮게 걸면 하드컷 시 호출이 차단(429)된다

## 4. 롤백
- `metis-ai/.env` 의 `OPENAI_BASE_URL` 줄 삭제 → metis가 OpenAI 직결로 복귀
- FinOps 창 닫기(또는 `finops-platform/stop.bat`)

## 5. 알려진 한계 (Phase 2에서 처리)
- **claude 경로**는 아직 게이트웨이 미경유(메티스가 Anthropic 네이티브 `/v1/messages` 호출, 게이트웨이는 OpenAI 호환 `/v1/chat/completions`만 제공). → Phase 2에서 ⓐ 게이트웨이에 `/v1/messages` 어댑터 추가 또는 ⓑ metis가 claude도 OpenAI 포맷으로 게이트웨이에 보내도록 변경.
- 기존 metis FinOps 화면/`token-optimizer` 제거 + 대시보드 UI 임베드 = Phase 2.
- 품질 점수 → 게이트웨이 `/api/quality` 폐루프 = Phase 3.
