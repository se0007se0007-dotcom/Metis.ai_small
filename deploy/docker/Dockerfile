# syntax=docker/dockerfile:1
# Multi-target image for the METIS monorepo (pnpm + turborepo + prisma).
#   build: docker build -f deploy/docker/Dockerfile --target api    -t $ACR/metis-api:TAG .
#          docker build -f deploy/docker/Dockerfile --target web    -t $ACR/metis-web:TAG .
#          docker build -f deploy/docker/Dockerfile --target worker -t $ACR/metis-worker:TAG .
#
# ── 사내망(폐쇄망/Nexus) 빌드 인자 ──────────────────────────────
#   BASE_IMAGE            : node:20-bookworm-slim 의 사내 미러 경로
#                           예) nexus.corp.local:8443/dockerhub-proxy/library/node:20-bookworm-slim
#   NPM_REGISTRY          : 사내 Nexus npm 프록시
#                           예) https://nexus.corp.local/repository/npm-proxy/
#   PRISMA_ENGINES_MIRROR : binaries.prisma.sh 의 사내 미러(Nexus raw-proxy)
#                           예) https://nexus.corp.local/repository/prisma-raw-proxy
#   미지정 시 기존(외부 인터넷) 동작 그대로.
# Debian (glibc) base so Prisma uses its default engine; openssl required by Prisma.
ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ---- deps: install full workspace ----
FROM base AS deps
ARG NPM_REGISTRY=""
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps ./apps
# 사내 Nexus npm 프록시 사용 (미지정 시 registry.npmjs.org 기본값 유지)
# 주의: corepack이 pnpm 바이너리 자체를 받을 때도 레지스트리를 따라가므로
#       COREPACK_NPM_REGISTRY를 같은 셸에서 먼저 export해야 폐쇄망에서 동작.
RUN if [ -n "$NPM_REGISTRY" ]; then \
      export COREPACK_NPM_REGISTRY="$NPM_REGISTRY" && \
      npm config set registry "$NPM_REGISTRY" && \
      pnpm config set registry "$NPM_REGISTRY"; \
    fi \
  && pnpm install --frozen-lockfile

# ---- build: prisma client + turbo build all apps ----
FROM deps AS build
# 폐쇄망에서 Prisma 엔진 바이너리 다운로드 미러 (binaries.prisma.sh 프록시)
ARG PRISMA_ENGINES_MIRROR=""
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
# Next.js 텔레메트리(외부 전송) 비활성화 — 폐쇄망 빌드 행 방지
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm db:generate && pnpm build

# ---- api runtime ----
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/main.js"]

# ---- worker runtime ----
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/worker
CMD ["node", "dist/main.js"]

# ---- web runtime (Next.js) ----
FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]

# ---- migrate/seed (one-shot Job) ----
FROM build AS migrate
ENV NODE_ENV=production
WORKDIR /app
CMD ["sh", "-lc", "pnpm db:push && pnpm db:seed"]
