# Metis.AI 사내망 CI/CD 구성 가이드 (KT Azure 랜딩존 + AKS + Nexus Pro)

목표: 소스를 사내망으로 옮긴 뒤 **커밋 → 자동 빌드/검증 → 이미지 푸시 → 승인 → AKS 배포**가 도는 파이프라인.
이미 저장소에 있는 자산(멀티타깃 Dockerfile, Helm 차트, install.sh)을 그대로 쓰므로 추가 개발 없이 "연결"만 하면 됩니다.

```
[사내 Git(Azure Repos)] → [Self-hosted Agent VM(랜딩존 노드)]
      push 트리거              │ pnpm install ← Nexus npm-proxy
                               │ docker build ← Nexus dockerhub-proxy (base image)
                               │ prisma generate ← Nexus raw-proxy (엔진 바이너리)
                               ▼
                         [ACR(또는 Nexus docker-hosted)]
                               ▼  승인(Environment check)
                         [AKS] helm upgrade --install (pre-upgrade hook이 DB 마이그레이션)
```

---

## 0. 준비물 체크리스트

| 항목 | 내용 |
|---|---|
| 랜딩존 VM 1대 (리눅스 권장, 4vCPU/16GB) | CI 에이전트 + 도커 빌드 수행 |
| VM에 설치 | docker, kubectl, helm, az CLI, git, (Node 불필요 — corepack은 도커 안에서) |
| Azure DevOps | 사내 조직/프로젝트, Azure Repos에 소스 push |
| Nexus Pro 레포 3개 | ① npm-proxy(→registry.npmjs.org) ② dockerhub-proxy(→Docker Hub) ③ **prisma-raw-proxy(→https://binaries.prisma.sh, raw 타입)** |
| 레지스트리 | ACR(랜딩존 기본) 또는 Nexus docker-hosted |
| AKS | 네임스페이스 metis, ACR pull 권한(`az aks update --attach-acr`) |

> **Prisma 엔진 미러가 핵심 함정입니다.** `pnpm db:generate`는 npm 외에 `binaries.prisma.sh`에서 엔진 바이너리를 받습니다. 폐쇄망에서는 Nexus **raw-proxy** 레포를 만들어 `PRISMA_ENGINES_MIRROR`로 지정해야 합니다(파이프라인/Dockerfile에 이미 변수로 반영됨).

## 1. Nexus 설정 (관리자 1회)

1. npm-proxy: Repositories → Create → npm(proxy) → remote `https://registry.npmjs.org` → URL 예: `https://nexus.corp.local/repository/npm-proxy/`
2. dockerhub-proxy: docker(proxy) → remote `https://registry-1.docker.io` → HTTPS 커넥터 포트(예: 8443) → `nexus.corp.local:8443`
3. prisma-raw-proxy: **raw(proxy)** → remote `https://binaries.prisma.sh` → URL 예: `https://nexus.corp.local/repository/prisma-raw-proxy`
4. (Nexus를 이미지 저장소로도 쓸 경우) docker(hosted) 레포 추가.

VM에서 확인:
```bash
npm config set registry https://nexus.corp.local/repository/npm-proxy/
npm ping
docker pull nexus.corp.local:8443/dockerhub-proxy/library/node:20-bookworm-slim
curl -I https://nexus.corp.local/repository/prisma-raw-proxy/  # 200/30x면 OK
```

## 2. Self-hosted Agent 설치 (VM에서 1회)

```bash
# Azure DevOps → Project Settings → Agent pools → "metis-pool" 생성 → New agent 안내대로
mkdir agent && cd agent
tar zxvf vsts-agent-linux-x64-*.tar.gz
./config.sh --url https://dev.azure.com/<org> --pool metis-pool --agent metis-agent-1
sudo ./svc.sh install && sudo ./svc.sh start
# docker 권한
sudo usermod -aG docker $(whoami)
```

## 3. Azure DevOps 설정 (1회)

1. **Variable Group** `metis-cicd` (Pipelines → Library):
   - `ACR_LOGIN_SERVER` = ktacr.azurecr.io
   - `NEXUS_NPM_REGISTRY` = https://nexus.corp.local/repository/npm-proxy/
   - `NEXUS_DOCKER_PROXY` = nexus.corp.local:8443/dockerhub-proxy
   - `PRISMA_MIRROR` = https://nexus.corp.local/repository/prisma-raw-proxy
   - `AKS_RG`, `AKS_NAME`, `AKS_NAMESPACE`(=metis)
2. **Service Connections**:
   - `metis-acr` (Docker Registry 타입 → ACR)
   - `metis-azure` (Azure Resource Manager → AKS 구독/RG 권한)
3. **Environment** `metis-prod` 생성 → Approvals and checks → 승인자 지정 (배포 수동 승인 게이트).
4. Pipelines → New pipeline → Azure Repos → 기존 `azure-pipelines.yml` 선택.

## 4. 시크릿/환경변수 주입

- 앱 런타임 시크릿(ANTHROPIC_API_KEY 등)은 파이프라인이 아니라 **K8s Secret**으로:
  ```bash
  kubectl -n metis create secret generic metis-env \
    --from-literal=ANTHROPIC_API_KEY=... \
    --from-literal=OPENAI_API_KEY=... \
    --from-literal=DATABASE_URL=... \
    --from-literal=AUTH_SECRET=...
  ```
  (helm values에서 envFrom으로 참조 — `deploy/helm/metis/values.yaml` 확인. Azure Key Vault + CSI 드라이버로 승격 가능)
- `deploy/.env.production.example` 참고.

## 5. 첫 배포 순서

```bash
# 1) 소스 반입 후 Azure Repos push (브랜치: main 또는 metis-improvements)
# 2) 파이프라인 자동 트리거 → CI → Image → (승인) → Deploy
# 3) 첫 회만 DB 시드가 필요하면 migrate 이미지를 Job으로 1회 실행하거나
#    helm hook이 db:push+seed를 수행하는지 values 확인
kubectl -n metis get pods
kubectl -n metis logs deploy/metis-api --tail=50
```

## 6. 운영 루틴

- **배포**: main에 머지 → 자동 빌드 → Environment 승인 클릭 → 완료 (5~10분)
- **롤백**: `helm -n metis history metis` → `helm -n metis rollback metis <rev>` (이미지 태그가 빌드번호라 어느 시점이든 복귀 가능)
- **핫픽스**: 브랜치 push → 같은 파이프라인 → 승인 시 배포
- **이미지 정리**: ACR retention 정책(예: 30일/태그 50개) 1회 설정

## 7. 자주 막히는 포인트 (폐쇄망 특화)

| 증상 | 원인/해결 |
|---|---|
| `pnpm install` 404/ETIMEDOUT | NPM_REGISTRY 미적용 — Variable Group 값/뒤 슬래시 확인 |
| `prisma generate`에서 행/타임아웃 | **PRISMA_ENGINES_MIRROR 미설정** — raw-proxy 레포 확인 |
| base image pull 실패 | dockerhub-proxy 경로에 `/library/` 누락 (`.../library/node:20-...`) |
| next build에서 멈춤 | 텔레메트리 외부 전송 — `NEXT_TELEMETRY_DISABLED=1` (반영됨) |
| AKS에서 ImagePullBackOff | `az aks update -g RG -n AKS --attach-acr ACR` 또는 imagePullSecret |
| corepack이 pnpm 다운로드 시도 | corepack도 npm registry를 따름 — `COREPACK_NPM_REGISTRY=$(NEXUS_NPM_REGISTRY)` 환경변수 추가 |
| 사설 CA(SSL) 오류 | 사내 CA를 VM(`/usr/local/share/ca-certificates`)과 Dockerfile base에 추가, `npm config set cafile` |

## 8. 사내 GitHub(Enterprise)를 쓰는 경우 — GitHub Actions

사내 깃허브에 push하며 진행한다면 `.github/workflows/ci.yml`이 동일 흐름(사전점검 → CI → 이미지 → 승인 → AKS)을 GitHub Actions로 제공합니다.

1. 랜딩존 VM에 self-hosted runner 등록 (labels: `self-hosted, metis`)
2. Repo Settings → Actions Variables/Secrets 등록 (ci.yml 머리말 참고)
3. Settings → Environments → `metis-prod`에 Required reviewers 지정(승인 게이트)

**반복 오류 잡기용 사전점검**: 빌드를 돌리기 전에 VM(또는 로컬)에서

```bash
NEXUS_NPM_REGISTRY=https://nexus.corp.local/repository/npm-proxy/ \
NEXUS_DOCKER_PROXY=nexus.corp.local:8443/dockerhub-proxy \
PRISMA_MIRROR=https://nexus.corp.local/repository/prisma-raw-proxy \
bash scripts/preflight-closed-network.sh
```

→ 못 찾는 이미지/미러/패키지를 **한 번에 목록으로** 보여주므로, 오류를 하나씩 만나가며 재빌드하는 시간을 줄여줍니다. 워크플로의 첫 잡(preflight)도 같은 스크립트를 실행합니다.

## 9. 더 쉬운 대안 (참고)

GitLab CE를 그 노드에 단독 설치하면 Git+CI+레지스트리가 한 통에 들어옵니다(.gitlab-ci.yml 변환은 요청 시 즉시 생성 가능). 다만 KT 랜딩존이면 (사내 GitHub Actions 또는 Azure DevOps) + ACR + AKS 조합이 권한/네트워크 정책상 마찰이 가장 적습니다.
