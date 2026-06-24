"""Metis FinOps Gateway — OpenAI 호환 LLM 프록시 (L1 수집 + L3 통제 집행점).

흐름:
  1) X-Metis-* 헤더에서 귀속 컨텍스트 추출 (tenant/project/agent/run/step)
  2) Control Plane precheck → allow / downgrade(모델 교체) / escalate / block(429)
     (프롬프트 복잡도 점수를 함께 전달 — 복잡도 기반 경제모델 라우팅)
  3) 시맨틱 캐시 조회: exact-match → 임베딩 코사인 유사도(metis-ai 이식) 2단계
     히트 시 즉시 반환 + 절감 기록. 거버넌스 인지형 키(테넌트|정책해시|데이터등급) 격리.
  4) 프로바이더 호출 (OpenAI/Azure/Anthropic 실연동, 키 없으면 mock)
  5) 사용량·비용 이벤트를 Control Plane 원장에 발행
"""
import hashlib
import json
import os
import time
import uuid
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import embeddings
import providers

LEDGER = os.environ.get("LEDGER_URL", "http://127.0.0.1:8500").rstrip("/")
REDIS_URL = os.environ.get("REDIS_URL", "").strip()
# 컨트롤플레인 불통 시 동작: closed=요청 거부(운영 권장, 예산/거버넌스 우회 방지), open=통과(개발 편의)
FAIL_CLOSED = os.environ.get("METIS_FAIL_CLOSED", "0") == "1"
# 임베딩 유사도 캐시 임계 (metis-ai 기본 0.93)
SIM_THRESHOLD = float(os.environ.get("METIS_CACHE_SIM_THRESHOLD", "0.93"))
app = FastAPI(title="Metis FinOps Gateway")
_ledger = httpx.Client(timeout=10.0)
CACHE_TTL = 300

EMBED = embeddings.EmbeddingClient()


class CacheBackend:
    """시맨틱 캐시 백엔드 추상화.

    - REDIS_URL 설정 시 Redis 사용 → AKS 다중 레플리카가 캐시를 공유(운영).
    - 미설정 시 프로세스 인메모리 dict (단일 노드/개발).
    무엇을 쓰는지는 /health 에 backend 로 노출된다.
    """

    def __init__(self) -> None:
        self.kind = "memory"
        self._mem: dict = {}
        self._r = None
        if REDIS_URL:
            try:
                import redis  # optional dependency
                self._r = redis.Redis.from_url(REDIS_URL, socket_timeout=1.5, decode_responses=False)
                self._r.ping()
                self.kind = "redis"
            except Exception as e:  # Redis 불가 시 인메모리로 우아하게 폴백
                print(f"[gateway] Redis 연결 실패 → 인메모리 캐시 폴백: {e}")
                self._r = None

    def get(self, key: str, ttl: int):
        if self._r is not None:
            try:
                raw = self._r.get("metis:cache:" + key)
                return json.loads(raw) if raw else None
            except Exception:
                return None
        v = self._mem.get(key)
        if v and time.time() - v["ts"] < ttl:
            return v
        return None

    def put(self, key: str, value: dict, ttl: int) -> None:
        if self._r is not None:
            try:
                self._r.set("metis:cache:" + key, json.dumps(value), ex=ttl)
            except Exception:
                pass
            return
        self._mem[key] = value
        if len(self._mem) > 5000:
            self._mem.clear()


_cache_backend = CacheBackend()

# 임베딩 유사도 인덱스 (scope → [{key, vec, ts}]) — 레플리카 로컬 best-effort.
# 값 자체는 CacheBackend(Redis 공유 가능)에 있고, 인덱스만 로컬이므로 멀티 레플리카에서도 안전(미스만 발생).
_embed_index: dict = {}
_EMBED_INDEX_CAP = 500


def _index_put(scope: str, key: str, vec: list) -> None:
    lst = _embed_index.setdefault(scope, [])
    lst.append({"key": key, "vec": vec, "ts": time.time()})
    if len(lst) > _EMBED_INDEX_CAP:
        del lst[: len(lst) - _EMBED_INDEX_CAP]


def _index_search(scope: str, vec: list, ttl: int):
    """scope 내 TTL 유효 항목 중 best cosine. (key, similarity) 또는 (None, 0)."""
    best_key, best_sim = None, 0.0
    now = time.time()
    for e in _embed_index.get(scope, []):
        if now - e["ts"] > ttl:
            continue
        s = embeddings.cosine(vec, e["vec"])
        if s > best_sim:
            best_key, best_sim = e["key"], s
    return best_key, best_sim


