"""단가 마스터 — 모델별 토큰 단가 (USD / 1M tokens).

정적 테이블(PRICES) 위에 런타임 오버레이를 얹는다:
control plane 이 model_prices 테이블을 load_runtime() 으로 로드하면
price_of/tier_of/downgrade_of 가 런타임 값을 우선 사용한다 (API 로 단가 수정 가능).
모델 ID 는 normalize_model_id 로 정규화한다 (예: claude-opus-4.6→4-6, -20251001 서픽스 제거).
reasoning(thinking) 토큰은 output 단가로 과금한다(업계 표준).
"""
import re

# (input, output, cache_read, cache_write)  USD per 1M tokens — 2026 GPT-5 세대 기준 현행화
PRICES = {
    "gpt-5":             (1.25, 10.00, 0.125, 1.25),
    "gpt-5-mini":        (0.25, 2.00, 0.025, 0.25),
    "gpt-5-nano":        (0.05, 0.40, 0.005, 0.05),
    "claude-opus-4-8":   (15.00, 75.00, 1.50, 18.75),
    "claude-sonnet-4-6": (3.00, 15.00, 0.30, 3.75),
    "claude-haiku-4-5":  (1.00, 5.00, 0.10, 1.25),
    # 셀프호스트 오픈모델: H100 상각 기준 합성 단가 (input=output)
    "qwen3-72b-local":   (0.40, 0.40, 0.0, 0.0),
    "llama4-scout-local": (0.20, 0.20, 0.0, 0.0),
    # 레거시(과거 원장 표시 호환용)
    "gpt-4o":            (2.50, 10.00, 1.25, 3.125),
    "gpt-4o-mini":       (0.15, 0.60, 0.075, 0.1875),
}

DEFAULT_PRICE = (1.00, 4.00, 0.25, 1.25)

# 3티어 강등(downgrade) 맵: premium -> standard -> economy -> self-host
DOWNGRADE_MAP = {
    "claude-opus-4-8": "claude-sonnet-4-6",
    "claude-sonnet-4-6": "claude-haiku-4-5",
    "claude-haiku-4-5": "qwen3-72b-local",
    "gpt-5": "gpt-5-mini",
    "gpt-5-mini": "gpt-5-nano",
    "gpt-5-nano": "qwen3-72b-local",
    "gpt-4o": "gpt-5-mini",       # 레거시 호출 유입 시
    "gpt-4o-mini": "gpt-5-nano",
}

MODEL_TIER = {
    "claude-opus-4-8": "premium", "gpt-5": "premium",
    "claude-sonnet-4-6": "standard", "gpt-5-mini": "standard",
    "claude-haiku-4-5": "economy", "gpt-5-nano": "economy",
    "qwen3-72b-local": "self-host", "llama4-scout-local": "self-host",
}


# 티어 순위 (낮을수록 저렴/저성능). 거버넌스 리스크 상향(escalation)에 사용.
TIER_RANK = {"self-host": 0, "economy": 1, "standard": 2, "premium": 3}

# 강등 맵의 역방향 = 상향(escalation) 맵.
# 레거시(gpt-4o*) 항목은 동일 타깃을 공유해 역매핑을 오염시키므로 제외하고,
# 현행(GPT-5/Claude) 주 계열만으로 상향 경로를 구성한다.
UPGRADE_MAP = {v: k for k, v in DOWNGRADE_MAP.items() if not k.startswith("gpt-4o")}


# ---------------------------------------------------------------- 모델 ID 정규화
_DATE_SUFFIX = re.compile(r"-20\d{6}$")   # claude-haiku-4-5-20251001 → claude-haiku-4-5
_DOT_VERSION = re.compile(r"(\d)\.(\d)")  # claude-opus-4.6 → claude-opus-4-6


def normalize_model_id(model: str) -> str:
    m = (model or "").strip()
    m = _DATE_SUFFIX.sub("", m)
    m = _DOT_VERSION.sub(r"\1-\2", m)
    return m


# ---------------------------------------------------------------- 런타임 단가 오버레이
_RUNTIME: dict = {}        # model -> (pi, po, pcr, pcw)
_RUNTIME_META: dict = {}   # model -> {"tier", "downgrade_to", "active"}


def load_runtime(rows) -> int:
    """model_prices 테이블 행을 런타임 오버레이로 로드. control plane 기동/단가변경 시 호출."""
    _RUNTIME.clear()
    _RUNTIME_META.clear()
    for r in rows or []:
        m = normalize_model_id(r["model"])
        meta = {"tier": r.get("tier") or None, "downgrade_to": r.get("downgrade_to") or None,
                "active": 1 if r.get("active", 1) else 0}
        _RUNTIME_META[m] = meta
        if meta["active"]:
            _RUNTIME[m] = (float(r["input_usd"] or 0), float(r["output_usd"] or 0),
                           float(r["cache_read_usd"] or 0), float(r["cache_write_usd"] or 0))
    return len(_RUNTIME)


def runtime_loaded() -> int:
    return len(_RUNTIME)


def tier_of(model: str) -> str:
    m = normalize_model_id(model)
    meta = _RUNTIME_META.get(m)
    if meta and meta.get("tier"):
        return meta["tier"]
    return MODEL_TIER.get(m, "standard")


def downgrade_of(model: str):
    """이 모델의 강등 대상 (런타임 오버라이드 우선). 없으면 None."""
    m = normalize_model_id(model)
    meta = _RUNTIME_META.get(m)
    if meta and meta.get("downgrade_to"):
        return meta["downgrade_to"]
    return DOWNGRADE_MAP.get(m)


def escalate_to_tier(model: str, min_tier: str) -> str:
    """model 이 min_tier 보다 낮으면 같은 계열에서 min_tier 이상으로 상향."""
    want = TIER_RANK.get(min_tier, 2)
    cur = normalize_model_id(model)
    for _ in range(5):
        if TIER_RANK.get(tier_of(cur), 2) >= want:
            return cur
        nxt = UPGRADE_MAP.get(cur)
        if not nxt or nxt == cur:
            return cur
        cur = nxt
    return cur


def price_of(model: str):
    m = normalize_model_id(model)
    return _RUNTIME.get(m) or PRICES.get(m, DEFAULT_PRICE)


def compute_cost(model: str, input_tokens: int, output_tokens: int,
                 cache_read: int = 0, cache_write: int = 0, reasoning: int = 0) -> float:
    """실제 청구 비용 (USD)."""
    pi, po, pcr, pcw = price_of(model)
    return (input_tokens * pi + (output_tokens + reasoning) * po
            + cache_read * pcr + cache_write * pcw) / 1_000_000.0


def counterfactual_no_cache(model: str, input_tokens: int, output_tokens: int,
                            cache_read: int = 0, cache_write: int = 0, reasoning: int = 0) -> float:
    """캐싱이 없었다면의 비용: 캐시 토큰을 전부 일반 input 단가로 환산."""
    pi, po, _, _ = price_of(model)
    return ((input_tokens + cache_read + cache_write) * pi
            + (output_tokens + reasoning) * po) / 1_000_000.0


def cost_at(model: str, input_tokens: int, output_tokens: int, reasoning: int = 0) -> float:
    """다른 모델로 동일 토큰을 처리했을 때의 비용(라우팅 절감 counterfactual)."""
    pi, po, _, _ = price_of(model)
    return (input_tokens * pi + (output_tokens + reasoning) * po) / 1_000_000.0
