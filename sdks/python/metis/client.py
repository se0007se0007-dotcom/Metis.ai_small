"""
metis.client — the METIS ingestion client.

Sends external agent runs to METIS's POST /v1/ingest/runs on-ramp, where each
run is evaluated through the SAME EvaluatorService (4 gates: accuracy,
hallucination, security, policy + anomaly) used by the internal PipelineEngine.

Design rules (deliberate):
  - Zero hard dependencies — uses stdlib urllib so it runs anywhere, no pip.
  - MUST NEVER raise into the host app on a transport error: every network
    failure is swallowed and logged. log_run/log_runs return a result dict (or
    None) instead of throwing, so instrumenting an agent can never break it.
  - Auth: Authorization: Bearer mts_live_... (matches IngestKeyGuard, which also
    accepts the x-metis-key header — pass header_mode="x-metis-key" to use it).
  - Optional non-blocking mode: batch=True buffers runs and flushes from a
    background worker thread; flush()/close() drain it. Default is simple sync.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

__all__ = ["Metis"]

logger = logging.getLogger("metis")

# Run fields accepted by the /ingest/runs contract. Anything else a caller
# passes is dropped into `metadata` so the wire payload stays clean.
_RUN_FIELDS = {
    "runId",
    "agentName",
    "workflowKey",
    "system",
    "stepKey",
    "input",
    "output",
    "context",
    "groundTruth",
    "model",
    "tokensIn",
    "tokensOut",
    "latencyMs",
    "costUsd",
    "startedAt",
    "endedAt",
    "status",
    "toolCalls",
    "metadata",
}


def build_run(**kwargs: Any) -> Dict[str, Any]:
    """
    Build a clean run object from keyword args. Known fields pass through;
    unknown fields are folded into `metadata`. None values are dropped.
    Pure + unit-testable (no network).
    """
    run: Dict[str, Any] = {}
    extra: Dict[str, Any] = {}
    for k, v in kwargs.items():
        if v is None:
            continue
        if k in _RUN_FIELDS:
            run[k] = v
        else:
            extra[k] = v
    if extra:
        md = run.get("metadata") or {}
        if isinstance(md, dict):
            md = {**md, **extra}
        else:
            md = extra
        run["metadata"] = md
    return run


class Metis:
    """
    METIS ingestion client.

        m = Metis(api_key="mts_live_...", base_url="http://localhost:4000")
        m.log_run(agentName="my-bot", input="...", output="...")

    Args:
        api_key:   ingest key (mts_live_... / mts_test_...).
        base_url:  API origin. /v1/ingest/runs is appended.
        timeout:   per-request timeout (seconds).
        batch:     if True, buffer + flush from a background thread (non-blocking).
        wait:      default ?wait=true so evaluation summaries come back inline.
        header_mode: "bearer" (default) or "x-metis-key".
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "http://localhost:4000",
        timeout: float = 5.0,
        batch: bool = False,
        wait: bool = True,
        header_mode: str = "bearer",
        api_prefix: str = "/v1",
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.batch = batch
        self.default_wait = wait
        self.header_mode = header_mode
        self.api_prefix = api_prefix.strip("/")
        self._url = f"{self.base_url}/{self.api_prefix}/ingest/runs" if self.api_prefix \
            else f"{self.base_url}/ingest/runs"

        # Background batching plumbing (only used when batch=True).
        self._queue: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self._worker: Optional[threading.Thread] = None
        self._closed = False
        if self.batch:
            self._worker = threading.Thread(target=self._drain_loop, daemon=True)
            self._worker.start()

        # Bind the ergonomic helpers (imported lazily to avoid a cycle).
        from .decorator import make_eval, make_session

        self.eval = make_eval(self)
        self.session = make_session(self)

    # ── public API ──────────────────────────────────────────────

    def log_run(self, wait: Optional[bool] = None, **run: Any) -> Optional[Dict[str, Any]]:
        """
        Log one external run. In sync mode returns the parsed JSON response
        (with evaluation summary if wait=True); in batch mode enqueues and
        returns None. Never raises on transport failure.
        """
        try:
            obj = build_run(**run)
            if self.batch:
                if not self._closed:
                    self._queue.put(obj)
                return None
            return self._post([obj], self.default_wait if wait is None else wait)
        except Exception as e:  # outer safety net — must never raise into host
            logger.warning("METIS log_run failed (ignored): %s", e)
            return None

    def log_runs(
        self, runs: List[Dict[str, Any]], wait: Optional[bool] = None
    ) -> Optional[Dict[str, Any]]:
        """Log a batch of runs (max 100 enforced server-side)."""
        try:
            cleaned = [build_run(**r) for r in runs]
            if self.batch:
                if not self._closed:
                    for r in cleaned:
                        self._queue.put(r)
                return None
            return self._post(cleaned, self.default_wait if wait is None else wait)
        except Exception as e:  # outer safety net
            logger.warning("METIS log_runs failed (ignored): %s", e)
            return None

    def flush(self) -> None:
        """Block until the background queue is drained (batch mode only)."""
        if self.batch:
            self._queue.join()

    def close(self) -> None:
        """Flush and stop the background worker (batch mode only)."""
        if self.batch and not self._closed:
            self._closed = True
            self._queue.put(None)  # sentinel
            if self._worker is not None:
                self._worker.join(timeout=self.timeout * 2)

    # Context-manager support for `with Metis(...) as m:`
    def __enter__(self) -> "Metis":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── transport (private) ─────────────────────────────────────

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json", "User-Agent": "metis-python-sdk/1.0"}
        if self.header_mode == "x-metis-key":
            h["x-metis-key"] = self.api_key
        else:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _post(self, runs: List[Dict[str, Any]], wait: bool) -> Optional[Dict[str, Any]]:
        """
        POST runs to /ingest/runs. Returns parsed JSON, or None on any transport
        error (which is logged, never raised — instrumentation must not break
        the host application).
        """
        url = self._url + ("?wait=true" if wait else "")
        # Single run posts the object directly; multiple posts an array.
        body = runs[0] if len(runs) == 1 else runs
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=self._headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            # Server responded with 4xx/5xx — surface the body but don't raise.
            try:
                payload = e.read().decode("utf-8")
            except Exception:
                payload = ""
            logger.warning("METIS ingest HTTP %s: %s", e.code, payload[:500])
            return None
        except Exception as e:  # URLError, timeout, JSON, anything
            logger.warning("METIS ingest transport error: %s", e)
            return None

    def _drain_loop(self) -> None:
        """Background worker: pull runs off the queue and POST them one at a time."""
        while True:
            item = self._queue.get()
            try:
                if item is None:  # close sentinel
                    return
                self._post([item], self.default_wait)
            finally:
                self._queue.task_done()
