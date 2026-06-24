# Metis FinOps — API & Header Quick Reference

## Agent → Gateway request headers (X-Metis-*)

| Header | Meaning | Notes |
|---|---|---|
| X-Metis-Tenant | 비용 귀속 테넌트 | 한글이면 percent-encode |
| X-Metis-Project | 프로젝트 | |
| X-Metis-Agent | 에이전트 이름 | 레지스트리 키 |
| X-Metis-Agent-Version | 버전 | |
| X-Metis-Env | dev/stg/prd | |
| X-Metis-Run-Id | 실행(run) ID | run 단위 귀속·서킷브레이커 |
| X-Metis-Step | 스텝 번호 | |
| X-Metis-Task-Type | 작업 유형 | |
| X-Metis-Step-Signature | 툴 호출 시그니처 | 루프 감지용 |
| X-Metis-Data-Class | PUBLIC/INTERNAL/PII/SECRET/CUSTOMER_CONFIDENTIAL | 거버넌스 캐시 차단 |
| X-Metis-Risk-Score | 0..1 | ≥0.7 캐시 차단, ≥0.8 강등 방어(상향) |
| X-Metis-Policy-Hash | 정책 버전 해시 | 캐시 스코프(변경 시 무효화) |
| X-Metis-Cacheable | "0"이면 opt-out | 적용 여부는 중앙 레지스트리가 결정 |
| X-Metis-Force-Mock | "1" 테스트용 mock | 비용 없이 호출 |
| X-Metis-Sim-* | mock 토큰 구성 제어 | out-tokens/cache-read/cache-write/reasoning |
| X-Metis-Tools-Saved-Tokens | 스킬패커 자가신고(상한 검증됨) | 레지스트리 등록 토큰이 상한 |

## Control Plane endpoints (:8500)

- `POST /api/policy/precheck` → `{action: allow|downgrade|escalate|block, model, reasons, gate, semantic_cache, governance, tool_registry_tokens}`
- `POST /api/ingest` → 원장 적재 + counterfactual 절감 회계, returns `{cost_usd, savings_usd, savings_kind, run_total_cost}`
- `POST /api/run/end`, `POST /api/quality`, `POST /api/config_change`
- Reads: `/api/overview`, `/api/spend_series?group=&minutes=`, `/api/runs/recent|detail`,
  `/api/run_stats`, `/api/showback`, `/api/savings`, `/api/quality_cost`, `/api/alerts`,
  `/api/budgets`, `/api/policies`, `/api/agents`(+`/update`), `/api/governance`(+`/update`),
  `/api/gpu`, `/api/insights`, `/api/export/focus`
- QA proxy: `POST /api/qa/test`, `GET /api/qa/report/{id}/download?fmt=md|docx`

## Gateway (:8400)

- `POST /v1/chat/completions` — OpenAI-compatible. Response adds `.metis`:
  `{routing_action, reasons, cache_hit, cost_usd, run_total_cost_usd, provider}`
- `GET /health` → includes `cache_backend` (memory|redis) and `fail_mode` (open|closed)

## Env vars

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`,
`AZURE_OPENAI_ENDPOINT/_API_KEY/_API_VERSION/_DEPLOYMENT`, `TEST_AGENT_MODEL`,
`REDIS_URL`(optional → shared cache), `METIS_FAIL_CLOSED`(1=reject when CP down),
`LEDGER_URL`, `GATEWAY_URL`, `TEST_AGENT_URL`, `METIS_DB`, `SIM_RPS`, `SIM_USE_REAL_API`.

## Savings kinds (counterfactual accounting)

`semantic_cache` (full-response cache hit), `prompt_cache` (prefix/cache_read discount),
`routing_downshift` (downgrade), `skill_packer` (tool registry tokens − sent tools).
