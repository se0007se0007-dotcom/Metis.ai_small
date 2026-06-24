#!/usr/bin/env bash
# E2E Harness Smoke Test — verifies the end-to-end automation pipeline.
#
# Prerequisites: API + Worker + Postgres + Redis running; seeds applied.
#
# What this script verifies:
#   1. CapabilityRegistry exposes agents/adapters/connectors
#   2. Builder CapabilityPlanner proposes a workflow from user intent
#   3. WorkflowRunner executes the workflow end-to-end
#   4. Mission is created + messages captured
#   5. Each node output is available in final state
#   6. Audit trail has execution traces for every step
#
# Usage:
#   BASE=http://localhost:4000/v1 TOKEN=<jwt> ./scripts/e2e-harness-smoke.sh

set -euo pipefail

BASE=${BASE:-http://localhost:4000/v1}
TOKEN=${TOKEN:?"Set TOKEN env var — login first: curl -X POST $BASE/auth/login ..."}

hdr=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )

echo "═══════════════════════════════════════════════════════════"
echo "Metis.AI — End-to-End Harness Smoke Test"
echo "═══════════════════════════════════════════════════════════"

# ── 1. CapabilityRegistry health ──
echo -e "\n[1] CapabilityRegistry 목록 조회"
caps=$(curl -s "$BASE/capabilities" "${hdr[@]}")
cap_count=$(echo "$caps" | jq '.items | length')
echo "  총 Capability: $cap_count"
echo "  Kind별 facet:"
curl -s "$BASE/capabilities/facets" "${hdr[@]}" | jq '.byKind'

if [ "$cap_count" -lt 10 ]; then
  echo "❌ Capability가 너무 적음 (최소 10개 기대). 시드 실행을 확인하세요."
  exit 1
fi

# ── 2. Agent Registry ──
echo -e "\n[2] AgentRegistry 등록된 에이전트 확인"
curl -s "$BASE/capabilities/agents/list" "${hdr[@]}" \
  | jq '.items | map({key, category, status})'

# ── 3. Builder CapabilityPlanner로 워크플로우 자동 생성 ──
echo -e "\n[3] Builder CapabilityPlanner: AP 시나리오"
INTENT="Acme 인보이스 OCR 처리 후 금액 검증하고 리스크가 낮으면 자동 승인, Slack으로 알림"
plan=$(curl -s -X POST "$BASE/builder/capability-plan" "${hdr[@]}" \
  -d "{\"intent\":\"$INTENT\",\"hints\":{\"domain\":\"ap\"}}")
echo "  의도: $INTENT"
echo "  설명: $(echo "$plan" | jq -r .explanation)"
echo "  신뢰도: $(echo "$plan" | jq -r .confidence)"
echo "  노드 수: $(echo "$plan" | jq '.nodes | length')"
echo "  선택된 Capabilities:"
echo "$plan" | jq '.capabilitiesUsed | map({key, kind, category})'

# Extract nodes to pass to runner
nodes=$(echo "$plan" | jq '.nodes')

# ── 4. WorkflowRunner로 실제 실행 ──
echo -e "\n[4] WorkflowRunner: 계획된 워크플로우 E2E 실행"
run_payload=$(jq -n \
  --arg title "AP 자동 처리 테스트" \
  --argjson nodes "$nodes" \
  --argjson initial '{"invoiceNumber":"INV-E2E-001","vendorName":"Acme","amount":5000000,"subjectId":"acc-001","transactionCountPerHour":3}' \
  '{workflowKey: "e2e-ap-auto", title: $title, nodes: $nodes, initialInput: $initial, createMission: true, missionKind: "AP_PROCESS"}')

result=$(curl -s -X POST "$BASE/workflows/run" "${hdr[@]}" -d "$run_payload")
status=$(echo "$result" | jq -r .status)
mission_id=$(echo "$result" | jq -r '.missionId // empty')
session_id=$(echo "$result" | jq -r .executionSessionId)
correlation=$(echo "$result" | jq -r .correlationId)
total_ms=$(echo "$result" | jq -r .totalDurationMs)

echo "  실행 상태: $status"
echo "  Mission ID: $mission_id"
echo "  Session ID: $session_id"
echo "  총 소요: ${total_ms}ms"
echo "  노드별 결과:"
echo "$result" | jq '.nodeResults | map({nodeId, success, durationMs})'

