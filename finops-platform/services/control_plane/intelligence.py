"""Metis FinOps Intelligence — metis-ai 지능 계층 이식.

이식 원본 (metis-ai/apps/api/src/modules):
  - finops-prediction.service.ts : 월말 비용 예측(선형 외삽) + What-if 시뮬레이션 + 권고
  - evaluator/anomaly-detector.ts: 이상감지 5종 (z-score 드리프트 / IQR 스파이크 /
                                   선형회귀 추세 / 에러 서지 / 거버넌스 패턴)
  - finops-insight.service.ts    : 품질 회귀 가드레일 (저티어 품질 하락 감지 + 자동 원복)

원본은 상수 기반 추정이었으나, 이 이식본은 원장(calls/runs)의 실데이터 counterfactual 로
계산해 정확도를 높였다. 순수 통계 함수는 DB 비의존이라 단위테스트 가능.
"""
import json
import math
import os
import time

import db
import pricing

# ---- 임계값 (metis-ai SDK 상수 미러링) ----
Z_SCORE_THRESHOLD = 2.5
IQR_FACTOR = 2.0
TREND_SLOPE_THRESHOLD = 0.05      # (정규화 latency 추세)
ERROR_SURGE_THRESHOLD = 0.20      # 20%p
TREND_MIN_POINTS = 5
GUARD_DROP_PCT = float(os.environ.get("METIS_GUARD_DROP_PCT", "10"))   # 저티어 품질 하락 허용 한계(%)
AUTO_REVERT = os.environ.get("METIS_AUTO_REVERT", "1") == "1"


# ================================================================ 순수 통계 함수
def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def zscore_drift(baseline: list, recent: list, threshold: float = Z_SCORE_THRESHOLD):
    """기준 구간 대비 최근 구간 평균의 z-score 드리프트. 감지 시 dict, 아니면 None."""
    if len(baseline) < 4 or len(recent) < 2:
        return None
    sd = stdev(baseline)
    if sd <= 1e-9:
        sd = max(abs(mean(baseline)) * 0.05, 1e-6)   # 무변동 기준선 보호
    z = (mean(recent) - mean(baseline)) / sd
    if abs(z) >= threshold:
        return {"z": round(z, 2), "baseline_mean": round(mean(baseline), 4),
                "recent_mean": round(mean(recent), 4)}
    return None


def iqr_bounds(values: list, factor: float = IQR_FACTOR):
    """IQR 상한 (스파이크 탐지). 데이터 4개 미만이면 None."""
    if len(values) < 4:
        return None
    s = sorted(values)
    q1 = s[int(0.25 * (len(s) - 1))]
    q3 = s[int(0.75 * (len(s) - 1))]
    iqr = max(q3 - q1, 1e-9)
    return q3 + factor * iqr


def linreg_slope(ys: list):
    """y 값 시퀀스(등간격 x)의 최소제곱 기울기."""
    n = len(ys)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx, my = mean(xs), mean(ys)
    den = sum((x - mx) ** 2 for x in xs) or 1e-9
    return sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / den


def error_surge(baseline_rate: float, recent_rate: float,
                threshold: float = ERROR_SURGE_THRESHOLD) -> bool:
    return (recent_rate - baseline_rate) >= threshold


