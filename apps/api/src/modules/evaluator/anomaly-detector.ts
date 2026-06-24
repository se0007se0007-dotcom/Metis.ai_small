/**
 * Anomaly Detector — Agent Evaluator Gate 7
 *
 * Implements statistical anomaly detection algorithms aligned with the
 * Agent Evaluator SDK specification:
 *
 *   - Z-score drift detection  (accuracy / quality drift)
 *   - IQR spike detection      (token count spikes)
 *   - Linear regression trend  (latency trend analysis)
 *   - Error rate surge          (sudden error rate increase)
 *   - Security pattern          (security threat rate deviation)
 *
 * Thresholds mirror the SDK constants:
 *   _Z_SCORE_THRESHOLD   = 2.5
 *   _IQR_FACTOR          = 2.0
 *   _TREND_SLOPE_THRESHOLD = 0.05   (s / task)
 *   _ERROR_SURGE_THRESHOLD = 0.20   (20 %)
 *   _TREND_MIN_POINTS      = 5
 *
 * @module evaluator
 */
import { Injectable, Logger } from '@nestjs/common';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** A single anomaly event produced by any detector. */
export interface AnomalyEvent {
  /** Anomaly category */
  type: 'latency_trend' | 'accuracy_drift' | 'token_spike' | 'error_surge' | 'security_pattern';

  /** Severity level */
  severity: 'warning' | 'critical';

  /** Human-readable description */
  detail: string;

  /** Observed value that triggered the alert */
  value: number;

  /** Threshold that was exceeded */
  threshold: number;

  /** Algorithm used: z-score | iqr | linear_regression | ratio */
  algorithm: string;

  /** ISO-8601 timestamp of detection */
  detectedAt: string;

  /** Optional suggested remediation action */
  suggestedAction?: string;
}

// ────────────────────────────────────────────────────────────────
// SDK-aligned constants
// ────────────────────────────────────────────────────────────────

/** Z-score deviation threshold (same as SDK _Z_SCORE_THRESHOLD) */
const Z_SCORE_THRESHOLD = 2.5;

/** IQR multiplier for spike detection (same as SDK _IQR_FACTOR) */
const IQR_FACTOR = 2.0;

/** Latency slope threshold in seconds per task (same as SDK _TREND_SLOPE_THRESHOLD) */
const TREND_SLOPE_THRESHOLD = 0.05;

/** Error rate surge threshold — 20 % (same as SDK _ERROR_SURGE_THRESHOLD) */
const ERROR_SURGE_THRESHOLD = 0.2;

/** Minimum data points required for trend analysis (same as SDK _TREND_MIN_POINTS) */
const TREND_MIN_POINTS = 5;

