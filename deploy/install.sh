#!/usr/bin/env bash
# METIS 사내망(AKS) 자동 빌드+배포 스크립트
# 사전: az login, az aks get-credentials, ACR attach, helm/kubectl/docker 설치
# 사용:  ACR=myacr.azurecr.io TAG=1.1.0 NS=metis ./deploy/install.sh
set -euo pipefail
ACR="${ACR:?ACR 레지스트리(예: myacr.azurecr.io) 필요}"
TAG="${TAG:-1.1.0}"
NS="${NS:-metis}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▶ 1) 이미지 빌드 (api/web/worker/migrate)"
for T in api web worker migrate; do
  docker build -f deploy/docker/Dockerfile --target "$T" -t "$ACR/metis-$T:$TAG" .
done

echo "▶ 2) ACR 푸시"
az acr login --name "${ACR%%.*}"
for T in api web worker migrate; do docker push "$ACR/metis-$T:$TAG"; done

echo "▶ 3) 네임스페이스"
kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"

echo "▶ 4) Helm 배포 (pre-upgrade hook이 DB 스키마 반영 + 시드 수행)"
helm upgrade --install metis deploy/helm/metis \
  --namespace "$NS" \
  --set image.registry="$ACR" \
  --set image.tag="$TAG" \
  -f deploy/helm/metis/values.yaml \
  --wait --timeout 10m

echo "✅ 완료. 상태 확인:  kubectl -n $NS get pods,svc,ingress"
