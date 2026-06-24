# Metis FinOps — Agent FinOps 플랫폼 프로토타입

ktds OPS.AI / Metis.AI(AgentOps Platform)용 FinOps 플랫폼의 실행 가능한 프로토타입입니다.
설계 의견서의 5계층 아키텍처(L1 수집 → L2 원장 → L3 통제 → L4 최적화 → L5 경험) 중
핵심 차별화 기능을 실제로 동작하는 코드로 구현했습니다.

## 핵심 기능

| 계층 | 구현 내용 |
|---|---|
| L1 수집 | OpenAI 호환 게이트웨이가 모든 LLM 호출을 가로채 토큰 5종(input/output/cache_read/cache_write/reasoning) 분리 계측. 실제 OpenAI/Anthropic API 연동 + 키 없을 때 mock 폴백. GPU 풀(H100×4) 메트릭 시뮬레이션 |
| L2 원장 | tenant→project→agent→run→step 귀속 차원의 비용 원장(SQLite), 모델별 단가 마스터, FOCUS 1.3 호환 CSV export |
| L3 통제 | 일 예산 3단계(소프트캡 알림→강등→하드컷), run 단위 서킷브레이커(비용/스텝 한도), 루프 감지, **품질 게이트 통과 후에만 강등 적용**(승인/카나리/보류 3상태 — 대상 모델의 최근 7일 품질 실적 검사, 미달 시 원 모델 유지+알림, 샘플 부족 시 카나리 비율만 강등해 데이터 수집) |
| L4 최적화 | **counterfactual 절감 회계** — 시맨틱 캐시·prefix 캐시·3티어 라우팅 강등·스킬패커(툴 동적로딩) 4종 메커니즘별 절감액 정량화(개요 화면 "절감 구성" 패널) |
| L5 경험 | 페르소나별 대시보드 6종 — 개요(관제)/**에이전트 정책(레지스트리: 시맨틱 캐시 적용 여부·품질 게이트 상태·툴 레지스트리, 클릭 토글)**/개발자(run 비용 워터폴)/운영(예산 게이지·p99·GPU)/재무(쇼백·cost-of-pass·품질-비용 폐루프)/인사이트(자동 권고) |

## 운영 정책 동작 방식 (실운영 기준)

- **시맨틱 캐시 = 중앙 레지스트리가 결정**: 에이전트별 적용 여부를 "에이전트 정책" 화면에서 관리(클릭 토글).
  클라이언트 헤더로는 opt-out만 가능, 임의 opt-in 불가. 캐시 키는 테넌트 스코프로 격리(교차 노출 방지).
  미등록 에이전트는 첫 호출 시 자동 등록되며 기본값은 캐시 OFF(안전 기본값).
- **프롬프트 캐시**: OpenAI/Azure는 벤더 자동. **Anthropic은 게이트웨이가 `cache_control` 마커를 자동 주입**
  (시스템 프롬프트 + 멀티턴 대화의 마지막 메시지 → 다음 턴 prefix 재사용).
- **3티어 강등 = 품질 게이트 통과 후에만**: 강등 후보 발생 시 대상 모델의 최근 7일 품질 실적을 검사.
  승인(샘플≥10·품질≥기준)→강등 적용 / 카나리(샘플 부족)→10%만 강등하며 데이터 수집 / 보류(품질 미달)→원 모델 유지+알림.
- **스킬패커 = 게이트웨이 실측**: 레지스트리에 등록된 전체 툴 스키마 토큰 대비 실제 전송된 `tools` 토큰의 차이를
  게이트웨이가 계산. 클라이언트 자가신고는 레지스트리 등록값을 상한으로만 인정(과대신고 방지).

## 실행 방법

### 방법 A — Docker Compose (권장, 실전형)
```bash
copy .env.example .env     # 필요 시 API 키 입력
docker compose up --build
```

### 방법 B — Docker 없이 (Python 3.10+)
`run.bat` 더블클릭. (가상환경 생성 → 의존성 설치 → 3개 서비스 기동 → 브라우저 자동 오픈)

### 접속
- **FinOps 대시보드**: http://localhost:8500
- **Test-Report Agent (실동작 데모 에이전트)**: http://localhost:8600
- 게이트웨이(OpenAI 호환): http://localhost:8400/v1/chat/completions

## Test-Report Agent — 실제 동작하는 데모 에이전트

**대시보드(:8500) 안에 완전 통합** — 사이드바 맨 아래 "테스트 에이전트" 메뉴를 누르면 같은 화면에서
바로 실행됩니다(별도 포트 접속 불필요). 내부적으로는 control plane 이 :8600 워커 서비스로 중계(프록시)하는
구조라 장애 격리·확장성은 유지됩니다. 실행 직후 개요(비용·절감)/재무(쇼백·cost-of-pass)/개발자(run 워터폴)
뷰에 결과가 즉시 반영되고, "개발자 뷰에서 이 run 비용 보기" 버튼으로 바로 이동할 수 있습니다.
**Python / Java / C** 소스를 붙여넣거나 파일을 올리면:

1. **정적 분석**: Python(AST), Java(빈 catch·문자열 == 비교·Runtime.exec 등), C(strcpy/gets/sprintf·메모리 누수 등) 검출
2. **동적 테스트** (격리 실행, 시간 제한): Python은 임포트+doctest+자동 호출, Java는 javac 컴파일+main 실행,
   C는 gcc 컴파일+실행. JDK/gcc 미설치 환경에서는 정적 분석만 수행(우아한 저하)
3. **LLM 코드 리뷰 3스텝** (요약→리스크→권고) — 실 API 키 설정 시 실제 Claude/GPT 호출, **모든 호출이 Gateway 경유**
4. **상세 보고서** — 화면 표시 + **Word(.docx, 점수 차트·스텝별 비용 차트·토큰 구성 차트·표 포함)** / .md 다운로드