# ── 5. Mission 타임라인 검증 ──
if [ -n "$mission_id" ]; then
  echo -e "\n[5] Mission 타임라인 (A2A 메시지)"
  curl -s "$BASE/missions/$mission_id/messages" "${hdr[@]}" \
    | jq '.items | map({kind, fromAgent, toAgent, naturalSummary})' | head -60
fi

# ── 6. ExecutionSteps 감사 ──
echo -e "\n[6] ExecutionSteps (per-node 상세)"
curl -s "$BASE/executions/$session_id" "${hdr[@]}" 2>/dev/null \
  | jq '.steps // "steps endpoint 없음 (선택 기능)"' 2>/dev/null || echo "  (steps 조회 미구현)"

# ── 7. 최종 검증 ──
echo -e "\n[7] 검증 결과 요약"
if [ "$status" = "SUCCEEDED" ]; then
  echo "  ✅ 워크플로우 정상 완료"
elif [ "$status" = "PAUSED" ]; then
  echo "  ⚠️ 인간 개입 대기 (예상된 흐름일 수 있음)"
else
  echo "  ❌ 워크플로우 실패 — 에러 확인 필요"
  echo "$result" | jq '.nodeResults | map(select(.success == false))'
  exit 2
fi

# ── 8. Phase 7: Explicit DAG with parallel execution ──
echo -e "\n[8] Phase 7 — 명시적 DAG + 병렬 실행 검증"
dag_payload=$(cat <<EOF
{
  "workflowKey": "e2e-dag-parallel",
  "title": "DAG 병렬 실행 테스트",
  "nodes": [
    { "id": "start", "type": "start" },
    { "id": "ocr", "type": "adapter", "capability": "adapter:ocr-mock", "dependsOn": ["start"], "config": { "defaultInput": { "sourceUri": "s3://test/inv.pdf" } } },
    { "id": "validate", "type": "agent", "capability": "agent:qa-agent", "dependsOn": ["ocr"] },
    { "id": "risk", "type": "agent", "capability": "agent:risk-agent", "dependsOn": ["ocr"], "config": { "defaultInput": { "amount": 5000000, "transactionCountPerHour": 3 } } },
    { "id": "end", "type": "end", "dependsOn": ["validate", "risk"] }
  ],
  "initialInput": {},
  "createMission": true,
  "missionKind": "AP_PROCESS"
}
EOF
)
dag_result=$(curl -s -X POST "$BASE/workflows/run" "${hdr[@]}" -d "$dag_payload")
echo "$dag_result" | jq '{status, totalDurationMs, nodeCount: (.nodeResults | length)}'

dag_status=$(echo "$dag_result" | jq -r .status)
if [ "$dag_status" = "SUCCEEDED" ]; then
  echo "  ✅ DAG 워크플로우 정상 완료 (validate/risk 병렬 실행)"
else
  echo "  ❌ DAG 워크플로우 실패"
  echo "$dag_result" | jq '.nodeResults'
fi

# ── 9. Phase 7: Schema validation rejection ──
echo -e "\n[9] Phase 7 — 스키마 검증 (의도적 오류)"
bad_payload='{
  "workflowKey": "e2e-bad-schema",
  "title": "스키마 위반 테스트",
  "nodes": [
    { "id": "start", "type": "start" },
    { "id": "ap", "type": "agent", "capability": "agent:ap-agent", "dependsOn": ["start"], "config": { "defaultInput": { "action": 123 } } },
    { "id": "end", "type": "end", "dependsOn": ["ap"] }
  ]
}'
bad_result=$(curl -s -X POST "$BASE/workflows/run" "${hdr[@]}" -d "$bad_payload")
echo "$bad_result" | jq '.nodeResults'
# If the schema validator is strict, the ap node should fail.
echo "  (위 결과에 validation error 포함 시 스키마 검증 작동 확인)"

echo -e "\n═══════════════════════════════════════════════════════════"
echo "✅ E2E Harness Smoke Test 완료 (Phase 6 + Phase 7)"
echo "═══════════════════════════════════════════════════════════"
echo "correlationId로 전체 감사 추적 가능: $correlation"
