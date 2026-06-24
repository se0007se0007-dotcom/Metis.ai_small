"""
metis.parsers — normalize common LLM return types into (text, tokens_in, tokens_out).

Pure, dependency-free, unit-testable. Used by the decorator/session helpers to
turn whatever your agent function returned into the `output` + token fields the
METIS /ingest/runs contract expects.

Supported shapes (auto-detected, best-effort, never raises):
  - OpenAI ChatCompletion-like dict: choices[0].message.content,
      usage.prompt_tokens / usage.completion_tokens
  - Anthropic Message-like dict:     content[0].text,
      usage.input_tokens / usage.output_tokens
  - LangChain-like object:           obj.content (AIMessage / BaseMessage)
  - Generic dict:                    answer | output | result | text | response
  - Plain str:                       returned verbatim
  - Anything else:                   str(obj)
"""
from __future__ import annotations

from typing import Any, Optional, Tuple


class ParsedOutput:
    """Result of extract_output(): text + optional token counts + detected kind."""

    __slots__ = ("text", "tokens_in", "tokens_out", "kind")

    def __init__(
        self,
        text: str,
        tokens_in: Optional[int] = None,
        tokens_out: Optional[int] = None,
        kind: str = "unknown",
    ) -> None:
        self.text = text
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out
        self.kind = kind

    def as_tuple(self) -> Tuple[str, Optional[int], Optional[int]]:
        return (self.text, self.tokens_in, self.tokens_out)

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return (
            f"ParsedOutput(kind={self.kind!r}, tokens_in={self.tokens_in}, "
            f"tokens_out={self.tokens_out}, text={self.text[:40]!r})"
        )


def _get(obj: Any, key: str) -> Any:
    """Attribute- or key-access, whichever the object supports."""
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _as_int(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        return int(v)
    except (TypeError, ValueError):
        return None


def _looks_openai(raw: Any) -> bool:
    choices = _get(raw, "choices")
    return isinstance(choices, (list, tuple)) and len(choices) > 0


def _looks_anthropic(raw: Any) -> bool:
    content = _get(raw, "content")
    usage = _get(raw, "usage")
    # Anthropic content is a list of blocks; usage uses input_tokens/output_tokens.
    if isinstance(content, (list, tuple)) and len(content) > 0:
        if usage is not None and (
            _get(usage, "input_tokens") is not None
            or _get(usage, "output_tokens") is not None
        ):
            return True
        # Even without usage, a list-of-blocks-with-text is Anthropic-shaped.
        first = content[0]
        return _get(first, "text") is not None or (
            isinstance(first, dict) and first.get("type") == "text"
        )
    return False


def _parse_openai(raw: Any) -> ParsedOutput:
    choices = _get(raw, "choices") or []
    first = choices[0]
    message = _get(first, "message")
    text = ""
    if message is not None:
        text = _get(message, "content") or ""
    if not text:
        # Legacy completions API: choices[0].text
        text = _get(first, "text") or ""
    usage = _get(raw, "usage")
    tin = _as_int(_get(usage, "prompt_tokens")) if usage is not None else None
    tout = _as_int(_get(usage, "completion_tokens")) if usage is not None else None
    return ParsedOutput(str(text), tin, tout, "openai")


def _parse_anthropic(raw: Any) -> ParsedOutput:
    content = _get(raw, "content") or []
    parts = []
    for block in content:
        t = _get(block, "text")
        if t:
            parts.append(str(t))
    text = "".join(parts)
    usage = _get(raw, "usage")
    tin = _as_int(_get(usage, "input_tokens")) if usage is not None else None
    tout = _as_int(_get(usage, "output_tokens")) if usage is not None else None
    return ParsedOutput(text, tin, tout, "anthropic")


_DICT_TEXT_KEYS = ("answer", "output", "result", "text", "response", "completion")


def _parse_dict(raw: dict) -> ParsedOutput:
    for k in _DICT_TEXT_KEYS:
        if k in raw and raw[k] is not None:
            return ParsedOutput(str(raw[k]), None, None, "dict")
    # Nothing recognizable — stringify the whole dict.
    return ParsedOutput(str(raw), None, None, "dict")


def extract_output(raw: Any) -> ParsedOutput:
    """
    Normalize any common LLM return value into a ParsedOutput.

    Detection order is deliberate: OpenAI (choices) and Anthropic (content list +
    usage) are matched before the generic-dict fallback so their token counts are
    captured. Never raises — worst case it stringifies the input.
    """
    try:
        if raw is None:
            return ParsedOutput("", None, None, "none")

        if isinstance(raw, str):
            return ParsedOutput(raw, None, None, "str")

        # OpenAI ChatCompletion-like (dict or SDK object with .choices)
        if _looks_openai(raw):
            return _parse_openai(raw)

        # Anthropic Message-like (dict or SDK object with .content blocks)
        if _looks_anthropic(raw):
            return _parse_anthropic(raw)

        # LangChain-like message object: has .content (string), not a list
        content_attr = getattr(raw, "content", None)
        if isinstance(content_attr, str):
            return ParsedOutput(content_attr, None, None, "langchain")

        # Generic dict with a known text key
        if isinstance(raw, dict):
            return _parse_dict(raw)

        # Fallback — stringify
        return ParsedOutput(str(raw), None, None, "fallback")
    except Exception:
        # Parsing must never break the host app.
        try:
            return ParsedOutput(str(raw), None, None, "error")
        except Exception:
            return ParsedOutput("", None, None, "error")