현재 `.env`에 실 API 키가 설정되어 있습니다(metis-ai 프로젝트에서 복사).
**OpenAI 키는 크레딧 소진(insufficient_quota) 상태여서 리뷰 모델은 Anthropic Claude(`claude-sonnet-4-6`)로 설정**했고,
실측 기준 보고서 1건당 LLM 비용은 haiku ~$0.006 / sonnet ~$0.03 수준입니다.
시뮬레이터는 `SIM_USE_REAL_API=0`(mock)으로 두어 백그라운드 트래픽이 실 비용을 쓰지 않게 했습니다.

보고서에 표시되는 Run ID 로 FinOps 대시보드 **개발자 뷰**에서 이 분석의
스텝별 비용 워터폴을 그대로 확인할 수 있습니다 — "실제 에이전트 1개가
플랫폼에 어떻게 보이는가"의 레퍼런스 구현입니다.

## Azure OpenAI 연동

`.env`에 아래를 설정하면 gpt-* / o3 모델 호출이 Azure 로 라우팅됩니다(Azure 우선):

```
AZURE_OPENAI_ENDPOINT=https://<리소스명>.openai.azure.com
AZURE_OPENAI_API_KEY=<키>
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_DEPLOYMENT=          # 비우면 모델명=배포명
```

Azure 의 실제 usage(캐시 토큰 포함)가 원장에 기록되므로 비용 귀속·예산·절감 회계가 동일하게 동작합니다.

기동 직후 시뮬레이터가 가상 에이전트 트래픽(고객상담봇·보고서·코드리뷰·이상감지)을 생성합니다.
**약 45초 후** 폭주 에이전트가 주기적으로 발생해 서킷브레이커 차단을 시연하고,
**약 3분 후** cs-relay-bot 의 라우팅이 셀프호스트 모델로 전환되는 구성 변경 이벤트가 발생해
재무 뷰의 "품질-비용 폐루프" 차트와 인사이트에서 영향 분석을 확인할 수 있습니다.

## 실제 에이전트 연동 방법

기존 에이전트의 OpenAI base URL만 게이트웨이로 바꾸고 귀속 헤더를 추가하면 됩니다:

```bash
curl http://localhost:8400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Metis-Tenant: %EA%B8%88%EC%9C%B5%EC%82%AC%EC%97%85%EB%B6%80" \
  -H "X-Metis-Agent: my-agent" \
  -H "X-Metis-Run-Id: run-001" \
  -H "X-Metis-Step: 1" \
  -H "X-Metis-Cacheable: 1" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"안녕"}]}'
```

- 한글 헤더 값은 percent-encoding(URL 인코딩)으로 전달합니다.
- `.env`에 `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`를 넣으면 해당 모델은 실제 API로 호출되고 실제 usage 가 원장에 기록됩니다(비용 발생 주의). 키가 없으면 mock 응답으로 동작합니다.
- 응답의 `metis` 필드에 호출 비용, run 누적 비용, 강등 여부가 담깁니다.
- `X-Metis-Step-Signature` 헤더에 툴 호출 시그니처를 넣으면 루프 감지가 동작합니다.

## 테스트

```bash
python tests/e2e.py
```
19개 시나리오(원장 기록, 캐시 절감 회계, 루프 차단, run 비용 한도 강등→차단,
cost-of-pass, FOCUS export 등)를 자동 검증합니다.

## 디렉토리 구조

```
├─ docker-compose.yml          # 3개 서비스 컨테이너 구성
├─ run.bat                     # Docker 없이 Windows 에서 바로 실행
├─ services/
│  ├─ control_plane/           # L2 원장 + L3 정책엔진 + L4 절감회계 + L5 API (:8500)
│  │  ├─ app.py                #   precheck/ingest/집계/인사이트/FOCUS export
│  │  ├─ db.py                 #   비용 원장 스키마 (토큰 5종, run, 예산, 정책)
│  │  ├─ pricing.py            #   단가 마스터 + 3티어 강등 맵 + counterfactual 계산
│  │  └─ static/               #   L5 대시보드 (HTML/JS/CSS, Chart.js)
│  ├─ gateway/                 # L1+L3 집행점: OpenAI 호환 프록시 (:8400)
│  │  ├─ app.py                #   precheck → 캐시 → 프로바이더 → 원장 발행
│  │  └─ providers.py          #   OpenAI / Azure OpenAI / Anthropic / mock 어댑터
│  ├─ test_agent/              # 실동작 데모 에이전트 (:8600) — 소스 업로드→테스트→보고서
│  └─ simulator/sim.py         # 가상 에이전트 트래픽 (캐시히트·폭주·품질·구성변경)
└─ tests/e2e.py                # E2E 자가 테스트 (19 시나리오)
```

## 운영 정책 기본값 (db.py 에서 수정 가능)

- 테넌트 일 예산: 금융사업부 $6/$10/$60 (소프트/강등/하드) 등
- run 정책: 예) cs-relay-bot 은 run당 $0.05·6스텝, code-review-agent 는 $0.80·20스텝
- 루프 감지: 동일 시그니처 4회 반복 시 run 중단(서킷브레이커)

## 프로토타입 한계 (실제 제품화 시 보강 포인트)

인증/RBAC 없음, SQLite 단일 노드(제품은 ClickHouse/TimescaleDB + 스트리밍),
시맨틱 캐시는 정규화 exact-match(제품은 임베딩 유사도 + false-hit 관제),
GPU 메트릭은 시뮬레이션(제품은 DCGM/vLLM/OpenCost 수집),
클라우드 청구 대사(reconciliation) 미구현, 품질 점수는 외부 입력 방식(제품은 평가 파이프라인 연동).
