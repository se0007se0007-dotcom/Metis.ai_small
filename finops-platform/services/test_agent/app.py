"""Metis Test-Report Agent — 실동작 데모 에이전트 (:8600).

지원 언어: Python(AST+격리실행) / Java(javac 컴파일+실행) / C(gcc 컴파일+실행)
파이프라인: 정적분석 → 동적테스트 → LLM 리뷰 3스텝(Gateway 경유, 비용 계측)
산출물: 상세 보고서 — 화면 표시(markdown) + .md / .docx(차트·표 포함) 다운로드
"""
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

import analyzers
import report_docx


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
MODEL = os.environ.get("TEST_AGENT_MODEL", "gpt-4o")
REPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
os.makedirs(REPORT_DIR, exist_ok=True)

# metis 대시보드/이력 보고(Ingest). 둘 다 설정돼야 동작(미설정 시 조용히 스킵).
#   METIS_INGEST_URL : metis API 베이스 (예: http://host.docker.internal:4000/v1)
#   METIS_INGEST_KEY : Ingest 키(mts_...) — metis 「Ingest 키 현황」에서 발급
METIS_INGEST_URL = os.environ.get("METIS_INGEST_URL", "").rstrip("/")
METIS_INGEST_KEY = os.environ.get("METIS_INGEST_KEY", "")
METIS_AGENT_NAME = os.environ.get("METIS_AGENT_NAME", "test-report-agent")
METIS_WORKFLOW_KEY = os.environ.get("METIS_WORKFLOW_KEY", "ops-test-automation")

app = FastAPI(title="Metis Test-Report Agent")
client = httpx.Client(timeout=90.0)

TENANT, PROJECT, AGENT = "AI혁신지원센터", "qa-automation", "test-report-agent"
LANG_KO = {"python": "Python", "java": "Java", "c": "C"}


def report_to_metis(*, input_text: str, output_text: str, model: str,
                    latency_ms: int, cost_usd: float, status: str) -> None:
    """실행 결과를 metis Ingest(/ingest/runs)로 best-effort 보고 → 대시보드/이력 + 4게이트.
    URL/KEY 미설정 시 no-op. 실패해도 본 실행에는 영향 없음."""
    if not METIS_INGEST_URL or not METIS_INGEST_KEY:
        return
    try:
        client.post(
            f"{METIS_INGEST_URL}/ingest/runs",
            headers={"Authorization": f"Bearer {METIS_INGEST_KEY}"},
            json={
                "agentName": METIS_AGENT_NAME,
                "workflowKey": METIS_WORKFLOW_KEY,
                "input": input_text[:8000],
                "output": output_text[:20000],
                "model": model,
                "latencyMs": int(latency_ms),
                "costUsd": float(cost_usd or 0),
                "status": status,
            },
            timeout=20.0,
        )
    except Exception:
        pass


# ---------------------------------------------------------------- LLM (Gateway 경유)
def llm_step(run_id: str, step: int, task: str, prompt: str) -> tuple:
    try:
        r = client.post(f"{GATEWAY}/v1/chat/completions",
                        headers={"X-Metis-Tenant": quote(TENANT), "X-Metis-Project": quote(PROJECT),
                                 "X-Metis-Agent": quote(AGENT), "X-Metis-Run-Id": run_id,
                                 "X-Metis-Step": str(step), "X-Metis-Task-Type": task},
                        json={"model": MODEL, "max_tokens": 800,
                              "messages": [{"role": "system",
                                            "content": "당신은 시니어 코드 리뷰어입니다. 한국어로 간결하고 구체적으로 답하세요. "
                                                       "마크다운 헤더 없이 문장과 짧은 목록으로만 답하세요."},
                                           {"role": "user", "content": prompt}]})
        if r.status_code != 200:
            return None, f"gateway:{r.status_code}"
        d = r.json()
        provider = (d.get("metis") or {}).get("provider")
        text = d["choices"][0]["message"]["content"]
        return (text if provider in ("openai", "azure", "anthropic") else None), provider
    except httpx.HTTPError as e:
        return None, f"error:{e}"


