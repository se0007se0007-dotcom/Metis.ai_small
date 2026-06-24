/**
 * Ingest API Key Service — Phase 1 (Ingestion On-Ramp)
 *
 * Issues and verifies long-lived API keys that EXTERNAL agents (running
 * outside METIS) use to POST their runs to the ingestion endpoint. Keys are
 * NEVER stored in plaintext: only a SHA-256 hash and a short display prefix
 * are persisted. The plaintext value is returned exactly once at creation.
 *
 * Key format:  mts_<env>_<32-hex>   (e.g. mts_live_ab12cd34...)
 *   - env ∈ { live, test }
 *   - prefix = first 12 chars (e.g. "mts_live_ab1") for safe display
 *
 * @module ingest
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PRISMA_TOKEN } from '../database.module';

// ────────────────────────────────────────────────────────────
// Pure helpers (exported for unit testing — no DB, no NestJS)
// ────────────────────────────────────────────────────────────

/** SHA-256 hex digest of the raw key. Deterministic — used for lookup. */
export function hashIngestKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/** Display prefix: first 12 chars of the raw key (e.g. "mts_live_ab1"). */
export function ingestKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 12);
}

/** Generate a fresh raw key: mts_<env>_<32 hex random>. */
export function generateIngestKey(env: string): string {
  const safeEnv = env === 'test' ? 'test' : 'live';
  const random = randomBytes(16).toString('hex'); // 32 hex chars
  return `mts_${safeEnv}_${random}`;
}

export interface IngestKeyScope {
  teamId?: string | null;
  agentKey?: string | null;
  subAgentKey?: string | null;
  agentName?: string | null;
  allowedAgentNames?: string[];
}

export interface CreatedIngestKey {
  id: string;
  /** Plaintext key — shown ONCE, never retrievable again. */
  key: string;
  prefix: string;
  name: string;
  env: string;
  scopes: string[];
  createdAt: Date;
}

export interface IngestKeyListItem {
  id: string;
  name: string;
  prefix: string;
  env: string;
  scopes: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  teamId: string | null;
  agentKey: string | null;
  subAgentKey: string | null;
  agentName: string | null;
  allowedAgentNames: string[];
  callCount: number;
  lastRunAt: Date | null;
}

@Injectable()
export class IngestKeyService {
  private readonly logger = new Logger(IngestKeyService.name);

  /** In-memory throttle for lastUsedAt writes (keyId -> last write ms). */
  private readonly lastUsedThrottle = new Map<string, number>();
  private static readonly LAST_USED_THROTTLE_MS = 60_000;

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  /**
   * Create a new ingest API key for a tenant. Returns the plaintext key ONCE
   * along with metadata. Only the hash + prefix are persisted.
   */
  async createKey(
    tenantId: string,
    name: string,
    env = 'live',
    createdById?: string,
    scope?: IngestKeyScope,
  ): Promise<CreatedIngestKey> {
    const safeEnv = env === 'test' ? 'test' : 'live';
    const rawKey = generateIngestKey(safeEnv);
    const hashedKey = hashIngestKey(rawKey);
    const prefix = ingestKeyPrefix(rawKey);

    const row = await (this.prisma as any).ingestApiKey.create({
      data: {
        tenantId,
        name: name?.trim() || 'External Agent Key',
        prefix,
        hashedKey,
        env: safeEnv,
        scopes: ['ingest:write'],
        createdById: createdById ?? null,
        // 표준화: 팀·메인Agent·Sub-Agent 귀속 + agentName 허용목록
        teamId: scope?.teamId ?? null,
        agentKey: scope?.agentKey ?? null,
        subAgentKey: scope?.subAgentKey ?? null,
        agentName: scope?.agentName ?? null,
        allowedAgentNames: scope?.allowedAgentNames ?? [],
      },
    });

    return {
      id: row.id,
      key: rawKey,
      prefix: row.prefix,
      name: row.name,
      env: row.env,
      scopes: row.scopes,
      createdAt: row.createdAt,
    };
  }

