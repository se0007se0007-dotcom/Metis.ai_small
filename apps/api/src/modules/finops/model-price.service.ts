/**
 * ModelPriceService — single source of truth for LLM pricing (F1-2).
 *
 * Previously prices were hard-coded in three places (finops-pricing.ts,
 * llm-judge.ts, worker pricing.ts) and drifted. This service:
 *   - lazily seeds the ModelPrice table from BUILT-IN defaults on first use
 *   - serves prices from a 5-minute in-memory cache
 *   - lets operators adjust prices at runtime via the FinOps API
 *
 * The hard-coded tables remain as FALLBACK so the platform keeps working
 * before the migration runs (all reads are best-effort).
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

export interface ModelPriceEntry {
  modelId: string;
  provider: string;
  inputPerMUsd: number;
  outputPerMUsd: number;
  cachedInputPerMUsd?: number | null;
  tier: number;
  active: boolean;
  source?: string;
}

/** Built-in defaults (USD per 1M tokens), 2026-06 list prices. */
export const BUILTIN_MODEL_PRICES: ModelPriceEntry[] = [
  // Anthropic — cached read ≈ 10% of input
  { modelId: 'claude-opus-4-6', provider: 'anthropic', inputPerMUsd: 15, outputPerMUsd: 75, cachedInputPerMUsd: 1.5, tier: 3, active: true },
  { modelId: 'claude-sonnet-4-6', provider: 'anthropic', inputPerMUsd: 3, outputPerMUsd: 15, cachedInputPerMUsd: 0.3, tier: 2, active: true },
  { modelId: 'claude-haiku-4-5', provider: 'anthropic', inputPerMUsd: 0.8, outputPerMUsd: 4, cachedInputPerMUsd: 0.08, tier: 1, active: true },
  // OpenAI — cached input ≈ 50% of input
  { modelId: 'gpt-5', provider: 'openai', inputPerMUsd: 10, outputPerMUsd: 30, cachedInputPerMUsd: 5, tier: 3, active: true },
  { modelId: 'o3', provider: 'openai', inputPerMUsd: 10, outputPerMUsd: 40, cachedInputPerMUsd: 5, tier: 3, active: true },
  { modelId: 'gpt-4o', provider: 'openai', inputPerMUsd: 2.5, outputPerMUsd: 10, cachedInputPerMUsd: 1.25, tier: 2, active: true },
  { modelId: 'gpt-4o-mini', provider: 'openai', inputPerMUsd: 0.15, outputPerMUsd: 0.6, cachedInputPerMUsd: 0.075, tier: 1, active: true },
  // Google
  { modelId: 'gemini-3.1-pro', provider: 'google', inputPerMUsd: 1.25, outputPerMUsd: 5, cachedInputPerMUsd: null, tier: 2, active: true },
  { modelId: 'gemini-3-flash', provider: 'google', inputPerMUsd: 0.075, outputPerMUsd: 0.3, cachedInputPerMUsd: null, tier: 1, active: true },
];

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Normalize dotted aliases to canonical pricing ids. */
export function normalizeModelId(model: string): string {
  return (model || '')
    .replace('claude-opus-4.6', 'claude-opus-4-6')
    .replace('claude-sonnet-4.6', 'claude-sonnet-4-6')
    .replace('claude-haiku-4.5', 'claude-haiku-4-5')
    .replace('claude-haiku-4-5-20251001', 'claude-haiku-4-5');
}

@Injectable()
export class ModelPriceService {
  private readonly logger = new Logger(ModelPriceService.name);
  private cache: Map<string, ModelPriceEntry> | null = null;
  private cacheLoadedAt = 0;
  private seeded = false;

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /** All prices (DB-backed, builtin fallback). */
  async listPrices(): Promise<ModelPriceEntry[]> {
    const map = await this.loadCache();
    return Array.from(map.values());
  }