// ────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class AnomalyDetector {
  private readonly logger = new Logger(AnomalyDetector.name);

  constructor() {}

  // ════════════════════════════════════════════════════════════
  // Z-Score Drift Detection
  // ════════════════════════════════════════════════════════════

  /**
   * Detect drift in a time-series using the Z-score algorithm.
   *
   * Computes the Z-score of the most recent value relative to the
   * series mean and standard deviation.  If |z| exceeds the threshold,
   * an anomaly event is returned.
   *
   * @param values   Ordered observations (oldest first)
   * @param label    Human-readable metric label (e.g. "accuracy", "token_count")
   * @param zThreshold  Z-score threshold (default: 2.5)
   * @returns AnomalyEvent or null if no anomaly
   */
  detectZScoreDrift(
    values: number[],
    label: string,
    zThreshold: number = Z_SCORE_THRESHOLD,
  ): AnomalyEvent | null {
    if (values.length < TREND_MIN_POINTS) {
      return null;
    }

    const mean = this.mean(values);
    const stdDev = this.stdDev(values, mean);

    // Avoid division by zero — no variation means no anomaly
    if (stdDev === 0) {
      return null;
    }

    const latest = values[values.length - 1];
    const zScore = Math.abs((latest - mean) / stdDev);

    if (zScore <= zThreshold) {
      return null;
    }

    const anomalyType = label.includes('accuracy') ? 'accuracy_drift' : 'token_spike';

    const severity: 'warning' | 'critical' = zScore > zThreshold * 1.5 ? 'critical' : 'warning';

    return {
      type: anomalyType,
      severity,
      detail: `${label} Z-score drift detected: latest value ${latest.toFixed(4)} deviates ${zScore.toFixed(2)} standard deviations from mean ${mean.toFixed(4)}`,
      value: latest,
      threshold: mean + zThreshold * stdDev,
      algorithm: 'z-score',
      detectedAt: new Date().toISOString(),
      suggestedAction: this.suggestAction(anomalyType, severity),
    };
  }

  // ════════════════════════════════════════════════════════════
  // IQR Spike Detection
  // ════════════════════════════════════════════════════════════

  /**
   * Detect spikes using the Interquartile Range (IQR) method.
   *
   * Values outside [Q1 - factor*IQR, Q3 + factor*IQR] are flagged.
   *
   * @param values   Ordered observations (oldest first)
   * @param label    Human-readable metric label
   * @param factor   IQR multiplier (default: 2.0)
   * @returns AnomalyEvent or null if no anomaly
   */
  detectIqrSpike(
    values: number[],
    label: string,
    factor: number = IQR_FACTOR,
  ): AnomalyEvent | null {
    if (values.length < TREND_MIN_POINTS) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const q1 = this.percentile(sorted, 25);
    const q3 = this.percentile(sorted, 75);
    const iqr = q3 - q1;

    // No spread — cannot detect spikes
    if (iqr === 0) {
      return null;
    }

    const lowerBound = q1 - factor * iqr;
    const upperBound = q3 + factor * iqr;
    const latest = values[values.length - 1];

    if (latest >= lowerBound && latest <= upperBound) {
      return null;
    }

    const severity: 'warning' | 'critical' =
      latest > q3 + factor * 2 * iqr || latest < q1 - factor * 2 * iqr ? 'critical' : 'warning';

    return {
      type: 'token_spike',
      severity,
      detail: `${label} IQR spike detected: latest value ${latest.toFixed(2)} outside bounds [${lowerBound.toFixed(2)}, ${upperBound.toFixed(2)}]`,
      value: latest,
      threshold: latest > upperBound ? upperBound : lowerBound,
      algorithm: 'iqr',
      detectedAt: new Date().toISOString(),
      suggestedAction: this.suggestAction('token_spike', severity),
    };
  }

  // ════════════════════════════════════════════════════════════
  // Linear Regression Trend Detection
  // ════════════════════════════════════════════════════════════

  /**
   * Detect increasing latency trends via simple least-squares
   * linear regression (y = a + bx).
   *
   * If the slope b exceeds the threshold, a latency_trend anomaly
   * is produced.
   *
   * @param latencies       Ordered latency values in milliseconds (oldest first)
   * @param slopeThreshold  Slope threshold in seconds/task (default: 0.05)
   * @returns AnomalyEvent or null if no anomaly
   */
  detectLatencyTrend(
    latencies: number[],
    slopeThreshold: number = TREND_SLOPE_THRESHOLD,
  ): AnomalyEvent | null {
    if (latencies.length < TREND_MIN_POINTS) {
      return null;
    }

    // Convert ms to seconds for threshold comparison
    const latenciesSec = latencies.map((l) => l / 1000);
    const { slope } = this.linearRegression(latenciesSec);

    if (slope <= slopeThreshold) {
      return null;
    }

    const severity: 'warning' | 'critical' = slope > slopeThreshold * 3 ? 'critical' : 'warning';

    return {
      type: 'latency_trend',
      severity,
      detail: `Latency trend detected: slope ${slope.toFixed(4)} s/task exceeds threshold ${slopeThreshold} s/task over ${latencies.length} observations`,
      value: slope,
      threshold: slopeThreshold,
      algorithm: 'linear_regression',
      detectedAt: new Date().toISOString(),
      suggestedAction: this.suggestAction('latency_trend', severity),
    };
  }

  // ════════════════════════════════════════════════════════════
  // Error Rate Surge Detection
  // ════════════════════════════════════════════════════════════

  /**
   * Detect error rate surges by comparing the current error rate
   * against the baseline.
   *
   * @param errorRate       Current error rate (0-1)
   * @param baselineRate    Historical baseline error rate (0-1)
   * @param threshold       Absolute increase threshold (default: 0.20 = 20%)
   * @returns AnomalyEvent or null if no anomaly
   */
  detectErrorSurge(
    errorRate: number,
    baselineRate: number,
    threshold: number = ERROR_SURGE_THRESHOLD,
  ): AnomalyEvent | null {
    const delta = errorRate - baselineRate;

    if (delta <= threshold) {
      return null;
    }

    const severity: 'warning' | 'critical' = delta > threshold * 2 ? 'critical' : 'warning';

    return {
      type: 'error_surge',
      severity,
      detail: `Error rate surge detected: current ${(errorRate * 100).toFixed(1)}% vs baseline ${(baselineRate * 100).toFixed(1)}% (delta ${(delta * 100).toFixed(1)}%)`,
      value: errorRate,
      threshold: baselineRate + threshold,
      algorithm: 'ratio',
      detectedAt: new Date().toISOString(),
      suggestedAction: this.suggestAction('error_surge', severity),
    };
  }

  // ════════════════════════════════════════════════════════════
  // Full Scan — Run All Detectors
  // ════════════════════════════════════════════════════════════

  /**
   * Run all anomaly detectors on a set of historical data.
   *
   * @param history  Historical metrics for all dimensions
   * @returns Array of detected anomaly events (may be empty)
   */
  scanAll(history: {
    latencies: number[];
    accuracies: number[];
    tokenCounts: number[];
    errorRate: number;
    baselineErrorRate: number;
    securityThreatRate?: number;
    baselineSecurityRate?: number;
  }): AnomalyEvent[] {
    const events: AnomalyEvent[] = [];

    try {
      // 1. Latency trend (linear regression)
      const latencyEvent = this.detectLatencyTrend(history.latencies);
      if (latencyEvent) {
        events.push(latencyEvent);
      }

      // 2. Accuracy drift (Z-score)
      const accuracyEvent = this.detectZScoreDrift(history.accuracies, 'accuracy');
      if (accuracyEvent) {
        events.push(accuracyEvent);
      }

      // 3. Token count spikes (IQR)
      const tokenEvent = this.detectIqrSpike(history.tokenCounts, 'token_count');
      if (tokenEvent) {
        events.push(tokenEvent);
      }

      // 4. Error rate surge
      const errorEvent = this.detectErrorSurge(history.errorRate, history.baselineErrorRate);
      if (errorEvent) {
        events.push(errorEvent);
      }

      // 5. Security threat rate deviation (Z-score)
      if (history.securityThreatRate !== undefined && history.baselineSecurityRate !== undefined) {
        const securityDelta = history.securityThreatRate - history.baselineSecurityRate;
        if (securityDelta > ERROR_SURGE_THRESHOLD) {
          const severity: 'warning' | 'critical' =
            securityDelta > ERROR_SURGE_THRESHOLD * 2 ? 'critical' : 'warning';

          events.push({
            type: 'security_pattern',
            severity,
            detail: `Security threat rate elevated: current ${(history.securityThreatRate * 100).toFixed(1)}% vs baseline ${(history.baselineSecurityRate * 100).toFixed(1)}%`,
            value: history.securityThreatRate,
            threshold: history.baselineSecurityRate + ERROR_SURGE_THRESHOLD,
            algorithm: 'ratio',
            detectedAt: new Date().toISOString(),
            suggestedAction:
              'Review recent security evaluations and tighten input validation rules.',
          });
        }
      }
    } catch (error) {
      this.logger.error(`Error during anomaly scan: ${(error as Error).message}`);
    }

    return events;
  }

  // ════════════════════════════════════════════════════════════
  // Explanation Helper
  // ════════════════════════════════════════════════════════════

  /**
   * Generate a human-readable explanation for an anomaly event,
   * including a suggested remediation action and deviation percentage.
   *
   * @param event  The anomaly event to explain
   * @returns Explanation object with text, action, and deviation %
   */
  explain(event: AnomalyEvent): {
    explanation: string;
    suggestedAction: string;
    deviationPct: number;
  } {
    const deviationPct =
      event.threshold !== 0
        ? Math.abs(((event.value - event.threshold) / event.threshold) * 100)
        : 0;

    const explanations: Record<AnomalyEvent['type'], string> = {
      latency_trend: `Latency is trending upward at a rate of ${event.value.toFixed(4)} s/task, which is ${deviationPct.toFixed(1)}% above the acceptable threshold. This may indicate resource contention, degraded upstream services, or growing prompt complexity.`,
      accuracy_drift: `Response accuracy has drifted ${deviationPct.toFixed(1)}% from the expected range. This may indicate model degradation, changed input distribution, or stale few-shot examples.`,
      token_spike: `Token consumption spiked to ${event.value.toFixed(0)}, which is ${deviationPct.toFixed(1)}% beyond the normal range. This may indicate verbose prompts, repeated context injection, or a missing skill packer optimization.`,
      error_surge: `Error rate has surged to ${(event.value * 100).toFixed(1)}%, which is ${deviationPct.toFixed(1)}% above the baseline. This may indicate a model API outage, prompt format change, or tool integration failure.`,
      security_pattern: `Security threat detection rate has increased ${deviationPct.toFixed(1)}% above baseline. This may indicate a targeted injection attack, compromised agent input, or a newly exposed vulnerability in the pipeline.`,
    };

    const actions: Record<AnomalyEvent['type'], string> = {
      latency_trend:
        'Consider scaling compute resources, reviewing prompt sizes, or enabling the FinOps Skill Packer for token compression.',
      accuracy_drift:
        'Review recent prompt templates, update ground-truth datasets, and consider fine-tuning or switching model tiers.',
      token_spike:
        'Enable FinOps 3-Gate pipeline optimization, review skill packer configuration, and check for context window bloat.',
      error_surge:
        'Check model API health dashboards, verify API key validity, review recent prompt format changes, and consider tier fallback routing.',
      security_pattern:
        'Activate enhanced input sanitization, review recent security evaluator logs, and consider temporarily tightening prompt injection detection thresholds.',
    };

    return {
      explanation: explanations[event.type] || event.detail,
      suggestedAction:
        event.suggestedAction ||
        actions[event.type] ||
        'Investigate the anomaly and take corrective action.',
      deviationPct: Math.round(deviationPct * 100) / 100,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Private Statistical Helpers
  // ════════════════════════════════════════════════════════════

  /** Compute the arithmetic mean of a numeric array. */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /** Compute the population standard deviation. */
  private stdDev(values: number[], mean?: number): number {
    if (values.length === 0) return 0;
    const m = mean ?? this.mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Compute a percentile of a sorted array using linear interpolation.
   * @param sorted  Pre-sorted array (ascending)
   * @param p       Percentile (0-100)
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];

    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
      return sorted[lower];
    }

    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /**
   * Simple least-squares linear regression: y = intercept + slope * x.
   *
   * @param y  Dependent variable values (ordered by x = 0, 1, 2, ...)
   * @returns  { slope, intercept }
   */
  private linearRegression(y: number[]): {
    slope: number;
    intercept: number;
  } {
    const n = y.length;
    if (n < 2) return { slope: 0, intercept: y[0] ?? 0 };

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += y[i];
      sumXY += i * y[i];
      sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) {
      return { slope: 0, intercept: sumY / n };
    }

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept };
  }

  /** Provide a default suggested action based on type and severity. */
  private suggestAction(type: AnomalyEvent['type'], severity: 'warning' | 'critical'): string {
    const actionMap: Record<string, string> = {
      latency_trend_warning:
        'Monitor latency trend over the next few evaluations and consider scaling if it persists.',
      latency_trend_critical:
        'Immediately investigate latency source — check model API response times, prompt sizes, and compute resource utilization.',
      accuracy_drift_warning:
        'Review recent prompt templates and ground-truth alignment. Consider A/B testing model tier changes.',
      accuracy_drift_critical:
        'Urgent: accuracy has degraded significantly. Pause affected workflows and audit prompt/model configuration.',
      token_spike_warning:
        'Review recent prompt constructions for unnecessary verbosity. Check skill packer configuration.',
      token_spike_critical:
        'Token usage critically elevated — enable aggressive skill packing and investigate for prompt injection or context bloat.',
      error_surge_warning:
        'Check model API status pages and recent deployment changes. Monitor error patterns.',
      error_surge_critical:
        'Critical error rate — activate fallback model routing and alert on-call team.',
      security_pattern_warning:
        'Review recent security evaluator findings. Consider tightening input validation.',
      security_pattern_critical:
        'Security threat pattern critical — activate enhanced security mode and review all recent pipeline inputs.',
    };

    return (
      actionMap[`${type}_${severity}`] ||
      'Investigate the detected anomaly and take appropriate corrective action.'
    );
  }
}
