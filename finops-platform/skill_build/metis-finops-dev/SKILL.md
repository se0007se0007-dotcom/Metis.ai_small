---
name: metis-finops-dev
description: >
  Continue developing the Metis FinOps platform — a standalone, vendor-neutral
  Agent FinOps solution (OpenAI-compatible gateway + control plane + dashboards)
  with a governance-fusion differentiation engine (Patent 3). Use this skill when
  working on the codebase at C:\Users\se000\14.FINOPS플랫폼 (GitHub:
  se0007se0007-dotcom/finops): adding features, fixing bugs, extending the
  cost ledger / policy engine / governance / dashboards / test agent, or
  preparing the AKS/Nexus deployment. Encodes the architecture, conventions,
  hard-won gotchas, test commands, and roadmap so a fresh agent can be productive
  immediately. Triggers: "FinOps platform", "Metis FinOps", "agent cost governance",
  "거버넌스 융합", "cost gateway", or any work inside the 14.FINOPS플랫폼 folder.
---

# Metis FinOps — Development Continuation Skill

You are continuing development of **Metis FinOps**, an Agent FinOps platform built
by ktds OPS.AI. Read this file fully before making changes. The actual code lives at
`C:\Users\se000\14.FINOPS플랫폼` (and on GitHub at `se0007se0007-dotcom/finops`).
This skill is the operating manual; the repo is the source of truth.

## 1. What this product is (and its strategy)

A **standalone, vendor-neutral FinOps gateway + control plane** that any LLM agent
(on Azure, AWS, or local; any framework) can route through by changing its OpenAI
base URL — no code integration required. It measures, controls, and optimizes
agent LLM spend in real time, and **fuses cost optimization with governance**
(data-class / risk / policy-hash) — the patentable differentiator.

Strategic thesis (from the comparison report vs. the in-platform metis-ai FinOps):
- **Product surface** = this standalone platform (vendor-neutral, runtime control,
  savings accounting, multi-persona UX, deployment packaging).
- **Differentiation engine** = governance fusion ("Patent 3"): cache reuse and model
  routing decided by data classification + risk score + policy hash, so cost savings
  never leak sensitive data or downgrade high-risk work. No pure cost router can copy this.
- Sellable as **on-prem/BYOC first** (kt/finance/public, network-isolated), then SaaS.
  See `EDITIONS.md`.

## 2. Architecture (4 services)

```
Agent (any) ──OpenAI-compatible──> Gateway(:8400) ──precheck/ingest──> Control Plane(:8500)
                                       │                                    │ SQLite ledger
                                       └─ provider call (OpenAI/Azure/      │ policy engine
                                          Anthropic/mock)                   │ governance (Patent 3)
                                                                            │ dashboards (single port)
Test-Report Agent(:8600) ── proxied via :8500 /api/qa/* (native dashboard view)
Simulator ── generates demo traffic (PII, high-risk, runaway, config-change)
```

- **Gateway** (`services/gateway/`): OpenAI-compatible proxy. Reads `X-Metis-*` headers
  (tenant/agent/run/step/data_class/risk_score/policy_hash), calls control-plane
  `precheck` (allow/downgrade/escalate/block), governance-aware semantic cache
  (Redis if `REDIS_URL` else in-memory), provider dispatch, emits usage to ledger.
  `METIS_FAIL_CLOSED=1` rejects requests if control plane is down (cache always fail-closed).
- **Control Plane** (`services/control_plane/`): SQLite cost ledger (5 token types),
  attribution tenant→agent→run→step, budgets (3-tier: soft→downgrade→hard), run-level
  circuit breaker + loop detection, quality-gated tier downgrade (approved/canary/rejected),
  counterfactual savings accounting (4 kinds), governance fusion, FOCUS 1.3 export,
  GPU pool sim, all aggregation APIs, and serves the dashboard (static/) + QA proxy.
- **Test-Report Agent** (`services/test_agent/`): real demo agent — uploads Python/Java/C,
  runs static + dynamic (compile/exec) analysis + 3-step LLM review (via gateway),
  produces a Word(.docx, charts) + .md report. Reached through the dashboard (no separate port for the user).
- **Simulator** (`services/simulator/sim.py`): synthetic agent traffic. Tenants:
  CRM사업팀 / AI혁신지원센터 / kt / ICT AX사업팀 / 오픈채널서비스팀.

