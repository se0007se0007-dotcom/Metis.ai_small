/**
 * ML Score Adapter Interface
 *
 * Defines the contract for pluggable ML-based risk scoring implementations.
 * Allows swapping between heuristic, ML models (XGBoost, neural nets), and LLM-based scoring.
 */

export interface MLScoreInput {
  /** Type of subject being scored: 'ACCOUNT', 'MERCHANT', 'TRANSACTION', etc. */
  subjectType: string;

  /** Unique identifier of the subject */
  subjectId: string;

  /** Feature vector for the ML model (amount, velocity, location, patterns, etc.) */
  features: Record<string, any>;

  /** Optional historical context (past transactions, velocity baseline, etc.) */
  historicalContext?: Record<string, any>;
}

export interface MLScoreOutput {
  /** Risk score, normalized to 0..1 range */
  score: number;

  /** Confidence in the score, 0..1 (indicates model certainty/data quality) */
  confidence: number;

  /** Name of the model that produced this score (e.g., 'heuristic-v1', 'xgboost-v2.1', 'openai-gpt4') */
  modelName: string;

  /** Latency in milliseconds (for monitoring and optimization) */
  latencyMs: number;

  /** Optional: Features actually used in scoring (useful for explainability) */
  features?: Record<string, any>;
}

/**
 * MLScoreAdapter interface
 *
 * Implementations should:
 * - Be deterministic (same input → same output)
 * - Handle errors gracefully (log and return fallback)
 * - Complete within timeout (5s recommended)
 * - Be thread-safe
 */
export interface MLScoreAdapter {
  /** Human-readable name of the adapter (e.g., 'heuristic', 'openai-gpt4') */
  readonly name: string;

  /** Semantic version of the adapter (e.g., '1.0', '2.1.3') */
  readonly version: string;

  /**
   * Score a subject based on provided features.
   *
   * @param input MLScoreInput containing subject and features
   * @returns Promise resolving to MLScoreOutput with risk score
   * @throws May throw for critical errors (adapter should log and handle gracefully)
   */
  score(input: MLScoreInput): Promise<MLScoreOutput>;

  /**
   * Health check for the adapter.
   * Used by ops teams to validate adapter readiness.
   *
   * @returns Promise<true> if adapter is healthy and ready, <false> if degraded
   */
  isHealthy(): Promise<boolean>;
}
