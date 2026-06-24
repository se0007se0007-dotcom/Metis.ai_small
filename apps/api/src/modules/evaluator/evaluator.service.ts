/**
 * Evaluator Service — Main Orchestrator
 *
 * Central orchestration service that coordinates all four evaluation engines
 * (Quality, Security, Anomaly, Cost) and persists results to Prisma.
 *
 * Called after each node execution in the pipeline to produce a comprehensive
 * evaluation result covering quality, security posture, anomaly detection,
 * and cost efficiency.
 *
 * Scoring model (weighted composite):
 *   - Quality:  40 %  (accuracy, hallucination, response quality)
 *   - Security: 30 %  (input threats, output leakage, tool chain)
 *   - Cost:     15 %  (cost efficiency, latency, throughput)
 *   - Anomaly:  15 %  (no anomaly = full score; anomaly detected = penalty)
 *
 * Design principles:
 *   - Evaluation failures never block pipeline execution (try-catch everywhere)
 *   - In-memory ring buffer per agent for anomaly detection history
 *   - Tenant resolution with fallback (same pattern as finops.service.ts)
 *   - All Prisma access uses `(this.prisma as any)` to handle generated types
 *
 * @module evaluator
 */
import { Injectable, Inject, Logger, Optional, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { QualityEvaluator } from './quality-evaluator';
import { SecurityEvaluator } from './security-evaluator';
import { AnomalyDetector, AnomalyEvent } from './anomaly-detector';
import { CostEvaluator } from './cost-evaluator';
import { LLMJudgeService, LLMJudgeScores } from './llm-judge';
import {
  EvaluationPolicyService,
  ResolvedEvaluationPolicy,
  DEFAULT_EVALUATION_POLICY,
} from './evaluation-policy.service';
import { AdaptiveSamplingService } from './feedback/adaptive-sampling.service';
import { evaluateAlarms } from './feedback/policy-alarm';
import { KnowledgeCaptureService } from './feedback/knowledge-capture.service';
import { FinopsReporterService } from '../../common/finops/finops-reporter.service';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Full evaluation result returned by the `evaluate()` method. */
export interface EvaluationResult {
  /** Composite overall score (0-100) */
  overallScore: number;

  /** Quality evaluation results (Gate 1 & 2) */
  quality: {
    accuracyScore: number;
    hallucinationRate: number;
    responseQuality: number;
    qualityGrade: string;
    completionScore: number;
  };

  /** Security evaluation results (Gate 5) */
  security: {
    securityScore: number;
    inputThreatCount: number;
    outputLeakageCount: number;
    toolChainRisk: boolean;
    securityRiskLevel: string;
  };

  /** Cost evaluation results (Gate 4) */
  cost: {
    costUsd: number;
    costEfficiency: number;
    latencyGrade: string;
    tokenEfficiency: number;
    savingsFromOptimization: number;
    recommendations: string[];
  };

  /** Anomaly detection results (Gate 7) */
  anomaly: {
    anomalyDetected: boolean;
    events: AnomalyEvent[];
  };

  /** Gates that were applied during this evaluation */
  gatesApplied: string[];

  /** Persisted record ID (null if persistence failed) */
  recordId: string | null;
}

/** Aggregated evaluation statistics for dashboard display. */
export interface EvalStats {
  totalEvaluations: number;
  avgOverallScore: number;
  avgAccuracy: number;
  avgSecurityScore: number;
  anomalyRate: number;
  avgCostEfficiency: number;
  gradeDistribution: Record<string, number>;
}

/** In-memory history buffer for a single agent. */
interface AgentHistory {
  latencies: number[];
  accuracies: number[];
  tokens: number[];
  errors: number;
  total: number;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Maximum entries kept in the per-agent ring buffer. */
const HISTORY_BUFFER_SIZE = 100;

/**
 * Default weighted score components.
 * NOTE: These are fallbacks only — at runtime the weights/thresholds are
 * loaded from the active EvaluationPolicy (Phase 1). With a default policy
 * the effective values are identical to these constants.
 */
const SCORE_WEIGHTS = {
  quality: 0.4,
  security: 0.3,
  cost: 0.15,
  anomaly: 0.15,
} as const;

/** Evaluation engine version tag persisted with every record. */
const ENGINE_VERSION = 'agent-evaluator-v0.9.3-hybrid';

/** Layer 0 score range where LLM Judge should be invoked for deeper evaluation */
const LLM_JUDGE_THRESHOLD = { min: 40, max: 75 };

// ────────────────────────────────────────────────────────────────
// Pure helpers — Anomalies page (unit tested in scripts/test-risk-anomaly.mjs)
// ────────────────────────────────────────────────────────────────

/** Normalize an anomaly severity into one of warning/critical/info. */
function normAnomalySeverity(sev: string): 'critical' | 'warning' | 'info' {
  const s = (sev || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'warning') return 'warning';
  return 'info';
}

/** Bucket a Date/string into a YYYY-MM-DD (UTC) string. */
function anomalyDayBucket(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}

/**
 * Flatten AgentEvaluation rows (each carrying anomalyEvents[]) into the
 * Anomalies page payload: items + summary + heatmap. Pure / deterministic.
 *
 * Rows shape: { id, workflowKey, agentName, stepKey, anomalyEvents, createdAt }.
 * Optional filters severity/type are applied to the flattened events.
 */
export function buildAnomaliesPayload(
  rows: Array<{
    id: string;
    workflowKey?: string | null;
    agentName?: string | null;
    stepKey?: string | null;
    anomalyEvents?: any;
    createdAt: Date | string;
  }>,
  opts: { days: number; since: string; severity?: string; type?: string } = {
    days: 30,
    since: '',
  },
): any {
  const items: any[] = [];

  for (const row of rows || []) {
    const events = Array.isArray(row.anomalyEvents) ? row.anomalyEvents : [];
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const sevNorm = normAnomalySeverity(ev.severity);
      const evType = String(ev.type || 'accuracy_drift');
      if (opts.severity && sevNorm !== normAnomalySeverity(opts.severity)) continue;
      if (opts.type && evType !== opts.type) continue;
      items.push({
        id: row.id,
        workflowKey: row.workflowKey ?? null,
        agentName: row.agentName ?? null,
        stepKey: row.stepKey ?? null,
        type: evType,
        severity: ev.severity ?? 'warning',
        detail: ev.detail ?? '',
        value: typeof ev.value === 'number' ? ev.value : null,
        threshold: typeof ev.threshold === 'number' ? ev.threshold : null,
        algorithm: ev.algorithm ?? null,
        detectedAt: ev.detectedAt ?? anomalyDayBucket(row.createdAt),
      });
    }
  }

  // ── Summary ──
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byType: Record<string, number> = {
    latency_trend: 0,
    accuracy_drift: 0,
    token_spike: 0,
    error_surge: 0,
    security_pattern: 0,
  };
  const agentCounts: Record<string, number> = {};
  for (const it of items) {
    bySeverity[normAnomalySeverity(it.severity)]++;
    if (byType[it.type] !== undefined) byType[it.type]++;
    const a = it.agentName || it.workflowKey || 'unknown';
    agentCounts[a] = (agentCounts[a] || 0) + 1;
  }
  const byAgent = Object.entries(agentCounts)
    .map(([agentName, count]) => ({ agentName, count }))
    .sort((x, y) => y.count - x.count);

  // ── Heatmap: count per (date, type) ──
  const heatMap = new Map<string, { date: string; type: string; count: number }>();
  for (const it of items) {
    const date = anomalyDayBucket(it.detectedAt || opts.since);
    const key = `${date}::${it.type}`;
    let h = heatMap.get(key);
    if (!h) {
      h = { date, type: it.type, count: 0 };
      heatMap.set(key, h);
    }
    h.count++;
  }
  const heatmap = Array.from(heatMap.values()).sort((x, y) =>
    x.date === y.date ? (x.type < y.type ? -1 : 1) : x.date < y.date ? -1 : 1,
  );

  return {
    items,
    summary: { total: items.length, bySeverity, byType, byAgent },
    heatmap,
    window: { days: opts.days, since: opts.since },
  };
}

// ────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class EvaluatorService {
  private readonly logger = new Logger(EvaluatorService.name);

  /**
   * In-memory ring buffer keyed by `tenantId::agentName` (or stepKey).
   * Stores recent evaluation metrics for anomaly detection without
   * requiring a database round-trip.
   */
  private evaluationHistory: Map<string, AgentHistory> = new Map();

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly qualityEvaluator: QualityEvaluator,
    private readonly securityEvaluator: SecurityEvaluator,
    private readonly anomalyDetector: AnomalyDetector,
    private readonly costEvaluator: CostEvaluator,
    @Optional() private readonly llmJudge?: LLMJudgeService,
    @Optional() private readonly policyService?: EvaluationPolicyService,
    @Optional() private readonly adaptiveSampling?: AdaptiveSamplingService,
    @Optional() private readonly knowledgeCapture?: KnowledgeCaptureService,
    @Optional() private readonly finopsReporter?: FinopsReporterService,
  ) {
    if (this.llmJudge?.isAvailable()) {
      this.logger.log('Hybrid evaluation enabled: Layer 0 (statistical) + Layer 1 (LLM Judge)');
    } else {
      this.logger.log('Layer 0 only: LLM Judge not available (no API key or service not injected)');
    }
  }

  // ════════════════════════════════════════════════════════════
  // Main Evaluation Entry Point
  // ════════════════════════════════════════════════════════════

  /**
   * Run all four evaluation gates on a single execution step and
   * persist the result to the `AgentEvaluation` table.
   *
   * This method is designed to be called after each node execution
   * in the pipeline.  It catches all errors internally so that
   * evaluation failures never block pipeline execution.
   *
   * @param params  Execution context and data
   * @returns Structured evaluation result
   */
  async evaluate(params: {
    tenantId: string;
    executionSessionId: string;
    stepKey: string;
    nodeType: string;
    agentName?: string;
    /** Parent workflow key (main agent) — denormalized onto AgentEvaluation. */
    workflowKey?: string;
    input?: string;
    output?: string;
    groundTruth?: string;
    context?: string;
    toolCalls?: string[];
    executionTimeMs?: number;
    tokensUsed?: number;
    model?: string;
    cacheHit?: boolean;
    routedTier?: number;
    estimatedCostUsd?: number;
    /** Optional agent group ("운영" | "개발" | "고도화") for policy scoping. */
    agentGroup?: string;
    /**
     * 노드 테스트 등 — 4게이트는 계산/반환하되 운영 지표 부수효과는 건너뛴다:
     * AgentEvaluation 저장, 이상동작 이력 갱신, FinOps 품질 보고, 정책 알람, 지식 캡처 제외.
     * (테스트 실행이 대시보드/이상동작/FinOps 지표를 오염시키지 않도록 함.)
     */
    excludeFromMetrics?: boolean;
  }): Promise<EvaluationResult> {
    const gatesApplied: string[] = [];

    // ── Phase 1: load the active Gate policy (config-driven thresholds) ──
    // Falls back to built-in defaults so scoring is unchanged when no policy
    // row exists or the service is not injected.
    let policy: ResolvedEvaluationPolicy = DEFAULT_EVALUATION_POLICY;
    try {
      if (this.policyService) {
        policy = await this.policyService.getActivePolicy(params.tenantId, params.agentGroup);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to resolve evaluation policy (using defaults): ${(err as Error).message}`,
      );
    }
    const result: EvaluationResult = {
      overallScore: 0,
      quality: {
        accuracyScore: 0,
        hallucinationRate: 0,
        responseQuality: 0,
        qualityGrade: 'N/A',
        completionScore: 0,
      },
      security: {
        securityScore: 100,
        inputThreatCount: 0,
        outputLeakageCount: 0,
        toolChainRisk: false,
        securityRiskLevel: 'low',
      },
      cost: {
        costUsd: 0,
        costEfficiency: 1,
        latencyGrade: 'fast',
        tokenEfficiency: 0,
        savingsFromOptimization: 0,
        recommendations: [],
      },
      anomaly: {
        anomalyDetected: false,
        events: [],
      },
      gatesApplied: [],
      recordId: null,
    };

    try {
      // ── Gate 1 & 2: Quality Evaluation ──
      if (params.output && params.output.trim().length > 0) {
        try {
          const qualityResult = this.runQualityEvaluation(params);
          result.quality = qualityResult;
          gatesApplied.push('quality');
        } catch (err) {
          this.logger.warn(`Quality evaluation failed: ${(err as Error).message}`);
        }
      }

      // ── Layer 1: LLM Judge ──
      // ALWAYS invoked when available. LLM Judge is the PRIMARY quality authority.
      // Layer 0 (statistical) alone cannot determine factual correctness.
      // Without LLM Judge, a wrong answer like "Japan" for "What is our country?"
      // gets a high score because it's structurally valid text.
      // Phase 2.3: adaptive sampling decides whether to spend an LLM Judge call
      // this round. Defaults to true (always) when the service isn't injected,
      // so behavior is unchanged unless adaptive sampling is active.
      const adaptiveAllows = this.adaptiveSampling
        ? this.adaptiveSampling.shouldRunJudge(params.tenantId, params.agentName)
        : true;

      if (
        policy.llmJudgeEnabled &&
        adaptiveAllows &&
        this.llmJudge?.isAvailable() &&
        params.output &&
        params.input
      ) {
        try {
          const judgeResult = await this.llmJudge.judge({
            question: params.input,
            response: params.output,
            context: params.context,
            forceJudge: true, // ALWAYS judge — quality gate requires factual accuracy check
            tenantId: params.tenantId, // G6a: per-tenant external-LLM governance flag
            isTest: params.excludeFromMetrics, // 노드 테스트면 판정 LLM 비용도 원장 제외
          });

          if (judgeResult.judged && judgeResult.scores) {
            const converted = this.llmJudge.convertToEvaluatorScore(judgeResult.scores);

            // Blend strategy depends on whether Layer 0 had ground truth
            const hasGroundTruth = !!params.groundTruth;
            const layer0HasAccuracy = result.quality.accuracyScore > 0;

            if (hasGroundTruth && layer0HasAccuracy) {
              // Both Layer 0 and LLM Judge have data → blend 30/70
              result.quality.accuracyScore =
                Math.round(
                  (result.quality.accuracyScore * 0.3 + (converted.qualityScore / 100) * 0.7) *
                    10000,
                ) / 10000;
            } else {
              // No ground truth → Layer 0 accuracy is 0 (meaningless)
              // LLM Judge is the ONLY accuracy source → use 100%
              result.quality.accuracyScore =
                Math.round((converted.qualityScore / 100) * 10000) / 10000;
            }

            result.quality.responseQuality =
              Math.round(
                (result.quality.responseQuality * 0.3 + converted.responseQuality * 0.7) * 100,
              ) / 100;
            result.quality.hallucinationRate =
              Math.round(
                (result.quality.hallucinationRate * 0.3 + converted.hallucinationRate * 0.7) *
                  10000,
              ) / 10000;

            // Recompute grade with blended scores
            // LLM Judge provides its own accuracy proxy, so treat as "has ground truth"
            const { overallScore: newGradeScore, grade: newGrade } =
              this.qualityEvaluator.computeOverallGrade(
                result.quality.accuracyScore,
                result.quality.hallucinationRate,
                result.quality.responseQuality,
                true, // LLM Judge acts as accuracy source
              );
            result.quality.qualityGrade = newGrade;
            result.quality.completionScore = newGradeScore;

            gatesApplied.push('llm-judge');
            this.logger.log(
              `LLM Judge blended: quality=${converted.qualityScore}, ` +
                `hallucination=${converted.hallucinationRate}, ` +
                `model=${judgeResult.model}, cost=$${judgeResult.costUsd}`,
            );
          }
        } catch (err) {
          this.logger.warn(`LLM Judge failed (falling back to Layer 0): ${(err as Error).message}`);
        }
      }

      // ── Gate 5: Security Evaluation ──
      try {
        const securityResult = this.runSecurityEvaluation(params);
        result.security = securityResult;
        gatesApplied.push('security');
      } catch (err) {
        this.logger.warn(`Security evaluation failed: ${(err as Error).message}`);
      }

      // ── Gate 4: Cost Evaluation ──
      if (params.tokensUsed || params.executionTimeMs) {
        try {
          const costResult = this.runCostEvaluation(params);
          result.cost = costResult;
          gatesApplied.push('cost');
        } catch (err) {
          this.logger.warn(`Cost evaluation failed: ${(err as Error).message}`);
        }
      }

      // ── Update history & Gate 7: Anomaly Detection ──
      try {
        const historyKey = this.buildHistoryKey(
          params.tenantId,
          params.agentName || params.stepKey,
        );
        // Seed the in-memory ring buffer from persisted history so anomaly
        // detection works after a restart and over seeded data (best-effort).
        await this.seedHistoryFromDb(historyKey, {
          tenantId: params.tenantId,
          agentName: params.agentName,
          stepKey: params.stepKey,
          workflowKey: params.workflowKey,
        });
        // 테스트 실행은 agent 이상동작 베이스라인을 오염시키지 않도록 이력에 추가하지 않는다.
        // (탐지는 실데이터 기반으로 그대로 수행 → 테스트도 이상동작 점수는 받음.)
        if (!params.excludeFromMetrics) {
          this.updateHistory(historyKey, {
            latency: params.executionTimeMs,
            accuracy: result.quality.accuracyScore,
            tokens: params.tokensUsed,
            isError: result.quality.qualityGrade === 'F',
          });
        }

        const anomalyResult = this.runAnomalyDetection(historyKey);
        result.anomaly = anomalyResult;
        gatesApplied.push('anomaly');
      } catch (err) {
        this.logger.warn(`Anomaly detection failed: ${(err as Error).message}`);
      }

      // ── Compute overall weighted score (policy-driven) ──
      result.overallScore = this.computeOverallScore(result, policy);
      result.gatesApplied = gatesApplied;

      // Phase 2.3: feed the outcome back into adaptive sampling so the next
      // round's LLM Judge frequency adapts to system health.
      if (!params.excludeFromMetrics) {
        try {
          this.adaptiveSampling?.record(params.tenantId, params.agentName, {
            anomalyDetected: result.anomaly.anomalyDetected,
            overallScore: result.overallScore,
          });
        } catch (err) {
          this.logger.warn(`Adaptive sampling update failed: ${(err as Error).message}`);
        }
      }

      // ── Persist to database ──
      // 테스트 실행도 4게이트 기록은 남긴다(isTest 태그로 저장). 운영 대시보드/이상동작
      // 베이스라인에서는 isTest 로 분리/제외되고, 'Sub-Agent 평가 이력'에서 조회된다.
      try {
        const recordId = await this.persistEvaluation(params, result);
        result.recordId = recordId;
      } catch (err) {
        this.logger.warn(`Evaluation persistence failed: ${(err as Error).message}`);
      }

      // ── FinOps 품질 폐루프: 평가 품질을 원장(control-plane)에 보고 ──
      // run_id = executionSessionId (게이트웨이 비용 귀속과 동일 키). 0..1 스케일.
      // best-effort — 원장 미기동/실패해도 평가를 막지 않는다.
      try {
        if (this.finopsReporter && !params.excludeFromMetrics) {
          const score01 = Math.max(0, Math.min(1, result.overallScore / 100));
          // fire-and-forget: 원장 보고가 평가 응답을 지연시키지 않도록 await 하지 않는다.
          void this.finopsReporter.reportQuality({
            runId: params.executionSessionId,
            score: score01,
            passed: score01 >= 0.8,
            agent: params.agentName,
            tenant: params.tenantId,
            status: result.quality.qualityGrade === 'F' ? 'failure' : 'success',
          });
        }
      } catch (err) {
        this.logger.warn(`FinOps quality report failed: ${(err as Error).message}`);
      }

      // ── Phase 2.3: policy-violation alarms (security/quality/anomaly) ──
      // Isolated so alarm failures never block evaluation. 테스트 실행은 알람 미발생.
      if (!params.excludeFromMetrics) {
        try {
          await this.raiseAlarms(params, result, policy);
        } catch (err) {
          this.logger.warn(`Policy alarm raise failed: ${(err as Error).message}`);
        }
      }

      // ── Scenario 1 (Part A): KNOWLEDGE-IFY problems into ErrorPattern ──
      // When the evaluation indicates a problem (quality F, security high/
      // critical, anomaly), capture it as durable knowledge. Best-effort:
      // never blocks the run. 테스트 실행은 지식 캡처 제외.
      if (!params.excludeFromMetrics)
        try {
          const grade = (result.quality.qualityGrade || '').toUpperCase();
        const risk = (result.security.securityRiskLevel || '').toLowerCase();
        const hasProblem =
          grade === 'F' || risk === 'high' || risk === 'critical' || result.anomaly.anomalyDetected;
        if (hasProblem && this.knowledgeCapture) {
          await this.knowledgeCapture.captureFromEvaluation({
            tenantId: params.tenantId,
            workflowKey: params.workflowKey ?? null,
            stepKey: params.stepKey ?? null,
            agentName: params.agentName ?? null,
            qualityGrade: result.quality.qualityGrade,
            securityRiskLevel: result.security.securityRiskLevel,
            anomalyDetected: result.anomaly.anomalyDetected,
          });
        }

        // ── Scenario 1 (Part B): KNOWLEDGE-IFY successes too ──
        // Grade A + high overall score → accumulate a SUCCESS_PATTERN artifact
        // (DRAFT, human-reviewed before injection). Closes the positive half
        // of the execution → knowledge feedback loop.
        const isSuccess =
          grade === 'A' && result.overallScore >= 90 && !result.anomaly.anomalyDetected;
        if (isSuccess && this.knowledgeCapture) {
          await this.knowledgeCapture.captureSuccessFromEvaluation({
            tenantId: params.tenantId,
            workflowKey: params.workflowKey ?? null,
            stepKey: params.stepKey ?? null,
            agentName: params.agentName ?? null,
            overallScore: result.overallScore,
          });
        }
      } catch (err) {
        this.logger.warn(`Knowledge capture (eval) failed: ${(err as Error).message}`);
      }

      // ── Scale normalization: ensure all scores are 0-100 ──
      // accuracyScore from Layer 0 is 0-1, convert to 0-100
      if (result.quality.accuracyScore > 0 && result.quality.accuracyScore <= 1) {
        result.quality.accuracyScore = Math.round(result.quality.accuracyScore * 100);
      }
      // completionScore should always be 0-100
      if (result.quality.completionScore <= 0) {
        result.quality.completionScore = result.overallScore;
      }
      // costEfficiency is 0-1, keep as-is (displayed as percentage on frontend)

      this.logger.log(
        `Evaluation complete: step=${params.stepKey}, score=${result.overallScore}, ` +
          `quality=${result.quality.completionScore}, security=${result.security.securityScore}, ` +
          `gates=[${gatesApplied.join(',')}], record=${result.recordId ?? 'not-persisted'}`,
      );
    } catch (err) {
      // Top-level catch — evaluation must never throw
      this.logger.error(
        `Evaluation failed entirely: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════
  // Query Methods
  // ════════════════════════════════════════════════════════════

  /**
   * Retrieve all evaluations for a specific execution session.
   *
   * @param tenantId           Tenant identifier
   * @param executionSessionId Execution session identifier
   * @returns Array of evaluation records
   */
  async getSessionEvaluations(tenantId: string, executionSessionId: string): Promise<any[]> {
    try {
      const resolvedTenantId = await this.resolveTenantId(tenantId);
      return await (this.prisma as any).agentEvaluation.findMany({
        where: {
          tenantId: resolvedTenantId,
          executionSessionId,
        },
        orderBy: { createdAt: 'asc' },
      });
    } catch (err) {
      this.logger.error(`Failed to get session evaluations: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Retrieve recent evaluations with aggregated statistics.
   *
   * @param tenantId Tenant identifier
   * @param limit    Maximum number of evaluations to return (default: 50)
   * @returns Evaluations and aggregated stats
   */
  async getRecentEvaluations(
    tenantId: string,
    limit: number = 50,
  ): Promise<{ evaluations: any[]; stats: EvalStats }> {
    try {
      const resolvedTenantId = await this.resolveTenantId(tenantId);

      const evaluations = await (this.prisma as any).agentEvaluation.findMany({
        where: { tenantId: resolvedTenantId, NOT: { workflowKey: { startsWith: 'nodetest-' } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      const stats = this.computeStats(evaluations);
      return { evaluations, stats };
    } catch (err) {
      this.logger.error(`Failed to get recent evaluations: ${(err as Error).message}`);
      return {
        evaluations: [],
        stats: {
          totalEvaluations: 0,
          avgOverallScore: 0,
          avgAccuracy: 0,
          avgSecurityScore: 0,
          anomalyRate: 0,
          avgCostEfficiency: 0,
          gradeDistribution: {},
        },
      };
    }
  }

  /**
   * Query anomalies for the agent operational-risk "Anomalies" page.
   *
   * Reads AgentEvaluation rows where anomalyDetected = true (within the
   * window, tenant-scoped) and FLATTENS each row's anomalyEvents[] array into
   * individual anomaly items. Optional filters: workflowKey, severity, type.
   *
   * Returns: { items, summary, heatmap, window }.
   */
  async getAnomalies(
    tenantId: string,
    opts: { days?: number; workflowKey?: string; severity?: string; type?: string } = {},
  ): Promise<any> {
    try {
      const resolvedTenantId = await this.resolveTenantId(tenantId);
      const days = Math.max(1, Math.min(365, opts.days || 30));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const where: any = {
        tenantId: resolvedTenantId,
        anomalyDetected: true,
        createdAt: { gte: since },
        NOT: { workflowKey: { startsWith: 'nodetest-' } }, // 운영 이상동작 화면에서 테스트 평가 제외
      };
      if (opts.workflowKey) where.workflowKey = opts.workflowKey;

      const rows = await (this.prisma as any).agentEvaluation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5000,
        select: {
          id: true,
          workflowKey: true,
          agentName: true,
          stepKey: true,
          anomalyEvents: true,
          createdAt: true,
        },
      });

      return buildAnomaliesPayload(rows, {
        days,
        since: since.toISOString(),
        severity: opts.severity,
        type: opts.type,
      });
    } catch (err) {
      this.logger.error(`Failed to query anomalies: ${(err as Error).message}`);
      return {
        items: [],
        summary: {
          total: 0,
          bySeverity: { critical: 0, warning: 0, info: 0 },
          byType: {
            latency_trend: 0,
            accuracy_drift: 0,
            token_spike: 0,
            error_surge: 0,
            security_pattern: 0,
          },
          byAgent: [],
        },
        heatmap: [],
        window: { days: opts.days || 30, since: new Date().toISOString() },
      };
    }
  }

  /**
   * Get evaluation trend data grouped by day.
   *
   * @param tenantId Tenant identifier
   * @param days     Number of days to look back (default: 7)
   * @returns Daily aggregated evaluation data
   */
  async getEvaluationTrend(tenantId: string, days: number = 7): Promise<any[]> {
    try {
      const resolvedTenantId = await this.resolveTenantId(tenantId);
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);

      const evaluations = await (this.prisma as any).agentEvaluation.findMany({
        where: {
          tenantId: resolvedTenantId,
          createdAt: { gte: sinceDate },
          NOT: { workflowKey: { startsWith: 'nodetest-' } }, // 트렌드에서 테스트 평가 제외
        },
        orderBy: { createdAt: 'asc' },
        select: {
          overallScore: true,
          accuracyScore: true,
          securityScore: true,
          costEfficiency: true,
          anomalyDetected: true,
          qualityGrade: true,
          createdAt: true,
        },
      });

      // Group by day
      const dailyMap = new Map<string, any[]>();
      for (const evalRecord of evaluations) {
        const day = evalRecord.createdAt.toISOString().substring(0, 10);
        if (!dailyMap.has(day)) {
          dailyMap.set(day, []);
        }
        dailyMap.get(day)!.push(evalRecord);
      }

      const trend = Array.from(dailyMap.entries()).map(([date, records]) => ({
        date,
        count: records.length,
        avgOverallScore: this.avg(records.map((r: any) => r.overallScore)),
        avgAccuracy: this.avg(
          records.map((r: any) => r.accuracyScore).filter((v: any) => v != null),
        ),
        avgSecurity: this.avg(
          records.map((r: any) => r.securityScore).filter((v: any) => v != null),
        ),
        avgCostEfficiency: this.avg(
          records.map((r: any) => r.costEfficiency).filter((v: any) => v != null),
        ),
        anomalyCount: records.filter((r: any) => r.anomalyDetected).length,
      }));

      return trend;
    } catch (err) {
      this.logger.error(`Failed to get evaluation trend: ${(err as Error).message}`);
      return [];
    }
  }

  // ════════════════════════════════════════════════════════════
  // Private: Individual Gate Runners
  // ════════════════════════════════════════════════════════════

  /**
   * Run the Quality Evaluator (Gate 1 & 2).
   * Evaluates accuracy, hallucination, and response quality.
   */
  private runQualityEvaluation(params: {
    output?: string;
    groundTruth?: string;
    context?: string;
    input?: string;
  }): EvaluationResult['quality'] {
    const output = params.output || '';

    // Accuracy (requires ground truth)
    let accuracyScore = 0;
    if (params.groundTruth) {
      const accuracy = this.qualityEvaluator.evaluateAccuracy(output, params.groundTruth);
      accuracyScore = accuracy.score;
    }

    // Hallucination detection (requires context)
    let hallucinationRate = 0;
    if (params.context) {
      const hallucination = this.qualityEvaluator.detectHallucination(
        output,
        params.context,
        params.groundTruth,
      );
      hallucinationRate = hallucination.hallucinationRate;
    }

    // Response quality scoring
    const qualityResult = this.qualityEvaluator.scoreResponseQuality(output, params.input);
    const responseQuality = qualityResult.totalScore;

    // Overall quality grade — pass hasGroundTruth flag so that
    // responses without ground truth aren't unfairly penalized
    const hasGroundTruth = !!params.groundTruth;
    const { overallScore, grade } = this.qualityEvaluator.computeOverallGrade(
      accuracyScore,
      hallucinationRate,
      responseQuality,
      hasGroundTruth,
    );

    // Completion score — derived from quality dimensions
    const completionScore = Math.min(1, (qualityResult.dimensions.completeness || 0) / 5);

    return {
      accuracyScore,
      hallucinationRate,
      responseQuality,
      qualityGrade: grade,
      completionScore,
    };
  }

  /**
   * Run the Security Evaluator (Gate 5).
   * Evaluates input threats, output leakage, and tool chain risk.
   */
  private runSecurityEvaluation(params: {
    input?: string;
    output?: string;
    toolCalls?: string[];
  }): EvaluationResult['security'] {
    // Input threat assessment
    const inputResult = this.securityEvaluator.evaluateInput(params.input || '');

    // Output leakage detection
    const outputResult = this.securityEvaluator.detectOutputLeakage(params.output || '');

    // Tool chain analysis
    const toolChainResult = this.securityEvaluator.analyzeToolChain(params.toolCalls || []);

    // Composite security score
    const securityScore = this.securityEvaluator.computeSecurityScore(
      inputResult,
      outputResult,
      toolChainResult,
    );

    // Aggregate risk level — use BOTH pattern severity AND score-based level
    // This prevents the case where score=45 but riskLevel='low'
    const riskLevels = [inputResult.riskLevel, outputResult.severity];
    if (toolChainResult.isSuspicious) riskLevels.push('high');

    // Score-based risk level override: if score is low, risk must be high
    if (securityScore < 40) riskLevels.push('critical');
    else if (securityScore < 60) riskLevels.push('high');
    else if (securityScore < 80) riskLevels.push('medium');

    const securityRiskLevel = this.highestRisk(riskLevels);

    return {
      securityScore,
      inputThreatCount: inputResult.threatCount,
      outputLeakageCount: outputResult.leakageCount,
      toolChainRisk: toolChainResult.isSuspicious,
      securityRiskLevel,
    };
  }

  /**
   * Run the Cost Evaluator (Gate 4).
   * Evaluates cost efficiency, latency, and token throughput.
   */
  private runCostEvaluation(params: {
    tokensUsed?: number;
    executionTimeMs?: number;
    model?: string;
    cacheHit?: boolean;
    routedTier?: number;
    estimatedCostUsd?: number;
  }): EvaluationResult['cost'] {
    return this.costEvaluator.evaluateExecution({
      tokensUsed: params.tokensUsed || 0,
      executionTimeMs: params.executionTimeMs || 0,
      model: params.model || 'unknown',
      cacheHit: params.cacheHit,
      routedTier: params.routedTier,
      estimatedCostUsd: params.estimatedCostUsd,
    });
  }

  /**
   * Run the Anomaly Detector (Gate 7) against in-memory history.
   */
  private runAnomalyDetection(historyKey: string): EvaluationResult['anomaly'] {
    const history = this.evaluationHistory.get(historyKey);
    if (!history || history.total < 5) {
      // Not enough data for meaningful anomaly detection
      return { anomalyDetected: false, events: [] };
    }

    const errorRate = history.total > 0 ? history.errors / history.total : 0;
    // Use a conservative baseline — first half of history
    const halfIdx = Math.floor(history.total / 2);
    const baselineErrors = history.total > 10 ? history.errors * (halfIdx / history.total) : 0;
    const baselineTotal = Math.max(1, halfIdx);
    const baselineErrorRate = baselineTotal > 0 ? baselineErrors / baselineTotal : 0;

    const events = this.anomalyDetector.scanAll({
      latencies: history.latencies,
      accuracies: history.accuracies,
      tokenCounts: history.tokens,
      errorRate,
      baselineErrorRate,
    });

    return {
      anomalyDetected: events.length > 0,
      events,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Private: Scoring & History
  // ════════════════════════════════════════════════════════════

  /**
   * Compute the weighted overall score (0-100) using the active policy.
   *
   * Components (weights from policy, defaults shown):
   *   - Quality (40%):  quality grade mapped to 0-100
   *   - Security (30%): security score (already 0-100)
   *   - Cost (15%):     cost efficiency * 100
   *   - Anomaly (15%):  100 if no anomaly, penalty per event
   *
   * Hard gates (caps) are also policy-driven:
   *   - qualityHardGateMin: quality below this caps the overall at 40
   *   - securityCriticalCap / securityHighCap: caps for critical/high risk
   *
   * @param result  Per-gate evaluation results
   * @param policy  Resolved evaluation policy (weights + thresholds)
   */
  private computeOverallScore(
    result: EvaluationResult,
    policy: ResolvedEvaluationPolicy = DEFAULT_EVALUATION_POLICY,
  ): number {
    // Quality component — map grade to 0-100
    const gradeMap: Record<string, number> = {
      A: 95,
      B: 85,
      C: 75,
      D: 65,
      F: 30,
      'N/A': 70,
    };
    const qualityScore = gradeMap[result.quality.qualityGrade] ?? 70;

    // Security component — already 0-100
    const securityScore = result.security.securityScore;

    // Cost component — costEfficiency is 0-1, scale to 0-100
    const costScore = result.cost.costEfficiency * 100;

    // Anomaly component — 100 if no anomaly, minus 20 per warning, 40 per critical
    let anomalyScore = 100;
    for (const event of result.anomaly.events) {
      if (event.severity === 'critical') {
        anomalyScore -= 40;
      } else {
        anomalyScore -= 20;
      }
    }
    anomalyScore = Math.max(0, anomalyScore);

    // Normalize weights so they always sum to 1 even if a policy is misconfigured.
    const rawWeights = {
      quality: policy.qualityWeight,
      security: policy.securityWeight,
      cost: policy.costWeight,
      anomaly: policy.anomalyWeight,
    };
    const weightSum =
      rawWeights.quality + rawWeights.security + rawWeights.cost + rawWeights.anomaly;
    const w =
      weightSum > 0
        ? {
            quality: rawWeights.quality / weightSum,
            security: rawWeights.security / weightSum,
            cost: rawWeights.cost / weightSum,
            anomaly: rawWeights.anomaly / weightSum,
          }
        : SCORE_WEIGHTS;

    let overall =
      qualityScore * w.quality +
      securityScore * w.security +
      costScore * w.cost +
      anomalyScore * w.anomaly;

    // ── HARD GATES: these caps override the weighted average ──

    // Quality hard gate — a factually wrong or poor quality response
    // cannot be a "good" overall response regardless of other scores.
    // This ensures "Japan" for "What is our country?" gets F, not D.
    const qualityHardGateMin = policy.qualityHardGateMin;
    if (qualityScore < 30) {
      overall = Math.min(overall, 25); // Terrible quality → F
    } else if (qualityScore < qualityHardGateMin) {
      overall = Math.min(overall, 40); // Below hard gate → F
    } else if (qualityScore < qualityHardGateMin + 10) {
      overall = Math.min(overall, 55); // Just above hard gate → D
    }

    // Security hard gate — leaking passwords/keys overrides everything
    if (result.security.securityRiskLevel === 'critical') {
      overall = Math.min(overall, policy.securityCriticalCap); // Critical → F
    } else if (result.security.securityRiskLevel === 'high') {
      overall = Math.min(overall, policy.securityHighCap); // High risk → D
    }

    return Math.round(Math.max(0, Math.min(100, overall)) * 100) / 100;
  }

  /**
   * Seed the in-memory ring buffer for a given agent/step from persisted
   * AgentEvaluation rows, so that anomaly detection has a baseline even
   * after a process restart and over seeded data. Best-effort: any failure
   * is swallowed (detection then falls back to whatever is in memory).
   *
   * Only seeds once per historyKey (when the buffer is empty / unseeded),
   * to avoid double counting on every evaluation. Loads the most recent
   * rows (excluding the row about to be persisted) for the same
   * (tenant, agentName|stepKey, [stepKey]) series.
   */
  private async seedHistoryFromDb(
    historyKey: string,
    params: {
      tenantId: string;
      agentName?: string;
      stepKey: string;
      workflowKey?: string;
    },
  ): Promise<void> {
    try {
      const existing = this.evaluationHistory.get(historyKey);
      if (existing && existing.total > 0) return; // already populated this run

      const where: any = {
        tenantId: params.tenantId,
        NOT: { workflowKey: { startsWith: 'nodetest-' } },
      };
      if (params.agentName) {
        where.agentName = params.agentName;
      } else {
        where.stepKey = params.stepKey;
      }
      if (params.workflowKey) where.workflowKey = params.workflowKey;

      const rows = await (this.prisma as any).agentEvaluation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: HISTORY_BUFFER_SIZE,
        select: {
          executionTimeMs: true,
          accuracyScore: true,
          tokensUsed: true,
          qualityGrade: true,
        },
      });
      if (!rows || rows.length === 0) return;

      // Replay oldest → newest so the ring buffer ordering matches live writes.
      for (const row of rows.reverse()) {
        this.updateHistory(historyKey, {
          latency: typeof row.executionTimeMs === 'number' ? row.executionTimeMs : undefined,
          // accuracyScore is stored 0..1; updateHistory accepts 0..100 or 0..1
          // (z-score is scale-invariant), so pass through as-is.
          accuracy: typeof row.accuracyScore === 'number' ? row.accuracyScore : undefined,
          tokens: typeof row.tokensUsed === 'number' ? row.tokensUsed : undefined,
          isError: row.qualityGrade === 'F',
        });
      }
    } catch (err) {
      this.logger.warn(`Anomaly history DB seed failed: ${(err as Error).message}`);
    }
  }

  /**
   * Update the in-memory ring buffer for a given agent/step.
   */
  private updateHistory(
    key: string,
    data: {
      latency?: number;
      accuracy?: number;
      tokens?: number;
      isError: boolean;
    },
  ): void {
    if (!this.evaluationHistory.has(key)) {
      this.evaluationHistory.set(key, {
        latencies: [],
        accuracies: [],
        tokens: [],
        errors: 0,
        total: 0,
      });
    }

    const history = this.evaluationHistory.get(key)!;

    if (data.latency !== undefined && data.latency > 0) {
      history.latencies.push(data.latency);
      if (history.latencies.length > HISTORY_BUFFER_SIZE) {
        history.latencies.shift();
      }
    }

    if (data.accuracy !== undefined && data.accuracy > 0) {
      history.accuracies.push(data.accuracy);
      if (history.accuracies.length > HISTORY_BUFFER_SIZE) {
        history.accuracies.shift();
      }
    }

    if (data.tokens !== undefined && data.tokens > 0) {
      history.tokens.push(data.tokens);
      if (history.tokens.length > HISTORY_BUFFER_SIZE) {
        history.tokens.shift();
      }
    }

    if (data.isError) {
      history.errors++;
    }
    history.total++;
  }

  /** Build a unique history key from tenant and agent/step. */
  private buildHistoryKey(tenantId: string, agentOrStep: string): string {
    return `${tenantId}::${agentOrStep}`;
  }

  // ════════════════════════════════════════════════════════════
  // Private: Persistence
  // ════════════════════════════════════════════════════════════

  /**
   * Persist evaluation result to the AgentEvaluation table.
   *
   * @returns The created record ID, or null on failure
   */
  private async persistEvaluation(
    params: {
      tenantId: string;
      executionSessionId: string;
      stepKey: string;
      nodeType: string;
      agentName?: string;
      workflowKey?: string;
      executionTimeMs?: number;
      tokensUsed?: number;
      estimatedCostUsd?: number;
      excludeFromMetrics?: boolean;
    },
    result: EvaluationResult,
  ): Promise<string | null> {
    const resolvedTenantId = await this.resolveTenantId(params.tenantId);

    // Check that the tenant actually exists before attempting to write
    const tenantExists = await (this.prisma as any).tenant.findUnique({
      where: { id: resolvedTenantId },
      select: { id: true },
    });

    if (!tenantExists) {
      this.logger.warn(
        `No valid tenant found for evaluation persistence (tenantId=${params.tenantId}). Skipping DB write.`,
      );
      return null;
    }

    const record = await (this.prisma as any).agentEvaluation.create({
      data: {
        tenantId: resolvedTenantId,
        executionSessionId: params.executionSessionId,
        stepKey: params.stepKey,
        nodeType: params.nodeType,
        agentName: params.agentName || null,
        // 테스트/단독 실행 평가는 workflowKey='nodetest-*' 로 태깅돼 운영 대시보드에서 분리된다.
        workflowKey: params.workflowKey || null,

        // Quality (Gate 1 & 2)
        overallScore: result.overallScore,
        accuracyScore: result.quality.accuracyScore || null,
        completionScore: result.quality.completionScore || null,
        hallucationRate: result.quality.hallucinationRate || null,
        responseQuality: result.quality.responseQuality || null,
        qualityGrade: result.quality.qualityGrade !== 'N/A' ? result.quality.qualityGrade : null,

        // Security (Gate 5)
        securityScore: result.security.securityScore,
        inputThreatCount: result.security.inputThreatCount,
        outputLeakageCount: result.security.outputLeakageCount,
        toolChainRisk: result.security.toolChainRisk,
        securityRiskLevel: result.security.securityRiskLevel,

        // Anomaly (Gate 7)
        anomalyDetected: result.anomaly.anomalyDetected,
        anomalyEvents: result.anomaly.events.length > 0 ? result.anomaly.events : null,

        // Cost (Gate 4)
        executionTimeMs: params.executionTimeMs || null,
        tokensUsed: params.tokensUsed || null,
        estimatedCostUsd: result.cost.costUsd || params.estimatedCostUsd || null,
        costEfficiency: result.cost.costEfficiency || null,
        latencyGrade: result.cost.latencyGrade || null,

        // Metadata
        evaluationEngine: ENGINE_VERSION,
        gatesApplied: result.gatesApplied,
        rawResultJson: {
          quality: result.quality,
          security: result.security,
          cost: result.cost,
          anomaly: result.anomaly,
        },
        recommendations:
          result.cost.recommendations.length > 0 ? result.cost.recommendations : null,
      },
    });

    return record.id;
  }

  // ════════════════════════════════════════════════════════════
  // Private: Policy-violation alarms (Phase 2.3)
  // ════════════════════════════════════════════════════════════

  /**
   * Raise FDSAlert rows when an evaluation violates policy (security risk,
   * quality hard-gate, anomaly). Best-effort: any failure here is logged and
   * swallowed by the caller so it never blocks the evaluation result.
   *
   * Delegates the decision to the pure `evaluateAlarms()` helper, then persists
   * one FDSAlert row per returned alarm draft.
   */
  private async raiseAlarms(
    params: {
      tenantId: string;
      executionSessionId: string;
      stepKey: string;
      agentName?: string;
      workflowKey?: string;
    },
    result: EvaluationResult,
    policy: ResolvedEvaluationPolicy,
  ): Promise<void> {
    const drafts = evaluateAlarms(
      {
        workflowKey: params.workflowKey ?? null,
        stepKey: params.stepKey ?? null,
        agentName: params.agentName ?? null,
        overallScore: result.overallScore,
        securityRiskLevel: result.security.securityRiskLevel ?? null,
        anomalyDetected: result.anomaly.anomalyDetected,
        qualityGrade: result.quality.qualityGrade ?? null,
      },
      {
        qualityHardGateMin: policy.qualityHardGateMin,
        securityAlarmLevel: 'high',
      },
    );

    if (drafts.length === 0) return;

    const correlationId = `eval-alarm-${params.executionSessionId}`;

    for (const draft of drafts) {
      try {
        await (this.prisma as any).fDSAlert.create({
          data: {
            tenantId: params.tenantId,
            severity: draft.severity,
            subjectType: 'AgentEvaluation',
            subjectId: result.recordId ?? params.executionSessionId,
            score: draft.score,
            summary: draft.summary,
            detailsJson: {
              category: draft.category,
              workflowKey: params.workflowKey ?? null,
              stepKey: params.stepKey,
              agentName: params.agentName ?? null,
              overallScore: result.overallScore,
              securityRiskLevel: result.security.securityRiskLevel,
              qualityGrade: result.quality.qualityGrade,
              anomalyDetected: result.anomaly.anomalyDetected,
            } as any,
            correlationId,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to persist policy-violation alarm (${draft.category}): ${(err as Error).message}`,
        );
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // Private: helpers (tenant resolution, stats aggregation)
  // ════════════════════════════════════════════════════════════

  /**
   * Resolve a (possibly slug/legacy) tenant identifier to a real Tenant.id.
   * Falls back to the oldest tenant, then to the input value unchanged.
   */
  private async resolveTenantId(tenantId: string): Promise<string> {
    // C-3 fix: validate the JWT tenantId exists. NEVER fall back to another
    // tenant (that would be a cross-tenant data breach). Throw instead.
    const tenant = await (this.prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (tenant) return tenant.id;
    throw new ForbiddenException('Invalid tenant');
  }

  /** Aggregate a list of AgentEvaluation rows into dashboard statistics. */
  private computeStats(evaluations: any[]): EvalStats {
    const total = evaluations.length;
    if (total === 0) {
      return {
        totalEvaluations: 0,
        avgOverallScore: 0,
        avgAccuracy: 0,
        avgSecurityScore: 0,
        anomalyRate: 0,
        avgCostEfficiency: 0,
        gradeDistribution: {},
      };
    }

    const gradeDistribution: Record<string, number> = {};
    let anomalyCount = 0;
    for (const e of evaluations) {
      const grade = e.qualityGrade || 'N/A';
      gradeDistribution[grade] = (gradeDistribution[grade] || 0) + 1;
      if (e.anomalyDetected) anomalyCount++;
    }

    return {
      totalEvaluations: total,
      avgOverallScore: this.avg(evaluations.map((e) => e.overallScore)),
      avgAccuracy: this.avg(evaluations.map((e) => e.accuracyScore).filter((v: any) => v != null)),
      avgSecurityScore: this.avg(
        evaluations.map((e) => e.securityScore).filter((v: any) => v != null),
      ),
      anomalyRate: total > 0 ? anomalyCount / total : 0,
      avgCostEfficiency: this.avg(
        evaluations.map((e) => e.costEfficiency).filter((v: any) => v != null),
      ),
      gradeDistribution,
    };
  }

  /** Arithmetic mean, rounded to 2 decimals. Returns 0 for an empty list. */
  private avg(nums: number[]): number {
    if (!nums || nums.length === 0) return 0;
    const sum = nums.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
    return Math.round((sum / nums.length) * 100) / 100;
  }

  /**
   * Return the highest-severity risk level from a list of level strings.
   * Order: critical > high > medium > low. Unknown values are ignored.
   */
  private highestRisk(levels: (string | undefined | null)[]): string {
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    let best = 'low';
    let bestRank = -1;
    for (const lvl of levels) {
      const key = (lvl ?? '').toLowerCase();
      if (rank[key] !== undefined && rank[key] > bestRank) {
        bestRank = rank[key];
        best = key;
      }
    }
    return best;
  }
}
