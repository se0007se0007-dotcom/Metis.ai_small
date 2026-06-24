/**
 * Evaluation Policy Service — Phase 1: Gate 정책 설정 시스템
 *
 * Loads the active EvaluationPolicy for a tenant (optionally scoped to an
 * agent group) and exposes it to the EvaluatorService so that gate
 * weights/thresholds are configuration-driven instead of hardcoded.
 *
 * Design:
 *   - 5-minute in-memory cache keyed by `tenantId::agentGroup`
 *   - Falls back to DEFAULT_EVALUATION_POLICY when no row exists, so the
 *     engine behaves identically to the pre-policy hardcoded defaults
 *   - All Prisma access uses `(this.prisma as any)` to tolerate generated
 *     types that may lag behind the schema (same pattern as evaluator.service.ts)
 *
 * @module evaluator
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

/** Fully-resolved evaluation policy used by the engine (no nullable fields). */
export interface ResolvedEvaluationPolicy {
  id: string | null;
  name: string;
  agentGroup: string | null;

  // 품질 Gate
  qualityWeight: number;
  qualityHardGateMin: number;
  llmJudgeEnabled: boolean;
  llmJudgeModel: string;
  llmJudgeBudgetPerDay: number;

  // 보안 Gate
  securityWeight: number;
  securityCriticalCap: number;
  securityHighCap: number;
  piiScanEnabled: boolean;
  promptInjectionEnabled: boolean;

  // 이상탐지 Gate
  anomalyWeight: number;
  zScoreThreshold: number;
  iqrFactor: number;

  // 비용 Gate
  costWeight: number;
  dailyBudgetUsd: number;
  latencySlowMs: number;
  latencyCriticalMs: number;

  // Canary 연동
  canaryQualityMin: number;
  canarySecurityMin: number;

  // ORB 연동
  orbPassThreshold: number;
  orbConditionalMin: number;

  isActive: boolean;
}

/**
 * Default policy — values mirror the historical hardcoded constants in
 * EvaluatorService so that, absent any DB row, scoring is unchanged.
 */
export const DEFAULT_EVALUATION_POLICY: ResolvedEvaluationPolicy = {
  id: null,
  name: 'default',
  agentGroup: null,

  qualityWeight: 0.4,
  qualityHardGateMin: 50,
  llmJudgeEnabled: true,
  llmJudgeModel: 'claude-haiku-4-5-20251001',
  llmJudgeBudgetPerDay: 1.0,

  securityWeight: 0.3,
  securityCriticalCap: 40,
  securityHighCap: 60,
  piiScanEnabled: true,
  promptInjectionEnabled: true,

  anomalyWeight: 0.15,
  zScoreThreshold: 2.5,
  iqrFactor: 2.0,

  costWeight: 0.15,
  dailyBudgetUsd: 100.0,
  latencySlowMs: 5000,
  latencyCriticalMs: 10000,

  canaryQualityMin: 70,
  canarySecurityMin: 60,

  orbPassThreshold: 70,
  orbConditionalMin: 50,

  isActive: true,
};