def fallback_commentary(kind: str, lang: str, sa: dict, dy: dict) -> str:
    crit = [i for i in sa["issues"] if i["sev"] == "critical"]
    warn = [i for i in sa["issues"] if i["sev"] == "warning"]
    fails = [t for t in dy.get("func_tests", []) if t["status"] == "fail"]
    if kind == "summary":
        return (f"{LANG_KO[lang]} 소스 {sa['lines']}줄, 함수/메서드 {len(sa['functions'])}개, "
                f"클래스 {len(sa['classes'])}개로 구성. 심각 {len(crit)}건·경고 {len(warn)}건 검출. "
                + ("동적 테스트(컴파일/실행)는 정상입니다." if dy.get("ok") else
                   f"동적 테스트 실패: {dy.get('error')}"))
    if kind == "risk":
        if crit:
            return "시급 리스크: " + "; ".join(f"L{i['line']} {i['msg']}" for i in crit[:3]) + ". 배포 전 수정 필수."
        if fails:
            return "실행 테스트 실패: " + ", ".join(f"{t['name']}({t['detail']})" for t in fails[:3])
        return "치명적 리스크 없음. 경고 수준 이슈는 리팩토링 시 처리 가능."
    return "권고: 문서화율 80% 이상 확보, 검출된 보안 패턴 교체, 실패 케이스의 단위 테스트 고정 후 수정."


# ---------------------------------------------------------------- 점수/마크다운
def compute_scores(sa, dy):
    ft = dy.get("func_tests", [])
    n_pass = sum(1 for t in ft if t["status"] == "pass")
    n_fail = sum(1 for t in ft if t["status"] == "fail")
    n_skip = sum(1 for t in ft if t["status"] == "skipped")
    crit = [i for i in sa["issues"] if i["sev"] == "critical"]
    warn = [i for i in sa["issues"] if i["sev"] == "warning"]
    info = [i for i in sa["issues"] if i["sev"] == "info"]
    doc = sa["docstring_coverage"]
    s = {"struct": max(0, 100 - min(60, len(warn) * 10) - min(40, len(info) * 5)),
         "safety": max(0, 100 - min(100, len(crit) * 40)),
         "test": 0 if not dy.get("ok") else (int(100 * n_pass / (n_pass + n_fail)) if (n_pass + n_fail) else 70),
         "doc": int((doc or 0) * 100)}
    total = int(s["struct"] * .25 + s["safety"] * .35 + s["test"] * .25 + s["doc"] * .15)
    verdict = "통과" if total >= 80 and not crit and dy.get("ok") else \
              "조건부 통과 (이슈 수정 권장)" if total >= 60 and dy.get("ok") else "실패"
    return s, total, verdict, dict(n_pass=n_pass, n_fail=n_fail, n_skip=n_skip,
                                   n_crit=len(crit), n_warn=len(warn), n_info=len(info),
                                   doc_cov_pct=(f"{int((doc or 0)*100)}%" if doc is not None else "N/A"))


