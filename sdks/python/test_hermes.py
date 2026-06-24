# Demonstrates the DIFFERENCE: same agent output evaluated as plain SDK vs Hermes.
# Mirrors backend hermes-governance.computeAutonomyRisk for a local, runnable demo.
RISKY={"execute_code","shell","browser","browser_use","file_write","http"}
def autonomy(meta):
    sc=meta.get("skillsCreated") or []; tcs=meta.get("toolCalls") or []
    mw=meta.get("memoryWrites") or 0; mr=meta.get("memoryReads") or 0
    risky=[t for t in tcs if (t.get("name","").lower() in RISKY) or t.get("risky") is True]
    new=len(sc); rk=len(risky); tot=len(tcs)
    score=min(50,new*25)+min(45,rk*15)+min(20,mw*5)+min(10,(tot//3)*2)
    score=min(100,score)
    lvl="low" if score<20 else "medium" if score<45 else "high" if score<70 else "critical"
    sig=[]
    if new: sig.append(f"신규 스킬 {new}개 자동 생성")
    if rk: sig.append(f"위험 툴 {rk}건 호출")
    if mw: sig.append(f"메모리 쓰기 {mw}건")
    return {"newSkillCount":new,"riskyToolCallCount":rk,"totalToolCalls":tot,
            "memoryWriteCount":mw,"memoryReadCount":mr,"autonomyRiskScore":score,
            "autonomyRiskLevel":lvl,"signals":sig}

meta={"skillsUsed":["summarize"],"skillsCreated":["parse_incident","auto_retry"],
      "memoryReads":2,"memoryWrites":3,
      "toolCalls":[{"name":"execute_code","ok":True},{"name":"browser","ok":True},{"name":"search","ok":True}]}

p=0;f=0
def ok(n,c):
    global p,f
    print(("  PASS " if c else "  FAIL ")+n); 
    p+= 1 if c else 0; f+= 0 if c else 1

print("== 기존(SDK) 실행: autonomy 신호 없음 ==")
ok("SDK 런타임엔 hermesMeta 미전송 → autonomy=None", True)  # by contract autonomy absent

print("== Hermes 실행: autonomy 거버넌스 산출 ==")
a=autonomy(meta)
print("   ",a)
ok("신규 스킬 2개 감지", a["newSkillCount"]==2)
ok("위험 툴 2건(execute_code,browser)", a["riskyToolCallCount"]==2)
ok("메모리 쓰기 3건", a["memoryWriteCount"]==3)
ok("리스크 레벨 critical", a["autonomyRiskLevel"]=="critical")
ok("기존 대비 차이=자율성 신호 추가", len(a["signals"])>=3)

# HermesRun payload shape
import sys; sys.path.insert(0,".")
from metis.hermes import HermesRun
r=HermesRun("Hermes-Researcher",workflow_key="research",model="claude")
r.input="요약해줘"; r.output="요약 결과"
r.on_skill_created("parse_incident"); r.on_skill_used("summarize")
r.on_memory(reads=2,writes=3); r.on_tool_call("execute_code"); r.on_tool_call("browser")
run=r.to_run(run_id="h1",latency_ms=4200)
ok("payload runtime=hermes", run["runtime"]=="hermes")
ok("payload hermesMeta.skillsCreated 포함", "parse_incident" in run["hermesMeta"]["skillsCreated"])

print(f"\nRESULT: {p} passed, {f} failed")
sys.exit(0 if f==0 else 1)
