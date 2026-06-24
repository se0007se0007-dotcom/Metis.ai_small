"""Metis FinOps Control Plane.

역할 (설계서의 L2 원장 + L3 통제 + L4 절감회계 + L5 API):
  - 비용 원장 적재(ingest) 및 단가 계산, counterfactual 절감 회계
  - 사전 정책 체크(precheck): 예산 강등/차단, run 서킷브레이커, 루프 감지,
    복잡도 기반 경제모델 라우팅(metis-ai 라우터 이식), 거버넌스 융합(Patent 3)
  - 지능 계층(metis-ai 이식): 월말 예측·What-if·자동 권고·이상감지 5종·품질 가드레일
  - 모델 단가 런타임 관리(model_prices), FOCUS 1.4 호환 CSV export (x_ 토큰 확장)
  - 대시보드 집계 API, GPU 메트릭 시뮬레이션(셀프호스트 H100 풀)
"""
import csv
import io
import math
import os
import random
import threading
import time

import httpx
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import intelligence
import pricing

app = FastAPI(title="Metis FinOps Control Plane")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

START_TS = time.time()

# 모델 단가 런타임 오버레이 로드 (model_prices 테이블 → pricing)
pricing.load_runtime(db.q("SELECT * FROM model_prices"))


# ---------------------------------------------------------------- models
class Ctx(BaseModel):
    tenant: str = "unknown"
    project: str = "default"
    agent: str = "unknown"
    agent_version: str = "v1"
    env: str = "prd"
    run_id: str = ""
    step: int = 0
    task_type: str = "general"
    step_signature: str = ""
    # 거버넌스 융합 (Patent 3): 데이터 등급 · 리스크 점수 · 정책 해시
    data_class: str = "INTERNAL"   # PUBLIC | INTERNAL | PII | SECRET | CUSTOMER_CONFIDENTIAL
    risk_score: float = 0.0        # 0..1 (노드 위험도 — 플랫폼 거버넌스가 산정)
    policy_hash: str = ""          # 적용 정책 버전 해시 (변경 시 캐시 무효화)


class PrecheckReq(BaseModel):
    ctx: Ctx
    model: str
    est_input_tokens: int = 0
    complexity: float | None = None   # 게이트웨이 산정 프롬프트 복잡도 (0..1)


class IngestReq(BaseModel):
    ctx: Ctx
    provider: str = "mock"
    model: str
    requested_model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    latency_ms: float = 0
    status: str = "ok"
    routing_action: str = "none"
    cache_hit: bool = False
    cached_cost_usd: float = 0.0   # 시맨틱 캐시 히트 시 회피된 원 비용
    tools_saved_tokens: int = 0    # 스킬패커(툴 스키마 동적로딩)로 절약된 입력 토큰
    cache_decision: str = "ALLOW"  # 거버넌스 캐시 판정
    gov_action: str = "none"       # 거버넌스 라우팅 조정 (risk_escalate 등)


class RunEndReq(BaseModel):
    run_id: str
    status: str = "success"          # success | failure


class QualityReq(BaseModel):
    run_id: str
    score: float
    passed: bool


# ---------------------------------------------------------------- helpers
def ensure_run(ctx: Ctx):
    if not ctx.run_id:
        return
    rows = db.q("SELECT run_id FROM runs WHERE run_id=?", (ctx.run_id,))
    if not rows:
        db.ex("INSERT OR IGNORE INTO runs(run_id,tenant,project,agent,agent_version,started) VALUES(?,?,?,?,?,?)",
              (ctx.run_id, ctx.tenant, ctx.project, ctx.agent, ctx.agent_version, time.time()))


def spend_since(scope_type: str, scope_id: str, since: float) -> float:
    col = "tenant" if scope_type == "tenant" else "agent"
    rows = db.q(f"SELECT COALESCE(SUM(cost_usd),0) s FROM calls WHERE {col}=? AND ts>=?", (scope_id, since))
    return rows[0]["s"] or 0.0


def get_policy(agent: str) -> dict:
    rows = db.q("SELECT * FROM run_policies WHERE agent=?", (agent,))
    if rows:
        return rows[0]
    return {"agent": agent, "max_cost_per_run": 0.50, "max_steps": 30, "loop_threshold": 4, "downgrade_ratio": 0.7}


def get_agent_cfg(agent: str) -> dict:
    """에이전트 레지스트리 조회 — 미등록 에이전트는 안전 기본값(시맨틱 캐시 OFF)으로 자동 등록."""
    rows = db.q("SELECT * FROM agents WHERE agent=?", (agent,))
    if rows:
        return rows[0]
    db.ex("INSERT OR IGNORE INTO agents(agent, description) VALUES(?, ?)",
          (agent, "자동 등록 (정책 미검토 — 시맨틱 캐시 OFF 기본)"))
    return db.q("SELECT * FROM agents WHERE agent=?", (agent,))[0]


def quality_gate(agent: str, cfg: dict, target_model: str) -> dict:
    """강등 대상 모델의 품질 게이트 판정.

    approved : 대상 모델 최근 품질이 기준 이상 → 강등 허용
    canary   : 샘플 부족 → canary_ratio 비율만 강등(품질 데이터 수집)
    rejected : 품질 기준 미달 → 강등 보류(원 모델 유지)
    """
    since = time.time() - 7 * 24 * 3600
    s = db.q("""SELECT COUNT(*) n, AVG(r.quality_score) q FROM runs r
                WHERE r.agent=? AND r.quality_score IS NOT NULL AND r.started>=?
                  AND EXISTS (SELECT 1 FROM calls c WHERE c.run_id=r.run_id AND c.model=?)""",
             (agent, since, target_model))[0]
    n, q = s["n"] or 0, s["q"]
    if n >= cfg["gate_min_samples"]:
        if q is not None and q >= cfg["gate_min_quality"]:
            return {"status": "approved", "samples": n, "avg_quality": q}
        return {"status": "rejected", "samples": n, "avg_quality": q}
    return {"status": "canary", "samples": n, "avg_quality": q}


def get_governance() -> dict:
    rows = db.q("SELECT * FROM governance_policy WHERE id=1")
    if rows:
        return rows[0]
    return {"sensitive_classes": "PII,SECRET,CUSTOMER_CONFIDENTIAL", "high_risk_threshold": 0.7,
            "escalate_risk_threshold": 0.8, "safe_min_tier": "standard", "enabled": 1}


def cache_policy_decision(gov: dict, data_class: str, risk_score: float) -> dict:
    """Patent 3 — 거버넌스 인지형 캐시 판정.

    비용이 아니라 '정책'으로 캐시 재사용 가능성을 판단한다:
      DENY_SENSITIVE_DATA — PII/기밀 prompt 는 재사용 금지
      DENY_HIGH_RISK      — riskScore >= 임계 노드는 재사용 금지
      ALLOW               — 그 외 (단, 게이트웨이가 policy_hash 스코프로 조회)
    """
    if not gov.get("enabled"):
        return {"decision": "ALLOW", "cache_allowed": True, "reason": "거버넌스 비활성"}
    sensitive = [c.strip() for c in (gov.get("sensitive_classes") or "").split(",") if c.strip()]
    if data_class in sensitive:
        return {"decision": "DENY_SENSITIVE_DATA", "cache_allowed": False,
                "reason": f"데이터 등급 {data_class} — 캐시 재사용 금지"}
    if risk_score >= (gov.get("high_risk_threshold") or 0.7):
        return {"decision": "DENY_HIGH_RISK", "cache_allowed": False,
                "reason": f"리스크 {risk_score:.2f} ≥ {gov.get('high_risk_threshold')} — 캐시 재사용 금지"}
    return {"decision": "ALLOW", "cache_allowed": True, "reason": "캐시 재사용 허용"}


