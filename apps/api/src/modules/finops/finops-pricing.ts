/**
 * FinOps pure pricing / cache-key logic — extracted for unit testing.
 *
 * These functions contain NO Prisma / NestJS dependencies so they can be
 * exercised directly by scripts/test-finops-cache.mjs.
 */

import { createHash } from 'crypto';
import { redactSecrets } from '../evaluator/prompt-guard';

// Reference per-token pricing (USD). Tier-2 is the "baseline" an un-optimized
// LLM call would have cost.
export const TIER_PRICING: Record<number, number> = {
  1: 0.001 / 1000,
  2: 0.005 / 1000,
  3: 0.02 / 1000,
};

/** Rough token estimate from raw character length. */
export function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

/**
 * Stable SHA-256 content hash of the full prompt (hex). Used to build a
 * content-exact cache key so identical prompts collide and different prompts
 * do not.
 *
 * Upgraded from a 32-bit rolling hash (~4.3B space, birthday-collision risk at
 * ~77k distinct prompts) to SHA-256, which makes cross-prompt cache collisions
 * cryptographically negligible. NOTE: changing the hash invalidates any cache
 * rows keyed with the old scheme — expect a one-time cold cache after deploy.
 */
export function computeCacheKey(prompt: string): string {
  const digest = createHash('sha256').update(prompt, 'utf8').digest('hex');
  return `cache_${digest}`;
}

/**
 * The exact value stored in (and looked up from) FinOpsTokenLog.promptText for
 * a real optimize() call. It embeds the full-prompt content hash as a marker so:
 *  - the SAME prompt always produces the SAME stored value → cache HIT
 *  - a DIFFERENT prompt produces a different value → cache MISS
 *  - seed-origin rows (promptText = NULL) can never match → no false HIT
 */
export function buildStoredPromptText(prompt: string): string {
  // SECRET-AT-REST guard: the cache identity (key) is hashed from the ORIGINAL
  // prompt so cache-hit semantics are unchanged, but the human-readable text
  // persisted to FinOpsTokenLog.promptText is REDACTED so no sk-/sk-ant-/AKIA/
  // ghp_/xoxb-/high-entropy secrets land in the DB. Both store + lookup paths go
  // through this function, so redaction is applied consistently → cache still hits.
  const key = computeCacheKey(prompt);
  const redacted = redactSecrets(prompt.substring(0, 480));
  return `[DEMO:${key}] ${redacted}`;
}

/** Tier-2 baseline cost of a prompt (the cost a plain LLM call would incur). */
export function tier2BaselineCost(prompt: string): number {
  return TIER_PRICING[2] * estimateTokens(prompt);
}

/**
 * Savings for a cache HIT: a cache hit avoids the entire Tier-2 LLM call, so the
 * avoided (saved) cost is the full Tier-2 baseline and the savings percentage is
 * effectively 100% (cache serving is free).
 */
export function cacheHitSavings(prompt: string): { savedUsd: number; savedPct: number } {
  return { savedUsd: tier2BaselineCost(prompt), savedPct: 100 };
}

/**
 * Savings for a routed (cache MISS) call: difference between the Tier-2 baseline
 * and the actually-routed tier cost.
 */
export function routedSavings(
  prompt: string,
  routedTier: number,
): { savedUsd: number; savedPct: number } {
  const tokens = estimateTokens(prompt);
  const baseline = TIER_PRICING[2] * tokens;
  const actual = (TIER_PRICING[routedTier] || TIER_PRICING[2]) * tokens;
  const savedUsd = Math.max(0, baseline - actual);
  const savedPct = baseline > 0 ? (savedUsd / baseline) * 100 : 0;
  return { savedUsd, savedPct };
}

/**
 * Cosine similarity between two equal-length numeric vectors. Returns a value in
 * [-1, 1] (1 = identical direction). Returns 0 for empty / mismatched / zero
 * vectors so callers can treat "no signal" as "no match".
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find the candidate vector with the highest cosine similarity to `query`.
 * Returns the best index + score, or {index:-1, score:0} when no candidate.
 */
export function bestCosineMatch(
  query: number[],
  candidates: number[][],
): { index: number; score: number } {
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < (candidates?.length || 0); i++) {
    const score = cosineSimilarity(query, candidates[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex === -1) {
    return { index: -1, score: 0 };
  }
  return { index: bestIndex, score: bestScore };
}
