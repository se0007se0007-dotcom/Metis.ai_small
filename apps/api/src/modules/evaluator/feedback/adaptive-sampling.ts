/**
 * Adaptive Sampling — Phase 2.3 (pure logic)
 *
 * Decides how often the (relatively expensive) LLM Judge should run, based on
 * recent system health. When anomalies/low scores appear, sampling ramps up to
 * 100% for tighter scrutiny; during healthy stretches it decays toward a floor
 * to save cost. Ported in spirit from the SDK AdaptivePolicy.
 *
 * Pure and deterministic given its inputs (the caller supplies a [0,1) roll for
 * the probabilistic decision), so it is fully unit-testable.
 *
 * @module evaluator/feedback
 */

export interface AdaptiveState {
  /** Current sampling rate in [floor, 1]. */
  rate: number;
  /** Consecutive healthy evaluations since the last anomaly. */
  healthyStreak: number;
}

export interface AdaptiveConfig {
  /** Lowest sampling rate during healthy periods (e.g. 0.1 = 10%). */
  floor: number;
  /** Rate jumps to this on an anomaly/failure (usually 1.0). */
  surgeTo: number;
  /** Multiplicative decay applied per healthy evaluation (e.g. 0.9). */
  decay: number;
  /** Healthy streak required before decay begins. */
  decayAfter: number;
  /** overallScore below this counts as "unhealthy" even without an anomaly. */
  lowScoreThreshold: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  floor: 0.1,
  surgeTo: 1.0,
  decay: 0.9,
  decayAfter: 5,
  lowScoreThreshold: 50,
};

export function initialAdaptiveState(
  config: AdaptiveConfig = DEFAULT_ADAPTIVE_CONFIG,
): AdaptiveState {
  return { rate: config.surgeTo, healthyStreak: 0 };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Update sampling state after observing one evaluation outcome.
 *
 * @param state    Previous adaptive state
 * @param outcome  Observed signals from the latest evaluation
 * @param config   Tuning config
 * @returns New state (does not mutate input)
 */
export function updateAdaptiveState(
  state: AdaptiveState,
  outcome: { anomalyDetected: boolean; overallScore: number },
  config: AdaptiveConfig = DEFAULT_ADAPTIVE_CONFIG,
): AdaptiveState {
  const unhealthy = outcome.anomalyDetected || outcome.overallScore < config.lowScoreThreshold;

  if (unhealthy) {
    // Surge back to full sampling and reset the healthy streak.
    return { rate: config.surgeTo, healthyStreak: 0 };
  }

  const healthyStreak = state.healthyStreak + 1;
  let rate = state.rate;
  if (healthyStreak >= config.decayAfter) {
    rate = clamp(state.rate * config.decay, config.floor, config.surgeTo);
  }
  return { rate, healthyStreak };
}

/**
 * Decide whether to run the LLM Judge for the next evaluation.
 *
 * @param state  Current adaptive state
 * @param roll   A value in [0,1) (caller supplies Math.random() in production;
 *               tests pass fixed values for determinism)
 */
export function shouldSample(state: AdaptiveState, roll: number): boolean {
  return roll < state.rate;
}