# ================================================================ 1. 월말 비용 예측
def forecast_monthly() -> dict:
    """선형 외삽 월말 예측 (metis-ai predictMonthlyCost 이식)."""
    now = time.time()
    t = time.localtime(now)
    m_start = db.month_start(now)
    # 이번 달 마지막 날
    if t.tm_mon == 12:
        next_m = time.mktime((t.tm_year + 1, 1, 1, 0, 0, 0, 0, 0, -1))
    else:
        next_m = time.mktime((t.tm_year, t.tm_mon + 1, 1, 0, 0, 0, 0, 0, -1))
    days_total = round((next_m - m_start) / 86400)
    days_elapsed = max((now - m_start) / 86400, 1e-6)

    cur = db.q("SELECT COALESCE(SUM(cost_usd),0) c, COALESCE(SUM(savings_usd),0) s FROM calls WHERE ts>=?",
               (m_start,))[0]
    actual, savings = cur["c"], cur["s"]
    avg_daily = actual / days_elapsed
    projected = avg_daily * days_total

    prev_start = db.month_start(m_start - 86400)
    prev = db.q("SELECT COALESCE(SUM(cost_usd),0) c FROM calls WHERE ts>=? AND ts<?",
                (prev_start, m_start))[0]["c"]
    mom_pct = ((projected - prev) / prev * 100) if prev > 0 else None
    # 데이터가 쌓일수록 신뢰도 상승 (metis-ai: 데이터 일수 기반)
    confidence = round(min(0.95, 0.30 + (days_elapsed / days_total) * 0.65), 2)

    daily = db.q("""SELECT CAST((ts-?)/86400 AS INTEGER) d, SUM(cost_usd) c, SUM(savings_usd) s
                    FROM calls WHERE ts>=? GROUP BY d ORDER BY d""", (m_start, m_start))
    return {"month": time.strftime("%Y-%m", t),
            "current_month_actual": round(actual, 4),
            "current_month_savings": round(savings, 4),
            "projected_month_total": round(projected, 4),
            "previous_month_total": round(prev, 4),
            "mom_pct": round(mom_pct, 1) if mom_pct is not None else None,
            "avg_daily_cost": round(avg_daily, 4),
            "days_elapsed": round(days_elapsed, 2), "days_total": days_total,
            "confidence": confidence, "daily_series": daily}


# ================================================================ 2. What-if 시뮬레이션
def whatif(cache_ttl_multiplier: float = 1.0, downgrade_aggressive: bool = False,
           skill_trim_ratio: float = 0.0, hours: int = 24) -> dict:
    """원장 실데이터 기반 시나리오 (metis-ai simulateWhatIf 이식 — 상수 대신 counterfactual).

    - cache_ttl_multiplier: 캐시 TTL 배수 → 시맨틱 캐시 절감 증가 추정(체감 0.5, 상한 2배)
    - downgrade_aggressive: 강등 가능한 모든 비캐시 호출을 한 단계 강등했다면
    - skill_trim_ratio:    툴 레지스트리 토큰을 비율만큼 추가 압축했다면
    """
    since = time.time() - hours * 3600
    scale = (30 * 24) / max(hours, 1)   # 윈도우 → 월 환산
    base = db.q("SELECT COALESCE(SUM(cost_usd),0) c FROM calls WHERE ts>=?", (since,))[0]["c"]

    # 레버 1: 캐시 TTL — 현 시맨틱 절감의 증가분 (수확 체감 0.5, 최대 2배)
    sem = db.q("""SELECT COALESCE(SUM(savings_usd),0) s FROM calls
                  WHERE ts>=? AND savings_kind='semantic_cache'""", (since,))[0]["s"]
    m = max(1.0, min(cache_ttl_multiplier, 4.0))
    cache_gain = min(sem * (m - 1.0) * 0.5, sem)

    # 레버 2: 전면 강등 — 강등 가능 모델의 비캐시 호출을 실 토큰으로 재계산한 counterfactual
    route_gain = 0.0
    rows = db.q("""SELECT model, SUM(input_tokens+cache_read_tokens+cache_write_tokens) i,
                   SUM(output_tokens) o, SUM(reasoning_tokens) r, SUM(cost_usd) c
                   FROM calls WHERE ts>=? AND cache_hit=0 AND routing_action='none' AND status='ok'
                   GROUP BY model""", (since,))
    if downgrade_aggressive:
        for r in rows:
            target = pricing.downgrade_of(r["model"])
            if not target:
                continue
            cheaper = pricing.cost_at(target, r["i"] or 0, r["o"] or 0, r["r"] or 0)
            route_gain += max(0.0, (r["c"] or 0) - cheaper)

    # 레버 3: 스킬패커 추가 압축 — 레지스트리 보유 에이전트의 호출 × 토큰 × 비율 × input 단가
    skill_gain = 0.0
    if skill_trim_ratio > 0:
        ag = db.q("""SELECT a.agent, a.tool_registry_tokens t, COUNT(c.id) n,
                     COALESCE(MAX(c.model),'gpt-5-mini') m
                     FROM agents a JOIN calls c ON c.agent=a.agent AND c.ts>=? AND c.cache_hit=0
                     WHERE a.tool_registry_tokens>0 GROUP BY a.agent""", (since,))
        for r in ag:
            pi = pricing.price_of(r["m"])[0]
            skill_gain += r["n"] * r["t"] * min(skill_trim_ratio, 1.0) * pi / 1_000_000.0

    total_gain = cache_gain + route_gain + skill_gain
    return {"window_hours": hours,
            "baseline_window_cost": round(base, 4),
            "baseline_monthly_est": round(base * scale, 2),
            "scenario_monthly_est": round(max(0.0, base - total_gain) * scale, 2),
            "savings_monthly_est": round(total_gain * scale, 2),
            "breakdown": {"semantic_cache_ttl": round(cache_gain * scale, 2),
                          "routing_downshift_all": round(route_gain * scale, 2),
                          "skill_packer_trim": round(skill_gain * scale, 2)},
            "assumptions": ["TTL 배수 효과는 현 시맨틱 절감 대비 체감계수 0.5, 상한 2배",
                            "전면 강등은 품질 게이트 통과를 가정한 상한 추정",
                            "월 환산 = 윈도우 실측 × (720h/윈도우)"]}


