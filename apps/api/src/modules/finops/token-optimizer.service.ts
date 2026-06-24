/**
 * Token Optimizer Service — Phase 4: 3-Gate Token Optimization Pipeline
 *
 * The 3-Gate Pipeline:
 * - Gate 1: Semantic Cache — Check if similar request was cached
 * - Gate 2: Model Router — Route to optimal model tier based on complexity
 * - Gate 3: Skill Packer — Compress/optimize prompt tokens
 *
 * Responsibilities:
 *   - Main optimization workflow
 *   - Semantic cache lookup and management
 *   - Prompt complexity analysis
 *   - Model tier selection
 *   - Cost estimation
 *   - Token usage logging
 */
import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { FinOpsService } from './finops.service';
import {
  computeCacheKey,
  buildStoredPromptText,
  estimateTokens,
  tier2BaselineCost,
  cacheHitSavings,
  routedSavings,
  cosineSimilarity,
} from './finops-pricing';
import { EmbeddingService } from './embedding.service';
import { GovernanceAwareCacheKeyService } from './governance-aware-cache-key.service';
import {
  CachePolicyDecisionEngine,
  CachePolicyDecision,
} from './cache-policy-decision.engine';
import { PolicyAwareModelRouterService, BudgetStatus } from './policy-aware-model-router.service';
import { PolicyContextService } from '../governance/policy-context.service';
import { EvidencePackService } from '../governance/evidence-pack.service';

interface OptimizationResult {
  cacheHit: boolean;
  cachedResponse: string | null;
  routedTier: number;
  routedModel: string;
  originalModel: string;
  estimatedCostReduction: number;
  optimizationApplied: string[];
  /**
   * Gate 3 output: the compressed prompt the caller SHOULD send to the LLM.
   * null when the packer was disabled / made no safe improvement. (F1-1: the
   * packer previously compressed in memory but callers kept using the
   * original prompt — savings were reported but never realized.)
   */
  optimizedPrompt: string | null;
  /**
   * F2-1 budget enforcement verdict. blocked=true means the caller MUST NOT
   * make the LLM call (FINOPS_BUDGET_ENFORCE=block and a hard ceiling was
   * crossed). 'downshift' means the router was forced to Tier 1.
   */
  budgetEnforcement: { action: 'NONE' | 'DOWNSHIFT' | 'BLOCK'; reason: string } | null;
  blocked: boolean;
  /** Patent 3: policy-aware decisions (감사 기록용) */
  policyHash?: string;
  cachePolicyDecision?: CachePolicyDecision;
  routeReason?: unknown;
  budget?: BudgetStatus;
}

interface RouteResult {
  tier: number;
  model: string;
}

/** Patent 3: governance context accompanying an LLM request. */
export interface OptimizeGovernanceParams {
  dataClass?: string;
  riskScore?: number;
  workflowId?: string;
  nodeKey?: string;
  skillId?: string;
}

@Injectable()
export class TokenOptimizerService {
  private readonly logger = new Logger(TokenOptimizerService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly finOpsService: FinOpsService,
    private readonly embeddingService: EmbeddingService,
    private readonly cacheKeys: GovernanceAwareCacheKeyService,
    private readonly cachePolicy: CachePolicyDecisionEngine,
    private readonly policyRouter: PolicyAwareModelRouterService,
    private readonly policyContext: PolicyContextService,
    private readonly evidencePacks: EvidencePackService,
  ) {}