def build_markdown(data: dict) -> str:
    sa, dy = data["static"], data["dynamic"]
    sev_icon = {"critical": "🔴", "warning": "🟡", "info": "🔵"}
    icon = {"pass": "✅", "fail": "❌", "skipped": "⏭️"}
    a = []
    a.append(f"# 기능 테스트 보고서 — `{data['filename']}`\n")
    a.append("| 항목 | 내용 |\n|---|---|")
    a.append(f"| 생성 시각 | {data['ts']} |")
    a.append(f"| 언어 | {LANG_KO[data['language']]} ({sa['lines']}줄) |")
    a.append(f"| Run ID | `{data['run_id']}` — 대시보드 개발자 뷰에서 비용 워터폴 확인 |")
    a.append(f"| LLM 리뷰 모드 | {data['mode']} |")
    a.append(f"| 동적 테스트 | {dy.get('kind','-')} |")
    a.append(f"| **종합 판정** | **{'✅' if data['verdict']=='통과' else '⚠️' if '조건부' in data['verdict'] else '❌'} {data['verdict']} (종합 {data['total_score']}점)** |\n")
    a.append("## 1. 점수 요약\n")
    a.append("| 영역 | 점수 | 비고 |\n|---|---|---|")
    a.append(f"| 구조 품질 | {data['scores']['struct']} | 경고 {data['n_warn']}건, 정보 {data['n_info']}건 |")
    a.append(f"| 안전성 | {data['scores']['safety']} | 심각 이슈 {data['n_crit']}건 |")
    a.append(f"| 동적 테스트 | {data['scores']['test']} | pass {data['n_pass']} / fail {data['n_fail']} / skip {data['n_skip']} |")
    a.append(f"| 문서화 | {data['scores']['doc']} | 커버리지 {data['doc_cov_pct']} |\n")
    a.append("## 2. 정적 분석\n")
    if not sa["syntax_ok"]:
        a.append(f"**구문 오류**: `{sa['syntax_error']}`\n")
    if sa["functions"]:
        a.append("| 함수/메서드 | 라인 | 인자 | 문서화 |\n|---|---|---|---|")
        for f in sa["functions"][:30]:
            a.append(f"| `{f['name']}` | {f['line']} | {f['args']} | {'✓' if f.get('doc') else '✗'} |")
        a.append("")
    if sa["classes"]:
        a.append("클래스: " + ", ".join(f"`{c['name']}`" for c in sa["classes"]) + "\n")
    a.append("## 3. 발견된 이슈\n")
    if sa["issues"]:
        for i in sorted(sa["issues"], key=lambda x: {"critical": 0, "warning": 1, "info": 2}[x["sev"]]):
            a.append(f"- {sev_icon[i['sev']]} **L{i['line']}** — {i['msg']}")
    else:
        a.append("- 발견된 이슈 없음")
    a.append("\n## 4. 동적 테스트\n")
    a.append(f"- 방식: {dy.get('kind','-')} · 결과: {'✅ 성공' if dy.get('ok') else '❌ 실패'}"
             + (f" — {dy.get('error')}" if dy.get("error") else ""))
    for n in dy.get("notes", []):
        a.append(f"- ※ {n}")
    if dy.get("doctests") and dy["doctests"]["attempted"]:
        a.append(f"- doctest: {dy['doctests']['attempted']}건 중 {dy['doctests']['failed']}건 실패")
    if dy.get("func_tests"):
        a.append("\n| 테스트 | 결과 | 상세 |\n|---|---|---|")
        for t in dy["func_tests"]:
            a.append(f"| `{t['name']}` | {icon[t['status']]} {t['status']} | {t['detail']} |")
    a.append("\n## 5. LLM 코드 리뷰\n")
    a.append(f"### 5.1 요약\n{data['reviews']['summary']}\n")
    a.append(f"### 5.2 리스크 평가\n{data['reviews']['risk']}\n")
    a.append(f"### 5.3 개선 권고\n{data['reviews']['recommend']}\n")
    a.append("## 6. FinOps 텔레메트리\n")
    tel = data.get("telemetry")
    if tel:
        a.append("| 항목 | 값 |\n|---|---|")
        a.append(f"| LLM 호출 | {tel['steps']}회 |")
        a.append(f"| 총 토큰 | {tel['tokens']:,} |")
        a.append(f"| 총 비용 | ${tel['cost']:.6f} |")
        a.append(f"| 절감액 | ${tel['savings']:.6f} |")
    else:
        a.append("텔레메트리 조회 실패")
    a.append("\n---\n*Metis FinOps Test-Report Agent — 모든 LLM 호출은 FinOps Gateway 를 경유합니다.*")
    return "\n".join(a)


# ---------------------------------------------------------------- API
def _prune_reports(keep: int = 50) -> None:
    """보고서 디렉토리 누적 방지 — run_id별(md/json/docx) 최근 keep개만 유지."""
    try:
        ids = {}
        for f in os.listdir(REPORT_DIR):
            rid, _, ext = f.rpartition(".")
            if rid:
                ids.setdefault(rid, os.path.getmtime(os.path.join(REPORT_DIR, f)))
        old = sorted(ids.items(), key=lambda x: x[1])[:-keep] if len(ids) > keep else []
        for rid, _ in old:
            for ext in ("md", "json", "docx"):
                p = os.path.join(REPORT_DIR, f"{rid}.{ext}")
                if os.path.exists(p):
                    os.remove(p)
    except OSError:
        pass


