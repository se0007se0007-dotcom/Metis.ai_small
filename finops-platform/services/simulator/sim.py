"""에이전트 트래픽 시뮬레이터 — Metis FinOps 데모용 가상 워크로드.

실제 Metis.AI 에 올라간 에이전트들이 게이트웨이를 경유하는 상황을 재현한다:
  - cs-relay-bot      : 고객상담 (대량·반복 질문 → 시맨틱 캐시 히트)
  - report-writer     : 보고서 생성 (멀티스텝 + prefix 캐시 토큰)
  - code-review-agent : 코드리뷰 (고가 모델 + reasoning 토큰, 롱테일 run)
  - ops-anomaly-agent : 운영 이상감지 (소액·고빈도)
  - runaway-test-agent: 주기적으로 폭주 루프 발생 → 서킷브레이커 시연

run 종료 시 품질 점수를 게시하고, 시작 3분 후 구성 변경(라우팅 전환) 이벤트를
발생시켜 '품질-비용 폐루프' 인사이트를 시연한다.
"""
import os
import random
import threading
import time
import uuid

import httpx
from urllib.parse import quote


def _load_dotenv():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

GATEWAY = os.environ.get("GATEWAY_URL", "http://127.0.0.1:8400").rstrip("/")
LEDGER = os.environ.get("LEDGER_URL", "http://127.0.0.1:8500").rstrip("/")
USE_REAL = os.environ.get("SIM_USE_REAL_API", "0") == "1"
RPS = float(os.environ.get("SIM_RPS", "0.8"))

client = httpx.Client(timeout=30.0)

FAQ_POOL = [f"요금제 {i}번 상품의 해지 위약금이 얼마인가요?" for i in range(1, 13)] + [
    "포인트 소멸 기한 알려줘", "명세서 재발급 방법", "자동이체 변경 절차", "카드 분실 신고 방법",
    "해외 결제 수수료 안내", "한도 상향 신청 조건",
]

STATE = {"cs_model": "claude-haiku-4-5", "cs_quality_mu": 0.95, "config_changed": False}


SAMPLE_TOOLS = [
    {"type": "function", "function": {"name": "read_diff", "description": "PR diff 청크를 읽는다",
     "parameters": {"type": "object", "properties": {"chunk_id": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "lint_check", "description": "정적 분석 실행",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}},
]


def call(agent, tenant, project, run_id, step, model, prompt, *, task_type="general",
         cacheable=False, sig="", out_tokens=None, cache_read=0, cache_write=0, reasoning=0,
         tools=None, data_class="INTERNAL", risk_score=0.0, policy_hash="pol-v1", max_tokens=512):
    headers = {
        "X-Metis-Tenant": quote(tenant), "X-Metis-Project": quote(project), "X-Metis-Agent": quote(agent),
        "X-Metis-Run-Id": run_id, "X-Metis-Step": str(step), "X-Metis-Task-Type": task_type,
        "X-Metis-Cacheable": "1" if cacheable else "0",
        "X-Metis-Force-Mock": "0" if USE_REAL else "1",
    }
    if sig:
        headers["X-Metis-Step-Signature"] = sig
    if out_tokens:
        headers["X-Metis-Sim-Out-Tokens"] = str(out_tokens)
    if cache_read:
        headers["X-Metis-Sim-Cache-Read"] = str(cache_read)
    if cache_write:
        headers["X-Metis-Sim-Cache-Write"] = str(cache_write)
    if reasoning:
        headers["X-Metis-Sim-Reasoning"] = str(reasoning)
    headers["X-Metis-Data-Class"] = data_class
    headers["X-Metis-Risk-Score"] = str(risk_score)
    headers["X-Metis-Policy-Hash"] = policy_hash
    body = {"model": model, "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": "당신은 ktds Metis.AI 플랫폼의 에이전트입니다."},
                         {"role": "user", "content": prompt}]}
    if tools is not None:
        body["tools"] = tools   # 동적 툴로딩: 필요한 툴만 전송 → 게이트웨이가 절감 실측
    r = client.post(f"{GATEWAY}/v1/chat/completions", headers=headers, json=body)
    return r


