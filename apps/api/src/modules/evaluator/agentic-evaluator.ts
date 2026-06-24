/**
 * Agentic Evaluator — Layer 2 Agentic Metrics
 *
 * Implements four evaluation trackers for multi-agent system behaviour,
 * ported from the Agent Evaluator SDK (Python) to TypeScript for NestJS:
 *
 *   - ToolCallAnalyzer:          tool usage efficiency, redundancy, failure rates
 *   - WorkflowExecutionTracker:  step success rates, bottleneck detection, recommendations
 *   - AgentCoordinationTracker:  coordination scoring, topology detection, role inference
 *   - RetryCorrectionTracker:    retry rates, correction success, error categorisation
 *
 * All constants and algorithms are aligned with the SDK reference implementation.
 *
 * @module evaluator
 */
import { Injectable, Logger } from '@nestjs/common';

// ═══════════════════════════════════════════
//  SDK Constants — Coordination Scoring
// ═══════════════════════════════════════════

/** Coordination score component weights (from SDK) */
const COORDINATION_WEIGHTS = {
  SUCCESS: 0.5,
  DIVERSITY: 0.3,
  BALANCE: 0.2,
} as const;

/** Ideal benchmarks for diversity scoring */
const IDEAL_AGENT_COUNT = 5;
const IDEAL_INTERACTION_TYPES = 3;

/** Score scale for coordination scoring */
const COORDINATION_SCORE_SCALE = 10;

/** Topology detection thresholds */
const HUB_THRESHOLD = 0.5;
const CHAIN_RATIO = 0.7;
const MESH_DENSITY_THRESHOLD = 0.5;

/** Role inference thresholds */
const PRODUCER_RATIO = 0.7;
const CONSUMER_RATIO = 0.3;

// ═══════════════════════════════════════════
//  SDK Constants — Interaction Type Aliases
// ═══════════════════════════════════════════

/** Normalised interaction type aliases from SDK */
const INTERACTION_TYPE_ALIASES: Record<string, string> = {
  task_delegation: 'delegation',
  result_sharing: 'communication',
  feedback: 'communication',
  status_update: 'communication',
  error_report: 'communication',
  data_request: 'query',
  data_response: 'query',
  coordination: 'delegation',
  handoff: 'delegation',
};

// ═══════════════════════════════════════════
//  SDK Constants — Error Categories
// ═══════════════════════════════════════════

/** Map from error class names / substrings to canonical categories */
const ERROR_CATEGORY_MAP: Record<string, string> = {
  RateLimitError: 'rate_limit',
  TimeoutError: 'timeout',
  ToolException: 'tool_failure',
  ValidationError: 'validation',
  AuthenticationError: 'authentication',
  PermissionError: 'permission',
  ConnectionError: 'connection',
  NetworkError: 'connection',
  NotFoundError: 'not_found',
  ParseError: 'parsing',
  InternalError: 'internal',
};

@Injectable()
export class AgenticEvaluator {
  private readonly logger = new Logger(AgenticEvaluator.name);

  // ═══════════════════════════════════════════
  //  ToolCallAnalyzer
  // ═══════════════════════════════════════════

