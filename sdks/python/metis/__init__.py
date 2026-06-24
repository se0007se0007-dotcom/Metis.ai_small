"""
METIS Python ingestion SDK.

Send runs from EXTERNAL agents (running outside METIS) to the METIS on-ramp
(POST /v1/ingest/runs), where they are evaluated through the SAME 4-gate
EvaluatorService (accuracy, hallucination, security, policy + anomaly) the
internal PipelineEngine uses.

Quickstart:
    from metis import Metis
    m = Metis(api_key="mts_live_...", base_url="http://localhost:4000")
    res = m.log_run(agentName="support-bot", input="...", output="...",
                    context="...", groundTruth="...", model="gpt-4o")
    print(res["results"][0]["evaluation"])  # overallScore / securityRiskLevel / anomalyDetected
"""
from .client import Metis, build_run
from .parsers import extract_output, ParsedOutput

__all__ = ["Metis", "build_run", "extract_output", "ParsedOutput"]
__version__ = "1.0.0"