def end_run(run_id, status, quality_mu=None):
    try:
        client.post(f"{LEDGER}/api/run/end", json={"run_id": run_id, "status": status})
        if quality_mu is not None:
            score = max(0.0, min(1.0, random.gauss(quality_mu, 0.05)))
            client.post(f"{LEDGER}/api/quality",
                        json={"run_id": run_id, "score": round(score, 3), "passed": score >= 0.8})
    except httpx.HTTPError:
        pass


# ---------------------------------------------------------------- 시나리오
def scenario_cs_bot():
    """1~2스텝, 반복 질문 풀 → 캐시 히트 다수."""
    run_id = f"cs-{uuid.uuid4().hex[:10]}"
    # 30%는 고객 개인정보(PII)가 포함된 문의 — 거버넌스가 캐시 재사용을 차단해야 함
    pii = random.random() < 0.3
    if pii:
        q = f"고객 {random.randint(1000,9999)}님(주민번호 뒤 {random.randint(1000000,9999999)}) 계좌 조회"
        dc = "PII"
    else:
        q = random.choice(FAQ_POOL) if random.random() < 0.55 else f"고객 문의: {uuid.uuid4().hex[:6]} 건 상세 확인"
        dc = "INTERNAL"
    r = call("cs-relay-bot", "CRM사업팀", "cs-automation", run_id, 1, STATE["cs_model"], q,
             task_type="customer_qa", cacheable=True, out_tokens=random.randint(80, 220),
             data_class=dc, risk_score=round(random.uniform(0.1, 0.4), 2))
    end_run(run_id, "success" if r.status_code == 200 else "failure", STATE["cs_quality_mu"])


def scenario_report_writer():
    """3~5스텝 멀티스텝 + prefix 캐시(시스템 프롬프트/문서 고정부)."""
    run_id = f"rpt-{uuid.uuid4().hex[:10]}"
    steps = random.randint(3, 5)
    ok = True
    for s in range(1, steps + 1):
        r = call("report-writer", "ICT AX사업팀", "weekly-report", run_id, s, "gpt-5",
                 f"섹션 {s} 작성: 운영 지표 분석 {uuid.uuid4().hex[:4]}",
                 task_type="report", out_tokens=random.randint(300, 700),
                 cache_read=random.randint(800, 2000) if s > 1 else 0,
                 cache_write=1500 if s == 1 else 0)
        if r.status_code != 200:
            ok = False
            break
        time.sleep(random.uniform(0.1, 0.3))
    end_run(run_id, "success" if ok else "failure", 0.90 if ok else None)


def scenario_code_review():
    """5~14스텝, 고가 모델 + reasoning, 가끔 에스컬레이션 — 롱테일 비용의 주범."""
    run_id = f"cr-{uuid.uuid4().hex[:10]}"
    steps = random.randint(5, 14)
    ok = True
    for s in range(1, steps + 1):
        model = "claude-sonnet-4-6" if random.random() < 0.85 else "claude-opus-4-8"
        # 보안 취약점 리뷰는 고위험(riskScore↑) — 예산 압박이 있어도 강등 방어돼야 함
        risk = round(random.uniform(0.82, 0.95), 2) if random.random() < 0.35 else round(random.uniform(0.2, 0.6), 2)
        r = call("code-review-agent", "AI혁신지원센터", "metis-dev", run_id, s, model,
                 f"PR diff 청크 {s} 리뷰: 보안/성능/정합성 {uuid.uuid4().hex[:4]}",
                 task_type="code_review", out_tokens=random.randint(200, 900),
                 reasoning=random.randint(300, 1500) if random.random() < 0.4 else 0,
                 cache_read=random.randint(500, 1500) if s > 1 else 0,
                 data_class="INTERNAL", risk_score=risk,
                 # 스킬패커: 전체 레지스트리(5,500토큰) 중 필요한 툴 2개만 동적 로딩해 전송
                 tools=random.sample(SAMPLE_TOOLS, k=random.randint(1, 2)) if random.random() < 0.6 else None)
        if r.status_code == 429:   # 서킷브레이커에 걸리면 run 종료
            ok = False
            break
        if r.status_code != 200:
            ok = False
            break
        time.sleep(random.uniform(0.05, 0.2))
    if ok:
        end_run(run_id, "success", 0.86)
    # 429로 끊긴 run 은 control plane 이 이미 killed 처리


