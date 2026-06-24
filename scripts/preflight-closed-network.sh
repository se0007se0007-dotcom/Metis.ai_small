#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# 폐쇄망 사전점검 — "이미지/미러 못 찾는 오류"를 빌드 전에 한 번에 발견
#
# 사용: NEXUS_NPM_REGISTRY=... NEXUS_DOCKER_PROXY=... PRISMA_MIRROR=... \
#       bash scripts/preflight-closed-network.sh
#
# 검사 항목:
#   1) Nexus npm 프록시 응답 + 핵심 패키지 메타데이터 조회
#   2) 베이스 이미지(node:20-bookworm-slim) pull 가능 여부
#   3) Prisma 엔진 미러 응답
#   4) docker / helm / kubectl / git 설치 여부
# 실패 항목은 모아서 마지막에 한꺼번에 보고 (exit 1).
# ════════════════════════════════════════════════════════════════
set -u
FAILED=()
ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED+=("$1"); }

echo "── 1. CLI 도구 ──"
for c in docker git curl; do
  command -v "$c" >/dev/null 2>&1 && ok "$c" || fail "$c 미설치"
done
for c in helm kubectl; do
  command -v "$c" >/dev/null 2>&1 && ok "$c" || echo "  - $c 없음 (배포 잡에서만 필요)"
done

echo "── 2. Nexus npm 프록시 (${NEXUS_NPM_REGISTRY:-미설정}) ──"
if [ -n "${NEXUS_NPM_REGISTRY:-}" ]; then
  # 핵심 패키지 3종 메타데이터가 프록시를 통해 보이는지
  for pkg in pnpm typescript @prisma/client; do
    code=$(curl -ks -o /dev/null -w '%{http_code}' "${NEXUS_NPM_REGISTRY%/}/${pkg}")
    if [ "$code" = "200" ]; then ok "npm: $pkg ($code)"; else fail "npm: $pkg → HTTP $code (프록시 원격/권한 확인)"; fi
  done
else
  fail "NEXUS_NPM_REGISTRY 미설정"
fi

echo "── 3. 베이스 이미지 (${NEXUS_DOCKER_PROXY:-미설정}) ──"
if [ -n "${NEXUS_DOCKER_PROXY:-}" ]; then
  IMG="${NEXUS_DOCKER_PROXY}/library/node:20-bookworm-slim"
  if docker pull "$IMG" >/dev/null 2>&1; then
    ok "docker pull $IMG"
  else
    fail "docker pull $IMG 실패 (경로에 /library/ 포함했는지, 프록시 포트/인증 확인)"
  fi
else
  fail "NEXUS_DOCKER_PROXY 미설정"
fi

echo "── 4. Prisma 엔진 미러 (${PRISMA_MIRROR:-미설정}) ──"
if [ -n "${PRISMA_MIRROR:-}" ]; then
  code=$(curl -ks -o /dev/null -w '%{http_code}' "${PRISMA_MIRROR%/}/")
  case "$code" in
    2*|3*|401|403) ok "미러 응답 (HTTP $code)";;
    *) fail "Prisma 미러 → HTTP $code (raw-proxy 레포가 binaries.prisma.sh를 가리키는지 확인)";;
  esac
else
  fail "PRISMA_MIRROR 미설정 — pnpm db:generate가 외부로 나가다 실패합니다"
fi

echo ""
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ 사전점검 실패 ${#FAILED[@]}건:"
  for f in "${FAILED[@]}"; do echo "   - $f"; done
  echo "위 항목을 해결한 뒤 다시 실행하세요. (deploy/CICD-GUIDE.md 7장 참고)"
  exit 1
fi
echo "✓ 폐쇄망 사전점검 통과 — 빌드를 진행해도 좋습니다."
