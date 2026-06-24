# Metis FinOps — 보안 운영 노트

## API 키 / 비밀 관리

- **`.env`는 Git에 절대 커밋되지 않습니다.** `.gitignore`가 `.env`, `.env.*`(단 `.env.example` 제외), `*.key`, `*.pem`, `secrets/`를 제외합니다.
- `push_to_github.bat`은 푸시 직전 **스테이징된 파일에서 API 키 패턴(`sk-ant-api`, `sk-proj-`, `sk-…`)을 스캔**해 발견 시 푸시를 중단합니다.
- **⚠ 키 회전 권고**: 개발 과정에서 OpenAI/Anthropic 키가 평문으로 다뤄졌다면(로컬 `.env`, 공유 등) 운영 전환 전 반드시 **키를 재발급(rotate)** 하세요.
- 운영 배포에서는 `.env` 대신 **Kubernetes Secret → 권장은 Azure Key Vault + Secrets Store CSI Driver**로 주입합니다(가이드 7장).

## 컨트롤플레인 불통 시 동작 (fail mode)

게이트웨이 환경변수 `METIS_FAIL_CLOSED`로 제어합니다.

| 값 | 동작 | 용도 |
|---|---|---|
| `0` (기본) | 통과(fail-open). 단 캐시는 비활성(미검증 응답 미제공) | 개발/데모 |
| `1` | 컨트롤플레인 불통 시 **503 거부**(예산·거버넌스 우회 방지) | **운영 권장** |

AKS 매니페스트(`deploy/k8s/30-gateway.yaml`)는 기본으로 `METIS_FAIL_CLOSED=1`을 설정합니다.
어느 모드든 **캐시 조회는 항상 fail-closed** — 컨트롤플레인이 캐시 정책(민감/고위험 차단)을 판정하지 못하면 캐시를 제공하지 않습니다.

## 캐시 백엔드 (멀티 레플리카)

- 게이트웨이 시맨틱 캐시는 `REDIS_URL` 미설정 시 **프로세스 인메모리**(단일 노드 전용)입니다.
- AKS 다중 레플리카에서는 `REDIS_URL`(예: Azure Cache for Redis)을 설정해 **레플리카 간 캐시를 공유**하세요. 미설정 시 레플리카마다 캐시가 분리되어 히트율이 낮아집니다.
- Redis 연결 실패 시 자동으로 인메모리로 폴백하며 `/health`의 `cache_backend` 필드로 현재 모드를 확인할 수 있습니다.

## 거버넌스 (Patent 3) 안전장치

- 데이터 등급 `PII`/`SECRET`/`CUSTOMER_CONFIDENTIAL` 요청은 시맨틱 캐시 재사용이 차단됩니다(누출 방지).
- 캐시 키는 테넌트 + 정책 해시 + 데이터 등급으로 스코프되어 **정책 변경 시 기존 캐시가 자동 무효화**됩니다.
- 고위험(riskScore ≥ 임계) 요청은 예산 압박에도 강등되지 않고 안전 최소 티어 이상으로 보장됩니다.
- 거버넌스 뷰의 **"민감 데이터 캐시 누출 0건"** 지표로 준수 여부를 상시 감시하세요.

## 코드 실행 격리 (Test Agent)

- Test Agent는 업로드 코드를 컴파일·실행합니다. 운영에서는 **전용 노드풀 + NetworkPolicy(egress 차단) + gVisor/Kata** 격리를 권장합니다.
- 보고서 산출물은 자동으로 최근 50건만 보존됩니다(디스크 누적 방지).

## 운영 전 필수 체크리스트

`deploy/배포가이드_사내망_AKS.md` 7장(운영 전환 체크리스트) 참조: 인증/RBAC, PostgreSQL 전환, Redis, Key Vault, NetworkPolicy, 컴플라이언스 인증.