  /**
   * Evaluate a sequence of tool calls for efficiency, redundancy, and reliability.
   *
   * Metrics produced:
   *   - totalCalls / uniqueTools / redundantCalls / failedCalls
   *   - avgDurationMs — average execution time across all calls
   *   - efficiencyScore — ratio of unique tools to total calls (null if empty)
   *   - successRate / redundancyRate / failureRate (0-100 each)
   *
   * A call is considered "redundant" when the same tool name + serialised
   * parameter set has already been seen in the sequence.
   *
   * @param toolCalls - Ordered list of tool invocations
   * @returns Aggregated tool-call metrics
   */
  evaluateToolCalls(
    toolCalls: Array<{
      name: string;
      parameters?: any;
      success?: boolean;
      durationMs?: number;
    }>,
  ): {
    totalCalls: number;
    uniqueTools: number;
    redundantCalls: number;
    failedCalls: number;
    avgDurationMs: number;
    efficiencyScore: number | null;
    successRate: number;
    redundancyRate: number;
    failureRate: number;
  } {
    if (!toolCalls || toolCalls.length === 0) {
      return {
        totalCalls: 0,
        uniqueTools: 0,
        redundantCalls: 0,
        failedCalls: 0,
        avgDurationMs: 0,
        efficiencyScore: null,
        successRate: 0,
        redundancyRate: 0,
        failureRate: 0,
      };
    }

    const totalCalls = toolCalls.length;
    const uniqueToolNames = new Set(toolCalls.map((tc) => tc.name));
    const uniqueTools = uniqueToolNames.size;

    // Detect redundant calls — same name + same serialised parameters
    const seen = new Set<string>();
    let redundantCalls = 0;
    for (const tc of toolCalls) {
      const key = `${tc.name}::${this.stableSerialise(tc.parameters)}`;
      if (seen.has(key)) {
        redundantCalls++;
      } else {
        seen.add(key);
      }
    }

    // Count failures (default to success if not specified)
    const failedCalls = toolCalls.filter((tc) => tc.success === false).length;

    // Average duration (only from calls that report a duration)
    const durations = toolCalls
      .filter((tc) => tc.durationMs !== undefined && tc.durationMs !== null)
      .map((tc) => tc.durationMs!);
    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

    // Efficiency: unique / total (null when no calls)
    const efficiencyScore =
      totalCalls > 0 ? Math.round((uniqueTools / totalCalls) * 10000) / 10000 : null;

    // Rates as percentages (0-100)
    const successRate = Math.round(((totalCalls - failedCalls) / totalCalls) * 10000) / 100;
    const redundancyRate = Math.round((redundantCalls / totalCalls) * 10000) / 100;
    const failureRate = Math.round((failedCalls / totalCalls) * 10000) / 100;

    this.logger.debug(
      `ToolCalls: total=${totalCalls}, unique=${uniqueTools}, redundant=${redundantCalls}, ` +
        `failed=${failedCalls}, avgMs=${avgDurationMs}, efficiency=${efficiencyScore}`,
    );

    return {
      totalCalls,
      uniqueTools,
      redundantCalls,
      failedCalls,
      avgDurationMs,
      efficiencyScore,
      successRate,
      redundancyRate,
      failureRate,
    };
  }

  // ═══════════════════════════════════════════
  //  WorkflowExecutionTracker
  // ═══════════════════════════════════════════