_gov_alerted: dict = {}


def gov_alert_once(agent: str, kind: str, severity: str, msg: str):
    key = f"{agent}:{kind}"
    now = time.time()
    if now - _gov_alerted.get(key, 0) > 1800:
        _gov_alerted[key] = now
        db.add_alert(severity, "governance", f"agent:{agent}", msg)


_gate_alerted: dict = {}


def gate_alert_once(agent: str, target: str, gate: dict):
    key = f"{agent}:{target}:{gate['status']}"
    now = time.time()
    if now - _gate_alerted.get(key, 0) > 3600:
        _gate_alerted[key] = now
        if gate["status"] == "rejected":
            db.add_alert("warning", "quality_gate", f"agent:{agent}",
                         f"[품질게이트] {agent} 강등 보류 — {target} 평균 품질 {gate['avg_quality']:.2f} < 기준 (샘플 {gate['samples']}건)")
        elif gate["status"] == "canary":
            db.add_alert("info", "quality_gate", f"agent:{agent}",
                         f"[품질게이트] {agent} → {target} 강등 후보: 품질 샘플 {gate['samples']}건 — 카나리 수집 중")


# ---------------------------------------------------------------- L3: precheck (통제)
@app.post("/api/policy/precheck")
def precheck(req: PrecheckReq):
    ctx, reasons, action = req.ctx, [], "allow"
    ensure_run(ctx)
    pol = get_policy(ctx.agent)

    run = db.q("SELECT * FROM runs WHERE run_id=?", (ctx.run_id,))
    run = run[0] if run else None

    # 1) 이미 차단된 run
    if run and run["status"] == "killed":
        return {"action": "block", "reasons": [f"run 차단됨: {run['kill_reason']}"], "model": req.model}

    # 2) 루프 감지 (동일 step signature 반복)
    if run and ctx.step_signature:
        if run["last_sig"] == ctx.step_signature:
            repeat = (run["sig_repeat"] or 0) + 1
        else:
            repeat = 1
        db.ex("UPDATE runs SET last_sig=?, sig_repeat=? WHERE run_id=?", (ctx.step_signature, repeat, ctx.run_id))
        if repeat >= pol["loop_threshold"]:
            kill_run(ctx.run_id, f"루프 감지: 동일 시그니처 {repeat}회 반복")
            return {"action": "block", "reasons": [f"루프 감지({repeat}회 반복) → run 중단"], "model": req.model}

    # 3) run 서킷브레이커: 스텝 수 / 비용
    if run:
        if (run["steps"] or 0) >= pol["max_steps"]:
            kill_run(ctx.run_id, f"최대 스텝({pol['max_steps']}) 초과")
            return {"action": "block", "reasons": [f"run 최대 스텝({pol['max_steps']}) 초과 → 중단"], "model": req.model}
        rc = run["total_cost"] or 0.0
        if rc >= pol["max_cost_per_run"]:
            kill_run(ctx.run_id, f"run 비용 한도(${pol['max_cost_per_run']:.2f}) 초과")
            return {"action": "block", "reasons": [f"run 비용 한도 초과(${rc:.4f} ≥ ${pol['max_cost_per_run']:.2f}) → 중단"], "model": req.model}
        if rc >= pol["max_cost_per_run"] * pol["downgrade_ratio"]:
            action = "downgrade"
            reasons.append(f"run 비용 {rc/pol['max_cost_per_run']*100:.0f}% 도달 → 저가 모델 강등")

    # 4) 예산(테넌트/에이전트, 일 단위) — 소프트캡 알림 → 강등 → 하드컷
    today = db.day_start()
    for st, sid in (("tenant", ctx.tenant), ("agent", ctx.agent)):
        for b in db.q("SELECT * FROM budgets WHERE scope_type=? AND scope_id=? AND period='daily'", (st, sid)):
            spent = spend_since(st, sid, today)
            if b["hard_limit"] and spent >= b["hard_limit"]:
                db.add_alert("critical", "budget_hard", f"{st}:{sid}",
                             f"[하드컷] {sid} 일 예산 ${b['hard_limit']:.2f} 소진(${spent:.2f}) — 요청 차단")
                return {"action": "block", "reasons": [f"{sid} 일 하드 예산 초과"], "model": req.model}
            if b["downgrade_limit"] and spent >= b["downgrade_limit"]:
                action = "downgrade"
                reasons.append(f"{sid} 일 예산 강등 임계(${b['downgrade_limit']:.2f}) 초과 → 저가 모델 전환")
            elif b["soft_limit"] and spent >= b["soft_limit"] and (b["soft_alerted"] or 0) < today:
                db.ex("UPDATE budgets SET soft_alerted=? WHERE id=?", (time.time(), b["id"]))
                db.add_alert("warning", "budget_soft", f"{st}:{sid}",
                             f"[소프트캡] {sid} 일 지출 ${spent:.2f} — 소프트 한도 ${b['soft_limit']:.2f} 도달")

    cfg = get_agent_cfg(ctx.agent)

    # 4.5) 복잡도 기반 라우팅 (metis-ai Model Router 이식) — 레지스트리 opt-in.
    # 단순 프롬프트(복잡도 ≤ 0.3)가 상위 티어 모델을 요청하면 한 단계 강등 후보로 만든다.
    # 이후 품질 게이트·거버넌스 방어를 그대로 통과해야 실제 적용된다 (안전).
    if (action == "allow" and bool(cfg.get("complexity_routing")) and req.complexity is not None
            and req.complexity <= 0.3
            and pricing.TIER_RANK.get(pricing.tier_of(req.model), 2) >= pricing.TIER_RANK["economy"]
            and pricing.downgrade_of(req.model)):
        action = "downgrade"
        reasons.append(f"복잡도 {req.complexity:.2f} ≤ 0.3 → 경제 모델 라우팅 후보")

    # 5) 거버넌스 융합 (Patent 3) — 비용/품질 결정 위에 거버넌스 제약을 얹는다.
    gov = get_governance()
    gov_action = "none"
    cache_dec = cache_policy_decision(gov, ctx.data_class, ctx.risk_score)
    if not cache_dec["cache_allowed"] and bool(cfg["semantic_cache"]):
        gov_alert_once(ctx.agent, cache_dec["decision"], "info",
                       f"[거버넌스] {ctx.agent} 캐시 차단 — {cache_dec['reason']}")

    # 고위험 요청: 예산 압박으로 인한 강등을 '방어'하고 안전 최소 티어 이상으로 상향
    risk_escalate = (gov.get("enabled") and ctx.risk_score >= (gov.get("escalate_risk_threshold") or 0.8))

    model, gate_info = req.model, None
    if risk_escalate:
        # 비용 절감보다 거버넌스 우선 — 강등 취소 + 최소 티어 보장
        safe_model = pricing.escalate_to_tier(req.model, gov.get("safe_min_tier") or "standard")
        if action == "downgrade":
            action = "allow"
            reasons.append(f"거버넌스: 리스크 {ctx.risk_score:.2f} → 예산 강등 방어")
        if safe_model != req.model:
            model, action, gov_action = safe_model, "escalate", "risk_escalate"
            reasons.append(f"거버넌스: 고위험 → {req.model}→{safe_model} 안전티어 상향")
            gov_alert_once(ctx.agent, "risk_escalate", "warning",
                           f"[거버넌스] {ctx.agent} 고위험(리스크 {ctx.risk_score:.2f}) → {safe_model} 상향, 강등 차단")
        else:
            gov_action = "risk_hold"
    elif action == "downgrade":
        target = pricing.downgrade_of(req.model) or req.model
        if target == req.model or not cfg["downgrade_enabled"]:
            action = "allow"  # 더 내려갈 모델이 없거나 강등 비활성
        else:
            gate = quality_gate(ctx.agent, cfg, target)
            gate_info = {**gate, "target": target}
            gate_alert_once(ctx.agent, target, gate)
            if gate["status"] == "approved":
                model = target
                reasons.append(f"품질게이트 통과(평균 {gate['avg_quality']:.2f}, {gate['samples']}건) → {target} 강등 적용")
            elif gate["status"] == "canary" and random.random() < cfg["canary_ratio"]:
                model = target
                reasons.append(f"품질 샘플 부족({gate['samples']}건) → 카나리 {cfg['canary_ratio']*100:.0f}% 강등(데이터 수집)")
            else:
                action = "allow"  # 강등 보류: 원 모델 유지
                reasons.append(f"품질게이트 {('미달' if gate['status']=='rejected' else '수집중')} → 강등 보류, {req.model} 유지")

    return {"action": action, "reasons": reasons, "model": model, "gate": gate_info,
            "semantic_cache": {"enabled": bool(cfg["semantic_cache"]), "ttl": cfg["cache_ttl"]},
            "tool_registry_tokens": cfg["tool_registry_tokens"],
            "governance": {"cache_decision": cache_dec["decision"], "cache_allowed": cache_dec["cache_allowed"],
                           "cache_reason": cache_dec["reason"], "gov_action": gov_action,
                           "data_class": ctx.data_class, "risk_score": ctx.risk_score}}


