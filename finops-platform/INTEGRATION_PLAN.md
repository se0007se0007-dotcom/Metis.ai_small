# Metis FinOps 게이트웨이 — Metis.AI 통합 계획 (ADR)

작성 기준: 가져온 소스 `metis-ai/finops-platform/` (원본 `14.FINOPS플랫폼`, FastAPI 마이크로서비스)

---

## 1. 분석 요약 — 무엇을 가져왔나

| 서비스 | 포트 | 역할 |
|---|---|---|
| **gateway** | 8400 | OpenAI 호환 LLM 프록시. 모든 LLM 호출을 가로채 **precheck(허용/강등/차단) → 캐시 → 라우팅 → 실제 호출 → 원장 적재**. 토큰 5종 계측 |
| **control_plane** | 8500 | SQLite 원장 + **6종 대시보드** + 정책 precheck API + pricing/intelligence. 테스트에이전트 프록시 |
| simulator | - | 부하 시뮬레이터(기본 mock) |
| test_agent | 8600 | 데모 에이전트(코드리뷰), control_plane이 프록시 |

**핵심 — 이미 거버넌스 인지형으로 설계됨 (Metis와 정합):**
- 캐시 키가 `tenant + model + policy_hash + data_class` 스코프 → Metis "정책결합 캐시키"와 동일 개념. **교차 테넌트 노출 방지**, 정책 미검증 시 **fail-closed(캐시 미제공)**.
- **시맨틱 캐시 = 중앙 레지스트리가 결정**(에이전트별 토글). 클라이언트는 opt-out만, 임의 opt-in 불가.
- **3티어 강등 = 품질 게이트 통과 후에만**(최근 7일 품질 실적 검사 → 승인/카나리/보류).
- **counterfactual 절감 회계** — 캐시·prefix·라우팅·스킬패커 4종 메커니즘별 절감액 정량화.

**gateway → control_plane 연동점**: `POST /api/policy/precheck`(호출 전), `POST /api/ingest`(호출 후 usage 적재).
**대시보드 API**: overview·spend_series·showback·savings·quality_cost·budgets·agents·governance·gpu·forecast·whatif·recommendations·anomalies·quality_guard·model_prices·insights·FOCUS export.

---

## 2. 통합 아키텍처 — "게이트웨이 = LLM egress, SDK = 거버넌스 트레이스"

```
          ┌──────────── Metis.AI (NestJS/Next) ────────────┐
 내부 실행 │  ai-analysis executor / worker llm-client       │
 (워크플로) │     │  OPENAI_BASE_URL = http://gateway:8400/v1  │
          └─────┼───────────────────────────────────────────┘
                ▼
외부 SDK Agent ─► [ FinOps Gateway :8400 ] ──► Azure/OpenAI/Anthropic/사내 QWEN
 (base_url=게이트웨이)      │  precheck·캐시·라우팅·계측
                          ▼
                   [ Control-Plane :8500 ] 원장 + 대시보드(현황/절감/예산)
                          ▲
 Metis governance ────────┘  (품질 점수 → /api/quality 로 폐루프; 트레이스는 기존 /ingest 유지)
```

- **LLM 호출 경로(신규)**: 내부·외부 Agent의 실제 모델 호출이 게이트웨이를 통과 → **실시간 예산 차단·캐시·라우팅 = 진짜 절감**.
- **거버넌스 트레이스(기존 유지)**: Agent는 실행 결과를 Metis `/ingest/runs`로 계속 전송 → 품질·보안·이상 5-게이트. **게이트웨이와 대체 아님, 보완.**
- **품질 폐루프**: Metis가 산출한 품질 점수를 게이트웨이 control_plane `/api/quality`로 흘려보내면, "품질 게이트 통과 후 강등"이 Metis 품질 기준으로 동작.

---

## 3. 단계별 계획 (Phase)

**Phase 1 — 나란히 띄우고 배선 (비파괴, 테스트 가능)**  ← 다음 실행 대상
1. `finops-platform`를 metis 기동에 합류 (docker-compose 또는 start-metis.bat에 2서비스 추가).
2. metis `.env`의 `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` → 게이트웨이(`http://localhost:8400/v1`)로 변경.
3. 게이트웨이 `.env`에 실제 프로바이더 키 설정(metis와 공유). 키 없으면 mock 폴백.
4. 스모크 테스트: Agent 1건 실행 → 게이트웨이 로그에 통과 + control_plane 대시보드(:8500)에 비용·절감 반영 확인.