  /**
   * Evaluate a workflow execution for step success rates and bottlenecks.
   *
   * A step is a bottleneck when its average execution time exceeds
   * the global average by more than 2x, or its individual success rate
   * falls below the overall step success rate.
   *
   * Recommendations are generated based on detected issues:
   *   - Low overall success rate (< 80%)
   *   - Identified bottleneck steps
   *   - Steps without duration data
   *
   * @param steps - Ordered list of workflow step executions
   * @returns Workflow metrics, bottlenecks, and actionable recommendations
   */
  evaluateWorkflow(
    steps: Array<{
      name: string;
      type?: string;
      success: boolean;
      durationMs?: number;
    }>,
  ): {
    totalSteps: number;
    successfulSteps: number;
    stepSuccessRate: number;
    bottlenecks: Array<{ name: string; avgTimeMs: number; successRate: number }>;
    recommendations: string[];
  } {
    if (!steps || steps.length === 0) {
      return {
        totalSteps: 0,
        successfulSteps: 0,
        stepSuccessRate: 0,
        bottlenecks: [],
        recommendations: [],
      };
    }

    const totalSteps = steps.length;
    const successfulSteps = steps.filter((s) => s.success).length;
    const stepSuccessRate = Math.round((successfulSteps / totalSteps) * 10000) / 100;

    // ── Group steps by name for bottleneck analysis ──
    const stepGroups = new Map<string, { durations: number[]; successes: number; total: number }>();

    for (const step of steps) {
      const group = stepGroups.get(step.name) ?? {
        durations: [],
        successes: 0,
        total: 0,
      };
      group.total++;
      if (step.success) group.successes++;
      if (step.durationMs !== undefined && step.durationMs !== null) {
        group.durations.push(step.durationMs);
      }
      stepGroups.set(step.name, group);
    }

    // Compute global average duration
    const allDurations = steps
      .filter((s) => s.durationMs !== undefined && s.durationMs !== null)
      .map((s) => s.durationMs!);
    const globalAvgMs =
      allDurations.length > 0 ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : 0;

    // ── Identify bottlenecks ──
    const bottlenecks: Array<{ name: string; avgTimeMs: number; successRate: number }> = [];

    for (const [name, group] of stepGroups) {
      const groupAvgMs =
        group.durations.length > 0
          ? group.durations.reduce((a, b) => a + b, 0) / group.durations.length
          : 0;
      const groupSuccessRate = group.total > 0 ? (group.successes / group.total) * 100 : 0;

      const isSlow = globalAvgMs > 0 && groupAvgMs > globalAvgMs * 2;
      const isUnreliable = groupSuccessRate < stepSuccessRate;

      if (isSlow || isUnreliable) {
        bottlenecks.push({
          name,
          avgTimeMs: Math.round(groupAvgMs),
          successRate: Math.round(groupSuccessRate * 100) / 100,
        });
      }
    }

    // Sort bottlenecks by success rate ascending (worst first)
    bottlenecks.sort((a, b) => a.successRate - b.successRate);

    // ── Generate recommendations ──
    const recommendations: string[] = [];

    if (stepSuccessRate < 80) {
      recommendations.push(
        `Overall step success rate is ${stepSuccessRate}% (below 80% threshold). ` +
          `Investigate failing steps and add retry logic or fallback handlers.`,
      );
    }

    for (const bn of bottlenecks) {
      if (bn.avgTimeMs > globalAvgMs * 2 && globalAvgMs > 0) {
        recommendations.push(
          `Step "${bn.name}" is a performance bottleneck ` +
            `(${bn.avgTimeMs}ms avg vs ${Math.round(globalAvgMs)}ms global avg). ` +
            `Consider caching, parallelisation, or timeout reduction.`,
        );
      }
      if (bn.successRate < stepSuccessRate) {
        recommendations.push(
          `Step "${bn.name}" has a low success rate of ${bn.successRate}%. ` +
            `Add error handling, input validation, or circuit breakers.`,
        );
      }
    }

    if (allDurations.length < totalSteps) {
      const missing = totalSteps - allDurations.length;
      recommendations.push(
        `${missing} step(s) lack duration data. ` +
          `Instrument all steps with timing to enable accurate bottleneck detection.`,
      );
    }

    this.logger.debug(
      `Workflow: total=${totalSteps}, success=${successfulSteps}, rate=${stepSuccessRate}%, ` +
        `bottlenecks=${bottlenecks.length}, recommendations=${recommendations.length}`,
    );

    return {
      totalSteps,
      successfulSteps,
      stepSuccessRate,
      bottlenecks,
      recommendations,
    };
  }

  // ═══════════════════════════════════════════
  //  AgentCoordinationTracker
  // ═══════════════════════════════════════════