def kill_run(run_id: str, reason: str):
    db.ex("UPDATE runs SET status='killed', kill_reason=?, ended=? WHERE run_id=? AND status='running'",
          (reason, time.time(), run_id))
    r = db.q("SELECT agent,tenant,total_cost FROM runs WHERE run_id=?", (run_id,))
    if r:
        db.add_alert("critical", "circuit_breaker", f"run:{run_id}",
                     f"[서킷브레이커] {r[0]['agent']} ({r[0]['tenant']}) run 중단 — {reason} (누적 ${r[0]['total_cost'] or 0:.4f})")


# ---------------------------------------------------------------- L2: ingest (원장)
@app.post("/api/ingest")
def ingest(req: IngestReq):
    ctx = req.ctx
    ensure_run(ctx)
    cost = pricing.compute_cost(req.model, req.input_tokens, req.output_tokens,
                                req.cache_read_tokens, req.cache_write_tokens, req.reasoning_tokens)
    # --- 절감 회계 (counterfactual) ---
    savings, kind, cf = 0.0, None, cost
    if req.cache_hit:
        # 시맨틱(전체 응답) 캐시: 실비용 ~0, 회피 비용 = 원 호출 비용
        cf = req.cached_cost_usd or pricing.compute_cost(req.model, req.input_tokens, req.output_tokens)
        savings, kind, cost = cf, "semantic_cache", 0.0
    else:
        cf_cache = pricing.counterfactual_no_cache(req.model, req.input_tokens, req.output_tokens,
                                                   req.cache_read_tokens, req.cache_write_tokens, req.reasoning_tokens)
        if cf_cache > cost + 1e-12:
            savings, kind, cf = cf_cache - cost, "prompt_cache", cf_cache
        if req.routing_action == "downgrade" and req.requested_model and req.requested_model != req.model:
            cf_route = pricing.cost_at(req.requested_model,
                                       req.input_tokens + req.cache_read_tokens + req.cache_write_tokens,
                                       req.output_tokens, req.reasoning_tokens)
            if cf_route - cost > savings:
                savings, kind, cf = cf_route - cost, "routing_downshift", cf_route
        if req.tools_saved_tokens > 0:
            # 스킬패커: 동적로딩이 없었다면 툴 스키마 전체가 매 호출 input 으로 과금됐을 것
            pi = pricing.price_of(req.model)[0]
            cf_tools = cost + req.tools_saved_tokens * pi / 1_000_000.0
            if cf_tools - cost > savings:
                savings, kind, cf = cf_tools - cost, "skill_packer", cf_tools

    db.ex("""INSERT INTO calls(ts,tenant,project,agent,agent_version,env,run_id,step,task_type,
             provider,model,requested_model,input_tokens,output_tokens,cache_read_tokens,
             cache_write_tokens,reasoning_tokens,cost_usd,counterfactual_usd,savings_usd,savings_kind,
             latency_ms,status,routing_action,cache_hit,data_class,risk_score,cache_decision,gov_action)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (time.time(), ctx.tenant, ctx.project, ctx.agent, ctx.agent_version, ctx.env,
           ctx.run_id, ctx.step, ctx.task_type, req.provider, req.model, req.requested_model or req.model,
           req.input_tokens, req.output_tokens, req.cache_read_tokens, req.cache_write_tokens,
           req.reasoning_tokens, cost, cf, savings, kind, req.latency_ms, req.status,
           req.routing_action, 1 if req.cache_hit else 0,
           ctx.data_class, ctx.risk_score, req.cache_decision, req.gov_action))

    tok = req.input_tokens + req.output_tokens + req.cache_read_tokens + req.cache_write_tokens + req.reasoning_tokens
    if ctx.run_id:
        db.ex("UPDATE runs SET total_cost=total_cost+?, total_tokens=total_tokens+?, steps=steps+1 WHERE run_id=?",
              (cost, tok, ctx.run_id))
    run = db.q("SELECT total_cost FROM runs WHERE run_id=?", (ctx.run_id,)) if ctx.run_id else []
    return {"cost_usd": cost, "savings_usd": savings, "savings_kind": kind,
            "run_total_cost": (run[0]["total_cost"] if run else cost)}


@app.post("/api/run/end")
def run_end(req: RunEndReq):
    db.ex("UPDATE runs SET status=?, ended=? WHERE run_id=? AND status='running'",
          (req.status, time.time(), req.run_id))
    return {"ok": True}


@app.post("/api/quality")
def quality(req: QualityReq):
    db.ex("UPDATE runs SET quality_score=?, quality_passed=? WHERE run_id=?",
          (req.score, 1 if req.passed else 0, req.run_id))
    # 품질 회귀 가드레일 — 해당 에이전트만 백그라운드 점검 (metis-ai quality-guard 이식)
    rows = db.q("SELECT agent FROM runs WHERE run_id=?", (req.run_id,))
    if rows:
        threading.Thread(target=lambda: intelligence.quality_guard(agent=rows[0]["agent"]),
                         daemon=True).start()
    return {"ok": True}


class QualityReportReq(BaseModel):
    """metis 평가기 → 원장 품질 폐루프.

    게이트웨이를 경유하지 않은 run(예: Anthropic 네이티브 호출)도 품질이 유실되지
    않도록 run 을 보장 생성한 뒤 quality_score 를 기록하고, 실행 중이면 종료 처리한다.
    """
    run_id: str
    score: float                 # 0..1
    passed: bool
    agent: str = "unknown"
    tenant: str = "unknown"
    project: str = "default"
    status: str = "success"      # success | failure


@app.post("/api/quality/report")
def quality_report(req: QualityReportReq):
    ensure_run(Ctx(run_id=req.run_id, agent=req.agent, tenant=req.tenant, project=req.project))
    score = max(0.0, min(1.0, req.score))
    db.ex("UPDATE runs SET quality_score=?, quality_passed=? WHERE run_id=?",
          (score, 1 if req.passed else 0, req.run_id))
    db.ex("UPDATE runs SET status=?, ended=? WHERE run_id=? AND status='running'",
          (req.status, time.time(), req.run_id))
    rows = db.q("SELECT agent FROM runs WHERE run_id=?", (req.run_id,))
    if rows:
        threading.Thread(target=lambda: intelligence.quality_guard(agent=rows[0]["agent"]),
                         daemon=True).start()
    return {"ok": True, "run_id": req.run_id, "score": score}


class ConfigChangeReq(BaseModel):
    agent: str
    description: str


@app.post("/api/config_change")
def config_change(req: ConfigChangeReq):
    db.ex("INSERT INTO config_changes(ts,agent,description) VALUES(?,?,?)", (time.time(), req.agent, req.description))
    db.add_alert("info", "config_change", f"agent:{req.agent}", f"[구성변경] {req.agent}: {req.description}")
    return {"ok": True}


# ---------------------------------------------------------------- L5: 집계 API
def pct(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    return sorted_vals[f] * (c - k) + sorted_vals[c] * (k - f)


@app.get("/api/overview")
def overview():
    now, today = time.time(), db.day_start()
    t = db.q("""SELECT COALESCE(SUM(cost_usd),0) c, COALESCE(SUM(savings_usd),0) s,
                COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens),0) tok,
                COUNT(*) n FROM calls WHERE ts>=?""", (today,))[0]
    burn = db.q("SELECT COALESCE(SUM(cost_usd),0) c FROM calls WHERE ts>=?", (now - 600,))[0]["c"] / 10.0
    active = db.q("SELECT COUNT(*) n FROM runs WHERE status='running' AND started>=?", (now - 1800,))[0]["n"]
    killed = db.q("SELECT COUNT(*) n FROM runs WHERE status='killed' AND started>=?", (today,))[0]["n"]
    downs = db.q("SELECT COUNT(*) n FROM calls WHERE routing_action='downgrade' AND ts>=?", (today,))[0]["n"]
    fin = db.q("SELECT COUNT(*) n, COALESCE(SUM(quality_passed),0) p, COALESCE(SUM(total_cost),0) c FROM runs WHERE status IN ('success','failure') AND started>=?", (today,))[0]
    cop = (fin["c"] / fin["p"]) if fin["p"] else None
    return {"today_cost": t["c"], "today_savings": t["s"], "today_tokens": t["tok"], "today_calls": t["n"],
            "burn_per_min": burn, "active_runs": active, "killed_today": killed, "downgrades_today": downs,
            "cost_of_pass": cop, "finished_runs": fin["n"], "passed_runs": fin["p"], "uptime_s": now - START_TS}


@app.get("/api/spend_series")
def spend_series(group: str = "tenant", minutes: int = 60):
    group = group if group in ("tenant", "agent", "model", "provider") else "tenant"
    minutes = max(5, min(minutes, 60 * 24 * 14))
    # 기간에 따라 버킷 크기 자동 조정 (차트 포인트 수 적정 유지)
    bucket = 60 if minutes <= 90 else 300 if minutes <= 360 else 900 if minutes <= 1440 else 3600
    since = time.time() - minutes * 60
    rows = db.q(f"""SELECT CAST(ts/{bucket} AS INTEGER)*{bucket} bucket, {group} g,
                    SUM(cost_usd) c, SUM(savings_usd) s FROM calls WHERE ts>=?
                    GROUP BY bucket, {group} ORDER BY bucket""", (since,))
    return {"rows": rows, "bucket": bucket}


@app.get("/api/runs/recent")
def runs_recent(limit: int = 40, agent: str = ""):
    where, args = "", []
    if agent:
        where, args = "WHERE agent=?", [agent]
    rows = db.q(f"""SELECT run_id,tenant,project,agent,agent_version,started,ended,status,kill_reason,
                    total_cost,total_tokens,steps,quality_score,quality_passed
                    FROM runs {where} ORDER BY started DESC LIMIT ?""", (*args, limit))
    return {"rows": rows}


@app.get("/api/runs/detail")
def run_detail(run_id: str):
    run = db.q("SELECT * FROM runs WHERE run_id=?", (run_id,))
    steps = db.q("""SELECT step,ts,model,requested_model,provider,input_tokens,output_tokens,
                    cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,savings_usd,savings_kind,
                    latency_ms,status,routing_action,cache_hit,task_type
                    FROM calls WHERE run_id=? ORDER BY step, ts""", (run_id,))
    return {"run": run[0] if run else None, "steps": steps}


@app.get("/api/run_stats")
def run_stats(hours: int = 24):
    since = time.time() - hours * 3600
    agents = db.q("SELECT DISTINCT agent FROM runs WHERE started>=?", (since,))
    out = []
    for a in agents:
        costs = sorted(r["total_cost"] or 0 for r in
                       db.q("SELECT total_cost FROM runs WHERE agent=? AND started>=? AND status!='running'", (a["agent"], since)))
        if not costs:
            continue
        fin = db.q("""SELECT COUNT(*) n, COALESCE(SUM(quality_passed),0) p, COALESCE(SUM(total_cost),0) c,
                      AVG(quality_score) qs FROM runs WHERE agent=? AND started>=? AND status IN ('success','failure')""",
                   (a["agent"], since))[0]
        killed = db.q("SELECT COUNT(*) n FROM runs WHERE agent=? AND started>=? AND status='killed'", (a["agent"], since))[0]["n"]
        out.append({"agent": a["agent"], "runs": len(costs), "killed": killed,
                    "p50": pct(costs, 0.5), "p95": pct(costs, 0.95), "p99": pct(costs, 0.99),
                    "avg_quality": fin["qs"], "pass_rate": (fin["p"] / fin["n"]) if fin["n"] else None,
                    "cost_of_pass": (fin["c"] / fin["p"]) if fin["p"] else None})
    out.sort(key=lambda x: -(x["p99"] or 0))
    return {"rows": out}


@app.get("/api/showback")
def showback(hours: int = 24):
    since = time.time() - hours * 3600
    rows = db.q("""SELECT tenant, SUM(cost_usd) cost, SUM(savings_usd) savings, COUNT(*) calls,
                   SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) tokens
                   FROM calls WHERE ts>=? GROUP BY tenant ORDER BY cost DESC""", (since,))
    total = sum(r["cost"] for r in rows) or 1
    for r in rows:
        r["share"] = r["cost"] / total
    by_agent = db.q("""SELECT tenant, agent, SUM(cost_usd) cost FROM calls WHERE ts>=?
                       GROUP BY tenant, agent ORDER BY cost DESC""", (since,))
    return {"rows": rows, "by_agent": by_agent, "total": total}


@app.get("/api/savings")
def savings(hours: int = 24):
    since = time.time() - hours * 3600
    rows = db.q("""SELECT savings_kind, SUM(savings_usd) s, COUNT(*) n FROM calls
                   WHERE ts>=? AND savings_usd>0 GROUP BY savings_kind""", (since,))
    series = db.q("""SELECT CAST(ts/300 AS INTEGER)*300 bucket, SUM(cost_usd) cost, SUM(savings_usd) savings
                     FROM calls WHERE ts>=? GROUP BY bucket ORDER BY bucket""", (since,))
    cache = db.q("""SELECT COUNT(*) total, SUM(cache_hit) hits FROM calls WHERE ts>=?""", (since,))[0]
    return {"by_kind": rows, "series": series,
            "cache_hit_rate": (cache["hits"] or 0) / cache["total"] if cache["total"] else 0}


@app.get("/api/quality_cost")
def quality_cost(hours: int = 24, agent: str = ""):
    since = time.time() - hours * 3600
    where, args = "", []
    if agent:
        where, args = "AND agent=?", [agent]
    rows = db.q(f"""SELECT CAST(started/300 AS INTEGER)*300 bucket, AVG(quality_score) q,
                    AVG(total_cost) c, COUNT(*) n FROM runs
                    WHERE started>=? AND quality_score IS NOT NULL {where}
                    GROUP BY bucket ORDER BY bucket""", (since, *args))
    changes = db.q("SELECT ts, agent, description FROM config_changes WHERE ts>=? ORDER BY ts", (since,))
    return {"rows": rows, "config_changes": changes}


@app.get("/api/alerts")
def alerts(limit: int = 60):
    return {"rows": db.q("SELECT * FROM alerts ORDER BY ts DESC LIMIT ?", (limit,))}


@app.get("/api/budgets")
def budgets():
    today = db.day_start()
    out = []
    for b in db.q("SELECT * FROM budgets"):
        spent = spend_since(b["scope_type"], b["scope_id"], today)
        out.append({**b, "spent": spent})
    return {"rows": out}


@app.get("/api/policies")
def policies():
    return {"rows": db.q("SELECT * FROM run_policies")}


@app.get("/api/agents")
def agents():
    """에이전트 레지스트리 + 캐시 정책 + 강등 품질 게이트 상태 (대시보드 '에이전트' 뷰)."""
    since = time.time() - 24 * 3600
    out = []
    for a in db.q("SELECT * FROM agents ORDER BY agent"):
        st = db.q("""SELECT COUNT(*) n, AVG(quality_score) q FROM runs
                     WHERE agent=? AND started>=? AND quality_score IS NOT NULL""",
                  (a["agent"], since))[0]
        # 강등 가능한(강등 맵 보유) 모델 중 최다 사용 모델 기준으로 게이트 평가
        tops = db.q("""SELECT requested_model model, COUNT(*) n FROM calls WHERE agent=? AND ts>=? AND cache_hit=0
                       GROUP BY requested_model ORDER BY n DESC""", (a["agent"], since))
        primary = next((t["model"] for t in tops if pricing.downgrade_of(t["model"])),
                       tops[0]["model"] if tops else None)
        target = pricing.downgrade_of(primary) if primary else None
        gate = quality_gate(a["agent"], a, target) if target else None
        pol = get_policy(a["agent"])
        out.append({**a, "primary_model": primary, "downgrade_target": target, "gate": gate,
                    "runs_24h": st["n"], "avg_quality_24h": st["q"],
                    "max_cost_per_run": pol["max_cost_per_run"], "max_steps": pol["max_steps"]})
    return {"rows": out}


class AgentUpdateReq(BaseModel):
    agent: str
    semantic_cache: bool | None = None
    downgrade_enabled: bool | None = None
    complexity_routing: bool | None = None


@app.post("/api/agents/update")
def agents_update(req: AgentUpdateReq):
    cfg = get_agent_cfg(req.agent)
    if req.semantic_cache is not None:
        db.ex("UPDATE agents SET semantic_cache=? WHERE agent=?", (1 if req.semantic_cache else 0, req.agent))
        db.add_alert("info", "config_change", f"agent:{req.agent}",
                     f"[정책변경] {req.agent} 시맨틱 캐시 {'적용' if req.semantic_cache else '해제'}")
    if req.downgrade_enabled is not None:
        db.ex("UPDATE agents SET downgrade_enabled=? WHERE agent=?", (1 if req.downgrade_enabled else 0, req.agent))
        db.add_alert("info", "config_change", f"agent:{req.agent}",
                     f"[정책변경] {req.agent} 라우팅 강등 {'활성' if req.downgrade_enabled else '비활성'}")
    if req.complexity_routing is not None:
        db.ex("UPDATE agents SET complexity_routing=? WHERE agent=?", (1 if req.complexity_routing else 0, req.agent))
        db.add_alert("info", "config_change", f"agent:{req.agent}",
                     f"[정책변경] {req.agent} 복잡도 기반 라우팅 {'활성' if req.complexity_routing else '비활성'}")
    return {"ok": True, "agent": db.q("SELECT * FROM agents WHERE agent=?", (req.agent,))[0]}


@app.get("/api/governance")
def governance(hours: int = 24):
    """거버넌스 융합 현황 (Patent 3) — 캐시 정책 차단·리스크 강등 방어·정책 준수."""
    since = time.time() - hours * 3600
    gov = get_governance()
    total = db.q("SELECT COUNT(*) n FROM calls WHERE ts>=?", (since,))[0]["n"] or 0
    # 캐시 정책 판정 분해
    cache_dec = db.q("""SELECT cache_decision d, COUNT(*) n FROM calls WHERE ts>=?
                        GROUP BY cache_decision ORDER BY n DESC""", (since,))
    denied = db.q("""SELECT COUNT(*) n FROM calls WHERE ts>=? AND cache_decision LIKE 'DENY%'""", (since,))[0]["n"] or 0
    # 리스크 강등 방어 (예산 압박에도 강등하지 않고 상향/유지)
    escalations = db.q("""SELECT COUNT(*) n FROM calls WHERE ts>=? AND gov_action='risk_escalate'""", (since,))[0]["n"] or 0
    holds = db.q("""SELECT COUNT(*) n FROM calls WHERE ts>=? AND gov_action='risk_hold'""", (since,))[0]["n"] or 0
    # 데이터 등급 분포
    by_class = db.q("""SELECT data_class d, COUNT(*) n, SUM(cost_usd) c FROM calls WHERE ts>=?
                       GROUP BY data_class ORDER BY n DESC""", (since,))
    # 민감 데이터가 캐시로 누출됐는지 (반드시 0 이어야 함 = 준수)
    sensitive = [c.strip() for c in (gov.get("sensitive_classes") or "").split(",") if c.strip()]
    leaks = 0
    if sensitive:
        ph = ",".join("?" * len(sensitive))
        leaks = db.q(f"""SELECT COUNT(*) n FROM calls WHERE ts>=? AND cache_hit=1
                         AND data_class IN ({ph})""", (since, *sensitive))[0]["n"] or 0
    # 최근 거버넌스 이벤트
    events = db.q("""SELECT ts, severity, message FROM alerts WHERE kind='governance' AND ts>=?
                     ORDER BY ts DESC LIMIT 20""", (since,))
    compliance = 1.0 if leaks == 0 else max(0.0, 1 - leaks / max(1, total))
    return {"policy": gov, "total": total, "cache_decisions": cache_dec, "denied": denied,
            "escalations": escalations, "holds": holds, "by_class": by_class,
            "sensitive_leaks": leaks, "compliance": compliance, "events": events}


class GovPolicyReq(BaseModel):
    high_risk_threshold: float | None = None
    escalate_risk_threshold: float | None = None
    safe_min_tier: str | None = None
    enabled: bool | None = None


@app.post("/api/governance/update")
def governance_update(req: GovPolicyReq):
    g = get_governance()
    vals = {
        "high_risk_threshold": req.high_risk_threshold if req.high_risk_threshold is not None else g["high_risk_threshold"],
        "escalate_risk_threshold": req.escalate_risk_threshold if req.escalate_risk_threshold is not None else g["escalate_risk_threshold"],
        "safe_min_tier": req.safe_min_tier or g["safe_min_tier"],
        "enabled": (1 if req.enabled else 0) if req.enabled is not None else g["enabled"],
    }
    db.ex("""UPDATE governance_policy SET high_risk_threshold=?, escalate_risk_threshold=?,
             safe_min_tier=?, enabled=? WHERE id=1""",
          (vals["high_risk_threshold"], vals["escalate_risk_threshold"], vals["safe_min_tier"], vals["enabled"]))
    db.add_alert("info", "config_change", "governance", "[거버넌스] 정책 변경됨")
    return {"ok": True, "policy": get_governance()}


@app.get("/api/gpu")
def gpu(minutes: int = 30):
    since = time.time() - minutes * 60
    rows = db.q("SELECT * FROM gpu_metrics WHERE ts>=? ORDER BY ts", (since,))
    latest = db.q("""SELECT node, gpu_util, mem_util, kv_cache_util, queue_depth, cost_per_hour
                     FROM gpu_metrics WHERE id IN (SELECT MAX(id) FROM gpu_metrics GROUP BY node)""")
    idle_cost = sum(g["cost_per_hour"] * max(0.0, 1 - g["gpu_util"]) for g in latest)
    return {"series": rows, "latest": latest, "idle_cost_per_hour": idle_cost}


# ---------------------------------------------------------------- 지능 계층 (metis-ai 이식)
@app.get("/api/forecast")
def forecast():
    """월말 비용 예측 — 선형 외삽 + 전월 대비 + 신뢰도 (metis-ai predictMonthlyCost)."""
    return intelligence.forecast_monthly()


class WhatIfReq(BaseModel):
    cache_ttl_multiplier: float = 1.0
    downgrade_aggressive: bool = False
    skill_trim_ratio: float = 0.0
    hours: int = 24


@app.post("/api/whatif")
def whatif(req: WhatIfReq):
    """What-if 시뮬레이션 — 원장 실데이터 counterfactual 기반 (metis-ai simulateWhatIf)."""
    return intelligence.whatif(req.cache_ttl_multiplier, req.downgrade_aggressive,
                               req.skill_trim_ratio, req.hours)


@app.get("/api/recommendations")
def recommendations(refresh: int = 1, limit: int = 30):
    if refresh:
        intelligence.build_recommendations()
    return {"rows": db.q("""SELECT * FROM recommendations ORDER BY
                            CASE status WHEN 'pending' THEN 0 ELSE 1 END, est_saving_usd DESC, ts DESC
                            LIMIT ?""", (limit,))}


@app.post("/api/recommendations/{rec_id}/apply")
def recommendation_apply(rec_id: int):
    return intelligence.apply_recommendation(rec_id)


@app.post("/api/recommendations/{rec_id}/dismiss")
def recommendation_dismiss(rec_id: int):
    db.ex("UPDATE recommendations SET status='dismissed' WHERE id=?", (rec_id,))
    return {"ok": True}


@app.get("/api/anomalies")
def anomalies(hours: int = 24):
    """이상감지 5종 — z-score 드리프트/IQR 스파이크/지연 추세/에러 서지/거버넌스 패턴."""
    return {"rows": intelligence.detect_anomalies(hours)}


@app.get("/api/quality_guard")
def quality_guard_api(hours: int = 24, auto: int = 1):
    """품질 회귀 가드레일 — 강등 run 품질 하락 감지 (+자동 원복)."""
    return {"rows": intelligence.quality_guard(hours, auto_revert=bool(auto)),
            "auto_revert_default": intelligence.AUTO_REVERT,
            "drop_threshold_pct": intelligence.GUARD_DROP_PCT}


@app.post("/api/quality_guard/{agent}/revert")
def quality_guard_revert(agent: str):
    return intelligence.revert_agent(agent)


# ---------------------------------------------------------------- 모델 단가 런타임 관리
@app.get("/api/model_prices")
def model_prices():
    return {"rows": db.q("SELECT * FROM model_prices ORDER BY tier DESC, model"),
            "runtime_loaded": pricing.runtime_loaded()}


class ModelPriceReq(BaseModel):
    model: str
    input_usd: float | None = None
    output_usd: float | None = None
    cache_read_usd: float | None = None
    cache_write_usd: float | None = None
    tier: str | None = None
    downgrade_to: str | None = None
    active: bool | None = None


@app.post("/api/model_prices/update")
def model_prices_update(req: ModelPriceReq):
    m = pricing.normalize_model_id(req.model)
    rows = db.q("SELECT * FROM model_prices WHERE model=?", (m,))
    cur = rows[0] if rows else {"input_usd": 1.0, "output_usd": 4.0, "cache_read_usd": 0.25,
                                "cache_write_usd": 1.25, "tier": "standard", "downgrade_to": None, "active": 1}
    vals = {
        "input_usd": req.input_usd if req.input_usd is not None else cur["input_usd"],
        "output_usd": req.output_usd if req.output_usd is not None else cur["output_usd"],
        "cache_read_usd": req.cache_read_usd if req.cache_read_usd is not None else cur["cache_read_usd"],
        "cache_write_usd": req.cache_write_usd if req.cache_write_usd is not None else cur["cache_write_usd"],
        "tier": req.tier or cur["tier"],
        "downgrade_to": req.downgrade_to if req.downgrade_to is not None else cur["downgrade_to"],
        "active": (1 if req.active else 0) if req.active is not None else cur["active"],
    }
    db.ex("""INSERT INTO model_prices(model,input_usd,output_usd,cache_read_usd,cache_write_usd,
             tier,downgrade_to,active,updated) VALUES(?,?,?,?,?,?,?,?,?)
             ON CONFLICT(model) DO UPDATE SET input_usd=excluded.input_usd, output_usd=excluded.output_usd,
             cache_read_usd=excluded.cache_read_usd, cache_write_usd=excluded.cache_write_usd,
             tier=excluded.tier, downgrade_to=excluded.downgrade_to, active=excluded.active, updated=excluded.updated""",
          (m, vals["input_usd"], vals["output_usd"], vals["cache_read_usd"], vals["cache_write_usd"],
           vals["tier"], vals["downgrade_to"], vals["active"], time.time()))
    pricing.load_runtime(db.q("SELECT * FROM model_prices"))
    db.add_alert("info", "config_change", f"model:{m}",
                 f"[단가변경] {m} input ${vals['input_usd']}/M · output ${vals['output_usd']}/M")
    return {"ok": True, "model": m, "price": vals}


@app.get("/api/insights")
def insights():
    out = []
    now = time.time()
    since = now - 24 * 3600
    sb = showback(24)
    if sb["rows"]:
        top = sb["rows"][0]
        if top["share"] > 0.4:
            out.append({"icon": "⚖️", "title": "지출 집중", "severity": "warning",
                        "body": f"'{top['tenant']}'가 최근 24시간 지출의 {top['share']*100:.0f}%를 차지합니다. "
                                f"파워로 분포(상위 소수가 대부분 소비)가 확인되므로 해당 테넌트의 run 단위 p99 점검을 권합니다."})
    rs = run_stats(24)["rows"]
    for r in rs:
        if r["p99"] and r["p50"] and r["p99"] > r["p50"] * 8:
            out.append({"icon": "📈", "title": f"{r['agent']} 롱테일 비용", "severity": "warning",
                        "body": f"p99 run 비용(${r['p99']:.4f})이 p50(${r['p50']:.4f})의 {r['p99']/r['p50']:.0f}배입니다. "
                                f"폭주 루프·과도한 툴 호출 가능성 — run 비용 한도 하향을 검토하세요."})
        if r["cost_of_pass"] and r["pass_rate"] is not None and r["pass_rate"] < 0.8:
            out.append({"icon": "🎯", "title": f"{r['agent']} cost-of-pass 악화", "severity": "critical",
                        "body": f"성공률 {r['pass_rate']*100:.0f}%로 성공 1건당 실질 비용이 ${r['cost_of_pass']:.4f}입니다. "
                                f"시도당 비용이 싸 보여도 실패 재시도까지 포함하면 비싼 구성일 수 있습니다."})
    sv = savings(24)
    tot_s = sum(r["s"] for r in sv["by_kind"]) if sv["by_kind"] else 0
    ov = overview()
    if tot_s > 0 and ov["today_cost"] > 0:
        out.append({"icon": "💰", "title": "절감 회계", "severity": "info",
                    "body": f"최근 24시간 FinOps 기능(캐시/라우팅)으로 ${tot_s:.4f}를 절감했습니다 "
                            f"(미적용 가정 대비 {tot_s/(tot_s+ov['today_cost'])*100:.0f}% 절감). 캐시 히트율 {sv['cache_hit_rate']*100:.0f}%."})
    # 월말 예측 인사이트 (metis-ai 이식)
    try:
        fc = intelligence.forecast_monthly()
        if fc["current_month_actual"] > 0:
            mom = f" (전월 대비 {fc['mom_pct']:+.0f}%)" if fc["mom_pct"] is not None else ""
            out.append({"icon": "🔮", "title": "월말 비용 전망", "severity": "info",
                        "body": f"이번 달 실적 ${fc['current_month_actual']:.2f} → 월말 전망 "
                                f"${fc['projected_month_total']:.2f}{mom}. 신뢰도 {fc['confidence']*100:.0f}% "
                                f"(경과 {fc['days_elapsed']:.0f}/{fc['days_total']}일). 자세한 시나리오는 '예측·이상감지' 뷰에서."})
    except Exception:
        pass
    # 이상감지 상위 3건 (metis-ai 이식)
    try:
        for a in intelligence.detect_anomalies(24, write_alerts=False)[:3]:
            icon = {"quality_drift": "📉", "token_spike": "💥", "latency_trend": "🐢",
                    "error_surge": "🚨", "governance_pattern": "🛡️"}.get(a["kind"], "⚠️")
            out.append({"icon": icon, "title": f"이상감지: {a['kind']}", "severity": a["severity"],
                        "body": a["message"]})
    except Exception:
        pass
    g = gpu(30)
    if g["latest"]:
        avg_util = sum(x["gpu_util"] for x in g["latest"]) / len(g["latest"])
        if avg_util < 0.45:
            out.append({"icon": "🖥️", "title": "GPU 유휴 비용", "severity": "warning",
                        "body": f"셀프호스트 GPU 평균 사용률 {avg_util*100:.0f}% — 유휴 비용 ${g['idle_cost_per_hour']:.2f}/시간이 발생 중입니다. "
                                f"MIG 분할 또는 야간 배치 워크로드 통합을 검토하세요."})
        elif avg_util > 0.55:
            out.append({"icon": "🖥️", "title": "PTU/증설 검토", "severity": "info",
                        "body": f"GPU 평균 사용률 {avg_util*100:.0f}%로 지속 사용률 기준(40–60%)을 충족합니다. "
                                f"상용 API 트래픽 일부의 셀프호스트 전환 또는 PTU 약정 손익분기 분석을 권합니다."})
    chg = db.q("SELECT * FROM config_changes WHERE ts>=? ORDER BY ts DESC LIMIT 1", (since,))
    if chg:
        c = chg[0]
        before = db.q("SELECT AVG(quality_score) q, AVG(total_cost) c FROM runs WHERE agent=? AND started<? AND started>=? AND quality_score IS NOT NULL",
                      (c["agent"], c["ts"], c["ts"] - 6 * 3600))[0]
        after = db.q("SELECT AVG(quality_score) q, AVG(total_cost) c FROM runs WHERE agent=? AND started>=? AND quality_score IS NOT NULL",
                     (c["agent"], c["ts"]))[0]
        if before["q"] and after["q"]:
            dq, dc = after["q"] - before["q"], (after["c"] or 0) - (before["c"] or 0)
            sev = "critical" if dq < -0.05 else "info"
            out.append({"icon": "🔁", "title": f"{c['agent']} 구성변경 영향 (품질-비용 폐루프)", "severity": sev,
                        "body": f"\"{c['description']}\" 이후 run당 평균 비용 {dc:+.5f} USD, 품질 점수 {dq:+.3f} 변화. "
                                + ("품질 저하가 절감폭 대비 큽니다 — 롤백 또는 카나리 비율 축소를 권합니다." if dq < -0.05
                                   else "품질 유지 중 — 카나리 비율 확대 가능합니다.")})
    gv = governance(24)
    if gv["denied"] > 0 or gv["escalations"] > 0:
        sev = "critical" if gv["sensitive_leaks"] > 0 else "info"
        out.append({"icon": "🛡️", "title": "거버넌스 융합 (Patent 3)", "severity": sev,
                    "body": f"최근 24시간 캐시 정책 차단 {gv['denied']}건(민감/고위험), 리스크 강등 방어 {gv['escalations']}건. "
                            f"민감 데이터 캐시 누출 {gv['sensitive_leaks']}건 — "
                            + ("⚠ 누출 발생, 정책 점검 필요." if gv['sensitive_leaks'] > 0
                               else f"준수율 {gv['compliance']*100:.0f}%(누출 0). 비용 최적화가 거버넌스를 침해하지 않았습니다.")})
    if not out:
        out.append({"icon": "✅", "title": "정상", "severity": "info", "body": "특이 패턴이 감지되지 않았습니다."})
    return {"rows": out}


# ---------------------------------------------------------------- FOCUS export (1.4 + x_ 토큰 확장)
@app.get("/api/export/focus")
def export_focus(hours: int = 24):
    """FOCUS 1.4 호환 CSV (metis-ai finops-insight FOCUS 1.4 export 이식).

    토큰 단위 비용은 FOCUS 표준에 아직 없으므로 x_ 확장 컬럼으로 선반영
    (ListCost=counterfactual, ContractedCost/BilledCost/EffectiveCost=실비용).
    """
    since = time.time() - hours * 3600
    rows = db.q("SELECT * FROM calls WHERE ts>=? ORDER BY ts", (since,))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["InvoiceIssuerName", "ProviderName", "PublisherName", "BillingAccountId", "SubAccountId",
                "ChargePeriodStart", "ChargePeriodEnd", "ChargeCategory", "ChargeClass",
                "ServiceName", "ServiceCategory", "ResourceId", "ResourceName", "ChargeDescription",
                "PricingQuantity", "PricingUnit", "ListCost", "ContractedCost", "BilledCost", "EffectiveCost",
                "BillingCurrency", "Tags",
                "x_InputTokens", "x_OutputTokens", "x_CacheReadTokens", "x_CacheWriteTokens",
                "x_ReasoningTokens", "x_SavingsUsd", "x_SavingsKind", "x_DataClass", "x_RiskScore",
                "x_CacheDecision", "x_RoutingAction"])
    for r in rows:
        ts0 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"]))
        tok = r["input_tokens"] + r["output_tokens"] + r["cache_read_tokens"] + r["cache_write_tokens"] + r["reasoning_tokens"]
        tags = (f"tenant:{r['tenant']};project:{r['project']};agent:{r['agent']};"
                f"run:{r['run_id']};env:{r['env']};savings_kind:{r['savings_kind'] or ''}")
        w.writerow(["Metis.AI", r["provider"], "Metis FinOps", "ktds-opsai", r["tenant"], ts0, ts0,
                    "Usage", "Standard",
                    "AI Model Inference", "AI and Machine Learning",
                    f"model/{r['model']}", r["model"],
                    f"{r['agent']} step{r['step']} ({r['task_type']})",
                    tok, "tokens",
                    f"{r['counterfactual_usd'] or r['cost_usd']:.8f}", f"{r['cost_usd']:.8f}",
                    f"{r['cost_usd']:.8f}", f"{r['cost_usd']:.8f}", "USD", tags,
                    r["input_tokens"], r["output_tokens"], r["cache_read_tokens"], r["cache_write_tokens"],
                    r["reasoning_tokens"], f"{r['savings_usd']:.8f}", r["savings_kind"] or "",
                    r["data_class"], r["risk_score"], r["cache_decision"], r["routing_action"]])
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=metis_focus14_export_{int(time.time())}.csv"})


@app.get("/api/health")
def health():
    return {"ok": True, "service": "control-plane", "ts": time.time()}


# ---------------------------------------------------------------- 테스트 에이전트 프록시
# 대시보드(:8500) 단일 화면에서 테스트 에이전트를 쓸 수 있도록 control plane 이 중계한다.
TEST_AGENT_URL = os.environ.get("TEST_AGENT_URL", "http://127.0.0.1:8600").rstrip("/")
_qa = httpx.Client(timeout=180.0)


class QaTestReq(BaseModel):
    filename: str = "uploaded.py"
    code: str


@app.post("/api/qa/test")
def qa_test(req: QaTestReq):
    try:
        r = _qa.post(f"{TEST_AGENT_URL}/api/test", json=req.model_dump())
        return Response(content=r.content, status_code=r.status_code, media_type="application/json")
    except httpx.HTTPError as e:
        return Response(content=f'{{"error":"테스트 에이전트 서비스(:8600)에 연결할 수 없습니다: {e}"}}',
                        status_code=502, media_type="application/json")


@app.get("/api/qa/report/{report_id}/download")
def qa_download(report_id: str, fmt: str = "md"):
    try:
        r = _qa.get(f"{TEST_AGENT_URL}/api/report/{report_id}/download", params={"fmt": fmt})
        headers = {}
        if "content-disposition" in r.headers:
            headers["Content-Disposition"] = r.headers["content-disposition"]
        return Response(content=r.content, status_code=r.status_code,
                        media_type=r.headers.get("content-type", "application/octet-stream"),
                        headers=headers)
    except httpx.HTTPError as e:
        return Response(content=str(e), status_code=502)


# ---------------------------------------------------------------- 백그라운드 루프
def gpu_sim_loop():
    nodes = ["h100-node-01", "h100-node-02", "h100-node-03", "h100-node-04"]
    phase = {n: random.random() * math.pi * 2 for n in nodes}
    while True:
        t = time.time()
        for n in nodes:
            base = 0.45 + 0.25 * math.sin(t / 180 + phase[n])
            util = max(0.05, min(0.98, base + random.uniform(-0.08, 0.08)))
            db.ex("""INSERT INTO gpu_metrics(ts,node,gpu_util,mem_util,kv_cache_util,queue_depth,cost_per_hour)
                     VALUES(?,?,?,?,?,?,?)""",
                  (t, n, util, min(0.99, util + random.uniform(0.05, 0.2)),
                   min(0.99, util + random.uniform(-0.05, 0.25)),
                   max(0, int((util - 0.6) * 40) + random.randint(0, 3)), 4.50))
        db.ex("DELETE FROM gpu_metrics WHERE ts < ?", (t - 7200,))
        time.sleep(10)


def intelligence_loop():
    """주기 점검: 이상감지(알림 기록) + 품질 가드레일 (metis-ai 워커 잡 이식)."""
    time.sleep(60)
    while True:
        try:
            intelligence.detect_anomalies(24)
            intelligence.quality_guard()
        except Exception as e:
            print(f"[intelligence] loop error: {e}")
        time.sleep(120)


threading.Thread(target=gpu_sim_loop, daemon=True).start()
threading.Thread(target=intelligence_loop, daemon=True).start()

# 정적 대시보드 (맨 마지막에 마운트해야 /api/* 가 우선됨)
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("CONTROL_PLANE_PORT", "8500")))