class TestReq(BaseModel):
    filename: str = "uploaded.py"
    code: str


@app.post("/api/test")
def run_test(req: TestReq):
    run_id = f"qa-{uuid.uuid4().hex[:10]}"
    t0 = time.time()
    lang = analyzers.detect_language(req.filename, req.code)

    sa = analyzers.analyze(lang, req.code)
    dy = analyzers.run_dynamic(lang, req.code, sa["syntax_ok"])
    ts_analysis = time.time()  # 정적+동적 분석 끝

    snippet = req.code[:4000]
    issues_txt = "\n".join(f"L{i['line']} [{i['sev']}] {i['msg']}" for i in sa["issues"]) or "없음"
    dyn_txt = json.dumps({k: dy.get(k) for k in ("ok", "error", "kind", "notes")}, ensure_ascii=False)

    # LLM 3콜은 서로 독립이라 병렬 실행 — 전체 소요가 '합'이 아니라 '가장 느린 1콜'에 수렴.
    _specs = [
        (1, "code_summary",
         f"다음 {LANG_KO[lang]} 코드를 3~4문장으로 요약 리뷰하세요.\n```{lang}\n{snippet}\n```"),
        (2, "risk_assessment",
         f"{LANG_KO[lang]} 코드의 정적 분석 이슈:\n{issues_txt}\n동적 테스트: {dyn_txt}\n"
         f"운영 배포 관점의 리스크를 평가하세요."),
        (3, "recommendation",
         f"이슈 목록:\n{issues_txt}\n{LANG_KO[lang]} 코드 개선 권고 3~5가지를 우선순위와 함께 제시하세요."),
    ]

    def _timed_llm(spec):
        step, task, prompt = spec
        _s = time.time()
        _txt, _prov = llm_step(run_id, step, task, prompt)
        return step, _txt, _prov, round(time.time() - _s, 2)

    _res = {}
    ts_llm_start = time.time()
    with ThreadPoolExecutor(max_workers=3) as _ex:
        for step, _txt, _prov, _dur in _ex.map(_timed_llm, _specs):
            _res[step] = (_txt, _prov, _dur)
    ts_llm_done = time.time()
    t1, p1, d1 = _res[1]
    t2, p2, d2 = _res[2]
    t3, p3, d3 = _res[3]

    real = any(p in ("openai", "azure", "anthropic") for p in (p1, p2, p3))
    mode = f"실제 LLM ({p1 or p2 or p3} / {MODEL})" if real else "로컬 휴리스틱 (mock — API 키 미설정)"
    reviews = {"summary": t1 or fallback_commentary("summary", lang, sa, dy),
               "risk": t2 or fallback_commentary("risk", lang, sa, dy),
               "recommend": t3 or fallback_commentary("recommend", lang, sa, dy)}

    ts_reviews = time.time()  # LLM 3콜 + 폴백 처리 끝
    scores, total, verdict, counts = compute_scores(sa, dy)

    quality = (0.5 * (1 if dy.get("ok") else 0)
               + 0.3 * (counts["n_pass"] / max(1, counts["n_pass"] + counts["n_fail"])
                        if (counts["n_pass"] + counts["n_fail"]) else 0.8)
               + 0.2 * (sa["docstring_coverage"] or 0.5))
    try:
        client.post(f"{LEDGER}/api/run/end", json={"run_id": run_id, "status": "success"})
        client.post(f"{LEDGER}/api/quality",
                    json={"run_id": run_id, "score": round(quality, 3), "passed": quality >= 0.6})
    except httpx.HTTPError:
        pass

    telemetry = None
    try:
        d = client.get(f"{LEDGER}/api/runs/detail", params={"run_id": run_id}).json()
        if d.get("run"):
            telemetry = {"steps": len(d["steps"]), "cost": d["run"]["total_cost"] or 0,
                         "tokens": d["run"]["total_tokens"] or 0,
                         "savings": sum(s["savings_usd"] or 0 for s in d["steps"]),
                         "detail": d["steps"]}
    except httpx.HTTPError:
        pass

    data = {"filename": req.filename, "language": lang, "run_id": run_id,
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"), "mode": mode,
            "static": sa, "dynamic": dy, "reviews": reviews, "scores": scores,
            "total_score": total, "verdict": verdict, **counts, "telemetry": telemetry}
    md = build_markdown(data)

    with open(os.path.join(REPORT_DIR, f"{run_id}.md"), "w", encoding="utf-8") as f:
        f.write(md)
    with open(os.path.join(REPORT_DIR, f"{run_id}.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    _prune_reports(keep=50)

    # metis 대시보드/이력 보고 (best-effort) — 비용·품질·보안·이상(4게이트)은 metis가 평가해 기록.
    ts_done = time.time()
    # ── 구간별 소요(초) — 어디서 시간이 걸리는지 한눈에. docker logs 로 확인 ──
    timings = {
        "analysis_s": round(ts_analysis - t0, 2),
        "llm1_summary_s": d1,           # 각 콜의 자체 소요(병렬이라 겹침)
        "llm2_risk_s": d2,
        "llm3_recommend_s": d3,
        "llm_wall_s": round(ts_llm_done - ts_llm_start, 2),  # 병렬 실제 소요(≈가장 느린 콜)
        "ledger_telemetry_s": round(ts_done - ts_reviews, 2),
        "report_write_s": round(time.time() - ts_done, 2),
        "total_s": round(time.time() - t0, 2),
    }
    print(
        f"[TIMING] {run_id} total={timings['total_s']}s | "
        f"analysis={timings['analysis_s']}s "
        f"llm_wall={timings['llm_wall_s']}s "
        f"(llm1={d1}s llm2={d2}s llm3={d3}s, 병렬) "
        f"ledger={timings['ledger_telemetry_s']}s report={timings['report_write_s']}s",
        flush=True,
    )

    elapsed_ms = int((time.time() - t0) * 1000)
    report_to_metis(
        input_text=f"[{req.filename}] {LANG_KO.get(lang, lang)} 코드 분석 요청 (총점 {total}, 판정 {verdict})",
        output_text=md,
        model=MODEL,
        latency_ms=elapsed_ms,
        cost_usd=(telemetry["cost"] if telemetry else 0) or 0,
        status="COMPLETED",
    )

    return {"report_id": run_id, "run_id": run_id, "markdown": md, "language": lang,
            "elapsed_s": round(time.time() - t0, 1), "mode": mode,
            "timings": timings,
            "cost_usd": telemetry["cost"] if telemetry else None}


@app.get("/api/report/{report_id}/download")
def download(report_id: str, fmt: str = "md"):
    safe = "".join(ch for ch in report_id if ch.isalnum() or ch in "-_")
    if fmt == "docx":
        jpath = os.path.join(REPORT_DIR, f"{safe}.json")
        if not os.path.exists(jpath):
            return HTMLResponse("report not found", status_code=404)
        dpath = os.path.join(REPORT_DIR, f"{safe}.docx")
        if not os.path.exists(dpath):
            with open(jpath, encoding="utf-8") as f:
                report_docx.build_docx(json.load(f), dpath)
        return FileResponse(dpath,
                            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                            filename=f"test_report_{safe}.docx")
    path = os.path.join(REPORT_DIR, f"{safe}.md")
    if not os.path.exists(path):
        return HTMLResponse("report not found", status_code=404)
    return FileResponse(path, media_type="text/markdown", filename=f"test_report_{safe}.md")


@app.get("/health")
def health():
    return {"ok": True, "service": "test-agent"}


@app.get("/")
def index():
    return HTMLResponse(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "index.html"),
                             encoding="utf-8").read())


from fastapi.staticfiles import StaticFiles  # noqa: E402
_vendor = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "vendor")
if os.path.isdir(_vendor):
    app.mount("/vendor", StaticFiles(directory=_vendor), name="vendor")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("TEST_AGENT_PORT", "8600")))
