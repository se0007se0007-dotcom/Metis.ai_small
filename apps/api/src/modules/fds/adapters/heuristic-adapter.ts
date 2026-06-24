/**
 * Heuristic ML Score Adapter
 *
 * Default implementation using pattern-based scoring.
 * Uses simple rules and heuristics extracted from the existing anomaly.service.ts mlScore() method.
 *
 * Useful for:
 * - Local development and testing
 * - Fallback when external adapters are unavailable
 * - Baseline fraud detection without external dependencies
 */

import { Injectable, Logger } from '@nestjs/common';
import { MLScoreAdapter, MLScoreInput, MLScoreOutput } from './ml-adapter.interface';

@Injectable()
export class HeuristicMLAdapter implements MLScoreAdapter {
  private readonly logger = new Logger(HeuristicMLAdapter.name);

  readonly name = 'heuristic';
  readonly version = '1.0';

  /**
   * Score using pattern-based heuristics.
   *
   * Patterns evaluated:
   * - Amount patterns (round amounts lower risk)
   * - Amount size (larger amounts = higher risk)
   * - Time-of-day patterns (odd hours = higher risk)
   * - Velocity deviations
   */
  async score(input: MLScoreInput): Promise<MLScoreOutput> {
    const startTime = Date.now();

    try {
      const scoreValue = this.computeHeuristicScore(input.features, input.subjectId);

      return {
        score: scoreValue,
        confidence: 0.75, // Heuristic is moderately confident
        modelName: this.name,
        latencyMs: Date.now() - startTime,
        features: input.features,
      };
    } catch (error) {
      this.logger.error(`Heuristic scoring failed for ${input.subjectId}:`, error);
      // Fallback to neutral score on error
      return {
        score: 0.5,
        confidence: 0.1,
        modelName: this.name,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  async isHealthy(): Promise<boolean> {
    // Heuristic adapter has no external dependencies
    return true;
  }

  /**
   * Core heuristic computation.
   *
   * Combines multiple pattern signals with weighted averaging.
   */
  private computeHeuristicScore(features: Record<string, any>, subjectId: string): number {
    const amount = features.amount || 0;
    const timestamp = features.timestamp ? new Date(features.timestamp) : new Date();
    const velocity = features.velocity || 0;
    const historicalAverage = features.historicalAverage || amount;

    // Pattern 1: Round amount detection (lower risk)
    // Round amounts (divisible by 1000) indicate legitimate transactions
    const roundAmountScore = this.scoreRoundAmount(amount);

    // Pattern 2: Amount size detection (higher risk for large amounts)
    // Large outliers are riskier
    const amountSizeScore = this.scoreAmountSize(amount);

    // Pattern 3: Time-of-day pattern (higher risk during odd hours)
    const timePatternScore = this.scoreTimePattern(timestamp, subjectId);

    // Pattern 4: Velocity anomaly (rapid succession of transactions)
    const velocityScore = this.scoreVelocity(velocity);

    // Pattern 5: Deviation from historical baseline
    const deviationScore = this.scoreDeviation(amount, historicalAverage);

    // Weighted average of patterns
    const combinedScore =
      roundAmountScore * 0.15 + // 15% weight
      amountSizeScore * 0.3 + // 30% weight
      timePatternScore * 0.2 + // 20% weight
      velocityScore * 0.2 + // 20% weight
      deviationScore * 0.15; // 15% weight

    return Math.min(Math.max(combinedScore, 0), 1.0);
  }

  /**
   * Score based on amount roundness.
   * Round amounts (x % 1000 === 0) have lower fraud risk.
   */
  private scoreRoundAmount(amount: number): number {
    const remainder = Math.abs(amount) % 1000;
    // Score 0 for round amounts, 1 for most irregular
    return Math.min(remainder / 500, 1.0);
  }

  /**
   * Score based on absolute amount size.
   * Very large amounts have higher fraud risk.
   */
  private scoreAmountSize(amount: number): number {
    const absAmount = Math.abs(amount);
    // Amounts over 10,000 are increasingly risky
    // 10,000 = 0.5 score, 20,000+ = 1.0 score
    return Math.min(absAmount / 20000, 1.0);
  }

  /**
   * Score based on time-of-day.
   * Transactions at odd hours (midnight-6am, 10pm+) are riskier.
   */
  private scoreTimePattern(timestamp: Date, subjectId: string): number {
    const hour = timestamp.getHours();

    // Odd hours: 22-23 (10-11pm), 0-5 (midnight-6am)
    if ((hour >= 22 && hour <= 23) || (hour >= 0 && hour <= 5)) {
      return 0.6; // Higher risk for odd hours
    }

    // Business hours (9am-5pm): lower risk
    if (hour >= 9 && hour <= 17) {
      return 0.1;
    }

    // Twilight hours (6-8am, 6-9pm): moderate risk
    return 0.3;
  }

  /**
   * Score based on transaction velocity.
   * Rapid succession of transactions indicates higher risk.
   */
  private scoreVelocity(velocity: number): number {
    // velocity in transactions per hour
    // 0-1 tps = low risk, 5+ tps = high risk
    return Math.min(velocity / 10, 1.0);
  }

  /**
   * Score based on deviation from historical average.
   * Large outliers from baseline are riskier.
   */
  private scoreDeviation(amount: number, historicalAverage: number): number {
    if (historicalAverage === 0) {
      return 0.2; // Neutral if no history
    }

    const ratio = Math.abs(amount) / Math.abs(historicalAverage);

    // Within 50-150% of baseline: low risk
    if (ratio >= 0.5 && ratio <= 1.5) {
      return 0.1;
    }

    // Outside 25-200% of baseline: moderate risk
    if (ratio >= 0.25 && ratio <= 2.0) {
      return 0.4;
    }

    // Extreme deviation: high risk
    return 0.8;
  }
}