def ctx_from_headers(h) -> dict:
    # 한글 등 비ASCII 값은 percent-encoding 으로 전달받아 디코딩한다
    g = lambda k, d="": unquote(h.get(k, d))
    try:
        risk = float(h.get("x-metis-risk-score", "0") or 0)
    except ValueError:
        risk = 0.0
    return {
        "tenant": g("x-metis-tenant", "unknown"),
        "project": g("x-metis-project", "default"),
        "agent": g("x-metis-agent", "unknown"),
        "agent_version": g("x-metis-agent-version", "v1"),
        "env": g("x-metis-env", "prd"),
        "run_id": g("x-metis-run-id"),
        "step": int(h.get("x-metis-step", "0") or 0),
        "task_type": g("x-metis-task-type", "general"),
        "step_signature": g("x-metis-step-signature"),
        # 거버넌스 융합 (Patent 3)
        "data_class": g("x-metis-data-class", "INTERNAL"),
        "risk_score": max(0.0, min(1.0, risk)),
        "policy_hash": g("x-metis-policy-hash"),
    }


def sim_from_headers(h) -> dict:
    return {
        "out_tokens": h.get("x-metis-sim-out-tokens"),
        "cache_read": h.get("x-metis-sim-cache-read"),
        "cache_write": h.get("x-metis-sim-cache-write"),
        "reasoning": h.get("x-metis-sim-reasoning"),
    }


def cache_scope(tenant: str, model: str, policy_hash: str = "", data_class: str = "") -> str:
    return f"{tenant}|{policy_hash}|{data_class}|{model}|"


def cache_key(tenant: str, model: str, messages: list, policy_hash: str = "", data_class: str = "") -> str:
    # 거버넌스 인지형 캐시 키 (Patent 3): 테넌트 + 정책해시 + 데이터등급 스코프로 격리.
    # 정책이 바뀌면(policy_hash 변경) 기존 캐시 조회가 자동으로 미스 처리된다.
    norm = json.dumps([(m.get("role"), str(m.get("content", "")).strip().lower()) for m in messages],
                      ensure_ascii=False)
    scope = cache_scope(tenant, model, policy_hash, data_class)
    return hashlib.sha256((scope + norm).encode()).hexdigest()


def embed_text(messages: list) -> str:
    """유사도 비교용 텍스트 — user/system 본문 결합, 시크릿 redaction, 길이 캡."""
    t = "\n".join(f"{m.get('role')}: {str(m.get('content', '')).strip().lower()}"
                  for m in messages if m.get("content"))
    return embeddings.redact_secrets(t)[:4000]


def measure_tools_saved(body: dict, headers, registry_tokens: int) -> int:
    """스킬패커 절감 실측: 에이전트 레지스트리의 전체 툴 스키마 토큰 - 실제 전송된 툴 토큰.

    클라이언트 자가신고 헤더는 레지스트리 등록값을 상한으로만 인정한다(과대신고 방지).
    """
    if registry_tokens <= 0:
        return 0
    tools = body.get("tools")
    if tools is not None:
        sent = providers.estimate_tokens(json.dumps(tools, ensure_ascii=False))
        return max(0, registry_tokens - sent)
    claimed = int(headers.get("x-metis-tools-saved-tokens", "0") or 0)
    return min(claimed, registry_tokens)