# ================================================================ 3. 자동 권고
def build_recommendations(hours: int = 24) -> list:
    """원장 기반 권고 생성 (이미 pending 인 동일 종류는 중복 생성 안 함)."""
    since = time.time() - hours * 3600
    pending = {(r["agent"], r["kind"]) for r in
               db.q("SELECT agent, kind FROM recommendations WHERE status='pending'")}
    created = []

    def add(agent, kind, title, body, action: dict | None, est: float):
        if (agent, kind) in pending:
            return
        db.ex("""INSERT INTO recommendations(ts,agent,kind,title,body,action,est_saving_usd)
                 VALUES(?,?,?,?,?,?,?)""",
              (time.time(), agent, kind, title, body,
               json.dumps(action, ensure_ascii=False) if action else None, est))
        created.append(kind)

    # R1/R2: 강등 여지 — 비캐시·미강등 호출의 한 단계 강등 counterfactual
    rows = db.q("""SELECT agent, model, SUM(input_tokens+cache_read_tokens+cache_write_tokens) i,
                   SUM(output_tokens) o, SUM(reasoning_tokens) r, SUM(cost_usd) c, COUNT(*) n
                   FROM calls WHERE ts>=? AND cache_hit=0 AND routing_action='none' AND status='ok'
                   GROUP BY agent, model""", (since,))
    per_agent: dict = {}
    for r in rows:
        target = pricing.downgrade_of(r["model"])
        if not target:
            continue
        gain = max(0.0, (r["c"] or 0) - pricing.cost_at(target, r["i"] or 0, r["o"] or 0, r["r"] or 0))
        per_agent[r["agent"]] = per_agent.get(r["agent"], 0.0) + gain
    for agent, gain in per_agent.items():
        if gain < 0.005:
            continue
        cfg = db.q("SELECT * FROM agents WHERE agent=?", (agent,))
        if cfg and not cfg[0]["downgrade_enabled"]:
            add(agent, "enable_downgrade", f"{agent} 라우팅 강등 활성화",
                f"최근 {hours}시간 강등 미적용 호출을 한 단계 강등했다면 약 ${gain:.4f} 절감 가능했습니다. "
                f"품질 게이트가 보호하므로 활성화를 권합니다.",
                {"agent": agent, "downgrade_enabled": True}, gain)
        elif cfg and not cfg[0]["complexity_routing"]:
            add(agent, "enable_complexity_routing", f"{agent} 복잡도 기반 라우팅 제안",
                f"단순 프롬프트를 경제 모델로 자동 라우팅하면 최근 {hours}시간 기준 최대 ${gain:.4f} 추가 절감 "
                f"여지가 있습니다 (복잡도 ≤0.3 호출만, 품질 게이트 적용).",
                {"agent": agent, "complexity_routing": True}, gain * 0.5)

    # R3: 캐시 후보 — 캐시 OFF 인데 호출량 많고 입력이 짧은(반복성 높을 확률) 에이전트
    cand = db.q("""SELECT c.agent, COUNT(*) n, AVG(c.input_tokens) ai, SUM(c.cost_usd) cc
                   FROM calls c JOIN agents a ON a.agent=c.agent
                   WHERE c.ts>=? AND a.semantic_cache=0 GROUP BY c.agent
                   HAVING n>=50 AND ai<500""", (since,))
    for r in cand:
        est = (r["cc"] or 0) * 0.2
        add(r["agent"], "enable_cache", f"{r['agent']} 시맨틱 캐시 후보",
            f"호출 {r['n']}건·평균 입력 {int(r['ai'])}tok — 반복성 워크로드일 가능성이 높습니다. "
            f"히트율 20% 가정 시 약 ${est:.4f}/{hours}h 절감.",
            {"agent": r["agent"], "semantic_cache": True}, est)

    # R4: 롱테일 — p99 ≫ p50 인 에이전트는 run 한도 하향
    for a in db.q("SELECT DISTINCT agent FROM runs WHERE started>=?", (since,)):
        costs = sorted(x["total_cost"] or 0 for x in
                       db.q("SELECT total_cost FROM runs WHERE agent=? AND started>=? AND status!='running'",
                            (a["agent"], since)))
        if len(costs) < 8:
            continue
        p50 = costs[int(0.5 * (len(costs) - 1))]
        p95 = costs[int(0.95 * (len(costs) - 1))]
        p99 = costs[int(0.99 * (len(costs) - 1))]
        if p50 > 0 and p99 > p50 * 8:
            add(a["agent"], "tighten_run_cap", f"{a['agent']} run 비용 한도 하향",
                f"p99(${p99:.4f})가 p50(${p50:.4f})의 {p99/p50:.0f}배 — 폭주/과다 툴호출 롱테일. "
                f"run 한도를 p95(${p95:.4f}) 수준으로 낮추는 것을 권합니다.",
                {"agent": a["agent"], "max_cost_per_run": round(max(p95, 0.01), 4)}, (p99 - p95))

    # R5: 예산 소진 임박 (수동 검토)
    today = db.day_start()
    for b in db.q("SELECT * FROM budgets WHERE period='daily'"):
        col = "tenant" if b["scope_type"] == "tenant" else "agent"
        spent = db.q(f"SELECT COALESCE(SUM(cost_usd),0) s FROM calls WHERE {col}=? AND ts>=?",
                     (b["scope_id"], today))[0]["s"]
        if b["hard_limit"] and spent >= b["hard_limit"] * 0.8:
            add(b["scope_id"], "budget_review", f"{b['scope_id']} 일 예산 80% 소진",
                f"오늘 ${spent:.2f} / 하드컷 ${b['hard_limit']:.2f}. 한도 상향 또는 워크로드 분산을 검토하세요.",
                None, 0.0)
    return created


