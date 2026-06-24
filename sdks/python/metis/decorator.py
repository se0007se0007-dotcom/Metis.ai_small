"""
metis.decorator — ergonomic instrumentation helpers bound to a Metis client.

These are attached to the client instance as `metis.eval(...)` and
`metis.session(...)` so an external agent can be instrumented with one line.

Both are strictly best-effort: the decorator ALWAYS returns the wrapped
function's original return value, even if building/sending the run fails. METIS
instrumentation must never change or break the behavior of the host agent.
"""
from __future__ import annotations

import functools
import logging
import time
from typing import Any, Callable, Optional

from .parsers import extract_output

logger = logging.getLogger("metis")


def make_eval(client: Any) -> Callable:
    """Build the `eval` decorator factory bound to a given Metis client."""

    def eval_decorator(
        agent: str,
        task_type: str = "qa",
        system: Optional[str] = None,
        workflow_key: Optional[str] = None,
        step_key: str = "sdk",
        capture: str = "io",
        question_arg: Optional[str] = None,
        model: Optional[str] = None,
        context_arg: Optional[str] = None,
        ground_truth_arg: Optional[str] = None,
    ) -> Callable:
        """
        Decorate a sync function so each call is logged to METIS as a run.

        Resolves the question from `question_arg` (named) or the first positional
        argument, runs the function, parses the return value via extract_output,
        measures latency, builds the run, and sends it best-effort.

        Args:
            agent:           agentName for the run (required).
            task_type:       stored in metadata.taskType (e.g. "qa", "summarize").
            system:          owning system label (metadata.system).
            capture:         "io" (input+output), "output", or "none".
            question_arg:    name of the kwarg holding the question/input.
            context_arg:     name of the kwarg holding RAG context.
            ground_truth_arg: name of the kwarg holding the reference answer.
        """

        def decorator(fn: Callable) -> Callable:
            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                started = time.time()
                started_iso = _now_iso()
                # Resolve the input/question for logging.
                question = _resolve_arg(question_arg, args, kwargs)
                context = _resolve_named(context_arg, kwargs)
                ground_truth = _resolve_named(ground_truth_arg, kwargs)

                result = fn(*args, **kwargs)  # run the real agent

                # Everything below is best-effort — never let it affect `result`.
                try:
                    latency_ms = int((time.time() - started) * 1000)
                    parsed = extract_output(result)
                    run: dict = {
                        "agentName": agent,
                        "workflowKey": workflow_key,
                        "stepKey": step_key,
                        "system": system,
                        "model": model,
                        "latencyMs": latency_ms,
                        "startedAt": started_iso,
                        "endedAt": _now_iso(),
                        "tokensIn": parsed.tokens_in,
                        "tokensOut": parsed.tokens_out,
                        "taskType": task_type,  # → folded into metadata by build_run
                    }
                    if capture in ("io", "input"):
                        run["input"] = _to_text(question)
                    if capture in ("io", "output"):
                        run["output"] = parsed.text
                    if context is not None:
                        run["context"] = _to_text(context)
                    if ground_truth is not None:
                        run["groundTruth"] = _to_text(ground_truth)
                    client.log_run(**run)
                except Exception as e:  # pragma: no cover - safety net
                    logger.warning("METIS @eval logging failed (ignored): %s", e)

                return result

            return wrapper

        return decorator

    return eval_decorator


class _Session:
    """Context manager returned by `metis.session(...)`. Each .log() sends a run."""

    def __init__(self, client: Any, **defaults: Any) -> None:
        self._client = client
        self._defaults = {k: v for k, v in defaults.items() if v is not None}
        self.logged = 0

    def log(self, **run: Any) -> Optional[dict]:
        """Send a run, merging session defaults (agent/system/workflow_key/etc.)."""
        merged = {**self._defaults, **{k: v for k, v in run.items() if v is not None}}
        # Normalize ergonomic aliases to contract field names.
        if "agent" in merged and "agentName" not in merged:
            merged["agentName"] = merged.pop("agent")
        if "workflow_key" in merged and "workflowKey" not in merged:
            merged["workflowKey"] = merged.pop("workflow_key")
        if "ground_truth" in merged and "groundTruth" not in merged:
            merged["groundTruth"] = merged.pop("ground_truth")
        try:
            res = self._client.log_run(**merged)
            self.logged += 1
            return res
        except Exception as e:  # pragma: no cover
            logger.warning("METIS session.log failed (ignored): %s", e)
            return None

    def __enter__(self) -> "_Session":
        return self

    def __exit__(self, *exc: Any) -> None:
        # Drain the client if it is in batch mode.
        try:
            self._client.flush()
        except Exception:
            pass


def make_session(client: Any) -> Callable:
    """Build the `session` factory bound to a given Metis client."""

    def session(agent: Optional[str] = None, **defaults: Any) -> _Session:
        if agent is not None:
            defaults["agent"] = agent
        return _Session(client, **defaults)

    return session


# ── small helpers ───────────────────────────────────────────────


def _now_iso() -> str:
    # Local helper to avoid importing datetime at module top for clarity.
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _resolve_arg(name: Optional[str], args: tuple, kwargs: dict) -> Any:
    """Resolve the question: named kwarg first, else first positional arg."""
    if name and name in kwargs:
        return kwargs[name]
    if args:
        return args[0]
    return None


def _resolve_named(name: Optional[str], kwargs: dict) -> Any:
    if name and name in kwargs:
        return kwargs[name]
    return None


def _to_text(v: Any) -> str:
    return v if isinstance(v, str) else str(v)