def process_request(ctx: dict, sim: dict, model: str, messages: list, max_tokens: int,
                    force_mock: bool, tools, headers, t0: float) -> dict:
    """precheck → 시맨틱 캐시 → 프로바이더 호출 → 원장 발행 공통 파이프라인.

    OpenAI(/v1/chat/completions) 와 Anthropic(/v1/messages) 엔드포인트가 공유한다.
    반환 dict 의 'kind' 로 결과를 구분: block | unavailable | provider_error | ok.
    응답 포맷팅(엔드포인트별 형태)은 호출자가 담당한다.
    """
    # ---- 1) 사전 정책 체크 (L3 통제) — 복잡도 점수 동봉 (복잡도 기반 라우팅)
    est_in = sum(providers.estimate_tokens(str(m.get("content", ""))) for m in messages)
    complexity = embeddings.complexity_score(messages, has_tools=tools is not None)
    routing_action, reasons = "none", []
    cache_policy = {"enabled": False, "ttl": CACHE_TTL}
    registry_tokens = 0
    gov = {"cache_decision": "ALLOW", "cache_allowed": True, "gov_action": "none"}
    try:
        pc = _ledger.post(f"{LEDGER}/api/policy/precheck",
                          json={"ctx": ctx, "model": model, "est_input_tokens": est_in,
                                "complexity": complexity}).json()
        if pc["action"] == "block":
            return {"kind": "block", "reasons": pc["reasons"]}
        cache_policy = pc.get("semantic_cache") or cache_policy
        registry_tokens = pc.get("tool_registry_tokens") or 0
        gov = pc.get("governance") or gov
        if pc["action"] in ("downgrade", "escalate"):
            routing_action, reasons = pc["action"], pc["reasons"]
            requested_model, model = model, pc["model"]
        else:
            requested_model = model
            reasons = pc.get("reasons") or []
    except httpx.HTTPError:
        # 컨트롤플레인 불통: FAIL_CLOSED 면 요청 거부(예산/거버넌스 우회 방지),
        # 아니면 통과하되 cache_policy.enabled=False 유지 → 캐시는 항상 fail-closed(미검증 응답 미제공)
        if FAIL_CLOSED:
            return {"kind": "unavailable"}
        requested_model = model

    # 시맨틱 캐시 적용 여부: 레지스트리 정책 AND 거버넌스 판정(민감/고위험 차단)이 모두 허용해야 함
    cacheable = (cache_policy["enabled"] and gov.get("cache_allowed", True)
                 and headers.get("x-metis-cacheable") != "0")
    ttl = cache_policy.get("ttl") or CACHE_TTL

    # ---- 2) 시맨틱 캐시 조회 — 1단계 exact-match, 2단계 임베딩 유사도 (둘 다 거버넌스 스코프)
    key = cache_key(ctx["tenant"], model, messages, ctx.get("policy_hash", ""), ctx.get("data_class", ""))
    scope = cache_scope(ctx["tenant"], model, ctx.get("policy_hash", ""), ctx.get("data_class", ""))
    now = time.time()
    cache_kind, cache_sim, query_vec = None, 0.0, None
    hit = _cache_backend.get(key, ttl) if cacheable else None
    if hit:
        cache_kind = "exact"
    elif cacheable:
        # 임베딩은 캐시 허용 요청만 수행 → 민감/고위험 prompt 는 외부 임베딩 API 로도 안 나간다
        query_vec = EMBED.embed(embed_text(messages), allow_external=not force_mock)
        if query_vec:
            k2, s = _index_search(scope, query_vec, ttl)
            if k2 and s >= SIM_THRESHOLD:
                hit = _cache_backend.get(k2, ttl)
                if hit:
                    cache_kind, cache_sim = "semantic_embedding", round(s, 3)
    if hit:
        report(ctx, "cache", model, requested_model, {"input_tokens": 0, "output_tokens": 0,
               "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0},
               (time.time() - t0) * 1000, routing_action, cache_hit=True, cached_cost=hit["cost"],
               cache_decision=gov.get("cache_decision", "ALLOW"), gov_action=gov.get("gov_action", "none"))
        return {"kind": "ok", "model": model, "text": hit["text"], "usage": hit["usage"],
                "provider": "cache", "routing_action": routing_action, "reasons": reasons,
                "cache_hit": True, "cache_kind": cache_kind, "cache_sim": cache_sim,
                "complexity": complexity, "cost": hit.get("cost"), "run_total": None}

    # ---- 3) 프로바이더 호출
    try:
        text, usage, provider = providers.dispatch(model, messages, max_tokens, sim, force_mock,
                                                   tools=tools)
        status = "ok"
    except Exception as e:  # 실 API 오류도 원장에 남긴다
        text, usage, provider, status = f"[provider error] {e}", \
            {"input_tokens": est_in, "output_tokens": 0, "cache_read_tokens": 0,
             "cache_write_tokens": 0, "reasoning_tokens": 0}, "error", "error"

    latency = (time.time() - t0) * 1000

    # ---- 4) 원장 발행 (스킬패커: 레지스트리 대비 실제 전송 툴 토큰을 게이트웨이가 실측)
    tools_saved = measure_tools_saved({"tools": tools} if tools is not None else {}, headers, registry_tokens)
    ing = report(ctx, provider, model, requested_model, usage, latency, routing_action,
                 status=status, tools_saved=tools_saved,
                 cache_decision=gov.get("cache_decision", "ALLOW"), gov_action=gov.get("gov_action", "none"))

    # ---- 5) 캐시 적재 (정상 응답만 — 오염 캐시 방지) + 임베딩 인덱스 등록
    if cacheable and status == "ok" and text and not text.startswith("[provider error]"):
        _cache_backend.put(key, {"ts": now, "text": text, "usage": usage, "cost": ing.get("cost_usd", 0)}, ttl)
        if query_vec is None:
            query_vec = EMBED.embed(embed_text(messages), allow_external=not force_mock)
        if query_vec:
            _index_put(scope, key, query_vec)

    if status == "error":
        return {"kind": "provider_error", "text": text}
    return {"kind": "ok", "model": model, "text": text, "usage": usage, "provider": provider,
            "routing_action": routing_action, "reasons": reasons, "cache_hit": False,
            "cache_kind": None, "cache_sim": 0.0, "complexity": complexity,
            "cost": ing.get("cost_usd"), "run_total": ing.get("run_total_cost")}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    t0 = time.time()
    body = await request.json()
    ctx = ctx_from_headers(request.headers)
    sim = sim_from_headers(request.headers)
    model = body.get("model", "gpt-4o-mini")
    messages = body.get("messages", [])
    max_tokens = int(body.get("max_tokens") or 1024)
    force_mock = request.headers.get("x-metis-force-mock", "0") == "1"

    res = process_request(ctx, sim, model, messages, max_tokens, force_mock,
                          body.get("tools"), request.headers, t0)
    if res["kind"] == "block":
        return JSONResponse(status_code=429, content={
            "error": {"type": "metis_policy_block", "message": "; ".join(res["reasons"]),
                      "reasons": res["reasons"]}})
    if res["kind"] == "unavailable":
        return JSONResponse(status_code=503, content={
            "error": {"type": "metis_control_plane_unavailable",
                      "message": "FinOps 컨트롤플레인 불통 — 정책 검증 불가로 요청 거부(FAIL_CLOSED)"}})
    if res["kind"] == "provider_error":
        return JSONResponse(status_code=502, content={"error": {"type": "provider_error", "message": res["text"]}})
    return openai_response(res["model"], res["text"], res["usage"], res["routing_action"], res["reasons"],
                           cache_hit=res["cache_hit"], cache_kind=res["cache_kind"],
                           cache_similarity=res["cache_sim"], complexity=res["complexity"],
                           cost=res["cost"], run_total=res["run_total"], provider=res["provider"])


def report(ctx, provider, model, requested_model, usage, latency, routing_action,
           cache_hit=False, cached_cost=0.0, status="ok", tools_saved=0,
           cache_decision="ALLOW", gov_action="none") -> dict:
    # 노드 테스트 호출(x-metis-env=test)은 실제 LLM 은 수행하되 원장에 비용/절감을 기록하지
    # 않는다 → FinOps 대시보드/원장이 테스트로 오염되지 않음. (운영 호출 env=prd 만 기록.)
    if (ctx or {}).get("env") == "test":
        return {}
    try:
        r = _ledger.post(f"{LEDGER}/api/ingest", json={
            "ctx": ctx, "provider": provider, "model": model, "requested_model": requested_model,
            **usage, "latency_ms": latency, "status": status,
            "routing_action": routing_action, "cache_hit": cache_hit, "cached_cost_usd": cached_cost,
            "tools_saved_tokens": tools_saved, "cache_decision": cache_decision, "gov_action": gov_action})
        return r.json()
    except httpx.HTTPError:
        return {}


def openai_response(model, text, usage, routing_action, reasons, cache_hit=False, cost=None,
                    run_total=None, provider=None, cache_kind=None, cache_similarity=0.0,
                    complexity=None):
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": usage["input_tokens"] + usage["cache_read_tokens"] + usage["cache_write_tokens"],
            "completion_tokens": usage["output_tokens"] + usage["reasoning_tokens"],
            "total_tokens": sum(usage.values()),
        },
        "metis": {"routing_action": routing_action, "reasons": reasons, "cache_hit": cache_hit,
                  "cache_kind": cache_kind, "cache_similarity": cache_similarity,
                  "complexity": complexity,
                  "cost_usd": cost, "run_total_cost_usd": run_total, "provider": provider},
    }