  /**
   * Evaluate inter-agent coordination quality and detect communication topology.
   *
   * Scoring (0-10 scale) is a weighted composite of:
   *   - Success rate of interactions (weight 0.5)
   *   - Diversity of agents and interaction types (weight 0.3)
   *   - Balance of interaction distribution across agents (weight 0.2)
   *
   * Topology detection:
   *   - hub:   a single agent participates in > 50% of all interactions
   *   - chain: > 70% of interactions are sequential (A→B, B→C, ...)
   *   - mesh:  network density exceeds 0.5
   *   - unknown: none of the above patterns detected
   *
   * Role inference:
   *   - producer:    outgoing / total > 0.7
   *   - consumer:    outgoing / total < 0.3
   *   - coordinator: participates in > 50% of interactions
   *   - inactive:    no interactions at all
   *
   * @param interactions - List of agent-to-agent interactions
   * @returns Coordination score, detected pattern, agent roles, network density
   */
  evaluateCoordination(
    interactions: Array<{
      from: string;
      to: string;
      type: string;
      success: boolean;
    }>,
  ): {
    coordinationScore: number;
    pattern: 'hub' | 'chain' | 'mesh' | 'unknown';
    patternConfidence: number;
    agentRoles: Record<string, 'producer' | 'consumer' | 'coordinator' | 'inactive'>;
    networkDensity: number;
  } {
    if (!interactions || interactions.length === 0) {
      return {
        coordinationScore: 0,
        pattern: 'unknown',
        patternConfidence: 0,
        agentRoles: {},
        networkDensity: 0,
      };
    }

    // ── Normalise interaction types ──
    const normalised = interactions.map((i) => ({
      ...i,
      type: INTERACTION_TYPE_ALIASES[i.type] ?? i.type,
    }));

    const totalInteractions = normalised.length;

    // ── Collect agent sets ──
    const allAgents = new Set<string>();
    for (const i of normalised) {
      allAgents.add(i.from);
      allAgents.add(i.to);
    }
    const agentCount = allAgents.size;

    // Unique interaction types after normalisation
    const uniqueTypes = new Set(normalised.map((i) => i.type));

    // ── Success component (weight 0.5) ──
    const successCount = normalised.filter((i) => i.success).length;
    const successRate = successCount / totalInteractions;

    // ── Diversity component (weight 0.3) ──
    const agentDiversity = Math.min(agentCount / IDEAL_AGENT_COUNT, 1);
    const typeDiversity = Math.min(uniqueTypes.size / IDEAL_INTERACTION_TYPES, 1);
    const diversityScore = (agentDiversity + typeDiversity) / 2;

    // ── Balance component (weight 0.2) ──
    // Measure how evenly interactions are distributed across agents
    const agentParticipation = new Map<string, number>();
    for (const i of normalised) {
      agentParticipation.set(i.from, (agentParticipation.get(i.from) ?? 0) + 1);
      agentParticipation.set(i.to, (agentParticipation.get(i.to) ?? 0) + 1);
    }

    let balanceScore = 1;
    if (agentCount > 1) {
      const counts = Array.from(agentParticipation.values());
      const maxCount = Math.max(...counts);
      const minCount = Math.min(...counts);
      const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
      // Balance is 1 when perfectly even, approaches 0 with extreme imbalance
      balanceScore = avgCount > 0 ? 1 - (maxCount - minCount) / (maxCount + minCount) : 0;
    }

    // ── Composite score ──
    const rawScore =
      successRate * COORDINATION_WEIGHTS.SUCCESS +
      diversityScore * COORDINATION_WEIGHTS.DIVERSITY +
      balanceScore * COORDINATION_WEIGHTS.BALANCE;

    const coordinationScore = Math.round(rawScore * COORDINATION_SCORE_SCALE * 100) / 100;

    // ── Network density ──
    // density = actual edges / possible edges (directed graph)
    const uniqueEdges = new Set(normalised.map((i) => `${i.from}→${i.to}`));
    const possibleEdges = agentCount * (agentCount - 1);
    const networkDensity =
      possibleEdges > 0 ? Math.round((uniqueEdges.size / possibleEdges) * 10000) / 10000 : 0;

    // ── Topology detection ──
    const { pattern, patternConfidence } = this.detectTopology(
      normalised,
      agentParticipation,
      totalInteractions,
      agentCount,
      networkDensity,
    );

    // ── Role inference ──
    const agentRoles = this.inferAgentRoles(
      normalised,
      allAgents,
      agentParticipation,
      totalInteractions,
    );

    this.logger.debug(
      `Coordination: score=${coordinationScore}, pattern=${pattern} (${patternConfidence}%), ` +
        `agents=${agentCount}, density=${networkDensity}, successRate=${(successRate * 100).toFixed(1)}%`,
    );

    return {
      coordinationScore,
      pattern,
      patternConfidence,
      agentRoles,
      networkDensity,
    };
  }

  // ═══════════════════════════════════════════
  //  RetryCorrectionTracker
  // ═══════════════════════════════════════════

