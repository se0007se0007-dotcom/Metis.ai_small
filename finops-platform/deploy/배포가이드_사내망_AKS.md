# Metis FinOps — 사내망(Azure AKS + Nexus Pro) 배포 가이드

전체 흐름:

```
[개발PC/외부망]                [사내망]
GitHub 푸시  ──다운로드──▶  로컬 검증(run.bat)
                              │
                              ▼
                  이미지 빌드 (모든 의존성 → Nexus Pro 경유)
                              │ docker push
                              ▼
                  레지스트리 (ACR 권장 / Nexus docker-hosted 가능)
                              │ kubectl apply
                              ▼
                  AKS (metis-finops 네임스페이스, 사내 Ingress)
```

이 저장소는 폐쇄망 대응이 이미 반영되어 있습니다: 대시보드 JS(Chart.js/marked)는
`static/vendor/` 로컬 번들을 사용하고(외부 CDN 불필요), Dockerfile 은 `--build-arg` 로
Nexus 프록시를 받도록 파라미터화되어 있습니다.

---

## 0. 사전 준비 — Nexus Pro 리포지토리 4종

| 리포지토리 | 타입 | 용도 | 예시 주소 |
|---|---|---|---|
| `pypi-proxy` | proxy → pypi.org | pip 패키지 (fastapi, matplotlib 등) | https://nexus.company.com/repository/pypi-proxy/simple |
| `docker-proxy` | proxy → docker.io | 베이스 이미지 (python:3.12-slim) | nexus.company.com:5000 (docker group/proxy 포트) |
| `docker-hosted` | hosted | 빌드한 메티스 이미지 보관 (ACR 미사용 시) | nexus.company.com:5001 |
| `apt-proxy` | proxy → deb.debian.org | test-agent 이미지의 gcc/JDK 설치 | nexus.company.com/repository/apt-proxy (선택) |

ACR(Azure Container Registry)을 쓸 수 있으면 docker-hosted 대신 ACR 권장
(AKS와 관리ID 연동으로 imagePullSecret 불필요).

## 1. GitHub 업로드 (외부망 PC)

```bash
cd C:\Users\se000\14.FINOPS플랫폼
git init
git add .
git commit -m "Metis FinOps platform v1.0"
git remote add origin https://github.com/<계정>/metis-finops.git
git push -u origin main
```

확인 사항 (보안):
- `.gitignore` 가 `.env`(실 API 키), `data/`(원장 DB), `reports/` 를 제외하는지 푸시 전 `git status` 로 확인.
- **`.env` 는 절대 커밋 금지** — 키는 5장에서 K8s Secret 으로 주입.

## 2. 사내망 다운로드

사내망 GitHub 접근 방식에 따라:
- GitHub 프록시(Nexus raw-proxy 또는 사내 git mirror)가 있으면 그대로 clone
- 없으면 외부 PC 에서 `git archive` 또는 ZIP 다운로드 → 반입 절차로 전달

```bash
git clone https://github.com/<계정>/metis-finops.git   # 또는 ZIP 해제
```

## 3. 사내망 로컬 검증 (선택이지만 권장)

pip 이 Nexus 를 보도록 설정 후 run.bat 실행:

```
copy deploy\nexus\pip.conf.example %APPDATA%\pip\pip.ini   # 주소를 실제 Nexus 로 수정
copy .env.example .env                                      # Azure OpenAI 키 입력 (6장 참조)
run.bat
```

브라우저 http://localhost:8500 에서 대시보드·테스트 에이전트 동작 확인,
`python tests\e2e.py` 로 자가 테스트(25개 시나리오) 실행.

## 4. 이미지 빌드 & 푸시

```bash
NEXUS=nexus.company.com
REGISTRY=myacr.azurecr.io          # 또는 nexus.company.com:5001

for SVC in control_plane gateway test_agent simulator; do
  IMG=$(echo $SVC | tr '_' '-')
  docker build \
    --build-arg BASE_IMAGE=$NEXUS:5000/python:3.12-slim \
    --build-arg PIP_INDEX_URL=https://$NEXUS/repository/pypi-proxy/simple \
    --build-arg PIP_TRUSTED_HOST=$NEXUS \
    --build-arg APT_MIRROR=$NEXUS/repository/apt-proxy \
    -f services/$SVC/Dockerfile \
    -t $REGISTRY/metis-finops/$IMG:1.0.0 .
  docker push $REGISTRY/metis-finops/$IMG:1.0.0
done
```

(APT_MIRROR 인자는 test_agent 만 사용하며 나머지 이미지에서는 무시됨.
apt-proxy 가 없으면 test_agent 빌드만 외부 반출 PC에서 수행해 이미지로 반입.)