Dashboard personas (single port :8500): 개요(관제) / 에이전트 정책 / 개발자 / 운영 / 재무 /
거버넌스 / 인사이트 + 테스트 에이전트(임베드).

## 3. The governance fusion (Patent 3) — the crown jewel

Implemented in `control_plane/app.py` (`cache_policy_decision`, `precheck` governance
branch) + `pricing.py` (`escalate_to_tier`) + gateway (governance-aware `cache_key`,
cache gating, header parsing). Three mechanisms:
1. **Cache policy decision**: data_class in {PII, SECRET, CUSTOMER_CONFIDENTIAL} or
   risk_score ≥ high_threshold → DENY cache reuse (no lookup, no store).
2. **Policy-hash-scoped cache key**: `tenant|policy_hash|data_class|model|<msgs>` —
   changing policy_hash invalidates old cache automatically. Tenant-isolated.
3. **Risk escalation**: risk_score ≥ escalate_threshold → defend against budget-driven
   downgrade and raise to `safe_min_tier` (e.g. haiku→sonnet). routing_action="escalate".
Governance config table `governance_policy`. Compliance KPI = "민감 데이터 캐시 누출 0".

## 4. CRITICAL conventions & hard-won gotchas (read before editing)

1. **File location**: everything under `C:\Users\se000\14.FINOPS플랫폼`. Save final
   outputs there (this is the connected/mounted user folder).
2. **Host vs sandbox mount**: in bash the folder is `/sessions/<id>/mnt/14.FINOPS플랫폼`.
   Edit/Write/Read use the host path; bash uses the mount path.
3. **Mount sync can lag/truncate** for files just edited (observed repeatedly). If a bash
   read of a just-edited file shows truncation/`SyntaxError`/null bytes while the Read tool
   shows it correct, the HOST file is fine — the mount is stale. To run tests reliably,
   reconstruct the needed files into `/tmp/...` from Read-tool content and run there, or wait.
   Never "fix" a file based only on a truncated mount read.
4. **Korean in HTTP headers**: non-ASCII header values MUST be percent-encoded
   (`urllib.parse.quote`) by clients and decoded (`unquote`) in the gateway. ASCII-only
   for .bat files (Korean Windows is CP949 — emit ASCII in run.bat/stop.bat/push bat).
5. **SQLite schema changes**: `CREATE TABLE IF NOT EXISTS` does NOT alter existing tables.
   Add new columns to the `MIGRATIONS` dict in `db.py` (auto `ALTER TABLE ADD COLUMN` on
   startup) — and `db.ex()` self-heals (migrate+retry on "no column" error). Always do this
   for new ledger columns, or existing user DBs throw 500s on ingest.
6. **Running process != edited file**: a server started before your edit keeps old code in
   memory. Tell the user to restart (stop.bat → run.bat) after schema/logic changes.
7. **Secrets**: `.env` holds real API keys and is git-ignored (`.gitignore` excludes
   `.env`, `*.key`, `~$*.docx`, etc.). `push_to_github.bat` scans staged files for key
   patterns (`sk-ant-api`, `sk-proj-`) and aborts on match. NEVER commit `.env`. The keys
   were handled in plaintext during dev — recommend rotation before production (SECURITY.md).
8. **Output format skills**: for .docx/.xlsx/.pptx/.pdf deliverables, read the corresponding
   skill's SKILL.md AFTER gathering content, then build. Reports here use docx-js + matplotlib
   (Korean font: 맑은 고딕; set East-Asian font via `get_or_add_rPr().get_or_add_rFonts()`).
9. **Models**: GPT-5 generation is current (`gpt-5`/`gpt-5-mini`/`gpt-5-nano`), Claude
   opus-4-8/sonnet-4-6/haiku-4-5, self-host qwen3-72b-local/llama4-scout-local. Legacy
   gpt-4o* kept only for back-compat in the price table. When building UPGRADE_MAP, exclude
   `gpt-4o*` keys (they pollute the reverse map — a real bug we fixed).
10. **Provider keys**: OpenAI key is currently `insufficient_quota` (no credit); Anthropic
    works. `TEST_AGENT_MODEL` defaults to a Claude model. Azure routing kicks in when
    `AZURE_OPENAI_ENDPOINT`+`AZURE_OPENAI_API_KEY` are set (gateway prefers Azure for gpt*).

## 5. How to run & test

