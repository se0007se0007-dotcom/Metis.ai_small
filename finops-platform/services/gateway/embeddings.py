"""게이트웨이 임베딩/복잡도 유틸 — metis-ai 이식.

- EmbeddingClient: 시맨틱(유사도) 캐시용 임베딩 (embedding.service.ts 이식)
  백엔드 선택 (METIS_EMBED_BACKEND, 기본 auto):
    · openai : OpenAI embeddings API (기본 text-embedding-3-small). 429/오류 시
               10분 쿼터 쿨다운(서킷브레이커), 외부 전송 전 시크릿 redaction.
    · local  : 외부 호출 없는 로컬 임베딩 — 단어 + 문자 bigram 해시 TF 를 L2 정규화한
               고차원(기본 512) 벡터. 비용 0·폐쇄망 안전·결정적. 한국어 FAQ 유사도에 적합.
               (Anthropic 은 임베딩 API 가 없어 LLM 응답 생성에만 사용하고, 유사도 벡터는
                로컬 임베더가 담당한다 — Anthropic + 임베딩 캐시 조합의 권장 구성.)
    · mock   : local 의 별칭(테스트/시뮬레이터 호환).
    · auto   : OpenAI 키가 있으면 openai, 없으면 local 자동 선택.
  실패는 항상 None → 호출자는 exact-match 로 폴백.
- complexity_score: 프롬프트 복잡도 휴리스틱 (token-optimizer.service.ts 라우터 이식)
"""
import hashlib
import math
import os
import re
import time

import httpx

QUOTA_COOLDOWN_S = 600
MOCK_DIM = 128
LOCAL_DIM = int(os.environ.get("METIS_EMBED_LOCAL_DIM", "512"))

# 시크릿 redaction — API 키/토큰 형태를 외부 임베딩 API 로 보내지 않는다
_SECRET_PAT = re.compile(
    r"(sk-[A-Za-z0-9_\-]{8,}|api[_-]?key\s*[:=]\s*\S+|Bearer\s+[A-Za-z0-9._\-]{8,}|"
    r"AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,})", re.IGNORECASE)


def redact_secrets(text: str) -> str:
    return _SECRET_PAT.sub("[REDACTED]", text or "")


def cosine(a: list, b: list) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _mock_embed(text: str) -> list:
    """결정적 bag-of-words 임베딩 — 단어 겹침이 많을수록 코사인 유사도가 높다."""
    vec = [0.0] * MOCK_DIM
    for w in re.findall(r"[\w가-힣]+", (text or "").lower()):
        h = int(hashlib.md5(w.encode()).hexdigest()[:8], 16)
        vec[h % MOCK_DIM] += 1.0
    return vec


def _hash_idx(token: str, dim: int) -> int:
    return int(hashlib.md5(token.encode("utf-8")).hexdigest()[:8], 16) % dim


def _local_embed(text: str, dim: int = LOCAL_DIM) -> list:
    """외부 호출 없는 로컬 임베딩 (운영 가능 수준).

    단어 토큰 + 문자 bigram 을 해시 버킷에 sublinear TF(1+log)로 적재한 뒤 L2 정규화.
    문자 bigram 을 섞어 어미/조사 변화('알려줘'/'알려주세요')에도 유사도가 유지된다.
    완전 결정적이고 비용이 없어 폐쇄망/오프라인 환경에 적합하다.
    """
    counts: dict = {}
    t = (text or "").lower()
    words = re.findall(r"[\w가-힣]+", t)
    for w in words:                                  # 단어 단위 (가중 2.0)
        counts[("w", w)] = counts.get(("w", w), 0) + 2.0
    compact = re.sub(r"\s+", "", t)
    for i in range(len(compact) - 1):                # 문자 bigram (가중 1.0)
        bg = compact[i:i + 2]
        counts[("b", bg)] = counts.get(("b", bg), 0) + 1.0
    if not counts:
        return [0.0] * dim
    vec = [0.0] * dim
    for (kind, tok), cnt in counts.items():
        vec[_hash_idx(f"{kind}:{tok}", dim)] += (1.0 + math.log(cnt))
    norm = math.sqrt(sum(x * x for x in vec))        # L2 정규화 → cosine 안정
    return [x / norm for x in vec] if norm else vec


class EmbeddingClient:
    """best-effort 임베딩. 실패는 항상 None — 호출자는 exact-match 로 폴백해야 한다."""

    def __init__(self) -> None:
        self.api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        self.base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.model = os.environ.get("OPENAI_EMBED_MODEL", "text-embedding-3-small").strip()
        backend = os.environ.get("METIS_EMBED_BACKEND", "").strip().lower()
        if not backend:
            # 구버전 호환: METIS_EMBED_MOCK=1 → local
            backend = "local" if os.environ.get("METIS_EMBED_MOCK", "0") == "1" else "auto"
        if backend == "auto":
            backend = "openai" if self.api_key else "local"
        if backend == "mock":
            backend = "local"
        self.backend = backend            # openai | local
        self._cooldown_until = 0.0
        self._client = httpx.Client(timeout=8.0)

    @property
    def mode(self) -> str:
        if self.backend == "openai":
            return "openai" if self.api_key else "off"
        return self.backend               # local

    def embed(self, text: str, allow_external: bool = True):
        if self.backend == "local":
            return _local_embed(text)
        # openai 백엔드
        if not self.api_key or not allow_external:
            return None
        if time.time() < self._cooldown_until:
            return None
        try:
            r = self._client.post(f"{self.base}/embeddings",
                                  headers={"Authorization": f"Bearer {self.api_key}"},
                                  json={"model": self.model,
                                        "input": redact_secrets(text)[:6000]})
            if r.status_code == 429:   # 쿼터/레이트리밋 → 쿨다운
                self._cooldown_until = time.time() + QUOTA_COOLDOWN_S
                return None
            r.raise_for_status()
            return r.json()["data"][0]["embedding"]
        except Exception:
            self._cooldown_until = time.time() + 60   # 짧은 백오프
            return None


# ---------------------------------------------------------------- 복잡도 라우팅
_COMPLEX_KW = ("analyze", "analysis", "architecture", "design", "optimize", "refactor", "prove",
               "분석", "아키텍처", "설계", "최적화", "리팩토링", "증명", "전략", "심층")
_SIMPLE_KW = ("translate", "summarize", "summary", "list", "greeting", "lookup", "classify",
              "번역", "요약", "목록", "안내", "알려줘", "알려주세요", "분류", "확인", "조회")
_CODE_PAT = re.compile(r"```|def |class |function |public |#include")


def complexity_score(messages: list, has_tools: bool = False) -> float:
    """0(단순)~1(복잡). metis-ai 라우터의 길이/키워드/코드/JSON 휴리스틱 이식. 기본 0.4."""
    text = " ".join(str(m.get("content", "")) for m in (messages or [])
                    if m.get("role") in ("user", "system"))
    t = text.lower()
    score = 0.4
    if len(text) > 2000:
        score += 0.3
    score += 0.15 * min(2, sum(1 for k in _COMPLEX_KW if k in t))
    score -= 0.10 * min(2, sum(1 for k in _SIMPLE_KW if k in t))
    if _CODE_PAT.search(text):
        score += 0.2
    if "{" in text and "}" in text:
        score += 0.1
    if has_tools:
        score += 0.2
    return max(0.0, min(1.0, round(score, 3)))
