"""Metis FinOps E2E 자가 테스트 (운영 기준 v3 — metis-ai 지능 계층 이식 검증 포함).

검증 시나리오:
  1~8. 원장·캐시정책·절감회계·스킬패커·서킷브레이커·품질게이트·집계API·FOCUS (기존)
  G1~G5. 거버넌스 융합 (Patent 3)
  I1. 임베딩 유사도 시맨틱 캐시 (mock 임베딩, 유사문장 히트/상이문장 미스)
  I2. 복잡도 기반 라우팅 (단순 프롬프트 → 경제 모델, 품질게이트 경유)
  I3. 월말 예측 / What-if 시뮬레이션
  I4. 자동 권고 생성 → 적용 (정책 반영 + 감사)
  I5. 이상감지 (에러 서지 · 토큰 스파이크 · 품질 드리프트 · 지연 추세)
  I6. 품질 회귀 가드레일 자동 원복
  I7. 모델 단가 런타임 변경 → 과금 즉시 반영
  I8. FOCUS 1.4 (x_ 토큰 확장 컬럼)
사용법: python tests/e2e.py
"""
import os
import subprocess
import sys
import time
import uuid

import httpx
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CP = "http://127.0.0.1:8500"
GW = "http://127.0.0.1:8400"
c = httpx.Client(timeout=15.0)
PASS, FAIL = 0, 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


def call_gw(agent, tenant, run_id, step, model, prompt, **kw):
    headers = {
        "X-Metis-Tenant": quote(tenant), "X-Metis-Agent": quote(agent), "X-Metis-Run-Id": run_id,
        "X-Metis-Step": str(step), "X-Metis-Force-Mock": "1",
        "X-Metis-Data-Class": kw.get("data_class", "INTERNAL"),
        "X-Metis-Risk-Score": str(kw.get("risk_score", 0.0)),
        "X-Metis-Policy-Hash": kw.get("policy_hash", "pol-v1"),
    }
    for h, k in [("X-Metis-Step-Signature", "sig"), ("X-Metis-Sim-Out-Tokens", "out"),
                 ("X-Metis-Sim-Cache-Read", "cache_read"), ("X-Metis-Sim-Cache-Write", "cache_write"),
                 ("X-Metis-Sim-Reasoning", "reasoning")]:
        if kw.get(k):
            headers[h] = str(kw[k])
    body = {"model": model, "messages": [{"role": "user", "content": prompt}]}
    if kw.get("tools") is not None:
        body["tools"] = kw["tools"]
    return c.post(f"{GW}/v1/chat/completions", headers=headers, json=body)


def ingest(agent, tenant, run_id, step, model, *, requested=None, inp=200, out=200,
           reasoning=0, latency=120, status="ok", routing="none"):
    """원장 직접 시딩 (시드 데이터로 이상감지/가드레일 검증)."""
    return c.post(f"{CP}/api/ingest", json={
        "ctx": {"tenant": tenant, "agent": agent, "run_id": run_id, "step": step},
        "provider": "mock", "model": model, "requested_model": requested or model,
        "input_tokens": inp, "output_tokens": out, "reasoning_tokens": reasoning,
        "latency_ms": latency, "status": status, "routing_action": routing})


def end_run(run_id, status="success", score=None):
    c.post(f"{CP}/api/run/end", json={"run_id": run_id, "status": status})
    if score is not None:
        c.post(f"{CP}/api/quality", json={"run_id": run_id, "score": score, "passed": score >= 0.8})


def agent_row(agent):
    return next(r for r in c.get(f"{CP}/api/agents").json()["rows"] if r["agent"] == agent)