def apply_recommendation(rec_id: int) -> dict:
    rows = db.q("SELECT * FROM recommendations WHERE id=?", (rec_id,))
    if not rows:
        return {"ok": False, "error": "권고를 찾을 수 없음"}
    rec = rows[0]
    if rec["status"] != "pending":
        return {"ok": False, "error": f"이미 {rec['status']} 상태"}
    if not rec["action"]:
        return {"ok": False, "error": "자동 적용 불가(수동 검토 항목)"}
    act = json.loads(rec["action"])
    agent = act.get("agent", rec["agent"])
    applied = []
    for k in ("semantic_cache", "downgrade_enabled", "complexity_routing"):
        if k in act:
            db.ex(f"UPDATE agents SET {k}=? WHERE agent=?", (1 if act[k] else 0, agent))
            applied.append(f"{k}={act[k]}")
    if "max_cost_per_run" in act:
        db.ex("""INSERT INTO run_policies(agent,max_cost_per_run) VALUES(?,?)
                 ON CONFLICT(agent) DO UPDATE SET max_cost_per_run=excluded.max_cost_per_run""",
              (agent, act["max_cost_per_run"]))
        applied.append(f"max_cost_per_run={act['max_cost_per_run']}")
    db.ex("UPDATE recommendations SET status='applied', applied_ts=? WHERE id=?", (time.time(), rec_id))
    db.ex("INSERT INTO config_changes(ts,agent,description) VALUES(?,?,?)",
          (time.time(), agent, f"[권고적용] {rec['title']} ({', '.join(applied)})"))
    db.add_alert("info", "recommendation", f"agent:{agent}", f"[권고적용] {rec['title']}")
    return {"ok": True, "applied": applied}


# ================================================================ 4. 이상감지 5종
_anom_alerted: dict = {}