  /**
   * Price for a model. Falls back to builtin entry, then to a conservative
   * Sonnet-class default for unknown models.
   */
  async getPrice(model: string): Promise<ModelPriceEntry> {
    const id = normalizeModelId(model);
    const map = await this.loadCache();
    return (
      map.get(id) ??
      BUILTIN_MODEL_PRICES.find((p) => p.modelId === id) ?? {
        modelId: id,
        provider: 'unknown',
        inputPerMUsd: 3,
        outputPerMUsd: 15,
        cachedInputPerMUsd: null,
        tier: 2,
        active: true,
      }
    );
  }

  /** Real cost in USD for a completed call (micro-dollar precision). */
  async computeCostUsd(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedPromptTokens = 0,
  ): Promise<number> {
    const p = await this.getPrice(model);
    const freshPrompt = Math.max(0, promptTokens - cachedPromptTokens);
    const cachedRate = p.cachedInputPerMUsd ?? p.inputPerMUsd;
    const cost =
      (freshPrompt / 1_000_000) * p.inputPerMUsd +
      (cachedPromptTokens / 1_000_000) * cachedRate +
      (completionTokens / 1_000_000) * p.outputPerMUsd;
    return Math.round(cost * 1_000_000) / 1_000_000;
  }

  /** Operator update (PUT /finops/model-prices/:modelId). */
  async upsertPrice(entry: ModelPriceEntry): Promise<ModelPriceEntry> {
    const id = normalizeModelId(entry.modelId);
    const saved = await (this.prisma as any).modelPrice.upsert({
      where: { modelId: id },
      update: {
        provider: entry.provider,
        inputPerMUsd: entry.inputPerMUsd,
        outputPerMUsd: entry.outputPerMUsd,
        cachedInputPerMUsd: entry.cachedInputPerMUsd ?? null,
        tier: entry.tier ?? 2,
        active: entry.active ?? true,
        source: 'MANUAL',
      },
      create: {
        modelId: id,
        provider: entry.provider,
        inputPerMUsd: entry.inputPerMUsd,
        outputPerMUsd: entry.outputPerMUsd,
        cachedInputPerMUsd: entry.cachedInputPerMUsd ?? null,
        tier: entry.tier ?? 2,
        active: entry.active ?? true,
        source: 'MANUAL',
      },
    });
    this.cache = null; // bust cache
    return saved as ModelPriceEntry;
  }

  // ── internals ──────────────────────────────────────────────

  private async loadCache(): Promise<Map<string, ModelPriceEntry>> {
    const now = Date.now();
    if (this.cache && now - this.cacheLoadedAt < CACHE_TTL_MS) return this.cache;

    const map = new Map<string, ModelPriceEntry>();
    // Builtin defaults first so DB rows override them.
    for (const p of BUILTIN_MODEL_PRICES) map.set(p.modelId, p);

    try {
      await this.ensureSeeded();
      const rows = await (this.prisma as any).modelPrice.findMany({ where: { active: true } });
      for (const r of rows as ModelPriceEntry[]) map.set(r.modelId, r);
    } catch (err) {
      // Pre-migration or DB issue → builtin fallback keeps everything working.
      this.logger.warn(`ModelPrice load failed (builtin fallback): ${(err as Error).message}`);
    }

    this.cache = map;
    this.cacheLoadedAt = now;
    return map;
  }

  private async ensureSeeded(): Promise<void> {
    if (this.seeded) return;
    const count = await (this.prisma as any).modelPrice.count();
    if (count === 0) {
      for (const p of BUILTIN_MODEL_PRICES) {
        await (this.prisma as any).modelPrice
          .create({
            data: {
              modelId: p.modelId,
              provider: p.provider,
              inputPerMUsd: p.inputPerMUsd,
              outputPerMUsd: p.outputPerMUsd,
              cachedInputPerMUsd: p.cachedInputPerMUsd ?? null,
              tier: p.tier,
              active: p.active,
              source: 'BUILTIN',
            },
          })
          .catch(() => {});
      }
      this.logger.log(`ModelPrice seeded with ${BUILTIN_MODEL_PRICES.length} builtin entries`);
    }
    this.seeded = true;
  }
}