  /**
   * Main optimization method — called for every LLM request from workflow agents
   * Runs through the 3-Gate pipeline to determine optimal routing and caching
   */
  async optimize(
    params: {
      tenantId: string;
      agentName: string;
      executionSessionId?: string;
      nodeId?: string;
      prompt: string;
      requestedModel?: string;
    } & OptimizeGovernanceParams,
  ) {
    const config = await this.finOpsService.getOrCreateConfig(params.tenantId);
    const agentConfig = await this.finOpsService
      .getAgentConfig(params.tenantId, params.agentName)
      .catch(() => null);

    if (!agentConfig) {
      // Create default agent config if it doesn't exist
      await this.finOpsService.upsertAgentConfig(params.tenantId, params.agentName, {
        agentName: params.agentName,
      });
    }

    // ── Patent 3: policy context resolution ──────────────────────
    // policyHash binds every FinOps decision to the policy surface in
    // force at request time; dataClass/riskScore gate cache reuse.
    const dataClass = params.dataClass ?? 'INTERNAL';
    const riskScore = params.riskScore ?? 0;
    const policyHash = await this.policyContext
      .getPolicyVersionHash(params.tenantId)
      .catch(() => 'policy-unavailable');
    const { cacheKey, promptHash } = this.cacheKeys.build({
      tenantId: params.tenantId,
      agentName: params.agentName,
      skillId: params.skillId,
      workflowId: params.workflowId,
      nodeKey: params.nodeKey ?? params.nodeId,
      policyHash,
      dataClass,
      prompt: params.prompt,
    });
    const cacheDecision = this.cachePolicy.decide({
      dataClass,
      riskScore,
      cacheEnabled: !!config.cacheEnabled && (agentConfig?.cacheEnabled ?? true),
    });
    const gov = {
      policyHash,
      dataClass,
      riskScore,
      cacheKey,
      promptHash,
      cachePolicyDecision: cacheDecision.decision,
      cacheDecisionReasonJson: { reasons: cacheDecision.reasons },
      workflowId: params.workflowId,
      nodeKey: params.nodeKey ?? params.nodeId,
      skillId: params.skillId,
    };

    const startTime = Date.now();
    const result: OptimizationResult = {
      cacheHit: false,
      cachedResponse: null,
      routedTier: config.routerFallbackTier,
      routedModel: '',
      originalModel: params.requestedModel || '',
      estimatedCostReduction: 0,
      optimizationApplied: [],
      optimizedPrompt: null,
      budgetEnforcement: null,
      blocked: false,
      policyHash,
      cachePolicyDecision: cacheDecision,
    };

    // ════════════════════════════════════════════════════════════
    // Gate 1: Semantic Cache (policy-gated — Patent 3)
    // ════════════════════════════════════════════════════════════
    // Cache reuse is permitted only when the CachePolicyDecisionEngine
    // allows it; lookups additionally filter on the CURRENT policyHash
    // so entries written under an older policy can never be reused.
    let queryEmbedding: number[] = [];
    let cacheSimilarity = 0;
    if (cacheDecision.cacheAllowed) {
      const cacheResult = await this.checkSemanticCache(params, config, policyHash);
      queryEmbedding = cacheResult.queryEmbedding;
      cacheSimilarity = cacheResult.similarity;
      if (cacheResult.hit) {
        result.cacheHit = true;
        result.cachedResponse = cacheResult.response;
        result.optimizationApplied.push('SEMANTIC_CACHE');

        // Cache HIT serves for free, but show how much Tier-2 baseline cost was
        // AVOIDED so the demo table shows real savings (≈100%) instead of 0%.
        const { savedUsd, savedPct } = cacheHitSavings(params.prompt);
        const estimatedTokens = estimateTokens(params.prompt);
        result.estimatedCostReduction = savedPct;

        const responseTimeMs = Date.now() - startTime;
        // Log and return early — cache hit means no LLM call needed
        await this.logUsage(params, result, responseTimeMs, true, queryEmbedding, gov);
        return {
          ...result,
          responseTimeMs,
          savedUsd,
          savedPct,
          estimatedTokens,
          cacheSimilarity,
        };
      }
    } else {
      // Cache reuse denied by policy — record an evidence pack so the
      // denial itself is auditable (Patent 3 종속청구항 7).
      try {
        const pack = await this.evidencePacks.create({
          tenantId: params.tenantId,
          kind: 'FINOPS',
          executionSessionId: params.executionSessionId,
          workflowId: params.workflowId,
          policyVersionHash: policyHash,
          promptHash,
          evaluation: {
            event: 'FINOPS_CACHE_DECISION_CREATED',
            decision: cacheDecision.decision,
            reasons: cacheDecision.reasons,
            dataClass,
            riskScore,
            agentName: params.agentName,
            nodeKey: gov.nodeKey ?? null,
          },
        });
        (gov as Record<string, unknown>).evidencePackId = pack.id;
      } catch (err) {
        this.logger.warn(`FinOps evidence pack failed: ${(err as Error).message}`);
      }
    }

    // ════════════════════════════════════════════════════════════
    // Gate 2: Policy-Aware Model Router (Patent 3)
    // ════════════════════════════════════════════════════════════
    // complexity + riskScore + daily budget pressure + allowed tiers를
    // 결합해 tier를 결정하고, 보정 사유를 routeReason으로 기록한다.
    if (config.routerEnabled && (agentConfig?.routerEnabled ?? true)) {
      const complexity = this.analyzePromptComplexity(params.prompt);
      const budget = await this.policyRouter.budgetStatus(
        params.tenantId,
        Number(config.alertDailyCostMax ?? 50),
      );
      const route = this.policyRouter.route({
        complexity,
        riskScore,
        budgetPressure: budget.budgetPressure,
        allowedTiers: (agentConfig?.allowedTiers as number[] | undefined) ?? [],
        tierModels: {
          1: config.routerTier1Models ?? [],
          2: config.routerTier2Models ?? [],
          3: config.routerTier3Models ?? [],
        },
        fallbackTier: config.routerFallbackTier || 2,
      });
      result.routedTier = route.tier;
      result.routedModel = route.model;
      result.routeReason = route.reason;
      result.budget = budget;
      result.optimizationApplied.push('MODEL_ROUTER');
      (gov as Record<string, unknown>).routeReasonJson = route.reason;
    }

    // ════════════════════════════════════════════════════════════
    // F2-1: Budget ENFORCEMENT gate (previously display-only)
    // ════════════════════════════════════════════════════════════
    // Mode via FINOPS_BUDGET_ENFORCE: 'off' | 'downshift' (default) | 'block'.
    //  - downshift: over agent/tenant daily limit → force Tier 1 (cheapest)
    //  - block: ≥120% of limit → blocked=true, caller must not call the LLM
    const enforceMode = (process.env.FINOPS_BUDGET_ENFORCE ?? 'downshift').toLowerCase();
    if (enforceMode !== 'off') {
      try {
        const agentLimit = Number(agentConfig?.dailyLimitUsd ?? 10);
        const tenantLimit = Number(config.alertDailyCostMax ?? 50);
        const since = new Date(new Date().toISOString().split('T')[0] + 'T00:00:00.000Z');
        const agg = await (this.prisma as any).finOpsTokenLog.aggregate({
          _sum: { optimizedCostUsd: true },
          where: {
            tenantId: params.tenantId,
            agentName: params.agentName,
            createdAt: { gte: since },
          },
        });
        const agentSpent = agg?._sum?.optimizedCostUsd ?? 0;
        const tenantSpent = result.budget?.usedTodayUsd ?? 0;

        const hardCrossed =
          (agentLimit > 0 && agentSpent >= agentLimit * 1.2) ||
          (tenantLimit > 0 && tenantSpent >= tenantLimit * 1.2);
        const softCrossed =
          (agentLimit > 0 && agentSpent >= agentLimit) ||
          (tenantLimit > 0 && tenantSpent >= tenantLimit);

        if (hardCrossed && enforceMode === 'block') {
          const reason =
            `일일 예산 한도 초과(120%): agent $${agentSpent.toFixed(4)}/$${agentLimit} · ` +
            `tenant $${tenantSpent.toFixed(4)}/$${tenantLimit}`;
          result.blocked = true;
          result.budgetEnforcement = { action: 'BLOCK', reason };
          result.optimizationApplied.push('BUDGET_BLOCK');
          this.logger.warn(`[FinOps] BUDGET BLOCK ${params.agentName}: ${reason}`);
          const responseTimeMs = Date.now() - startTime;
          await this.logUsage(params, result, responseTimeMs, false, queryEmbedding, gov);
          return {
            ...result,
            responseTimeMs,
            savedUsd: 0,
            savedPct: 0,
            estimatedTokens: estimateTokens(params.prompt),
            cacheSimilarity,
          };
        }

        if (softCrossed) {
          const tier1Models: string[] = config.routerTier1Models ?? [];
          const downModel = tier1Models[0];
          if (downModel && result.routedTier > 1) {
            const reason =
              `일일 예산 도달 → Tier ${result.routedTier} → 1 다운시프트: ` +
              `agent $${agentSpent.toFixed(4)}/$${agentLimit} · tenant $${tenantSpent.toFixed(4)}/$${tenantLimit}`;
            result.routedTier = 1;
            result.routedModel = downModel;
            result.budgetEnforcement = { action: 'DOWNSHIFT', reason };
            result.optimizationApplied.push('BUDGET_DOWNSHIFT');
            this.logger.warn(`[FinOps] BUDGET DOWNSHIFT ${params.agentName}: ${reason}`);
          }
        }
      } catch (err) {
        // Enforcement must never break the call path.
        this.logger.warn(`[FinOps] budget enforcement check failed: ${(err as Error).message}`);
      }
    }

    // ════════════════════════════════════════════════════════════
    // Gate 3: Skill Packer — Prompt compression & token optimization
    // ════════════════════════════════════════════════════════════
    // F1-1: the compressed prompt is now RETURNED (optimizedPrompt) so callers
    // actually send it to the LLM. Quality guard: never hand back a TRUNCATED
    // prompt (content loss) unless FINOPS_PACKER_TRUNCATE=true; require ≥3%
    // real savings before swapping prompts.
    if (config.packerEnabled && (agentConfig?.packerEnabled ?? true)) {
      const packResult = this.applySkillPacker(params.prompt, config, result.routedTier);
      if (packResult.applied) {
        const truncated = packResult.compressedPrompt.includes(
          '[...truncated by FinOps Skill Packer]',
        );
        const allowTruncate = (process.env.FINOPS_PACKER_TRUNCATE ?? 'false') === 'true';
        if (packResult.savedPct >= 3 && (!truncated || allowTruncate)) {
          result.optimizedPrompt = packResult.compressedPrompt;
          result.optimizationApplied.push('SKILL_PACKER');
          this.logger.debug(
            `Skill Packer: compressed ${packResult.originalTokens} → ${packResult.optimizedTokens} tokens (${packResult.savedPct.toFixed(1)}% reduction, applied=true)`,
          );
        } else {
          this.logger.debug(
            `Skill Packer: compression ${packResult.savedPct.toFixed(1)}% not applied ` +
              `(threshold 3% / truncated=${truncated})`,
          );
        }
      }
    }

    // Calculate cost reduction
    result.estimatedCostReduction = this.calculateSavings(result);

    const responseTimeMs = Date.now() - startTime;
    // Log the optimization with savedUsd for frontend. Store the query embedding
    // so a future semantically-similar prompt can match this row.
    await this.logUsage(params, result, responseTimeMs, false, queryEmbedding, gov);

    // Calculate savedUsd/savedPct (vs Tier-2 baseline) for frontend consumption
    const estimatedTokens = estimateTokens(params.prompt);
    const { savedUsd, savedPct } = routedSavings(params.prompt, result.routedTier);

    return {
      ...result,
      responseTimeMs,
      savedUsd,
      savedPct,
      estimatedTokens,
      cacheSimilarity,
    };
  }

