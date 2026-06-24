/**
 * Worker-side LLM pricing — real per-token cost calculation.
 *
 * Replaces the previous Tier-abstraction pricing in the simulated execution
 * path. Prices are USD per 1M tokens (input/output) and mirror the public
 * list prices as of 2026-06. Keep this table in sync with
 * apps/api/src/modules/finops/finops-pricing.ts.
 *
 * NOTE (S3 follow-up): this hard-coded map is intended to be migrated to a
 * `ModelPrice` DB table so prices can be maintained without a redeploy. Until
 * then `resolvePrice()` falls back to a safe default for unknown models.
 */

export interface ModelPrice {
  /** USD per 1,000,000 input tokens */
  inputPerM: number;
  /** USD per 1,000,000 output tokens */
  outputPerM: number;
}

/** Canonical model id → price. Aliases are normalized in resolvePrice(). */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Anthropic
  'claude-opus-4-6': { inputPerM: 15, outputPerM: 75 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku-4-5': { inputPerM: 0.8, outputPerM: 4 },
  // OpenAI
  'gpt-5': { inputPerM: 10, outputPerM: 30 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'o3': { inputPerM: 10, outputPerM: 40 },
  // Google
  'gemini-3.1-pro': { inputPerM: 1.25, outputPerM: 5 },
  'gemini-3-flash': { inputPerM: 0.075, outputPerM: 0.3 },
};

/** Default price for unknown models — conservative (Sonnet-class). */
const DEFAULT_PRICE: ModelPrice = { inputPerM: 3, outputPerM: 15 };

/** Normalize a model name to a pricing key (handles dotted aliases). */
export function normalizeModelId(model: string): string {
  return (model || '')
    .replace('claude-opus-4.6', 'claude-opus-4-6')
    .replace('claude-sonnet-4.6', 'claude-sonnet-4-6')
    .replace('claude-haiku-4.5', 'claude-haiku-4-5')
    .replace('claude-haiku-4-5-20251001', 'claude-haiku-4-5');
}

export function resolvePrice(model: string): ModelPrice {
  return MODEL_PRICING[normalizeModelId(model)] ?? DEFAULT_PRICE;
}

/** Real cost in USD for a completed LLM call. */
export function computeCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = resolvePrice(model);
  const cost =
    (promptTokens / 1_000_000) * price.inputPerM +
    (completionTokens / 1_000_000) * price.outputPerM;
  // Round to 6 decimals (micro-dollar precision).
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Rough token estimate when a provider omits usage (chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}