def _anthropic_to_messages(body: dict) -> list:
    """Anthropic Messages 요청을 내부 파이프라인용 messages(list[{role,content}])로 변환.

    - system: 문자열 또는 [{type:text,text}] 블록 → role='system' 메시지로 편입
      (call_anthropic 가 다시 system 으로 분리하므로 왕복 안전)
    - 각 메시지 content: 문자열 또는 블록 배열 → text 만 결합
    """
    out = []
    system = body.get("system")
    if isinstance(system, list):
        system = "\n".join(b.get("text", "") for b in system if isinstance(b, dict))
    if system:
        out.append({"role": "system", "content": system})
    for m in body.get("messages", []):
        c = m.get("content")
        if isinstance(c, list):
            c = "".join(b.get("text", "") for b in c
                        if isinstance(b, dict) and b.get("type") == "text")
        out.append({"role": m.get("role", "user"), "content": c or ""})
    return out


def anthropic_response(model, text, usage, routing_action, reasons, cache_hit=False, cost=None,
                       run_total=None, provider=None, cache_kind=None, cache_similarity=0.0,
                       complexity=None):
    """Anthropic Messages API 응답 형태로 직렬화 (metis callAnthropic 가 기대하는 구조)."""
    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage["input_tokens"] + usage["cache_read_tokens"],
            "output_tokens": usage["output_tokens"] + usage["reasoning_tokens"],
            "cache_read_input_tokens": usage["cache_read_tokens"],
            "cache_creation_input_tokens": usage["cache_write_tokens"],
        },
        "metis": {"routing_action": routing_action, "reasons": reasons, "cache_hit": cache_hit,
                  "cache_kind": cache_kind, "cache_similarity": cache_similarity,
                  "complexity": complexity,
                  "cost_usd": cost, "run_total_cost_usd": run_total, "provider": provider},
    }