## 5. AKS 배포

```bash
az aks get-credentials -g <리소스그룹> -n <클러스터>

# 5-1. 네임스페이스
kubectl apply -f deploy/k8s/00-namespace.yaml

# 5-2. LLM 키 Secret (Azure OpenAI 권장 — 6장)
kubectl -n metis-finops create secret generic metis-llm-keys \
  --from-literal=AZURE_OPENAI_ENDPOINT='https://<리소스>.openai.azure.com' \
  --from-literal=AZURE_OPENAI_API_KEY='<키>' \
  --from-literal=AZURE_OPENAI_API_VERSION='2024-10-21' \
  --from-literal=ANTHROPIC_API_KEY='' \
  --from-literal=OPENAI_API_KEY=''

# 5-3. 레지스트리 주소 치환 후 적용
sed -i "s|__REGISTRY__|myacr.azurecr.io|g" deploy/k8s/*.yaml
kubectl apply -f deploy/k8s/20-control-plane.yaml
kubectl apply -f deploy/k8s/30-gateway.yaml
kubectl apply -f deploy/k8s/40-test-agent.yaml
kubectl apply -f deploy/k8s/50-simulator.yaml      # 데모용 — 운영 시 생략 가능
kubectl apply -f deploy/k8s/60-ingress.yaml        # host/ingressClass 를 환경에 맞게 수정

kubectl -n metis-finops get pods -w
```

접속: 사내 DNS(예: metis-finops.internal.company.com) → 대시보드.
에이전트 연동 엔드포인트: `https://metis-finops.internal.company.com/v1/chat/completions`

## 6. 사내망 LLM 연결 — Azure OpenAI 전환

사내망에서는 api.anthropic.com / api.openai.com 직접 호출이 차단되는 경우가 일반적입니다.
게이트웨이는 **AZURE_OPENAI_ENDPOINT 가 설정되어 있으면 gpt 계열 모델을 Azure 로 우선 라우팅**
하도록 이미 구현되어 있으므로, Secret 에 Azure 값만 넣으면 코드 수정 없이 동작합니다.

- Azure OpenAI 배포명 = 모델명(예: gpt-4o)으로 만들거나, 다르면 `AZURE_OPENAI_DEPLOYMENT` 지정
- 테스트 에이전트 리뷰 모델: `deploy/k8s/40-test-agent.yaml` 의 `TEST_AGENT_MODEL` 을
  `gpt-4o` 등 Azure 배포 모델로 변경
- Anthropic 을 사내에서 쓸 경우(프록시 허용 시) ANTHROPIC_API_KEY 만 추가하면 됨

## 7. 운영 전환 체크리스트 (프로토타입 → 운영)

| 항목 | 현재(프로토타입) | 운영 권장 |
|---|---|---|
| 인증 | 없음 | Ingress 앞단 AAD 인증(oauth2-proxy / EasyAuth), 게이트웨이는 가상키 발급 체계 |
| 원장 DB | SQLite + PVC (단일 레플리카) | PostgreSQL(Azure Database) 또는 ClickHouse 전환 후 control-plane 수평 확장 |
| 키 관리 | K8s Secret | Azure Key Vault + Secrets Store CSI Driver |
| 캐시/카운터 | 게이트웨이 인메모리 | Redis(Azure Cache) — 게이트웨이 다중 레플리카 간 공유 |
| 코드 실행 격리 | 서브프로세스 + 타임아웃 | gVisor/Kata 또는 전용 노드풀 + NetworkPolicy 로 test-agent 격리 |
| 텔레메트리 | 자체 수집 | OTel Collector 경유로 사내 APM(SkyWalking/Grafana) 연계 |
| 네트워크 | 기본 | NetworkPolicy: test-agent → gateway/control-plane 만 허용, egress 차단 |

## 8. 자주 걸리는 지점

- **pip 403/SSL**: pip.conf 의 trusted-host 누락 또는 Nexus 인증서 미신뢰 → 사내 CA 를 빌드 이미지에 추가
- **이미지 pull 실패**: AKS↔ACR 연결(`az aks update --attach-acr`) 또는 Nexus 용 imagePullSecret 생성
- **대시보드 차트 안 보임**: static/vendor/ 누락 — git 에 포함되어 있는지 확인 (CDN 폴백은 폐쇄망에서 무용)
- **테스트 에이전트 LLM 리뷰 타임아웃**: Ingress proxy-read-timeout(기본 60s) → 300s 로 상향(매니페스트 반영됨)
- **시뮬레이터 실비용**: SIM_USE_REAL_API 는 반드시 0 유지