def _alert_once(key: str, severity: str, msg: str):
    now = time.time()
    if now - _anom_alerted.get(key, 0) > 1800:
        _anom_alerted[key] = now
        db.add_alert(severity, "anomaly", key, msg)


def detect_anomalies(hours: int = 24, write_alerts: bool = True) -> list:
    """이상감지 5종 (metis-ai anomaly-detector.ts 이식). 원장/품질 데이터 기반."""
    since = time.time() - hours * 3600
    out = []
    agents = [r["agent"] for r in db.q(
        "SELECT DISTINCT agent FROM calls WHERE ts>=? UNION SELECT DISTINCT agent FROM runs WHERE started>=?",
        (since, since))]

    for agent in agents:
        # 1) 품질 z-score 드리프트 — 입력 순서 기준 70/30 분할 (동시각 시드 데이터 대응)
        qs = [r["quality_score"] for r in db.q(
            """SELECT quality_score FROM runs WHERE agent=? AND started>=? AND quality_score IS NOT NULL
               ORDER BY started, ROWID""", (agent, since))]
        if len(qs) >= 8:
            cut = max(int(len(qs) * 0.7), 4)
            d = zscore_drift(qs[:cut], qs[cut:])
            if d and d["z"] < 0:   # 하락 드리프트만 경보
                out.append({"kind": "quality_drift", "agent": agent, "severity": "warning",
                            "message": f"{agent} 품질 드리프트: 기준 {d['baseline_mean']:.2f} → 최근 "
                                       f"{d['recent_mean']:.2f} (z={d['z']})", **d})

        # 2) 토큰 IQR 스파이크
        toks = [r["t"] for r in db.q(
            """SELECT (input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) t
               FROM calls WHERE agent=? AND ts>=? ORDER BY ts, id""", (agent, since))]
        ub = iqr_bounds(toks[:-3] if len(toks) > 8 else toks)
        if ub and toks:
            spikes = [t for t in toks[-3:] if t > ub]
            if spikes:
                out.append({"kind": "token_spike", "agent": agent, "severity": "warning",
                            "message": f"{agent} 토큰 스파이크: 최근 호출 {max(spikes):,}tok > IQR 상한 {int(ub):,}tok",
                            "value": max(spikes), "bound": int(ub)})

        # 3) 지연 추세 (선형회귀) — 호출 순서 기준 기울기
        lats = [r["latency_ms"] or 0 for r in db.q(
            "SELECT latency_ms FROM calls WHERE agent=? AND ts>=? ORDER BY ts, id", (agent, since))]
        if len(lats) >= TREND_MIN_POINTS:
            slope = linreg_slope(lats)
            base = mean(lats[:max(3, len(lats) // 3)]) or 1.0
            if slope / base > TREND_SLOPE_THRESHOLD:   # 호출당 기준선 대비 5%+ 상승 추세
                out.append({"kind": "latency_trend", "agent": agent, "severity": "info",
                            "message": f"{agent} 지연 상승 추세: 호출당 +{slope:.1f}ms (기준 {base:.0f}ms)",
                            "slope": round(slope, 2)})

        # 4) 에러 서지 — 입력 순서 기준 70/30 분할 (동시각 데이터에도 동작)
        errs = [1.0 if r["status"] != "ok" else 0.0 for r in db.q(
            "SELECT status FROM calls WHERE agent=? AND ts>=? ORDER BY ts, id", (agent, since))]
        if len(errs) >= 10:
            cut = max(int(len(errs) * 0.7), 5)
            b_rate, r_rate = mean(errs[:cut]), mean(errs[cut:])
            if len(errs) - cut >= 3 and error_surge(b_rate, r_rate):
                out.append({"kind": "error_surge", "agent": agent, "severity": "critical",
                            "message": f"{agent} 에러 서지: {b_rate*100:.0f}% → {r_rate*100:.0f}% "
                                       f"(최근 {len(errs)-cut}건)", "baseline": b_rate, "recent": r_rate})

    # 5) 거버넌스 패턴 — 캐시 차단(DENY) 비율 급증 (전 테넌트, 순서 70/30 분할)
    dens = [1.0 if (r["cache_decision"] or "").startswith("DENY") else 0.0 for r in db.q(
        "SELECT cache_decision FROM calls WHERE ts>=? ORDER BY ts, id", (since,))]
    if len(dens) >= 15:
        cut = max(int(len(dens) * 0.7), 10)
        b_rate, r_rate = mean(dens[:cut]), mean(dens[cut:])
        if len(dens) - cut >= 5 and (r_rate - b_rate) >= 0.25:
            out.append({"kind": "governance_pattern", "agent": "*", "severity": "warning",
                        "message": f"거버넌스 차단 비율 급증: {b_rate*100:.0f}% → {r_rate*100:.0f}% — "
                                   f"민감/고위험 트래픽 유입 점검 필요"})

    if write_alerts:
        for f in out:
            _alert_once(f"{f['kind']}:{f.get('agent','*')}", f["severity"], f["message"])
    return out


# ================================================================ 5. 품질 회귀 가드레일
def quality_guard(hours: int = 24, drop_pct: float = GUARD_DROP_PCT,
                  auto_revert: bool = None, agent: str = "") -> list:
    """강등된 run 품질이 비강등 run 대비 drop_pct% 이상 낮으면 감지 + (옵션) 자동 원복.

    metis-ai finops-insight.service.ts 의 qualityRegressions + revertAgentToSafeTiers 이식.
    """
    if auto_revert is None:
        auto_revert = AUTO_REVERT
    since = time.time() - hours * 3600
    where, args = "", [since]
    if agent:
        where, args = "AND r.agent=?", [since, agent]
    rows = db.q(f"""SELECT r.agent,
                    AVG(CASE WHEN d.n>0 THEN r.quality_score END) low_q,
                    SUM(CASE WHEN d.n>0 THEN 1 ELSE 0 END) low_n,
                    AVG(CASE WHEN d.n=0 THEN r.quality_score END) high_q,
                    SUM(CASE WHEN d.n=0 THEN 1 ELSE 0 END) high_n
                    FROM runs r
                    JOIN (SELECT run_id, SUM(CASE WHEN routing_action='downgrade' THEN 1 ELSE 0 END) n
                          FROM calls GROUP BY run_id) d ON d.run_id=r.run_id
                    WHERE r.started>=? AND r.quality_score IS NOT NULL {where}
                    GROUP BY r.agent""", args)
    findings = []
    for r in rows:
        if (r["low_n"] or 0) < 5 or (r["high_n"] or 0) < 5 or not r["high_q"]:
            continue
        drop = (r["high_q"] - (r["low_q"] or 0)) / r["high_q"] * 100
        if drop < drop_pct:
            continue
        f = {"agent": r["agent"], "high_q": round(r["high_q"], 3), "low_q": round(r["low_q"], 3),
             "high_n": r["high_n"], "low_n": r["low_n"], "drop_pct": round(drop, 1), "reverted": False}
        cfg = db.q("SELECT downgrade_enabled FROM agents WHERE agent=?", (r["agent"],))
        if auto_revert and cfg and cfg[0]["downgrade_enabled"]:
            db.ex("UPDATE agents SET downgrade_enabled=0 WHERE agent=?", (r["agent"],))
            db.ex("INSERT INTO config_changes(ts,agent,description) VALUES(?,?,?)",
                  (time.time(), r["agent"],
                   f"[가드레일] 강등 run 품질 {drop:.0f}% 하락 → 강등 자동 비활성(원복)"))
            db.add_alert("critical", "quality_guard", f"agent:{r['agent']}",
                         f"[가드레일] {r['agent']} 강등 품질 회귀(비강등 {f['high_q']:.2f} vs 강등 "
                         f"{f['low_q']:.2f}, -{drop:.0f}%) → 강등 자동 원복")
            f["reverted"] = True
        findings.append(f)
    return findings


def revert_agent(agent: str) -> dict:
    db.ex("UPDATE agents SET downgrade_enabled=0, complexity_routing=0 WHERE agent=?", (agent,))
    db.ex("INSERT INTO config_changes(ts,agent,description) VALUES(?,?,?)",
          (time.time(), agent, "[가드레일] 수동 원복 — 강등/복잡도 라우팅 비활성"))
    db.add_alert("warning", "quality_guard", f"agent:{agent}", f"[가드레일] {agent} 수동 원복 실행")
    return {"ok": True, "agent": agent}
