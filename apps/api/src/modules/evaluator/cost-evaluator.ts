/**
 * Cost Evaluator — Agent Evaluator Gate 4: Cost & Performance
 *
 * Evaluates execution cost efficiency, latency grades, and token throughput.
 * Provides per-model cost estimation aligned with approximate market pricing
 * and produces actionable optimization recommendations.
 *
 * Model pricing (approximate, for estimation):
 *   - gpt-4o / claude-3-opus:       $0.015/1k input, $0.075/1k output
 *   - gpt-4o-mini / claude-3-haiku: $0.00015/1k input, $0.0006/1k output
 *   - gpt-3.5-turbo:                $0.0005/1k input, $0.0015/1k output
 *   - Default:                       $0.003/1k (blended)
 *
 * Latency grades:
 *   - fast:     < 1 000 ms
 *   - normal:   < 3 000 ms
 *   - slow:     < 10 000 ms
 *   - critical: >= 10 000 ms
 *
 * @module evaluator
 */
import { Injectable, Logger } from '@nestjs/common';

// ────────────────────────────────────────────────────────────────
// Pricing Constants (USD per 1 000 tokens)
// ────────────────────────────────────────────────────────────────

/**
 * Per-model pricing table.
 * Key: lowercased model name substring.
 * Value: { input, output } cost per 1 000 tokens in USD.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 0.015, output: 0.075 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-5': { input: 0.02, output: 0.08 },
  o3: { input: 0.015, output: 0.06 },

  // Anthropic
  'claude-3-opus': { input: 0.015, output: 0.075 },
  'claude-opus': { input: 0.015, output: 0.075 },
  'claude-3-sonnet': { input: 0.003, output: 0.015 },
  'claude-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00015, output: 0.0006 },
  'claude-haiku': { input: 0.00015, output: 0.0006 },

  // Google
  'gemini-3-flash': { input: 0.0005, output: 0.0015 },
  'gemini-3.1-pro': { input: 0.007, output: 0.021 },
};

/** Default blended cost when model is unknown */
const DEFAULT_COST_PER_1K: number = 0.003;

// ────────────────────────────────────────────────────────────────
// Latency Thresholds (milliseconds)
// ────────────────────────────────────────────────────────────────

const LATENCY_FAST = 1_000;
const LATENCY_NORMAL = 3_000;
const LATENCY_SLOW = 10_000;

// ────────────────────────────────────────────────────────────────
// Cost Efficiency Reference Baselines
// ────────────────────────────────────────────────────────────────

/** Optimal tokens per second benchmark — used for efficiency scoring */
const OPTIMAL_TOKENS_PER_SECOND = 50;

/** Maximum acceptable cost per single execution (USD) before efficiency drops */
const MAX_ACCEPTABLE_COST_USD = 0.5;

