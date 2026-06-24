"""
MetisHermesAdapter — capture Hermes-style autonomous agent runs (self-created
skills, persistent memory, autonomous tool calls) and send them to METIS as
runtime='hermes' so METIS layers AUTONOMY GOVERNANCE on top of the standard
4-gate evaluation.

Difference vs a plain agent run (runtime='sdk'):
  - plain: only input/output → quality/security/anomaly gates.
  - hermes: ALSO reports skillsCreated/Used, memory reads/writes, toolCalls →
    METIS computes autonomyRisk and raises a governance alert on high risk.
"""
from __future__ import annotations
from typing import Any


class HermesRun:
    """Accumulates Hermes lifecycle signals during one agent run."""

    def __init__(self, agent: str, *, workflow_key: str | None = None, model: str | None = None):
        self.agent = agent
        self.workflow_key = workflow_key
        self.model = model
        self.input: str = ""
        self.output: str = ""
        self.skills_used: list[str] = []
        self.skills_created: list[str] = []
        self.memory_reads = 0
        self.memory_writes = 0
        self.tool_calls: list[dict] = []

    # lifecycle hooks (call these from Hermes callbacks)
    def on_skill_used(self, name: str) -> None:
        self.skills_used.append(name)

    def on_skill_created(self, name: str) -> None:
        self.skills_created.append(name)

    def on_memory(self, *, reads: int = 0, writes: int = 0) -> None:
        self.memory_reads += reads
        self.memory_writes += writes

    def on_tool_call(self, name: str, ok: bool = True, risky: bool | None = None) -> None:
        tc: dict[str, Any] = {"name": name, "ok": ok}
        if risky is not None:
            tc["risky"] = risky
        self.tool_calls.append(tc)

    def to_run(self, run_id: str | None = None, latency_ms: int | None = None) -> dict:
        return {
            "runId": run_id,
            "agentName": self.agent,
            "workflowKey": self.workflow_key,
            "model": self.model,
            "input": self.input,
            "output": self.output,
            "latencyMs": latency_ms,
            "status": "COMPLETED",
            "runtime": "hermes",
            "hermesMeta": {
                "skillsUsed": self.skills_used,
                "skillsCreated": self.skills_created,
                "memoryReads": self.memory_reads,
                "memoryWrites": self.memory_writes,
                "toolCalls": self.tool_calls,
            },
        }


class MetisHermesAdapter:
    """Sends a HermesRun to METIS via the existing Metis ingest client."""

    def __init__(self, metis_client):
        self.client = metis_client  # a metis.Metis instance

    def run(self, agent: str, **kwargs) -> HermesRun:
        return HermesRun(agent, **kwargs)

    def submit(self, run: HermesRun, run_id: str | None = None, latency_ms: int | None = None):
        payload = run.to_run(run_id=run_id, latency_ms=latency_ms)
        return self.client.log_run(**payload)
