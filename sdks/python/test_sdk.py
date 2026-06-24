"""
METIS Python SDK unit tests — plain `python3 test_sdk.py`, ASCII output, no deps.

Covers:
  - extract_output() for OpenAI dict, Anthropic dict, LangChain-like object,
    dict variants, and plain str (text + token extraction).
  - build_run() field passthrough + metadata folding.
  - the @eval decorator builds a correct run payload (agentName/input/output/
    model/tokens/latency present) and posts it via a monkeypatched transport,
    while still returning the host function's original value.
  - session.log() sends a run with merged defaults.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from metis import Metis, extract_output, build_run  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s  %s" % (name, detail))


print("=" * 70)
print("METIS SDK UNIT TESTS")
print("=" * 70)

# ── extract_output ───────────────────────────────────────────────
print("\n[1] extract_output()")

openai_resp = {
    "id": "chatcmpl-1",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Paris is the capital."}}],
    "usage": {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17},
}
p = extract_output(openai_resp)
check("openai: text", p.text == "Paris is the capital.", p.text)
check("openai: tokens_in=12", p.tokens_in == 12, str(p.tokens_in))
check("openai: tokens_out=5", p.tokens_out == 5, str(p.tokens_out))
check("openai: kind", p.kind == "openai", p.kind)

anthropic_resp = {
    "id": "msg_1",
    "type": "message",
    "content": [{"type": "text", "text": "The answer is 42."}],
    "usage": {"input_tokens": 20, "output_tokens": 6},
}
p = extract_output(anthropic_resp)
check("anthropic: text", p.text == "The answer is 42.", p.text)
check("anthropic: tokens_in=20", p.tokens_in == 20, str(p.tokens_in))
check("anthropic: tokens_out=6", p.tokens_out == 6, str(p.tokens_out))
check("anthropic: kind", p.kind == "anthropic", p.kind)


class FakeAIMessage:
    """LangChain-like message object exposing .content as a string."""

    def __init__(self, content):
        self.content = content


p = extract_output(FakeAIMessage("LangChain response text"))
check("langchain: text", p.text == "LangChain response text", p.text)
check("langchain: kind", p.kind == "langchain", p.kind)

check("dict answer", extract_output({"answer": "A"}).text == "A")
check("dict output", extract_output({"output": "O"}).text == "O")
check("dict result", extract_output({"result": "R"}).text == "R")
check("dict text", extract_output({"text": "T"}).text == "T")
check("plain str", extract_output("just text").text == "just text")
check("plain str kind", extract_output("x").kind == "str")
check("none -> empty", extract_output(None).text == "")
check("unknown obj -> str", extract_output(123).text == "123")

# ── build_run ────────────────────────────────────────────────────
print("\n[2] build_run()")
r = build_run(agentName="bot", input="q", output="a", customField="x", model=None)
check("build_run keeps known fields", r["agentName"] == "bot" and r["input"] == "q")
check("build_run drops None", "model" not in r)
check("build_run folds unknown into metadata", r.get("metadata", {}).get("customField") == "x")

# ── decorator + transport capture ────────────────────────────────
print("\n[3] @eval decorator builds + posts a correct run payload")

captured = {}


class StubMetis(Metis):
    """Metis subclass whose transport is replaced by an in-memory capture."""

    def _post(self, runs, wait):
        captured["runs"] = runs
        captured["wait"] = wait
        return {
            "accepted": len(runs),
            "rejected": [],
            "results": [
                {"runId": None, "sessionId": "sess-1", "status": "evaluated",
                 "evaluation": {"overallScore": 88, "securityRiskLevel": "low",
                                "anomalyDetected": False}}
            ],
        }


m = StubMetis(api_key="mts_live_test", base_url="http://stub.local")


@m.eval(agent="qa-agent", task_type="qa", system="support", model="gpt-4o",
        question_arg="question", context_arg="context", ground_truth_arg="truth")
def answer(question, context=None, truth=None):
    # Returns an OpenAI-shaped response to exercise token parsing.
    return {
        "choices": [{"message": {"content": "Seoul is the capital of Korea."}}],
        "usage": {"prompt_tokens": 9, "completion_tokens": 7},
    }


ret = answer(question="What is the capital of Korea?",
             context="Korea's capital is Seoul.", truth="Seoul")

# 1) host return value is untouched
check("decorator returns original value",
      isinstance(ret, dict) and ret["choices"][0]["message"]["content"].startswith("Seoul"))

run = captured.get("runs", [{}])[0]
check("payload posted", "runs" in captured)
check("payload agentName", run.get("agentName") == "qa-agent", str(run))
check("payload input present", run.get("input") == "What is the capital of Korea?", str(run.get("input")))
check("payload output parsed", run.get("output") == "Seoul is the capital of Korea.", str(run.get("output")))
check("payload model", run.get("model") == "gpt-4o")
check("payload tokensIn=9", run.get("tokensIn") == 9, str(run.get("tokensIn")))
check("payload tokensOut=7", run.get("tokensOut") == 7, str(run.get("tokensOut")))
check("payload latencyMs present", isinstance(run.get("latencyMs"), int))
check("payload context", run.get("context") == "Korea's capital is Seoul.")
check("payload groundTruth", run.get("groundTruth") == "Seoul")
check("payload taskType folded to metadata", run.get("metadata", {}).get("taskType") == "qa")
check("wait defaulted true", captured.get("wait") is True)

# decorator never breaks host fn even if logging would fail
print("\n[4] decorator is best-effort (never raises into host fn)")


class ExplodingMetis(Metis):
    def _post(self, runs, wait):
        raise RuntimeError("transport boom")


bad = ExplodingMetis(api_key="mts_live_x")
# _post raising is swallowed in log_run, but also verify decorator path is safe
bad.log_run(agentName="x", input="i", output="o")  # must not raise


@bad.eval(agent="safe-agent")
def risky(question):
    return "ok"


check("log_run swallows transport error", bad.log_run(agentName="x", input="i") is None)
check("decorator returns value despite logging error", risky("hi") == "ok")

# ── session ──────────────────────────────────────────────────────
print("\n[5] session() context manager")

sess_capture = {}


class SessStub(Metis):
    def _post(self, runs, wait):
        sess_capture.setdefault("runs", []).extend(runs)
        return {"accepted": len(runs), "rejected": [], "results": []}


ms = SessStub(api_key="mts_live_x")
with ms.session(agent="batch-agent", system="ops", workflow_key="wf-1") as s:
    s.log(input="q1", output="a1")
    s.log(input="q2", output="a2", ground_truth="gt2")

runs = sess_capture.get("runs", [])
check("session sent 2 runs", len(runs) == 2, str(len(runs)))
check("session merged agentName", all(r.get("agentName") == "batch-agent" for r in runs))
check("session merged workflowKey", all(r.get("workflowKey") == "wf-1" for r in runs))
check("session aliased ground_truth", runs[1].get("groundTruth") == "gt2", str(runs[1]))

# ── summary ──────────────────────────────────────────────────────
print("\n" + "=" * 70)
print("RESULT: %d passed, %d failed" % (PASS, FAIL))
print("=" * 70)
sys.exit(0 if FAIL == 0 else 1)