def scenario_ops_anomaly():
    run_id = f"ops-{uuid.uuid4().hex[:10]}"
    r = call("ops-anomaly-agent", "오픈채널서비스팀", "anomaly-watch", run_id, 1, "gpt-5-mini",
             f"메트릭 윈도우 {uuid.uuid4().hex[:5]} 이상 여부 판단", task_type="ops",
             out_tokens=random.randint(40, 120))
    end_run(run_id, "success" if r.status_code == 200 else "failure", 0.93)


def scenario_runaway():
    """동일 시그니처 반복 → 루프 감지 서킷브레이커 시연."""
    run_id = f"loop-{uuid.uuid4().hex[:10]}"
    for s in range(1, 30):
        r = call("runaway-test-agent", "kt", "agent-lab", run_id, s, "gpt-5",
                 "동일 도구 재시도: parse_document(file=report.pdf)",
                 task_type="loop_test", sig="tool:parse_document:report.pdf",
                 out_tokens=random.randint(400, 800))
        if r.status_code == 429:
            return  # 차단됨 (의도된 결과)
        time.sleep(0.15)
    end_run(run_id, "failure", 0.2)


def config_change_event():
    """시작 3분 후: cs-relay-bot 을 셀프호스트 경제 모델로 전환 → 품질-비용 폐루프 시연."""
    time.sleep(180)
    STATE["cs_model"] = "qwen3-72b-local"
    STATE["cs_quality_mu"] = 0.87
    STATE["config_changed"] = True
    try:
        client.post(f"{LEDGER}/api/config_change", json={
            "agent": "cs-relay-bot",
            "description": "라우팅 변경: claude-haiku-4-5 → qwen3-72b-local (셀프호스트, 비용 -60% 목표)"})
    except httpx.HTTPError:
        pass


SCENARIOS = [
    (scenario_cs_bot, 0.42),
    (scenario_ops_anomaly, 0.25),
    (scenario_report_writer, 0.18),
    (scenario_code_review, 0.15),
]


def worker():
    while True:
        x, acc = random.random(), 0.0
        for fn, w in SCENARIOS:
            acc += w
            if x <= acc:
                try:
                    fn()
                except Exception as e:
                    print("scenario error:", e)
                break
        time.sleep(max(0.05, random.expovariate(RPS)))


def runaway_worker():
    time.sleep(45)
    while True:
        try:
            scenario_runaway()
        except Exception as e:
            print("runaway error:", e)
        time.sleep(90)


def wait_ready():
    for _ in range(60):
        try:
            if client.get(f"{GATEWAY}/health").status_code == 200 and \
               client.get(f"{LEDGER}/api/health").status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(1)
    return False


if __name__ == "__main__":
    if not wait_ready():
        raise SystemExit("gateway/control-plane 가 준비되지 않았습니다.")
    print(f"[simulator] 시작 — gateway={GATEWAY}, real_api={USE_REAL}, rps={RPS}")
    threading.Thread(target=config_change_event, daemon=True).start()
    threading.Thread(target=runaway_worker, daemon=True).start()
    ths = [threading.Thread(target=worker, daemon=True) for _ in range(3)]
    for t in ths:
        t.start()
    while True:
        time.sleep(3600)