  /**
   * Verify a presented raw key. Returns { tenantId, keyId } when the key
   * exists and is not revoked; otherwise null. Best-effort, throttled
   * lastUsedAt update so hot keys don't write on every request.
   */
  async verifyKey(rawKey: string): Promise<{
    tenantId: string;
    keyId: string;
    allowedAgentNames: string[];
    subAgentKey: string | null;
    agentName: string | null;
  } | null> {
    if (!rawKey || !rawKey.startsWith('mts_')) return null;
    const hashedKey = hashIngestKey(rawKey);

    const row = await (this.prisma as any).ingestApiKey.findFirst({
      where: { hashedKey, revokedAt: null },
      select: {
        id: true,
        tenantId: true,
        allowedAgentNames: true,
        subAgentKey: true,
        agentName: true,
      },
    });
    if (!row) return null;

    // Throttled best-effort lastUsedAt touch — never block the request.
    try {
      const now = Date.now();
      const prev = this.lastUsedThrottle.get(row.id) ?? 0;
      if (now - prev > IngestKeyService.LAST_USED_THROTTLE_MS) {
        this.lastUsedThrottle.set(row.id, now);
        void (this.prisma as any).ingestApiKey
          .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
      }
    } catch {
      /* ignore */
    }

    return {
      tenantId: row.tenantId,
      keyId: row.id,
      allowedAgentNames: row.allowedAgentNames ?? [],
      subAgentKey: row.subAgentKey ?? null,
      agentName: row.agentName ?? null,
    };
  }

  /**
   * run이 키로 인증되어 처리될 때 호출 — 누적 호출수/마지막 사용 시각 갱신(best-effort).
   * 키별·Sub-Agent별 호출량 추적의 캐시. 상세 집계는 ExecutionSession.ingestKeyId 로 별도 쿼리.
   */
  async recordUsage(keyId: string): Promise<void> {
    if (!keyId) return;
    try {
      await (this.prisma as any).ingestApiKey.update({
        where: { id: keyId },
        data: { callCount: { increment: 1 }, lastRunAt: new Date() },
      });
    } catch {
      /* best-effort — 추적 실패가 ingest를 막지 않음 */
    }
  }

