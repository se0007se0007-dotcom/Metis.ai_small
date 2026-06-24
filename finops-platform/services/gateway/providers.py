"""LLM 프로바이더 어댑터 — OpenAI / Anthropic / Mock.

게이트웨이는 OpenAI Chat Completions 형식을 받아 프로바이더별로 변환한다.
키가 없거나 모델이 로컬(-local)이면 mock 으로 폴백해 비용 없이 테스트 가능.
반환: (text, usage dict, provider_name)
usage = {input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens}
"""
import os
import random

import httpx


def _load_dotenv():
    """프로젝트 루트의 .env 를 환경변수로 로드 (의존성 없는 간이 구현)."""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
AZURE_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "").strip().rstrip("/")
AZURE_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "").strip()
AZURE_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21").strip()
AZURE_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "").strip()  # 비우면 모델명=배포명

_client = httpx.Client(timeout=60.0)

LOREM = ("분석 결과를 요약하면 다음과 같습니다. 요청하신 항목에 대해 단계별로 검토했으며 "
         "주요 지표는 정상 범위입니다. 추가 확인이 필요한 부분은 후속 스텝에서 처리하겠습니다. ").split()


def estimate_tokens(text: str) -> int:
    # 한글/영문 혼용 대략치: 2.5자 ≈ 1토큰
    return max(1, int(len(text) / 2.5))


def call_mock(model: str, messages: list, sim: dict) -> tuple:
    """외부 호출 없는 합성 응답. sim 헤더로 토큰 구성을 제어할 수 있다."""
    inp = sum(estimate_tokens(str(m.get("content", ""))) for m in messages)
    out = int(sim.get("out_tokens") or max(30, int(random.gauss(300, 120))))
    n_words = max(5, out // 3)
    text = " ".join(random.choices(LOREM, k=n_words))
    usage = {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_tokens": int(sim.get("cache_read") or 0),
        "cache_write_tokens": int(sim.get("cache_write") or 0),
        "reasoning_tokens": int(sim.get("reasoning") or 0),
    }
    return text, usage, "mock"


def call_openai(model: str, messages: list, max_tokens: int, tools: list = None) -> tuple:
    body = {"model": model, "messages": messages, "max_tokens": max_tokens}
    if tools:
        body["tools"] = tools
    r = _client.post(f"{OPENAI_BASE}/chat/completions",
                     headers={"Authorization": f"Bearer {OPENAI_KEY}"},
                     json=body)
    r.raise_for_status()
    d = r.json()
    u = d.get("usage", {})
    det_in = u.get("prompt_tokens_details", {}) or {}
    det_out = u.get("completion_tokens_details", {}) or {}
    cached = det_in.get("cached_tokens", 0) or 0
    usage = {
        "input_tokens": (u.get("prompt_tokens", 0) or 0) - cached,
        "output_tokens": u.get("completion_tokens", 0) or 0,
        "cache_read_tokens": cached,
        "cache_write_tokens": 0,
        "reasoning_tokens": det_out.get("reasoning_tokens", 0) or 0,
    }
    text = d["choices"][0]["message"].get("content", "") if d.get("choices") else ""
    return text, usage, "openai"


def call_azure(model: str, messages: list, max_tokens: int, tools: list = None) -> tuple:
    """Azure OpenAI — 배포(deployment) 단위 호출. 기본값: 모델명 = 배포명."""
    deployment = AZURE_DEPLOYMENT or model
    url = f"{AZURE_ENDPOINT}/openai/deployments/{deployment}/chat/completions?api-version={AZURE_API_VERSION}"
    body = {"messages": messages, "max_tokens": max_tokens}
    if tools:
        body["tools"] = tools
    r = _client.post(url, headers={"api-key": AZURE_KEY}, json=body)
    r.raise_for_status()
    d = r.json()
    u = d.get("usage", {})
    det_in = u.get("prompt_tokens_details", {}) or {}
    det_out = u.get("completion_tokens_details", {}) or {}
    cached = det_in.get("cached_tokens", 0) or 0
    usage = {
        "input_tokens": (u.get("prompt_tokens", 0) or 0) - cached,
        "output_tokens": u.get("completion_tokens", 0) or 0,
        "cache_read_tokens": cached,
        "cache_write_tokens": 0,
        "reasoning_tokens": det_out.get("reasoning_tokens", 0) or 0,
    }
    text = d["choices"][0]["message"].get("content", "") if d.get("choices") else ""
    return text, usage, "azure"


def call_anthropic(model: str, messages: list, max_tokens: int, tools: list = None) -> tuple:
    """Anthropic — 프롬프트 캐싱 cache_control 마커를 게이트웨이가 자동 주입.

    - 시스템 프롬프트: 항상 캐시 브레이크포인트 표시 (최소 토큰 미만이면 벤더가 무시하므로 무해)
    - 멀티턴(3개 메시지 이상): 마지막 메시지에도 마커 → 다음 턴에서 대화 prefix 재사용
    """
    system = "\n".join(str(m["content"]) for m in messages if m.get("role") == "system")
    msgs = [dict(m) for m in messages if m.get("role") != "system"]
    if len(msgs) >= 3 and msgs and isinstance(msgs[-1].get("content"), str):
        msgs[-1]["content"] = [{"type": "text", "text": msgs[-1]["content"],
                                "cache_control": {"type": "ephemeral"}}]
    body = {"model": model, "max_tokens": max_tokens or 1024, "messages": msgs}
    if system:
        body["system"] = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
    r = _client.post("https://api.anthropic.com/v1/messages",
                     headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"},
                     json=body)
    r.raise_for_status()
    d = r.json()
    u = d.get("usage", {})
    usage = {
        "input_tokens": u.get("input_tokens", 0),
        "output_tokens": u.get("output_tokens", 0),
        "cache_read_tokens": u.get("cache_read_input_tokens", 0) or 0,
        "cache_write_tokens": u.get("cache_creation_input_tokens", 0) or 0,
        "reasoning_tokens": 0,
    }
    text = "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
    return text, usage, "anthropic"


def dispatch(model: str, messages: list, max_tokens: int, sim: dict, force_mock: bool,
             tools: list = None) -> tuple:
    if force_mock or model.endswith("-local"):
        return call_mock(model, messages, sim)
    if model.startswith(("gpt", "o3", "o4")):
        if AZURE_ENDPOINT and AZURE_KEY:        # Azure 우선 (사내 환경)
            return call_azure(model, messages, max_tokens, tools)
        if OPENAI_KEY:
            return call_openai(model, messages, max_tokens, tools)
    if model.startswith("claude") and ANTHROPIC_KEY:
        return call_anthropic(model, messages, max_tokens, tools)
    return call_mock(model, messages, sim)
