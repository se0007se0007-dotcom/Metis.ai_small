# METIS 사내망(Azure AKS) 배포

## 빠른 시작
1. `cp deploy/.env.production.example .env` 후 값 채우기 (또는 K8s Secret/Key Vault).
2. `deploy/helm/metis/values.yaml`에서 image.registry / ingress.host / secret.data 설정.
3. 시크릿 주입:
   - 간단: `values.yaml`의 `secret.data`에 값 입력(create=true).
   - 권장(운영): Azure Key Vault + Secret Store CSI로 `metis-secrets` 동기화 후 `secret.create=false`, `secret.existingSecret=metis-secrets`.
4. 배포: `ACR=myacr.azurecr.io TAG=1.1.0 NS=metis ./deploy/install.sh`

## 구성
- 이미지 3종(api/web/worker) + migrate(1회 Job). `deploy/docker/Dockerfile` 멀티타깃.
- Helm 차트 `deploy/helm/metis` — Deployment/Service/Ingress/ConfigMap/Secret/PVC/HPA/Migrate-Job.
- DB 스키마 반영: pre-install/pre-upgrade Helm hook Job이 `pnpm db:push (+ db:seed)` 실행.
- 외부 노출: Ingress → web(3000)만. web이 `/api/*`를 내부 API(4000/v1)로 프록시(API 직접 노출 안 함).
- 파일 저장: PVC(Azure Files, RWX) → UPLOAD_DIR/OUTPUT_DIR.

## 사전 점검
- `helm lint deploy/helm/metis` 및 `helm template ... | kubectl apply --dry-run=server -f -`
- 사내망 egress: LLM API(api.anthropic.com/api.openai.com) 허용 또는 사내 프록시/내부 LLM 설정.