  /** List keys for a tenant — NEVER returns hashedKey. */
  async listKeys(tenantId: string): Promise<IngestKeyListItem[]> {
    const rows = await (this.prisma as any).ingestApiKey.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        env: true,
        scopes: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
        teamId: true,
        agentKey: true,
        subAgentKey: true,
        agentName: true,
        allowedAgentNames: true,
        callCount: true,
        lastRunAt: true,
      },
    });
    return rows as IngestKeyListItem[];
  }

  /** 테넌트 팀 목록. */
  async listTeams(tenantId: string): Promise<Array<{ id: string; name: string }>> {
    try {
      return await (this.prisma as any).team.findMany({
        where: { tenantId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
    } catch {
      return [];
    }
  }

  /** 팀 생성(테넌트 내 이름 유니크). 이미 있으면 기존 반환. */
  async createTeam(tenantId: string, name: string): Promise<{ id: string; name: string }> {
    const nm = (name || '').trim();
    if (!nm) throw new Error('팀 이름이 필요합니다.');
    const existing = await (this.prisma as any).team.findFirst({
      where: { tenantId, name: nm },
      select: { id: true, name: true },
    });
    if (existing) return existing;
    return (this.prisma as any).team.create({
      data: { tenantId, name: nm },
      select: { id: true, name: true },
    });
  }

  /**
   * 관리자 현황표 — 키별 사용량 + 그룹(팀/Sub-Agent/env) 집계.
   * 최근 7일 호출수·비용은 ExecutionSession.ingestKeyId 로 정확 집계, 누적은 키 캐시(callCount).
   */
  async overview(tenantId: string): Promise<{
    keys: any[];
    groups: { byTeam: any[]; bySubAgent: any[]; byEnv: any[] };
    totals: {
      keys: number;
      active: number;
      calls7d: number;
      cost7d: number;
      avgQuality: number | null;
      avgSecurity: number | null;
      anomalyRate: number;
    };
  }> {
    const keys = await (this.prisma as any).ingestApiKey.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prefix: true, env: true, scopes: true,
        lastUsedAt: true, revokedAt: true, createdAt: true,
        teamId: true, agentKey: true, subAgentKey: true, agentName: true,
        allowedAgentNames: true, callCount: true, lastRunAt: true,
        team: { select: { name: true } },
      },
    });

    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    // ── 최근 7일: 키별 호출수·비용 (ExecutionSession.ingestKeyId 기준) ──
    let recent: Array<{ ingestKeyId: string | null; _count: { _all: number }; _sum: { costUsd: any } }> = [];
    const sessKey = new Map<string, string>(); // sessionId -> keyId (품질/보안/이상 조인용)
    try {
      recent = await (this.prisma as any).executionSession.groupBy({
        by: ['ingestKeyId'],
        where: { tenantId, createdAt: { gte: since }, ingestKeyId: { not: null } },
        _count: { _all: true },
        _sum: { costUsd: true },
      });
      const sessions = await (this.prisma as any).executionSession.findMany({
        where: { tenantId, createdAt: { gte: since }, ingestKeyId: { not: null } },
        select: { id: true, ingestKeyId: true },
        take: 20000,
      });
      for (const s of sessions) sessKey.set(s.id, s.ingestKeyId);
    } catch {
      recent = [];
    }
    const recentByKey = new Map<string, { calls: number; cost: number }>();
    for (const r of recent) {
      if (!r.ingestKeyId) continue;
      recentByKey.set(r.ingestKeyId, { calls: r._count?._all ?? 0, cost: Number(r._sum?.costUsd ?? 0) });
    }

    // ── 4Gate 품질·보안·이상동작: AgentEvaluation 을 키별로 누적 ──
    // (키↔run = ExecutionSession.ingestKeyId, run↔평가 = AgentEvaluation.executionSessionId)
    const metric = new Map<string, { qSum: number; qN: number; sSum: number; sN: number; anom: number; n: number }>();
    try {
      const sessionIds = Array.from(sessKey.keys());
      if (sessionIds.length > 0) {
        const evals = await (this.prisma as any).agentEvaluation.findMany({
          where: { tenantId, executionSessionId: { in: sessionIds } },
          select: { executionSessionId: true, overallScore: true, securityScore: true, anomalyDetected: true },
          take: 50000,
        });
        for (const e of evals) {
          const kid = sessKey.get(e.executionSessionId);
          if (!kid) continue;
          let m = metric.get(kid);
          if (!m) { m = { qSum: 0, qN: 0, sSum: 0, sN: 0, anom: 0, n: 0 }; metric.set(kid, m); }
          if (typeof e.overallScore === 'number') { m.qSum += e.overallScore; m.qN++; }
          if (typeof e.securityScore === 'number') { m.sSum += e.securityScore; m.sN++; }
          if (e.anomalyDetected) m.anom++;
          m.n++;
        }
      }
    } catch {
      /* 평가 조인 실패해도 호출/비용은 표시 */
    }

    const enriched = keys.map((k: any) => {
      const rc = recentByKey.get(k.id) ?? { calls: 0, cost: 0 };
      const m = metric.get(k.id) ?? { qSum: 0, qN: 0, sSum: 0, sN: 0, anom: 0, n: 0 };
      return {
        ...k,
        teamName: k.team?.name ?? null,
        calls7d: rc.calls,
        cost7d: rc.cost,
        evalN: m.n,
        avgQuality: m.qN ? Math.round((m.qSum / m.qN) * 10) / 10 : null,
        avgSecurity: m.sN ? Math.round((m.sSum / m.sN) * 10) / 10 : null,
        anomalyRate: m.n ? Math.round((m.anom / m.n) * 1000) / 10 : 0, // %
        active: !k.revokedAt,
        _m: m,
      };
    });

    // ── 그룹 집계 (호출·비용 합 + 품질·보안·이상 가중평균) ──
    const groupBy = (rows: any[], keyFn: (r: any) => string) => {
      const m = new Map<string, any>();
      for (const r of rows) {
        const gk = keyFn(r);
        let g = m.get(gk);
        if (!g) { g = { label: gk, keys: 0, calls7d: 0, cost7d: 0, qSum: 0, qN: 0, sSum: 0, sN: 0, anom: 0, n: 0 }; m.set(gk, g); }
        g.keys += 1; g.calls7d += r.calls7d; g.cost7d += r.cost7d;
        g.qSum += r._m.qSum; g.qN += r._m.qN; g.sSum += r._m.sSum; g.sN += r._m.sN; g.anom += r._m.anom; g.n += r._m.n;
      }
      return Array.from(m.values())
        .map((g) => ({
          label: g.label, keys: g.keys, calls7d: g.calls7d, cost7d: g.cost7d,
          avgQuality: g.qN ? Math.round((g.qSum / g.qN) * 10) / 10 : null,
          avgSecurity: g.sN ? Math.round((g.sSum / g.sN) * 10) / 10 : null,
          anomalyRate: g.n ? Math.round((g.anom / g.n) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.calls7d - a.calls7d);
    };

    const byTeam = groupBy(enriched, (r) => r.teamName ?? '(미지정)');
    const bySubAgent = groupBy(enriched, (r) => r.subAgentKey ?? '(메인/미지정)');
    const byEnv = groupBy(enriched, (r) => r.env);

    // 전체 합계 (품질·보안 가중평균, 이상비율) — _m 삭제 전에 계산.
    let tQSum = 0, tQN = 0, tSSum = 0, tSN = 0, tAnom = 0, tN = 0;
    for (const e of enriched) {
      const m = (e as any)._m;
      tQSum += m.qSum; tQN += m.qN; tSSum += m.sSum; tSN += m.sN; tAnom += m.anom; tN += m.n;
    }
    for (const e of enriched) delete (e as any)._m; // 내부 누적치 제거

    const totals = {
      keys: enriched.length,
      active: enriched.filter((k: any) => k.active).length,
      calls7d: enriched.reduce((s: number, k: any) => s + k.calls7d, 0),
      cost7d: enriched.reduce((s: number, k: any) => s + k.cost7d, 0),
      avgQuality: tQN ? Math.round((tQSum / tQN) * 10) / 10 : null,
      avgSecurity: tSN ? Math.round((tSSum / tSN) * 10) / 10 : null,
      anomalyRate: tN ? Math.round((tAnom / tN) * 1000) / 10 : 0,
    };

    return { keys: enriched, groups: { byTeam, bySubAgent, byEnv }, totals };
  }

  /**
   * 키 메타/매핑 수정(테넌트 스코프) — 키 값/해시는 불변, 이름·팀·agent·sub-agent·허용목록만 변경.
   * 생성 후에도 관련 팀/Agent 맵핑을 자유롭게 고칠 수 있게 한다.
   */
  async updateKey(
    tenantId: string,
    id: string,
    patch: IngestKeyScope & { name?: string },
  ): Promise<{ ok: boolean }> {
    const existing = await (this.prisma as any).ingestApiKey.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) return { ok: false };
    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name?.trim() || 'External Agent Key';
    if (patch.teamId !== undefined) data.teamId = patch.teamId || null;
    if (patch.agentKey !== undefined) data.agentKey = patch.agentKey || null;
    if (patch.subAgentKey !== undefined) data.subAgentKey = patch.subAgentKey || null;
    if (patch.agentName !== undefined) data.agentName = patch.agentName || null;
    if (patch.allowedAgentNames !== undefined)
      data.allowedAgentNames = Array.isArray(patch.allowedAgentNames) ? patch.allowedAgentNames : [];
    await (this.prisma as any).ingestApiKey.update({ where: { id }, data });
    return { ok: true };
  }

  /** 키 완전 삭제(테넌트 스코프). 과거 run의 ingestKeyId 문자열은 남고 키 레코드만 제거. */
  async deleteKey(tenantId: string, id: string): Promise<{ id: string; deleted: boolean }> {
    try {
      const r = await (this.prisma as any).ingestApiKey.deleteMany({ where: { id, tenantId } });
      return { id, deleted: (r?.count ?? 0) > 0 };
    } catch {
      return { id, deleted: false };
    }
  }

  /** Revoke a key (tenant-scoped). Idempotent. */
  async revokeKey(tenantId: string, id: string): Promise<{ id: string; revokedAt: Date }> {
    const existing = await (this.prisma as any).ingestApiKey.findFirst({
      where: { id, tenantId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) {
      // Don't reveal cross-tenant existence — treat as already gone.
      return { id, revokedAt: new Date() };
    }
    const revokedAt = existing.revokedAt ?? new Date();
    if (!existing.revokedAt) {
      await (this.prisma as any).ingestApiKey.update({
        where: { id: existing.id },
        data: { revokedAt },
      });
    }
    return { id: existing.id, revokedAt };
  }
}