  /**
   * Evaluate retry behaviour and correction effectiveness across task attempts.
   *
   * Metrics:
   *   - retryRate:              percentage of tasks that required > 1 attempt
   *   - firstAttemptSuccessRate: percentage of tasks that succeeded on attempt 1
   *   - eventualSuccessRate:    percentage of tasks that eventually succeeded
   *   - correctionSuccessRate:  percentage of retried tasks that eventually succeeded
   *   - avgRetriesPerTask:      average number of attempts per task
   *   - errorCategories:        aggregated error counts by canonical category
   *
   * Error categories are normalised via substring matching against the SDK
   * error class name map (e.g., "RateLimitError" → "rate_limit").
   *
   * @param attempts - List of task attempt records (grouped by taskId)
   * @returns Retry metrics and error categorisation
   */
  evaluateRetries(
    attempts: Array<{
      taskId: string;
      attemptNumber: number;
      success: boolean;
      error?: string;
      durationMs?: number;
    }>,
  ): {
    retryRate: number;
    firstAttemptSuccessRate: number;
    eventualSuccessRate: number;
    correctionSuccessRate: number;
    avgRetriesPerTask: number;
    errorCategories: Record<string, number>;
  } {
    if (!attempts || attempts.length === 0) {
      return {
        retryRate: 0,
        firstAttemptSuccessRate: 0,
        eventualSuccessRate: 0,
        correctionSuccessRate: 0,
        avgRetriesPerTask: 0,
        errorCategories: {},
      };
    }

    // ── Group attempts by taskId ──
    const taskMap = new Map<
      string,
      Array<{ attemptNumber: number; success: boolean; error?: string }>
    >();

    for (const attempt of attempts) {
      const list = taskMap.get(attempt.taskId) ?? [];
      list.push({
        attemptNumber: attempt.attemptNumber,
        success: attempt.success,
        error: attempt.error,
      });
      taskMap.set(attempt.taskId, list);
    }

    const totalTasks = taskMap.size;
    let firstAttemptSuccesses = 0;
    let eventualSuccesses = 0;
    let retriedTasks = 0;
    let retriedAndSucceeded = 0;
    let totalAttempts = 0;

    for (const [, taskAttempts] of taskMap) {
      // Sort by attempt number to determine first attempt
      const sorted = [...taskAttempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
      totalAttempts += sorted.length;

      const firstAttempt = sorted[0];
      const hasRetries = sorted.length > 1;
      const anySuccess = sorted.some((a) => a.success);

      if (firstAttempt.success) {
        firstAttemptSuccesses++;
      }

      if (anySuccess) {
        eventualSuccesses++;
      }

      if (hasRetries) {
        retriedTasks++;
        if (anySuccess) {
          retriedAndSucceeded++;
        }
      }
    }

    // ── Compute rates ──
    const retryRate = Math.round((retriedTasks / totalTasks) * 10000) / 100;
    const firstAttemptSuccessRate = Math.round((firstAttemptSuccesses / totalTasks) * 10000) / 100;
    const eventualSuccessRate = Math.round((eventualSuccesses / totalTasks) * 10000) / 100;
    const correctionSuccessRate =
      retriedTasks > 0 ? Math.round((retriedAndSucceeded / retriedTasks) * 10000) / 100 : 0;
    const avgRetriesPerTask = Math.round((totalAttempts / totalTasks) * 100) / 100;

    // ── Categorise errors ──
    const errorCategories: Record<string, number> = {};

    for (const attempt of attempts) {
      if (attempt.error) {
        const category = this.categoriseError(attempt.error);
        errorCategories[category] = (errorCategories[category] ?? 0) + 1;
      }
    }

    this.logger.debug(
      `Retries: tasks=${totalTasks}, retryRate=${retryRate}%, firstSuccess=${firstAttemptSuccessRate}%, ` +
        `eventual=${eventualSuccessRate}%, correction=${correctionSuccessRate}%, ` +
        `avgRetries=${avgRetriesPerTask}, errorTypes=${Object.keys(errorCategories).length}`,
    );

    return {
      retryRate,
      firstAttemptSuccessRate,
      eventualSuccessRate,
      correctionSuccessRate,
      avgRetriesPerTask,
      errorCategories,
    };
  }

  // ═══════════════════════════════════════════
  //  Private: Topology Detection
  // ═══════════════════════════════════════════

  /**
   * Detect the communication topology pattern from interaction data.
   *
   * Detection rules (evaluated in priority order):
   *   1. Hub — a single agent participates in > hubThreshold of all interactions.
   *            For 3+ agents the threshold is dynamically computed as max(0.5, 1/agentCount + 0.2).
   *   2. Chain — > 70% of interactions form sequential pairs (A→B, B→C, ...).
   *   3. Mesh — network density exceeds 0.5.
   *   4. Unknown — no pattern matched.
   */
  private detectTopology(
    interactions: Array<{ from: string; to: string; type: string; success: boolean }>,
    agentParticipation: Map<string, number>,
    totalInteractions: number,
    agentCount: number,
    networkDensity: number,
  ): { pattern: 'hub' | 'chain' | 'mesh' | 'unknown'; patternConfidence: number } {
    // ── Hub detection ──
    const dynamicHubThreshold =
      agentCount >= 3 ? Math.max(HUB_THRESHOLD, 1 / agentCount + 0.2) : HUB_THRESHOLD;

    let maxParticipation = 0;
    for (const count of agentParticipation.values()) {
      // Each interaction involves 2 agents, so total participation slots = totalInteractions * 2
      const ratio = count / (totalInteractions * 2);
      if (ratio > maxParticipation) {
        maxParticipation = ratio;
      }
    }

    // Alternative: check against raw interaction count (agent appears in from OR to)
    for (const [agent] of agentParticipation) {
      const involvedCount = interactions.filter((i) => i.from === agent || i.to === agent).length;
      const ratio = involvedCount / totalInteractions;
      if (ratio > dynamicHubThreshold) {
        const confidence = Math.round(Math.min(100, ratio * 100));
        return { pattern: 'hub', patternConfidence: confidence };
      }
    }

    // ── Chain detection ──
    // Count sequential pairs: interaction N's "to" === interaction N+1's "from"
    let chainPairs = 0;
    for (let i = 0; i < interactions.length - 1; i++) {
      if (interactions[i].to === interactions[i + 1].from) {
        chainPairs++;
      }
    }
    const chainRatio = interactions.length > 1 ? chainPairs / (interactions.length - 1) : 0;

    if (chainRatio >= CHAIN_RATIO) {
      const confidence = Math.round(Math.min(100, chainRatio * 100));
      return { pattern: 'chain', patternConfidence: confidence };
    }

    // ── Mesh detection ──
    if (networkDensity >= MESH_DENSITY_THRESHOLD) {
      const confidence = Math.round(Math.min(100, networkDensity * 100));
      return { pattern: 'mesh', patternConfidence: confidence };
    }

    // ── Unknown ──
    return { pattern: 'unknown', patternConfidence: 0 };
  }

  // ═══════════════════════════════════════════
  //  Private: Agent Role Inference
  // ═══════════════════════════════════════════

  /**
   * Infer the role of each agent based on their interaction direction ratio.
   *
   *   - producer:    outgoing ratio > 0.7
   *   - consumer:    outgoing ratio < 0.3
   *   - coordinator: participates in > 50% of all interactions
   *   - inactive:    no interactions observed (edge case for enumerated agents)
   */
  private inferAgentRoles(
    interactions: Array<{ from: string; to: string }>,
    allAgents: Set<string>,
    agentParticipation: Map<string, number>,
    totalInteractions: number,
  ): Record<string, 'producer' | 'consumer' | 'coordinator' | 'inactive'> {
    const roles: Record<string, 'producer' | 'consumer' | 'coordinator' | 'inactive'> = {};

    for (const agent of allAgents) {
      const outgoing = interactions.filter((i) => i.from === agent).length;
      const incoming = interactions.filter((i) => i.to === agent).length;
      const total = outgoing + incoming;

      if (total === 0) {
        roles[agent] = 'inactive';
        continue;
      }

      // Check coordinator first (participates in > 50% of interactions)
      const participationCount = interactions.filter(
        (i) => i.from === agent || i.to === agent,
      ).length;
      if (participationCount / totalInteractions > HUB_THRESHOLD) {
        roles[agent] = 'coordinator';
        continue;
      }

      const outgoingRatio = outgoing / total;

      if (outgoingRatio > PRODUCER_RATIO) {
        roles[agent] = 'producer';
      } else if (outgoingRatio < CONSUMER_RATIO) {
        roles[agent] = 'consumer';
      } else {
        // Balanced — default to producer if slightly more outgoing, else consumer
        roles[agent] = outgoingRatio >= 0.5 ? 'producer' : 'consumer';
      }
    }

    return roles;
  }

  // ═══════════════════════════════════════════
  //  Private: Error Categorisation
  // ═══════════════════════════════════════════

  /**
   * Map an error message / class name to a canonical error category.
   *
   * Uses substring matching against the SDK error class name map.
   * Falls back to "unknown" if no match is found.
   */
  private categoriseError(error: string): string {
    for (const [key, category] of Object.entries(ERROR_CATEGORY_MAP)) {
      if (error.includes(key)) {
        return category;
      }
    }
    return 'unknown';
  }

  // ═══════════════════════════════════════════
  //  Private: Stable Serialisation
  // ═══════════════════════════════════════════

  /**
   * Produce a stable JSON string for parameter comparison.
   * Sorts object keys to ensure deterministic output.
   */
  private stableSerialise(value: any): string {
    if (value === undefined || value === null) return '';
    try {
      return JSON.stringify(value, Object.keys(value ?? {}).sort());
    } catch {
      return String(value);
    }
  }
}