/** Cache TTL — policy changes take effect within this window. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  policy: ResolvedEvaluationPolicy;
  expiresAt: number;
}

@Injectable()
export class EvaluationPolicyService {
  private readonly logger = new Logger(EvaluationPolicyService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ════════════════════════════════════════════════════════════
  // Read (cached) — used by EvaluatorService on the hot path
  // ════════════════════════════════════════════════════════════

  /**
   * Return the active policy for a tenant, optionally scoped to an agent
   * group. Falls back to a tenant-default row, then to the built-in default.
   * Results are cached for {@link CACHE_TTL_MS}.
   */
  async getActivePolicy(
    tenantId: string,
    agentGroup?: string | null,
  ): Promise<ResolvedEvaluationPolicy> {
    const key = this.cacheKey(tenantId, agentGroup);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.policy;
    }

    let policy = DEFAULT_EVALUATION_POLICY;
    try {
      // Prefer an agent-group-scoped active policy, then the tenant default.
      const row =
        (agentGroup
          ? await (this.prisma as any).evaluationPolicy.findFirst({
              where: { tenantId, agentGroup, isActive: true },
              orderBy: { updatedAt: 'desc' },
            })
          : null) ??
        (await (this.prisma as any).evaluationPolicy.findFirst({
          where: { tenantId, agentGroup: null, isActive: true },
          orderBy: { updatedAt: 'desc' },
        }));

      if (row) {
        policy = this.toResolved(row);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to load evaluation policy (using defaults): ${(err as Error).message}`,
      );
    }

    this.cache.set(key, { policy, expiresAt: Date.now() + CACHE_TTL_MS });
    return policy;
  }

  /** Drop cached entries for a tenant (call after any write). */
  invalidate(tenantId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}::`)) {
        this.cache.delete(key);
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // CRUD — backing the settings UI
  // ════════════════════════════════════════════════════════════

  /**
   * Fetch the raw policy row for editing, creating a default-valued row on
   * first access so the UI always has something to bind to.
   */
  async getOrCreatePolicy(tenantId: string, name = 'default'): Promise<ResolvedEvaluationPolicy> {
    try {
      const existing = await (this.prisma as any).evaluationPolicy.findUnique({
        where: { tenantId_name: { tenantId, name } },
      });
      if (existing) return this.toResolved(existing);

      const created = await (this.prisma as any).evaluationPolicy.create({
        data: { tenantId, name, ...this.defaultsForCreate() },
      });
      this.invalidate(tenantId);
      return this.toResolved(created);
    } catch (err) {
      this.logger.error(`getOrCreatePolicy failed: ${(err as Error).message}`);
      return { ...DEFAULT_EVALUATION_POLICY, name };
    }
  }

  /** Update (upsert) a policy and clear the cache. */
  async updatePolicy(
    tenantId: string,
    name: string,
    patch: Partial<ResolvedEvaluationPolicy>,
  ): Promise<ResolvedEvaluationPolicy> {
    const data = this.sanitizePatch(patch);
    const row = await (this.prisma as any).evaluationPolicy.upsert({
      where: { tenantId_name: { tenantId, name } },
      update: data,
      create: { tenantId, name, ...this.defaultsForCreate(), ...data },
    });
    this.invalidate(tenantId);
    return this.toResolved(row);
  }

  /** Reset a policy back to built-in defaults. */
  async resetPolicy(tenantId: string, name = 'default'): Promise<ResolvedEvaluationPolicy> {
    const row = await (this.prisma as any).evaluationPolicy.upsert({
      where: { tenantId_name: { tenantId, name } },
      update: this.defaultsForCreate(),
      create: { tenantId, name, ...this.defaultsForCreate() },
    });
    this.invalidate(tenantId);
    return this.toResolved(row);
  }

  // ════════════════════════════════════════════════════════════
  // Private helpers
  // ════════════════════════════════════════════════════════════

  private cacheKey(tenantId: string, agentGroup?: string | null): string {
    return `${tenantId}::${agentGroup ?? '__default__'}`;
  }

  /** Map a Prisma row to a fully-resolved policy, filling gaps with defaults. */
  private toResolved(row: any): ResolvedEvaluationPolicy {
    const d = DEFAULT_EVALUATION_POLICY;
    return {
      id: row.id ?? null,
      name: row.name ?? d.name,
      agentGroup: row.agentGroup ?? null,

      qualityWeight: num(row.qualityWeight, d.qualityWeight),
      qualityHardGateMin: num(row.qualityHardGateMin, d.qualityHardGateMin),
      llmJudgeEnabled: bool(row.llmJudgeEnabled, d.llmJudgeEnabled),
      llmJudgeModel: row.llmJudgeModel ?? d.llmJudgeModel,
      llmJudgeBudgetPerDay: num(row.llmJudgeBudgetPerDay, d.llmJudgeBudgetPerDay),

      securityWeight: num(row.securityWeight, d.securityWeight),
      securityCriticalCap: num(row.securityCriticalCap, d.securityCriticalCap),
      securityHighCap: num(row.securityHighCap, d.securityHighCap),
      piiScanEnabled: bool(row.piiScanEnabled, d.piiScanEnabled),
      promptInjectionEnabled: bool(row.promptInjectionEnabled, d.promptInjectionEnabled),

      anomalyWeight: num(row.anomalyWeight, d.anomalyWeight),
      zScoreThreshold: num(row.zScoreThreshold, d.zScoreThreshold),
      iqrFactor: num(row.iqrFactor, d.iqrFactor),

      costWeight: num(row.costWeight, d.costWeight),
      dailyBudgetUsd: num(row.dailyBudgetUsd, d.dailyBudgetUsd),
      latencySlowMs: num(row.latencySlowMs, d.latencySlowMs),
      latencyCriticalMs: num(row.latencyCriticalMs, d.latencyCriticalMs),

      canaryQualityMin: num(row.canaryQualityMin, d.canaryQualityMin),
      canarySecurityMin: num(row.canarySecurityMin, d.canarySecurityMin),

      orbPassThreshold: num(row.orbPassThreshold, d.orbPassThreshold),
      orbConditionalMin: num(row.orbConditionalMin, d.orbConditionalMin),

      isActive: bool(row.isActive, d.isActive),
    };
  }

  /** Column defaults for create() — everything except identity/relations. */
  private defaultsForCreate(): Record<string, unknown> {
    const { id, name, agentGroup, ...rest } = DEFAULT_EVALUATION_POLICY;
    return rest;
  }

  /** Allow-list editable numeric/boolean/string fields from an inbound patch. */
  private sanitizePatch(patch: Partial<ResolvedEvaluationPolicy>): Record<string, unknown> {
    const editableKeys: (keyof ResolvedEvaluationPolicy)[] = [
      'qualityWeight',
      'qualityHardGateMin',
      'llmJudgeEnabled',
      'llmJudgeModel',
      'llmJudgeBudgetPerDay',
      'securityWeight',
      'securityCriticalCap',
      'securityHighCap',
      'piiScanEnabled',
      'promptInjectionEnabled',
      'anomalyWeight',
      'zScoreThreshold',
      'iqrFactor',
      'costWeight',
      'dailyBudgetUsd',
      'latencySlowMs',
      'latencyCriticalMs',
      'canaryQualityMin',
      'canarySecurityMin',
      'orbPassThreshold',
      'orbConditionalMin',
      'isActive',
      'agentGroup',
    ];
    const out: Record<string, unknown> = {};
    for (const key of editableKeys) {
      if (patch[key] !== undefined) out[key] = patch[key];
    }
    return out;
  }
}

/** Coerce to a finite number, falling back to a default. */
function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Coerce to boolean, falling back to a default. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
