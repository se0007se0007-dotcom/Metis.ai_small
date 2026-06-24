/**
 * EmbeddingService — produces prompt embeddings for the FinOps semantic cache.
 *
 * Mirrors the egress pattern used by llm-judge.ts:
 *   - reads OPENAI_API_KEY from config
 *   - redacts secrets before sending text to the external API
 *   - respects per-tenant externalLlmDisabled (no external call when disabled)
 *
 * Returns `null` whenever an embedding cannot be produced (no key, tenant
 * disabled, network/API error). Callers MUST treat null as "no embedding" and
 * fall back to exact-string cache matching — embeddings are best-effort.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { redactSecrets } from '../evaluator/prompt-guard';

/** After a quota/rate-limit (429) response, skip embedding calls for this long. */
const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly openaiApiKey: string;
  private readonly openaiBaseUrl: string;
  private readonly embedModel: string;
  /** Circuit breaker: epoch ms until which embedding calls are suspended. */
  private quotaCooldownUntil = 0;

  constructor(
    private readonly config: ConfigService,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
  ) {
    this.openaiApiKey = this.config.get<string>('OPENAI_API_KEY', '') || '';
    this.openaiBaseUrl = (this.config.get<string>('OPENAI_BASE_URL', '') || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.embedModel = this.config.get<string>('OPENAI_EMBED_MODEL', '') || 'text-embedding-3-small';
  }

  /** True when this tenant has external LLM calls disabled (governance switch). */
  private async isExternalDisabled(tenantId: string): Promise<boolean> {
    try {
      const tenant = await (this.prisma as any).tenant.findUnique({
        where: { id: tenantId },
        select: { externalLlmDisabled: true },
      });
      return tenant?.externalLlmDisabled === true;
    } catch (err) {
      this.logger.warn(
        `externalLlmDisabled lookup failed (default enabled): ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Embed a prompt for a tenant. Returns a numeric vector, or null when the
   * embedding cannot be produced (caller falls back to exact match).
   */
  async embedForTenant(
    tenantId: string,
    text: string,
    model = '',
  ): Promise<number[] | null> {
    if (!this.openaiApiKey) {
      return null;
    }
    // Circuit breaker: don't hammer the API while quota is exhausted.
    if (Date.now() < this.quotaCooldownUntil) {
      return null;
    }
    if (await this.isExternalDisabled(tenantId)) {
      this.logger.debug(`Embedding skipped: external LLM disabled for tenant ${tenantId}`);
      return null;
    }
    // Secret-at-egress guard + length cap (embeddings ignore very long tails).
    const embedModel = model || this.embedModel;
    const safeInput = redactSecrets((text || '').substring(0, 8000));
    if (!safeInput.trim()) {
      return null;
    }
    try {
      const response = await fetch(`${this.openaiBaseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openaiApiKey}`,
        },
        body: JSON.stringify({ model: embedModel, input: safeInput }),
      });
      if (!response.ok) {
        const errBody = await response.text();
        this.logger.warn(`OpenAI embeddings ${response.status}: ${errBody.slice(0, 160)}`);
        if (response.status === 429) {
          // Quota exhausted — suspend embedding attempts; semantic cache
          // falls back to exact match until the cooldown elapses.
          this.quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
          this.logger.warn(
            `Embedding suspended for ${QUOTA_COOLDOWN_MS / 60000}min (quota). Exact-match cache fallback active.`,
          );
        }
        return null;
      }
      const data = (await response.json()) as any;
      const vector = data?.data?.[0]?.embedding;
      if (Array.isArray(vector) && vector.length > 0) {
        return vector as number[];
      }
      return null;
    } catch (err) {
      this.logger.warn(`Embedding request failed (fallback to exact): ${(err as Error).message}`);
      return null;
    }
  }
}
