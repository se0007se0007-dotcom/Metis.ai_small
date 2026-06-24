/**
 * Adaptive Sampling Service — Phase 2.3
 *
 * Maintains per-(tenant::agent) adaptive sampling state in memory and exposes
 * a decision API for whether the LLM Judge should run on a given evaluation.
 * The math lives in the pure `adaptive-sampling.ts` module; this class only
 * owns the in-memory state map and the Math.random() roll.
 *
 * Usage from EvaluatorService (optional, non-breaking):
 *   if (this.adaptiveSampling?.shouldRunJudge(tenantId, agent)) { ...run judge... }
 *   // after computing result:
 *   this.adaptiveSampling?.record(tenantId, agent, { anomalyDetected, overallScore });
 *
 * @module evaluator/feedback
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AdaptiveConfig,
  AdaptiveState,
  DEFAULT_ADAPTIVE_CONFIG,
  initialAdaptiveState,
  shouldSample,
  updateAdaptiveState,
} from './adaptive-sampling';

@Injectable()
export class AdaptiveSamplingService {
  private readonly logger = new Logger(AdaptiveSamplingService.name);
  private readonly states = new Map<string, AdaptiveState>();
  private readonly config: AdaptiveConfig = DEFAULT_ADAPTIVE_CONFIG;

  private key(tenantId: string, agent: string | null | undefined): string {
    return `${tenantId}::${agent ?? '__default__'}`;
  }

  /** Current sampling rate for inspection/telemetry. */
  getRate(tenantId: string, agent?: string | null): number {
    const s = this.states.get(this.key(tenantId, agent));
    return s ? s.rate : this.config.surgeTo;
  }

  /** Decide whether to run the LLM Judge for the next evaluation. */
  shouldRunJudge(tenantId: string, agent?: string | null, roll: number = Math.random()): boolean {
    const k = this.key(tenantId, agent);
    const state = this.states.get(k) ?? initialAdaptiveState(this.config);
    if (!this.states.has(k)) this.states.set(k, state);
    return shouldSample(state, roll);
  }

  /** Record an evaluation outcome to evolve the sampling rate. */
  record(
    tenantId: string,
    agent: string | null | undefined,
    outcome: { anomalyDetected: boolean; overallScore: number },
  ): void {
    const k = this.key(tenantId, agent);
    const prev = this.states.get(k) ?? initialAdaptiveState(this.config);
    const next = updateAdaptiveState(prev, outcome, this.config);
    this.states.set(k, next);
  }

  /** Snapshot of all tracked sampling rates (for the dashboard). */
  snapshot(): Array<{ key: string; rate: number; healthyStreak: number }> {
    return Array.from(this.states.entries()).map(([key, s]) => ({
      key,
      rate: Math.round(s.rate * 1000) / 1000,
      healthyStreak: s.healthyStreak,
    }));
  }
}