@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    """Anthropic 호환 입구 — metis 의 네이티브 claude 호출을 FinOps 파이프라인으로 통과시킨다.

    metis 가 ANTHROPIC_BASE_URL=게이트웨이 로 설정하면 claude 비용/절감도 동일 run_id 에
    귀속되어 원장·재무 탭에 반영된다. 실제 egress 는 providers.call_anthropic 가 담당.
    """
    t0 = time.time()
    body = await request.json()
    ctx = ctx_from_headers(request.headers)
    sim = sim_from_headers(request.headers)
    model = body.get("model", "claude-haiku-4-5-20251001")
    max_tokens = int(body.get("max_tokens") or 1024)
    force_mock = request.headers.get("x-metis-force-mock", "0") == "1"
    messages = _anthropic_to_messages(body)

    res = process_request(ctx, sim, model, messages, max_tokens, force_mock,
                          body.get("tools"), request.headers, t0)
    if res["kind"] == "block":
        return JSONResponse(status_code=429, content={
            "type": "error",
            "error": {"type": "metis_policy_block", "message": "; ".join(res["reasons"]),
                      "reasons": res["reasons"]}})
    if res["kind"] == "unavailable":
        return JSONResponse(status_code=503, content={
            "type": "error",
            "error": {"type": "metis_control_plane_unavailable",
                      "message": "FinOps 컨트롤플레인 불통 — 정책 검증 불가로 요청 거부(FAIL_CLOSED)"}})
    if res["kind"] == "provider_error":
        return JSONResponse(status_code=502, content={
            "type": "error", "error": {"type": "provider_error", "message": res["text"]}})
    return anthropic_response(res["model"], res["text"], res["usage"], res["routing_action"], res["reasons"],
                              cache_hit=res["cache_hit"], cache_kind=res["cache_kind"],
                              cache_similarity=res["cache_sim"], complexity=res["complexity"],
                              cost=res["cost"], run_total=res["run_total"], provider=res["provider"])


@app.get("/health")
def health():
    return {"ok": True, "service": "gateway", "cache_backend": _cache_backend.kind,
            "embed_mode": EMBED.mode, "sim_threshold": SIM_THRESHOLD,
            "fail_mode": "closed" if FAIL_CLOSED else "open"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("GATEWAY_PORT", "8400")))
