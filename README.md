# Metis.AI

**ITO Agent 통합운영(거버넌스) 플랫폼** — 멀티테넌트 SaaS

운영 환경에서 동작하는 AI Agent를 *등록 심사 · 수행 통제 · 비용(FinOps) 거버넌스* 관점에서 통합 관리하는 플랫폼입니다. Agent의 품질·보안·비용·책임추적을 실시간으로 통제하고, 모든 판정·조치·승인을 증거(Evidence)로 남깁니다.

---

## 아키텍처 4계층

| 계층 | 영역 | 핵심 |
|------|------|------|
| **L1** | 성과·KPI 대시보드 | KPI·품질·비용 실시간 측정 (사용자·운영자·고객·비용 4관점) |
| **L2** | 거버넌스 엔진 (수행 통제) | 실행 중 5-Gate 평가 → 정책 판정 → 자동 차단·격리 → 감사 증거 |
| **L3** | Agent 등록관리 (배포 전 심사) | 등록 심사(6-Gate + ORB) → 승인본만 배포 → 변경(drift) 감지 |
| **L4** | 인프라 & 연동 | PostgreSQL · Redis · MCP 커넥터 · ITSM/APM/CI·CD/Slack 연동 |

---

## 기술 스택

- **모노레포**: Turborepo + pnpm workspace
- **백엔드** (`apps/api`): NestJS 10 · Prisma ORM · PostgreSQL 16
- **프론트엔드** (`apps/web`): Next.js 15 (App Router) · React 19 · TanStack Query · Zustand · Tailwind CSS
- **워커** (`apps/worker`): 비동기 작업 처리
- **공유 패키지** (`packages/`): `database`(Prisma 스키마) · `types`(TypeScript 타입)
- **인증/권한**: JWT + RBAC (6역할: PLATFORM_ADMIN ~ VIEWER) · 테넌트 격리

---

## 프로젝트 구조

```
metis-ai/
├── apps/
│   ├── api/        # NestJS API 서버
│   ├── web/        # Next.js 프론트엔드
│   └── worker/     # 비동기 워커
├── packages/
│   ├── database/   # Prisma 스키마 · 마이그레이션 · 시드
│   └── types/      # 공유 TypeScript 타입
├── sdks/python/    # 외부 연동용 Python SDK
├── deploy/         # 배포 매니페스트
├── infra/          # 인프라 설정
└── docs/           # 설계 문서
```

---

## 로컬 실행

### 사전 요구사항
- Node.js 20+
- pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- PostgreSQL 16
- Redis

### 환경 변수
```bash
cp .env.example .env
# .env 파일을 열어 DB 연결 정보, API 키 등을 입력
```

### 설치 및 실행
```bash
# 의존성 설치
pnpm install --frozen-lockfile

# DB 스키마 생성 / 마이그레이션 / 시드
pnpm db:generate
pnpm --filter @metis/database push
pnpm db:seed

# 개발 서버 (Windows: start-metis.bat 사용 가능)
pnpm --filter @metis/api dev
pnpm --filter @metis/web dev
pnpm --filter @metis/worker dev
```

기본 접속: 프론트엔드 `http://localhost:3000` · API `http://localhost:3001`

---

## 사내망(Nexus + CI/CD) 운영

사내 폐쇄망에서는 사내 Nexus 레지스트리를 통해 패키지를 설치합니다.

```ini
# .npmrc
registry=https://<nexus-host>/repository/npm-group/
//<nexus-host>/repository/npm-group/:_authToken=${NEXUS_TOKEN}
```

CI 파이프라인:
```yaml
- run: corepack enable && corepack prepare pnpm@9.15.9 --activate
- run: pnpm install --frozen-lockfile
- run: pnpm build
```

---

## 라이선스 / 기밀

본 저장소는 **사내 전용(Confidential)** 입니다. 무단 복제·배포·공개를 금합니다.
© 2026 KTDS ICT AX사업본부 Ops.AI