// ────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class CostEvaluator {
  private readonly logger = new Logger(CostEvaluator.name);

  // ════════════════════════════════════════════════════════════
  // Main Evaluation
  // ════════════════════════════════════════════════════════════

  /**
   * Evaluate the cost efficiency of a single execution step.
   *
   * Computes:
   *   - Estimated cost in USD based on model pricing
   *   - Cost efficiency ratio (0-1, where 1 = optimal)
   *   - Latency grade (fast / normal / slow / critical)
   *   - Token throughput (tokens per second)
   *   - Savings from optimization (cache hit, tier routing)
   *   - Actionable recommendations
   *
   * @param params  Execution parameters
   * @returns Cost evaluation result
   */
  evaluateExecution(params: {
    tokensUsed: number;
    executionTimeMs: number;
    model: string;
    cacheHit?: boolean;
    routedTier?: number;
    estimatedCostUsd?: number;
  }): {
    costUsd: number;
    costEfficiency: number;
    latencyGrade: string;
    tokenEfficiency: number;
    savingsFromOptimization: number;
    recommendations: string[];
  } {
    const {
      tokensUsed,
      executionTimeMs,
      model,
      cacheHit = false,
      routedTier,
      estimatedCostUsd,
    } = params;

    // ── Cost calculation ──
    const costUsd =
      estimatedCostUsd !== undefined && estimatedCostUsd > 0
        ? estimatedCostUsd
        : this.estimateCost(tokensUsed, model);

    // ── Latency grade ──
    const latencyGrade = this.gradeLatency(executionTimeMs);

    // ── Token throughput ──
    const executionTimeSec = executionTimeMs / 1000;
    const tokenEfficiency =
      executionTimeSec > 0 ? Math.round((tokensUsed / executionTimeSec) * 100) / 100 : 0;

    // ── Cost efficiency (0-1) ──
    // Combines cost, latency, and throughput into a single score
    const costScore = this.computeCostScore(costUsd);
    const latencyScore = this.computeLatencyScore(executionTimeMs);
    const throughputScore = this.computeThroughputScore(tokenEfficiency);

    const costEfficiency =
      Math.round((costScore * 0.4 + latencyScore * 0.35 + throughputScore * 0.25) * 100) / 100;

    // ── Savings estimate ──
    const savingsFromOptimization = this.computeSavings(tokensUsed, model, cacheHit, routedTier);

    // ── Recommendations ──
    const recommendations = this.generateRecommendations({
      costUsd,
      costEfficiency,
      latencyGrade,
      tokenEfficiency,
      tokensUsed,
      executionTimeMs,
      model,
      cacheHit,
      routedTier,
    });

    return {
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal precision
      costEfficiency,
      latencyGrade,
      tokenEfficiency,
      savingsFromOptimization: Math.round(savingsFromOptimization * 1_000_000) / 1_000_000,
      recommendations,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Cost Estimation
  // ════════════════════════════════════════════════════════════

  /**
   * Estimate the cost of a given number of tokens for a specific model.
   *
   * Uses the pricing table to find the closest model match.
   * Falls back to a default blended rate if the model is unknown.
   * Assumes a 60/40 input/output token split for blended estimation.
   *
   * @param tokens  Total token count
   * @param model   Model identifier string
   * @returns Estimated cost in USD
   */
  estimateCost(tokens: number, model: string): number {
    if (tokens <= 0) return 0;

    const pricing = this.resolveModelPricing(model);

    // Assume 60% input, 40% output split for blended cost
    const inputTokens = Math.ceil(tokens * 0.6);
    const outputTokens = Math.ceil(tokens * 0.4);

    const cost = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;

    return cost;
  }

  // ════════════════════════════════════════════════════════════
  // Latency Grading
  // ════════════════════════════════════════════════════════════

  /**
   * Grade the execution latency.
   *
   * @param ms  Execution time in milliseconds
   * @returns Latency grade: fast | normal | slow | critical
   */
  gradeLatency(ms: number): 'fast' | 'normal' | 'slow' | 'critical' {
    if (ms < LATENCY_FAST) return 'fast';
    if (ms < LATENCY_NORMAL) return 'normal';
    if (ms < LATENCY_SLOW) return 'slow';
    return 'critical';
  }

  // ════════════════════════════════════════════════════════════
  // Private Helpers
  // ════════════════════════════════════════════════════════════

  /**
   * Resolve model pricing from the pricing table.
   * Performs a case-insensitive substring match against known model keys.
   */
  private resolveModelPricing(model: string): {
    input: number;
    output: number;
  } {
    if (!model) {
      return { input: DEFAULT_COST_PER_1K, output: DEFAULT_COST_PER_1K };
    }

    const lower = model.toLowerCase();

    // Exact match first
    if (MODEL_PRICING[lower]) {
      return MODEL_PRICING[lower];
    }

    // Substring match (longest match wins for specificity)
    let bestMatch: { input: number; output: number } | null = null;
    let bestMatchLength = 0;

    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
      if (lower.includes(key) && key.length > bestMatchLength) {
        bestMatch = pricing;
        bestMatchLength = key.length;
      }
    }

    return bestMatch ?? { input: DEFAULT_COST_PER_1K, output: DEFAULT_COST_PER_1K };
  }

  /** Compute a 0-1 cost score (1 = cheap, 0 = expensive). */
  private computeCostScore(costUsd: number): number {
    if (costUsd <= 0) return 1;
    if (costUsd >= MAX_ACCEPTABLE_COST_USD) return 0;
    // Exponential decay — small costs score near 1, large costs drop fast
    return Math.max(0, 1 - costUsd / MAX_ACCEPTABLE_COST_USD);
  }

  /** Compute a 0-1 latency score (1 = fast, 0 = critical). */
  private computeLatencyScore(ms: number): number {
    if (ms <= LATENCY_FAST) return 1;
    if (ms >= LATENCY_SLOW) return 0;
    // Linear interpolation between fast and slow
    return 1 - (ms - LATENCY_FAST) / (LATENCY_SLOW - LATENCY_FAST);
  }

  /** Compute a 0-1 throughput score based on tokens/sec. */
  private computeThroughputScore(tokensPerSecond: number): number {
    if (tokensPerSecond >= OPTIMAL_TOKENS_PER_SECOND) return 1;
    if (tokensPerSecond <= 0) return 0;
    return tokensPerSecond / OPTIMAL_TOKENS_PER_SECOND;
  }

  /**
   * Compute estimated savings from optimization.
   * Compares actual cost vs what a Tier 3 call would have cost.
   */
  private computeSavings(
    tokensUsed: number,
    model: string,
    cacheHit: boolean,
    routedTier?: number,
  ): number {
    if (cacheHit) {
      // Cache hit = 100% of what the call would have cost
      return this.estimateCost(tokensUsed, model);
    }

    if (routedTier !== undefined && routedTier < 3) {
      // Compare current tier cost vs Tier 3 cost
      const currentCost = this.estimateCost(tokensUsed, model);
      const tier3Cost = this.estimateCost(tokensUsed, 'gpt-4o'); // Tier 3 reference
      return Math.max(0, tier3Cost - currentCost);
    }

    return 0;
  }

  /**
   * Generate actionable cost optimization recommendations
   * based on the evaluation results.
   */
  private generateRecommendations(ctx: {
    costUsd: number;
    costEfficiency: number;
    latencyGrade: string;
    tokenEfficiency: number;
    tokensUsed: number;
    executionTimeMs: number;
    model: string;
    cacheHit: boolean;
    routedTier?: number;
  }): string[] {
    const recommendations: string[] = [];

    // High cost
    if (ctx.costUsd > 0.1) {
      recommendations.push(
        'Execution cost exceeds $0.10 — consider enabling the FinOps Skill Packer to reduce token count.',
      );
    }

    // Slow latency
    if (ctx.latencyGrade === 'slow') {
      recommendations.push(
        'Latency is slow (>3s) — consider routing to a faster model tier or enabling semantic caching.',
      );
    }
    if (ctx.latencyGrade === 'critical') {
      recommendations.push(
        'Latency is critical (>10s) — immediate attention required. Check model API status and consider Tier 1 routing.',
      );
    }

    // Low throughput
    if (ctx.tokenEfficiency > 0 && ctx.tokenEfficiency < 10) {
      recommendations.push(
        'Token throughput is below 10 tokens/sec — investigate model API bottlenecks or prompt complexity.',
      );
    }

    // High token usage without cache
    if (ctx.tokensUsed > 4000 && !ctx.cacheHit) {
      recommendations.push(
        'High token usage (>4000) without cache hit — enable semantic caching for repeated similar queries.',
      );
    }

    // Tier 3 usage
    if (ctx.routedTier === 3) {
      recommendations.push(
        'Using Tier 3 (most expensive) model — verify that prompt complexity justifies this tier selection.',
      );
    }

    // No cache benefit
    if (!ctx.cacheHit && ctx.costEfficiency < 0.5) {
      recommendations.push(
        'Cost efficiency is below 50% — review FinOps 3-Gate pipeline configuration for optimization opportunities.',
      );
    }

    return recommendations;
  }
}