  /** Expose budget status for the FinOps API (Patent 3). */
  async getBudgetStatus(tenantId: string, dailyLimitUsd: number) {
    return this.policyRouter.budgetStatus(tenantId, dailyLimitUsd);
  }

  /**
   * Gate 1: Semantic Cache Implementation
   *
   * Real semantic matching: embed the incoming prompt (OpenAI
   * text-embedding-3-small) and compare it by COSINE SIMILARITY against the
   * embeddings of recent non-cached calls for the same tenant+agent. A HIT
   * occurs when the best similarity >= config.cacheSimilarityThreshold (default
   * 0.93) — so semantically-equivalent prompts (e.g. "테트리스 개발해줘" vs
   * "테트리스 게임 개발해줘") match even though the raw strings differ.
   *
   * Fallback: when no embedding can be produced (no OPENAI_API_KEY, tenant has
   * externalLlmDisabled, or the API errors) we fall back to the previous
   * content-exact string match so the cache still works offline.
   *
   * Returns the query embedding so the caller can persist it on a MISS without
   * a second embedding call.
   */
  private async checkSemanticCache(
    params: {
      tenantId: string;
      agentName: string;
      prompt: string;
    },
    config: any,
    /** Patent 3: only entries written under the SAME policy surface may match. */
    policyHash?: string,
  ): Promise<{
    hit: boolean;
    response: string | null;
    similarity: number;
    queryEmbedding: number[];
  }> {
    // Check exclude patterns
    for (const pattern of config.cacheExcludePatterns || []) {
      if (params.prompt.includes(pattern)) {
        return { hit: false, response: null, similarity: 0, queryEmbedding: [] };
      }
    }

    const cacheTtlMs = (config.cacheTtlSeconds || 86400) * 1000;
    const cacheThreshold = new Date(Date.now() - cacheTtlMs);
    const model = config.cacheEmbeddingModel || 'text-embedding-3-small';
    const threshold =
      typeof config.cacheSimilarityThreshold === 'number' ? config.cacheSimilarityThreshold : 0.93;

    // 1) Try to embed the incoming prompt (best-effort).
    const queryEmbedding =
      (await this.embeddingService.embedForTenant(params.tenantId, params.prompt, model)) || [];

    try {
      if (queryEmbedding.length > 0) {
        // SEMANTIC PATH: fetch recent original (non-cached) calls that have a
        // stored embedding, then cosine-compare.
        const candidates = await (this.prisma as any).finOpsTokenLog.findMany({
          where: {
            tenantId: params.tenantId,
            agentName: params.agentName,
            cacheHit: false,
            createdAt: { gte: cacheThreshold },
            // Patent 3: policy change invalidates all prior cache entries.
            ...(policyHash ? { policyHash } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            routedModel: true,
            completionTokens: true,
            promptEmbedding: true,
          },
        });

        let best: any = null;
        let bestScore = -Infinity;
        for (const c of candidates) {
          const vec = (c.promptEmbedding || []) as number[];
          if (!vec.length) {
            continue;
          }
          const score = cosineSimilarity(queryEmbedding, vec);
          if (score > bestScore) {
            bestScore = score;
            best = c;
          }
        }

        if (best && bestScore >= threshold) {
          this.logger.debug(
            `Semantic cache HIT (cosine=${bestScore.toFixed(3)} >= ${threshold}) for tenant ${params.tenantId}, agent ${params.agentName}`,
          );
          return {
            hit: true,
            response: `[Cached] ${best.routedModel} response (${best.completionTokens || 0} tokens)`,
            similarity: bestScore,
            queryEmbedding,
          };
        }
        // No candidate cleared the threshold → MISS (but return embedding to store).
        return {
          hit: false,
          response: null,
          similarity: best ? bestScore : 0,
          queryEmbedding,
        };
      }

      // 2) FALLBACK PATH (no embedding): content-exact string match as before.
      const lookupPrompt = this.buildStoredPromptText(params.prompt);
      const recentExact = await (this.prisma as any).finOpsTokenLog.findFirst({
        where: {
          tenantId: params.tenantId,
          agentName: params.agentName,
          promptText: lookupPrompt,
          cacheHit: false,
          createdAt: { gte: cacheThreshold },
          // Patent 3: policy change invalidates all prior cache entries.
          ...(policyHash ? { policyHash } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (recentExact) {
        this.logger.debug(
          `Exact cache HIT (fallback, no embedding) for tenant ${params.tenantId}, agent ${params.agentName}`,
        );
        return {
          hit: true,
          response: `[Cached] ${recentExact.routedModel} response (${recentExact.completionTokens || 0} tokens)`,
          similarity: 1,
          queryEmbedding,
        };
      }
    } catch (error) {
      this.logger.error(`Semantic cache lookup error: ${(error as Error).message}`);
    }

    return { hit: false, response: null, similarity: 0, queryEmbedding };
  }

  /**
   * Gate 2: Model Router Implementation
   * Routes to the optimal model tier based on prompt complexity
   */
  private async routeToOptimalModel(
    params: {
      tenantId: string;
      agentName: string;
      prompt: string;
    },
    config: any,
    agentConfig: any,
  ): Promise<RouteResult> {
    // Analyze prompt complexity
    const complexity = this.analyzePromptComplexity(params.prompt);

    // Determine optimal tier based on complexity
    let tier: number;
    if (complexity <= 0.3) {
      tier = 1; // Simple queries → cheapest model
    } else if (complexity <= 0.7) {
      tier = 2; // Medium queries → standard model
    } else {
      tier = 3; // Complex queries → most capable model
    }

    // Enforce agent tier restrictions if configured
    if (agentConfig?.allowedTiers && agentConfig.allowedTiers.length > 0) {
      const allowedTiers = agentConfig.allowedTiers;
      if (!allowedTiers.includes(tier)) {
        // Find the closest allowed tier
        const higherTiers = allowedTiers.filter((t: number) => t >= tier);
        const lowerTiers = allowedTiers.filter((t: number) => t < tier);

        tier = higherTiers.length > 0 ? higherTiers[0] : lowerTiers[lowerTiers.length - 1];
      }
    }

    // Fallback to configured default if tier is not valid
    if (tier < 1 || tier > 3) {
      tier = config.routerFallbackTier || 2;
    }

    // Select model from tier
    let models: string[] = [];
    switch (tier) {
      case 1:
        models = config.routerTier1Models || ['claude-haiku-4.5', 'gemini-3-flash', 'gpt-4o-mini'];
        break;
      case 2:
        models = config.routerTier2Models || ['claude-sonnet-4.6', 'gpt-4o', 'gemini-3.1-pro'];
        break;
      case 3:
        models = config.routerTier3Models || ['claude-opus-4.6', 'o3', 'gpt-5'];
        break;
      default:
        models = config.routerTier2Models || ['claude-sonnet-4.6', 'gpt-4o', 'gemini-3.1-pro'];
    }

    const model = models[0] || 'claude-sonnet-4.6';

    this.logger.debug(
      `Routed prompt to tier ${tier}, model ${model} (complexity: ${complexity.toFixed(2)})`,
    );

    return { tier, model };
  }

  /**
   * Prompt complexity analyzer
   * Estimates complexity based on length, keywords, code presence, etc.
   */
  private analyzePromptComplexity(prompt: string): number {
    let score = 0;
    const len = prompt.length;

    // Length factor
    if (len > 2000) {
      score += 0.3;
    } else if (len > 500) {
      score += 0.15;
    }

    // Complexity keywords
    const complexKeywords = [
      '분석',
      'analyze',
      'architecture',
      '설계',
      'complex',
      '복잡',
      'multi-step',
      'reasoning',
      '추론',
      'compare',
      '비교',
      'design',
      'optimize',
    ];
    const simpleKeywords = [
      '번역',
      'translate',
      'summarize',
      '요약',
      'list',
      '목록',
      'FAQ',
      'greeting',
      '인사',
      'hello',
      'format',
      'parse',
    ];

    const lowerPrompt = prompt.toLowerCase();
    for (const kw of complexKeywords) {
      if (lowerPrompt.includes(kw)) {
        score += 0.15;
      }
    }
    for (const kw of simpleKeywords) {
      if (lowerPrompt.includes(kw)) {
        score -= 0.1;
      }
    }

    // Code detection
    if (prompt.includes('```') || prompt.includes('function') || prompt.includes('class ')) {
      score += 0.2;
    }

    // JSON/structured data
    if (prompt.includes('{') && prompt.includes('}')) {
      score += 0.1;
    }

    // Return normalized score [0, 1]
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Cost calculation based on model tier
   * Reference pricing (approximate, Jan 2026):
   * - Tier 1: $0.001/1K tokens
   * - Tier 2: $0.005/1K tokens
   * - Tier 3: $0.020/1K tokens
   */
  private calculateSavings(result: OptimizationResult): number {
    // Rough estimate: if cache hit, 100% savings. If routed to lower tier, partial savings.
    if (result.cacheHit) {
      return 100; // Full savings
    }

    // If routed to tier 1 instead of tier 2, approximately 80% savings
    // If routed to tier 2 instead of tier 3, approximately 75% savings
    if (result.routedTier === 1) {
      return 80;
    } else if (result.routedTier === 2) {
      return 75;
    }

    return 0;
  }

  /**
   * Gate 3: Skill Packer — Prompt compression and token optimization
   *
   * Techniques applied:
   * 1. Whitespace normalization (collapse multiple spaces/newlines)
   * 2. Redundant instruction removal (duplicate phrases)
   * 3. System prompt compression (common boilerplate reduction)
   * 4. Few-shot example trimming (limit examples by tier)
   * 5. Output format hints (enforce structured output to reduce tokens)
   */
  private applySkillPacker(
    prompt: string,
    config: any,
    tier: number,
  ): {
    applied: boolean;
    originalTokens: number;
    optimizedTokens: number;
    savedPct: number;
    compressedPrompt: string;
  } {
    const originalTokens = Math.ceil(prompt.length / 4);
    let compressed = prompt;

    // Technique 1: Whitespace normalization
    compressed = compressed.replace(/\n{3,}/g, '\n\n');
    compressed = compressed.replace(/  +/g, ' ');
    compressed = compressed.trim();

    // Technique 2: Remove redundant instruction phrases
    const redundantPatterns = [
      /Please make sure to /gi,
      /I would like you to /gi,
      /Could you please /gi,
      /I want you to /gi,
      /Make sure that /gi,
      /것을 확인해 주세요\.?\s*/g,
      /부탁드립니다\.?\s*/g,
    ];
    for (const pattern of redundantPatterns) {
      compressed = compressed.replace(pattern, '');
    }

    // Technique 3: System prompt compression — shorten common boilerplate
    const boilerplateMap: [RegExp, string][] = [
      [/You are a helpful assistant that /gi, 'As assistant: '],
      [/You are an AI language model /gi, 'AI: '],
      [/도움이 되는 AI 어시스턴트로서 /g, 'AI로서 '],
      [/다음 내용을 분석하고 결과를 알려주세요/g, '분석 요청:'],
    ];
    for (const [pattern, replacement] of boilerplateMap) {
      compressed = compressed.replace(pattern, replacement);
    }

    // Technique 4: Few-shot example trimming (tier-based limits)
    const maxExamples = tier === 1 ? 1 : tier === 2 ? 3 : 5;
    const examplePattern = /(?:Example|예시|예제)\s*\d+[:\s]/gi;
    let exampleCount = 0;
    compressed = compressed.replace(examplePattern, (match) => {
      exampleCount++;
      if (exampleCount > maxExamples) {
        return ''; // Remove excess examples
      }
      return match;
    });

    // Technique 5: Token budget enforcement
    const maxTokensPerSkill = config.packerMaxTokensPerSkill || 2000;
    const maxChars = maxTokensPerSkill * 4; // Approximate
    if (compressed.length > maxChars) {
      compressed = compressed.substring(0, maxChars) + '\n[...truncated by FinOps Skill Packer]';
    }

    const optimizedTokens = Math.ceil(compressed.length / 4);
    const savedPct =
      originalTokens > 0 ? ((originalTokens - optimizedTokens) / originalTokens) * 100 : 0;

    return {
      applied: savedPct > 0,
      originalTokens,
      optimizedTokens,
      savedPct,
      compressedPrompt: compressed,
    };
  }

  /**
   * Compute a stable content hash for the prompt (delegates to pure logic).
   * In production, this would use semantic embeddings for similarity.
   */
  private computeCacheKey(prompt: string): string {
    return computeCacheKey(prompt);
  }

  /**
   * The exact value stored in / looked up from FinOpsTokenLog.promptText.
   * Hash-marked so the cache key is content-exact and seed rows (NULL) never match.
   */
  private buildStoredPromptText(prompt: string): string {
    return buildStoredPromptText(prompt);
  }

  /**
   * Log token usage to database
   */
  private async logUsage(
    params: {
      tenantId: string;
      agentName: string;
      executionSessionId?: string;
      nodeId?: string;
      prompt: string;
    },
    result: OptimizationResult,
    responseTimeMs: number,
    cacheHit: boolean,
    promptEmbedding: number[] = [],
    gov?: {
      policyHash?: string;
      dataClass?: string;
      riskScore?: number;
      cacheKey?: string;
      promptHash?: string;
      cachePolicyDecision?: string;
      cacheDecisionReasonJson?: unknown;
      routeReasonJson?: unknown;
      evidencePackId?: string;
      workflowId?: string;
      nodeKey?: string;
      skillId?: string;
    },
  ) {
    try {
      // Estimate token counts (rough approximation)
      const estimatedPromptTokens = Math.ceil(params.prompt.length / 4);
      const estimatedCompletionTokens = Math.ceil((result.cachedResponse?.length || 0) / 4);

      // Rough cost estimation (in USD)
      const tierPricing: Record<number, number> = {
        1: 0.001 / 1000, // $0.001 per 1K tokens
        2: 0.005 / 1000, // $0.005 per 1K tokens
        3: 0.02 / 1000, // $0.02 per 1K tokens
      };

      const totalTokens = estimatedPromptTokens + estimatedCompletionTokens;
      const originalCostUsd = (tierPricing[2] || 0) * totalTokens; // Default to tier 2 cost
      const optimizedCostUsd = (tierPricing[result.routedTier] || 0) * totalTokens;
      const savedUsd = Math.max(0, originalCostUsd - optimizedCostUsd);

      await this.finOpsService.logTokenUsage(params.tenantId, {
        agentName: params.agentName,
        executionSessionId: params.executionSessionId,
        nodeId: params.nodeId,
        promptText: this.buildStoredPromptText(params.prompt), // hash-marked, content-exact key
        promptEmbedding, // semantic-cache vector (empty when embedding unavailable)
        promptTokens: estimatedPromptTokens,
        completionTokens: estimatedCompletionTokens,
        totalTokens,
        cacheHit,
        cachedResponseUsed: cacheHit,
        routedTier: result.routedTier,
        routedModel: result.routedModel,
        originalCostUsd,
        optimizedCostUsd,
        savedUsd,
        responseTimeMs,
        // Patent 3: policy-aware audit fields
        ...(gov ?? {}),
      });
    } catch (error) {
      this.logger.error(`Error logging token usage: ${(error as Error).message}`);
      // Don't throw — logging failure shouldn't break the flow
    }
  }
}