**Phase 2 — UI 통합 + 기존 FinOps 정리 (확인 후 진행, 일부 파괴적)**
5. control_plane 대시보드(:8500)를 metis UI에 **iframe 임베드**(Insights > FinOps 자리) 또는 핵심 API를 metis가 프록시해 재구성.
6. 기존 metis FinOps **제거 대상**: 화면 `insights/finops`·`insights/finops-lab`·`insights/finops-demo`·`governance/finops-lab`, 백엔드 실행기 내 `token-optimizer`(게이트웨이가 대체) — **단, 런타임 거버넌스가 참조하는 부분은 잔존 확인 후 제거**.
7. SDK 가이드/연동설정 모달에 "게이트웨이 base_url" 안내 추가.

**Phase 3 — 폐루프·운영화**
8. Metis 품질 점수 → control_plane `/api/quality` 연동(품질 게이트 실데이터화).
9. 사내망/AKS 배포 통합(`finops-platform/deploy/k8s` + Nexus pip.conf 반영).

---

## 4. 통합 전 점검 (앞서 말한 리스크 ↔ 실제 코드 대조)

| 점검 항목 | 상태 | 비고 |
|---|---|---|
| 거버넌스 컨텍스트(policyHash·dataClass) 캐시 반영 | **이미 됨** | 캐시 키에 tenant·policy_hash·data_class 포함, fail-closed |
| 캐시 교차 테넌트 노출 | **차단됨** | tenant 스코프 격리 |
| 품질 무시 강등(품질 저하) | **방지됨** | 품질 게이트 통과 후에만 강등(승인/카나리/보류) |
| 단일 장애점(SPOF) | **대응 필요** | 게이트웨이 다운 시 LLM 중단 → HA(레플리카)+Redis 캐시 공유+폴백(직접 호출) 정책 필요 |
| 폐쇄망 경로/인증 | **부분 준비** | Azure/사내 QWEN 라우팅 env 있음, Nexus pip.conf 예시 포함 |
| 인증 분리 | **설계 필요** | 게이트웨이 호출 인증 vs Metis Ingest 키 역할 분리 |
| 특허 정합성 | **점검 필요** | 정책결합 캐시키/라우팅 로직이 게이트웨이로 이동 → 청구범위·구현 위치 재정리 |
| 스택 이질성(Python vs Node) | **수용** | 게이트웨이는 OpenAI 호환 HTTP라 언어 무관. 재작성 불필요, 사이드카로 운영 |

---

## 5. 실행/테스트 방법 (Phase 1 기준, 단독 먼저)

```bash
# (단독 검증) finops-platform 폴더에서
copy .env.example .env      # 키 입력(없으면 mock)
docker compose up --build
#  대시보드 http://localhost:8500 / 게이트웨이 http://localhost:8400/v1/chat/completions

# (metis 연동) metis-ai/.env 에 추가
OPENAI_BASE_URL=http://localhost:8400/v1
ANTHROPIC_BASE_URL=http://localhost:8400/v1
#  → metis Agent 실행 시 모든 LLM 호출이 게이트웨이 경유 → :8500 대시보드에 비용/절감 반영
```

---

## 6. 자가 검토

- **Principal Engineer**: 게이트웨이가 OpenAI 호환이라 metis 코드 변경 최소(주로 env). 재작성 없이 사이드카 운영이 합리적. 리스크는 SPOF·폐쇄망 egress — Phase 1은 비파괴라 안전, Phase 2 제거는 런타임거버넌스 의존성 확인 후.
- **Security/Governance**: 캐시가 이미 tenant·policy 스코프 + fail-closed라 교차노출/정책우회 위험 낮음. 단 게이트웨이가 LLM 평문·키를 다루므로 망분리·시크릿 관리(K8s secret/Nexus) 필수. 인증 분리 설계 필요.
- **SaaS Ops**: 단일 egress = 현황·예산 일원화 큰 이점. 대신 게이트웨이 HA/관측 필요(레플리카+Redis 캐시공유 옵션 이미 있음). 롤백 = env 원복으로 즉시 직접호출 복귀 가능.

---

## 7. 다음 단계 (확인 요청)

Phase 1(비파괴: 나란히 띄우고 metis egress를 게이트웨이로 배선 + 스모크테스트)부터 진행할지,
아니면 Phase 2의 기존 FinOps 화면 제거까지 한 번에 갈지 결정해 주세요.
**권장: Phase 1 먼저** — 실제 절감/대시보드 동작을 확인한 뒤 기존 화면을 정리하는 것이 안전합니다.