def main():
    env = dict(os.environ)
    env["METIS_DB"] = "/tmp/metis_e2e_v2/metis.db"
    env["METIS_EMBED_MOCK"] = "1"                 # 임베딩: 결정적 mock (외부 호출 없음)
    env["METIS_CACHE_SIM_THRESHOLD"] = "0.6"      # e2e 유사문장 임계
    env["METIS_AUTO_REVERT"] = "1"
    os.makedirs("/tmp/metis_e2e_v2", exist_ok=True)
    for f in os.listdir("/tmp/metis_e2e_v2"):
        os.remove(os.path.join("/tmp/metis_e2e_v2", f))
    procs = [
        subprocess.Popen([sys.executable, os.path.join(ROOT, "services/control_plane/app.py")],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
        subprocess.Popen([sys.executable, os.path.join(ROOT, "services/gateway/app.py")],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
    ]
    rc = 1
    try:
        for _ in range(30):
            try:
                if c.get(f"{CP}/api/health").status_code == 200 and c.get(f"{GW}/health").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        else:
            print("서비스 기동 실패")
            return
        print("== 서비스 기동 완료 ==")
        gh = c.get(f"{GW}/health").json()
        check("게이트웨이 임베딩 mock 모드", gh.get("embed_mode") == "mock", str(gh))

        # 1) 기본 호출
        rid = f"e2e-basic-{uuid.uuid4().hex[:6]}"
        r = call_gw("report-writer", "ICT AX사업팀", rid, 1, "gpt-5", "기본 호출 테스트", out=500)
        m = r.json().get("metis", {})
        check("기본 호출 200", r.status_code == 200)
        check("비용 계산됨", (m.get("cost_usd") or 0) > 0, str(m))
        d = c.get(f"{CP}/api/runs/detail", params={"run_id": rid}).json()
        check("원장 기록 + 한글 테넌트", d["run"] and d["run"]["tenant"] == "ICT AX사업팀")

        # 2) 중앙 캐시 정책
        rid2 = f"e2e-cache-{uuid.uuid4().hex[:6]}"
        call_gw("cs-relay-bot", "CRM사업팀", rid2, 1, "claude-haiku-4-5", "포인트 소멸 기한 알려줘", out=100)
        r2 = call_gw("cs-relay-bot", "CRM사업팀", rid2, 2, "claude-haiku-4-5", "포인트 소멸 기한 알려줘")
        check("중앙 정책 캐시 히트 (cs-relay-bot, 헤더 불필요)", r2.json()["metis"]["cache_hit"] is True)
        check("exact 캐시 종류 표기", r2.json()["metis"]["cache_kind"] == "exact", str(r2.json()["metis"]))
        rw1 = call_gw("report-writer", "ICT AX사업팀", rid2 + "a", 1, "gpt-5", "동일 질문 캐시 테스트", out=100)
        rw2 = call_gw("report-writer", "ICT AX사업팀", rid2 + "a", 2, "gpt-5", "동일 질문 캐시 테스트", out=100)
        check("캐시 미적용 에이전트는 캐시 안 됨 (report-writer)", rw2.json()["metis"]["cache_hit"] is False)
        # 테넌트 격리: 같은 질문이라도 다른 테넌트면 캐시 미스
        r3 = call_gw("cs-relay-bot", "오픈채널서비스팀", rid2 + "b", 1, "claude-haiku-4-5", "포인트 소멸 기한 알려줘", out=100)
        check("테넌트 스코프 캐시 격리", r3.json()["metis"]["cache_hit"] is False)

        # 3) prefix 캐시 절감
        call_gw("report-writer", "ICT AX사업팀", f"e2e-px-{uuid.uuid4().hex[:6]}", 1, "gpt-5",
                "프리픽스 캐시", out=200, cache_read=2000)
        kinds = {x["savings_kind"] for x in c.get(f"{CP}/api/savings?hours=1").json()["by_kind"]}
        check("절감 회계: prompt_cache", "prompt_cache" in kinds, str(kinds))
        check("절감 회계: semantic_cache", "semantic_cache" in kinds, str(kinds))

        # 4) 스킬패커 실측 (code-review-agent 레지스트리 5500 토큰)
        tools = [{"type": "function", "function": {"name": "read_diff", "description": "diff 읽기",
                  "parameters": {"type": "object", "properties": {"id": {"type": "string"}}}}}]
        call_gw("code-review-agent", "AI혁신지원센터", f"e2e-sp-{uuid.uuid4().hex[:6]}", 1,
                "claude-sonnet-4-6", "스킬패커 테스트", out=100, tools=tools)
        sv = c.get(f"{CP}/api/savings?hours=1").json()["by_kind"]
        sp = next((x for x in sv if x["savings_kind"] == "skill_packer"), None)
        check("스킬패커 실측 절감 기록", sp is not None and sp["s"] > 0, str(sv))
        # 레지스트리 미등록 에이전트의 자가신고는 무시됨
        r = c.post(f"{GW}/v1/chat/completions",
                   headers={"X-Metis-Tenant": "RnD", "X-Metis-Agent": "no-registry-agent",
                            "X-Metis-Run-Id": "e2e-nr-1", "X-Metis-Step": "1",
                            "X-Metis-Force-Mock": "1", "X-Metis-Tools-Saved-Tokens": "99999"},
                   json={"model": "gpt-5", "messages": [{"role": "user", "content": "hi"}]})
        det = c.get(f"{CP}/api/runs/detail", params={"run_id": "e2e-nr-1"}).json()
        check("미등록 에이전트 과대신고 차단", det["steps"][0]["savings_kind"] != "skill_packer",
              str(det["steps"][0]["savings_kind"]))

        # 5) 폭주 루프 서킷브레이커
        rid4 = f"e2e-loop-{uuid.uuid4().hex[:6]}"
        blocked = False
        for s in range(1, 12):
            r = call_gw("runaway-test-agent", "kt", rid4, s, "gpt-5", "반복",
                        sig="tool:same:call", out=300)
            if r.status_code == 429:
                blocked = True
                break
        check("루프 감지 → 차단", blocked)

        # 6) 품질 게이트
        g0 = agent_row("cs-relay-bot")["gate"]
        check("게이트 초기 상태 = canary (데이터 없음)", g0 and g0["status"] == "canary", str(g0))
        # 강등 대상(qwen3-72b-local) 품질 시딩: 12개 run
        for i in range(12):
            srid = f"e2e-seed-{i}-{uuid.uuid4().hex[:4]}"
            call_gw("cs-relay-bot", "CRM사업팀", srid, 1, "qwen3-72b-local", f"시딩 {i}", out=80)
            end_run(srid, "success", 0.9)
        g1 = agent_row("cs-relay-bot")["gate"]
        check("품질 시딩 후 게이트 = approved", g1 and g1["status"] == "approved", str(g1))
        # 이제 run 비용 한도 → 강등이 게이트 통과 후 적용됨
        rid5 = f"e2e-cost-{uuid.uuid4().hex[:6]}"
        saw_down, saw_block = False, False
        for s in range(1, 40):
            r = call_gw("cs-relay-bot", "CRM사업팀", rid5, s, "claude-haiku-4-5", f"한도 {s}-{uuid.uuid4().hex[:4]}", out=4000)
            if r.status_code == 429:
                saw_block = True
                break
            if r.json()["metis"]["routing_action"] == "downgrade":
                saw_down = True
        check("게이트 통과 후 강등 적용", saw_down)
        check("run 한도 최종 차단", saw_block)

        # 7) 집계·정책 API
        end_run(rid, "success", 0.9)
        ov = c.get(f"{CP}/api/overview").json()
        check("cost-of-pass 계산", ov["cost_of_pass"] is not None and ov["cost_of_pass"] > 0)
        al = c.get(f"{CP}/api/alerts").json()["rows"]
        check("서킷브레이커 알림", any(a["kind"] == "circuit_breaker" for a in al))
        ag = c.get(f"{CP}/api/agents").json()["rows"]
        cs = next(a for a in ag if a["agent"] == "cs-relay-bot")
        crv = next(a for a in ag if a["agent"] == "code-review-agent")
        check("레지스트리: cs-relay-bot 시맨틱 캐시 적용 표시", cs["semantic_cache"] == 1)
        check("레지스트리: code-review 툴 5500 토큰", crv["tool_registry_tokens"] == 5500)
        nr = next((a for a in ag if a["agent"] == "no-registry-agent"), None)
        check("미등록 에이전트 자동 등록(캐시 OFF)", nr is not None and nr["semantic_cache"] == 0)
        # 정책 토글
        c.post(f"{CP}/api/agents/update", json={"agent": "report-writer", "semantic_cache": True})
        check("정책 토글 반영", agent_row("report-writer")["semantic_cache"] == 1)
        st = c.get(f"{CP}/api/run_stats?hours=1").json()["rows"]
        check("run 통계(p50/p99)", len(st) > 0)
        check("인사이트 생성", len(c.get(f"{CP}/api/insights").json()["rows"]) > 0)

        # 8) FOCUS export + 대시보드
        fx = c.get(f"{CP}/api/export/focus?hours=1")
        check("FOCUS CSV export", fx.status_code == 200 and "BilledCost" in fx.text.splitlines()[0])
        idx = c.get(f"{CP}/")
        check("대시보드 서빙", idx.status_code == 200 and "Metis" in idx.text)

        # ===== 거버넌스 융합 (Patent 3) =====
        gid = f"e2e-gov-pii-{uuid.uuid4().hex[:6]}"
        call_gw("cs-relay-bot", "CRM사업팀", gid, 1, "claude-haiku-4-5", "동일 PII 질문", data_class="PII", cache_read=0, out=100)
        r = call_gw("cs-relay-bot", "CRM사업팀", gid, 2, "claude-haiku-4-5", "동일 PII 질문", data_class="PII", out=100)
        check("거버넌스: PII 캐시 차단(재사용 안됨)", r.json()["metis"]["cache_hit"] is False)
        gid2 = f"e2e-gov-ok-{uuid.uuid4().hex[:6]}"
        call_gw("cs-relay-bot", "CRM사업팀", gid2, 1, "claude-haiku-4-5", "일반 캐시질문 govok", data_class="INTERNAL", out=100)
        r2 = call_gw("cs-relay-bot", "CRM사업팀", gid2, 2, "claude-haiku-4-5", "일반 캐시질문 govok", data_class="INTERNAL", out=100)
        check("거버넌스: 일반 데이터는 캐시 정상", r2.json()["metis"]["cache_hit"] is True)
        gid3 = f"e2e-gov-ph-{uuid.uuid4().hex[:6]}"
        call_gw("cs-relay-bot", "CRM사업팀", gid3, 1, "claude-haiku-4-5", "정책해시 질문", policy_hash="pol-A", out=100)
        rA = call_gw("cs-relay-bot", "CRM사업팀", gid3, 2, "claude-haiku-4-5", "정책해시 질문", policy_hash="pol-A", out=100)
        rB = call_gw("cs-relay-bot", "CRM사업팀", gid3, 3, "claude-haiku-4-5", "정책해시 질문", policy_hash="pol-B", out=100)
        check("거버넌스: 동일 정책해시 캐시 히트", rA.json()["metis"]["cache_hit"] is True)
        check("거버넌스: 정책해시 변경 시 캐시 무효화", rB.json()["metis"]["cache_hit"] is False)
        ph = f"e2e-gov-risk-{uuid.uuid4().hex[:6]}"
        saw_escalate = False
        for s in range(1, 30):
            r = call_gw("cs-relay-bot", "CRM사업팀", ph, s, "claude-haiku-4-5",
                        f"고위험 {s}-{uuid.uuid4().hex[:4]}", risk_score=0.9, out=3000)
            if r.status_code != 200:
                break
            if r.json()["metis"]["routing_action"] == "escalate":
                saw_escalate = True
                break
        check("거버넌스: 고위험 강등 방어(상향)", saw_escalate)
        gv = c.get(f"{CP}/api/governance?hours=1").json()
        check("거버넌스 API: 캐시 차단 집계", gv["denied"] > 0, str(gv["denied"]))
        check("거버넌스 API: 민감 데이터 캐시 누출 0(준수)", gv["sensitive_leaks"] == 0, str(gv["sensitive_leaks"]))
        check("거버넌스 정책 토글", c.post(f"{CP}/api/governance/update", json={"enabled": True}).json()["ok"] is True)

        # ===== I1. 임베딩 유사도 시맨틱 캐시 (metis-ai 이식) =====
        eid = f"e2e-emb-{uuid.uuid4().hex[:6]}"
        e1 = call_gw("cs-relay-bot", "CRM사업팀", eid, 1, "claude-haiku-4-5",
                     "환불 규정 정책 문서 전체 요약 알려줘", out=120)
        check("임베딩 캐시: 최초 호출은 미스", e1.json()["metis"]["cache_hit"] is False)
        e2 = call_gw("cs-relay-bot", "CRM사업팀", eid, 2, "claude-haiku-4-5",
                     "환불 규정 정책 문서 전체 요약 알려줘요")
        m2 = e2.json()["metis"]
        check("임베딩 캐시: 유사 문장 히트", m2["cache_hit"] is True, str(m2))
        check("임베딩 캐시: 종류=semantic_embedding", m2.get("cache_kind") == "semantic_embedding", str(m2))
        check("임베딩 캐시: 유사도 ≥ 임계(0.6)", (m2.get("cache_similarity") or 0) >= 0.6, str(m2))
        e3 = call_gw("cs-relay-bot", "CRM사업팀", eid, 3, "claude-haiku-4-5", "오늘 점심 메뉴 추천 부탁", out=80)
        check("임베딩 캐시: 상이 문장은 미스", e3.json()["metis"]["cache_hit"] is False)

        # ===== I2. 복잡도 기반 라우팅 (metis-ai Model Router 이식) =====
        c.post(f"{CP}/api/agents/update", json={"agent": "cs-relay-bot", "complexity_routing": True})
        check("복잡도 라우팅 토글", agent_row("cs-relay-bot")["complexity_routing"] == 1)
        cxid = f"e2e-cx-{uuid.uuid4().hex[:6]}"
        r = call_gw("cs-relay-bot", "CRM사업팀", cxid, 1, "claude-haiku-4-5",
                    f"신규 확인 요약 목록 알려줘 {uuid.uuid4().hex[:5]}", out=100)
        mx = r.json()["metis"]
        check("복잡도 라우팅: 단순 프롬프트 강등", mx["routing_action"] == "downgrade", str(mx))
        check("복잡도 라우팅: 사유 명시", any("복잡도" in x for x in mx["reasons"]), str(mx["reasons"]))
        check("복잡도 라우팅: 복잡도 점수 응답 포함", (mx.get("complexity") or 1) <= 0.3, str(mx.get("complexity")))
        # 복잡한 프롬프트는 강등하지 않음
        r = call_gw("cs-relay-bot", "CRM사업팀", cxid, 2, "claude-haiku-4-5",
                    "전사 비용 거버넌스 아키텍처 심층 분석 및 설계 최적화 전략 보고서 " + "상세 " * 300, out=100)
        check("복잡도 라우팅: 복잡 프롬프트는 원 모델 유지", r.json()["metis"]["routing_action"] != "downgrade")
        c.post(f"{CP}/api/agents/update", json={"agent": "cs-relay-bot", "complexity_routing": False})

        # ===== I3. 월말 예측 / What-if =====
        fc = c.get(f"{CP}/api/forecast").json()
        check("예측: 월말 전망 산출", fc["projected_month_total"] > 0, str(fc))
        check("예측: 신뢰도 0..1", 0 <= fc["confidence"] <= 1)
        check("예측: 일별 시리즈 포함", isinstance(fc["daily_series"], list))
        wf = c.post(f"{CP}/api/whatif", json={"cache_ttl_multiplier": 2.0, "downgrade_aggressive": True,
                                              "skill_trim_ratio": 0.5, "hours": 1}).json()
        check("What-if: 절감 시나리오 ≥ 0", wf["savings_monthly_est"] >= 0, str(wf))
        check("What-if: 시나리오 ≤ 기준선", wf["scenario_monthly_est"] <= wf["baseline_monthly_est"] + 1e-9)
        check("What-if: 메커니즘별 분해", set(wf["breakdown"]) ==
              {"semantic_cache_ttl", "routing_downshift_all", "skill_packer_trim"}, str(wf["breakdown"]))

        # ===== I4. 자동 권고 생성 → 적용 =====
        # 강등 여지 시딩: code-review-agent 의 대형 sonnet 호출 (라우팅 미적용)
        for i in range(3):
            ingest("code-review-agent", "AI혁신지원센터", f"e2e-rec-{i}", 1, "claude-sonnet-4-6",
                   inp=3000, out=20000)
        recs = c.get(f"{CP}/api/recommendations?refresh=1").json()["rows"]
        check("권고 생성", len(recs) > 0, str(len(recs)))
        cxr = next((r for r in recs if r["kind"] == "enable_complexity_routing"
                    and r["agent"] == "code-review-agent" and r["status"] == "pending"), None)
        check("권고: code-review 복잡도 라우팅 제안", cxr is not None,
              str([(r['agent'], r['kind']) for r in recs]))
        if cxr:
            ap = c.post(f"{CP}/api/recommendations/{cxr['id']}/apply").json()
            check("권고 적용 성공", ap.get("ok") is True, str(ap))
            check("권고 적용 → 정책 반영", agent_row("code-review-agent")["complexity_routing"] == 1)
            check("권고 상태 = applied", any(r["id"] == cxr["id"] and r["status"] == "applied"
                  for r in c.get(f"{CP}/api/recommendations?refresh=0").json()["rows"]))
            c.post(f"{CP}/api/agents/update", json={"agent": "code-review-agent", "complexity_routing": False})

        # ===== I5. 이상감지 =====
        # 에러 서지: 정상 14건 후 에러 6건
        for i in range(14):
            ingest("anomaly-err-agent", "kt", f"e2e-an-e{i}", 1, "gpt-5-mini", inp=100, out=100)
        for i in range(6):
            ingest("anomaly-err-agent", "kt", f"e2e-an-ee{i}", 1, "gpt-5-mini", inp=100, out=0, status="error")
        # 토큰 스파이크: 평탄 12건 후 폭증 1건
        for i in range(12):
            ingest("anomaly-tok-agent", "kt", f"e2e-an-t{i}", 1, "gpt-5-mini", inp=500, out=500)
        ingest("anomaly-tok-agent", "kt", "e2e-an-tspike", 1, "gpt-5-mini", inp=40000, out=40000)
        # 품질 드리프트: 0.9×14 → 0.5×6
        for i in range(14):
            rid_q = f"e2e-an-q{i}"
            ingest("anomaly-q-agent", "kt", rid_q, 1, "gpt-5-mini", inp=100, out=100)
            end_run(rid_q, "success", 0.9)
        for i in range(6):
            rid_q = f"e2e-an-ql{i}"
            ingest("anomaly-q-agent", "kt", rid_q, 1, "gpt-5-mini", inp=100, out=100)
            end_run(rid_q, "success", 0.5)
        # 지연 추세: 100ms → 4000ms 점증
        for i in range(15):
            ingest("anomaly-lat-agent", "kt", f"e2e-an-l{i}", 1, "gpt-5-mini", inp=100, out=100,
                   latency=100 + i * 260)
        an = c.get(f"{CP}/api/anomalies?hours=1").json()["rows"]
        kinds_found = {a["kind"] for a in an}
        check("이상감지: 에러 서지", "error_surge" in kinds_found, str(kinds_found))
        check("이상감지: 토큰 스파이크", "token_spike" in kinds_found, str(kinds_found))
        check("이상감지: 품질 드리프트", "quality_drift" in kinds_found, str(kinds_found))
        check("이상감지: 지연 추세", "latency_trend" in kinds_found, str(kinds_found))
        al2 = c.get(f"{CP}/api/alerts?limit=100").json()["rows"]
        check("이상감지: 알림 기록", any(a["kind"] == "anomaly" for a in al2))

        # ===== I6. 품질 회귀 가드레일 자동 원복 =====
        c.post(f"{CP}/api/agents/update", json={"agent": "guard-agent", "downgrade_enabled": True})
        for i in range(6):   # 강등된 run 6건, 품질 0.5
            rid_g = f"e2e-gd-low{i}"
            ingest("guard-agent", "kt", rid_g, 1, "qwen3-72b-local",
                   requested="claude-haiku-4-5", routing="downgrade", inp=100, out=100)
            end_run(rid_g, "success", 0.5)
        for i in range(6):   # 비강등 run 6건, 품질 0.92
            rid_g = f"e2e-gd-hi{i}"
            ingest("guard-agent", "kt", rid_g, 1, "claude-haiku-4-5", inp=100, out=100)
            end_run(rid_g, "success", 0.92)
        qg = c.get(f"{CP}/api/quality_guard?hours=1&auto=1").json()
        gd = next((f for f in qg["rows"] if f["agent"] == "guard-agent"), None)
        check("가드레일: 품질 회귀 감지", gd is not None, str(qg))
        check("가드레일: 하락률 ≥ 10%", gd and gd["drop_pct"] >= 10, str(gd))
        check("가드레일: 강등 자동 원복", agent_row("guard-agent")["downgrade_enabled"] == 0)
        al3 = c.get(f"{CP}/api/alerts?limit=100").json()["rows"]
        check("가드레일: 원복 알림", any(a["kind"] == "quality_guard" for a in al3))

        # ===== I7. 모델 단가 런타임 변경 =====
        mp = c.get(f"{CP}/api/model_prices").json()
        check("단가 마스터 시드 (10종)", len(mp["rows"]) >= 10, str(len(mp["rows"])))
        c.post(f"{CP}/api/model_prices/update",
               json={"model": "qwen3-72b-local", "input_usd": 4.0, "output_usd": 4.0})
        r = call_gw("price-test-agent", "kt", f"e2e-pr-{uuid.uuid4().hex[:4]}", 1,
                    "qwen3-72b-local", "단가 반영 테스트 호출", out=1000)
        cost_new = r.json()["metis"]["cost_usd"] or 0
        check("단가 변경 즉시 과금 반영 (×10)", cost_new > 0.002, f"cost={cost_new}")
        c.post(f"{CP}/api/model_prices/update",
               json={"model": "qwen3-72b-local", "input_usd": 0.4, "output_usd": 0.4})
        r = call_gw("price-test-agent", "kt", f"e2e-pr2-{uuid.uuid4().hex[:4]}", 1,
                    "qwen3-72b-local", "단가 원복 테스트 호출", out=1000)
        check("단가 원복 반영", (r.json()["metis"]["cost_usd"] or 1) < 0.002,
              str(r.json()["metis"]["cost_usd"]))
        check("단가 정규화 (4.6→4-6)", c.post(f"{CP}/api/model_prices/update",
              json={"model": "claude-sonnet-4.6", "input_usd": 3.0}).json()["model"] == "claude-sonnet-4-6")

        # ===== I8. FOCUS 1.4 (x_ 토큰 확장) =====
        fx = c.get(f"{CP}/api/export/focus?hours=1")
        head = fx.text.splitlines()[0]
        check("FOCUS 1.4: ListCost/ContractedCost", "ListCost" in head and "ContractedCost" in head)
        check("FOCUS 1.4: x_ 토큰 확장 컬럼", "x_InputTokens" in head and "x_ReasoningTokens" in head
              and "x_DataClass" in head, head[:120])

        print(f"\n결과: PASS {PASS} / FAIL {FAIL}")
        rc = 0 if FAIL == 0 else 1
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=3)
            except Exception:
                p.kill()
    sys.exit(rc)


if __name__ == "__main__":
    main()