- **Run (Windows, no Docker)**: `run.bat` (creates venv, installs, starts 4 services,
  opens http://localhost:8500). `stop.bat` to stop. `requirements.txt` = fastapi, uvicorn,
  httpx, pydantic, python-docx, matplotlib, redis(optional).
- **Run (Docker)**: `docker compose up --build`.
- **Tests**:
  - `python tests/e2e.py` — full E2E (25+ scenarios: ledger, caching, savings, circuit
    breaker, quality gate, governance G1–G5, FOCUS export). Spawns control-plane+gateway
    as subprocesses, uses mock provider (`X-Metis-Force-Mock: 1`).
  - `python tests/governance_unit.py` — fast pure-logic unit tests (escalation, cache
    policy, cache-key isolation) with no services.
  - In the sandbox, prefer reconstructing to /tmp if the mount is flaky (see gotcha #3).
- **Always add a verification step** (run e2e or unit tests) after non-trivial changes.

## 6. File map

```
services/control_plane/
  app.py        # FastAPI: precheck, ingest, governance, all aggregation APIs, QA proxy, static mount
  db.py         # SQLite schema + MIGRATIONS + seeds (tenants/agents/policies/governance)
  pricing.py    # price table, DOWNGRADE_MAP/UPGRADE_MAP, tiers, escalate_to_tier, cost fns
  static/       # dashboard: index.html, app.js, style.css, vendor/ (Chart.js, marked — local, offline-safe)
services/gateway/
  app.py        # OpenAI-compatible proxy, CacheBackend (redis/mem), governance gating, FAIL_CLOSED
  providers.py  # OpenAI / Azure / Anthropic (auto cache_control) / mock dispatch, .env loader
services/test_agent/
  app.py        # /api/test, /api/report/{id}/download (md|docx), report retention(50)
  analyzers.py  # Python(AST+exec) / Java(javac) / C(gcc) static+dynamic analysis
  report_docx.py# docx-js-style report via python-docx + matplotlib charts
services/simulator/sim.py   # demo traffic incl. PII/high-risk/runaway/config-change
tests/e2e.py, tests/governance_unit.py
deploy/k8s/*.yaml           # AKS manifests (namespace, secret, control-plane+PVC, gateway, test-agent, simulator, ingress)
deploy/nexus/pip.conf.example
deploy/배포가이드_사내망_AKS.md / .html   # Nexus+AKS deployment guide
README.md, SECURITY.md, EDITIONS.md
run.bat, stop.bat, push_to_github.bat, docker-compose.yml, .env(.example), .gitignore
거버넌스융합_개발_테스트결과.html, FinOps_비교분석_특허_사업화_리포트.docx
```

## 7. Roadmap / good next features

Already built: ledger+attribution, 3-tier budgets, run circuit breaker + loop detection,
quality-gated downgrade (approved/canary/rejected), counterfactual savings (semantic/prefix/
routing/skill-packer), agent registry + central cache policy, governance fusion (Patent 3),
GPU sim, FOCUS 1.3 export, 7 dashboard personas, multilingual test agent, Azure adapter,
Redis cache option, FAIL_CLOSED, AKS/Nexus packaging, GitHub push with secret scan.

High-value next steps (from the gap analysis):
- **cost-of-pass / outcome-based unit economics** deepening (quality×cost per successful task).
- **Embedding-based semantic cache** + false-hit monitoring (port the metis-ai embedding idea).
- **Forecasting + anomaly detection** (metis-ai has monthly forecast + what-if — port it).
- **Auth/RBAC + virtual keys + audit log** (enterprise prerequisite; AAD/SSO at ingress).
- **PostgreSQL/ClickHouse** ledger (replace SQLite) for horizontal scale; Redis counters.
- **Chargeback automation** + FOCUS 1.4 AI extensions when ratified.
- **Patent filing**: combine quality-gate downgrade state machine + governance fusion as one family.

## 8. Working style here

- Use the task list (TaskCreate/TaskUpdate) for multi-step work; finish with a verification step.
- Keep the existing dashboard look (the user likes it); add new views in the same style.
- Be honest about test results; if the sandbox couldn't run something due to the mount issue,
  say so and tell the user how to run it locally.
- Deliverables the user values: working code in the folder, plus HTML/DOCX reports for results.
- The user is the ktds OPS.AI lead building Metis.AI (AgentOps platform). This FinOps platform
  is intended to become a sellable solution and to contribute to the agent era.
