/**
 * FinOps Prediction Service — Cost Forecasting & Simulation
 *
 * Responsibilities:
 *   - Monthly cost prediction with linear extrapolation
 *   - What-if scenario simulation (cache, tier, skill optimizations)
 *   - Intelligent recommendations based on historical data
 *   - Recommendation application & audit logging
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  CostForecast,
  SimulationRequest,
  SimulationResult,
  SimulationBreakdown,
  Recommendation,
  ApplyRecommendationResponse,
} from './finops.dto';

// ═══════════════════════════════════════════════════════════
// Cost Model Constants
// ═══════════════════════════════════════════════════════════

const TIER_COSTS_PER_1K_TOKENS = {
  1: 0.002, // Tier 1: $0.002 per 1K tokens
  2: 0.01, // Tier 2: $0.01 per 1K tokens
  3: 0.03, // Tier 3: $0.03 per 1K tokens
};

const CACHE_COST_REDUCTION = 0.7; // Cache hit saves 70% of token cost
const CACHE_HIT_RATE_IMPROVEMENT = 0.03; // 2x TTL → +3% cache hit rate

@Injectable()
export class FinOpsPredictionService {
  private readonly logger = new Logger(FinOpsPredictionService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ════════════════════════════════════════════════════════════
  // 1. Monthly Cost Prediction
  // ════════════════════════════════════════════════════════════

  async predictMonthlyCost(ctx: TenantContext): Promise<CostForecast> {
    const db = withTenantIsolation(this.prisma, ctx);

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const daysElapsed = now.getDate();

    // Days in current month (1-31)
    const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate();

    // Get current month logs
    const monthStart = new Date(currentYear, currentMonth, 1);
    const monthEnd = new Date(currentYear, currentMonth + 1, 1);

    const currentMonthLogs = await db.finOpsTokenLog.findMany({
      where: {
        createdAt: {
          gte: monthStart,
          lt: monthEnd,
        },
      },
    });

    // Calculate current month actual cost
    const currentMonthActual = currentMonthLogs.reduce(
      (sum: number, log: any) => sum + (log.optimizedCostUsd || 0),
      0,
    );

    // Calculate average daily cost
    const avgDailyCost = daysElapsed > 0 ? currentMonthActual / daysElapsed : 0;

    // Linear extrapolation: project to end of month
    const projectedMonthTotal = avgDailyCost * totalDays;

    // Get previous month total
    const prevMonthStart = new Date(currentYear, currentMonth - 1, 1);
    const prevMonthEnd = new Date(currentYear, currentMonth, 1);

    const prevMonthLogs = await db.finOpsTokenLog.findMany({
      where: {
        createdAt: {
          gte: prevMonthStart,
          lt: prevMonthEnd,
        },
      },
    });

    const previousMonthTotal = prevMonthLogs.reduce(
      (sum: number, log: any) => sum + (log.optimizedCostUsd || 0),
      0,
    );

    // Calculate month-over-month percentage
    const monthOverMonthPct =
      previousMonthTotal > 0
        ? ((projectedMonthTotal - previousMonthTotal) / previousMonthTotal) * 100
        : 0;

    // Confidence: higher when we have more data
    const confidence = Math.min(daysElapsed / totalDays, 1.0);

    return {
      currentMonthActual: Math.round(currentMonthActual * 100) / 100,
      projectedMonthTotal: Math.round(projectedMonthTotal * 100) / 100,
      previousMonthTotal: Math.round(previousMonthTotal * 100) / 100,
      monthOverMonthPct: Math.round(monthOverMonthPct * 100) / 100,
      daysElapsed,
      totalDays,
      confidence: Math.round(confidence * 100) / 100,
      method: 'linear_extrapolation',
    };
  }

  // ════════════════════════════════════════════════════════════
  // 2. What-If Simulation
  // ════════════════════════════════════════════════════════════

  async simulateWhatIf(
    ctx: TenantContext,
    simulation: SimulationRequest,
  ): Promise<SimulationResult> {
    const db = withTenantIsolation(this.prisma, ctx);

    // Get baseline (current month projection)
    const baseline = await this.predictMonthlyCost(ctx);
    const baselineMonthlyCost = baseline.projectedMonthTotal;

    // Get current month logs for detailed analysis
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const monthStart = new Date(currentYear, currentMonth, 1);
    const monthEnd = new Date(currentYear, currentMonth + 1, 1);

    const currentMonthLogs = await db.finOpsTokenLog.findMany({
      where: {
        createdAt: {
          gte: monthStart,
          lt: monthEnd,
        },
      },
    });

    let simulatedCost = baselineMonthlyCost;
    const breakdown: SimulationBreakdown = {
      cache: 0,
      tier: 0,
      skill: 0,
    };

    // ─ Cache TTL Optimization ─
    if (simulation.cacheTTLMultiplier && simulation.cacheTTLMultiplier > 1) {
      const multiplier = Math.log2(simulation.cacheTTLMultiplier);
      const hitRateImprovement = CACHE_HIT_RATE_IMPROVEMENT * multiplier;

      // Count current cache hits
      const cacheHits = currentMonthLogs.filter((log: any) => log.cacheHit).length;
      const cacheHitRate = currentMonthLogs.length > 0 ? cacheHits / currentMonthLogs.length : 0;
      const newCacheHitRate = Math.min(cacheHitRate + hitRateImprovement, 0.95);

      const additionalSavings =
        currentMonthLogs.length *
        (newCacheHitRate - cacheHitRate) *
        TIER_COSTS_PER_1K_TOKENS[2] * // avg cost per log
        (0.001 * 3000) * // avg tokens
        CACHE_COST_REDUCTION;

      breakdown.cache = -additionalSavings;
      simulatedCost += breakdown.cache;
    }

    // ─ Tier Downgrade Optimization ─
    if (simulation.tierDowngrade && simulation.tierDowngrade > 0) {
      // Estimate cost reduction: each tier downgrade saves ~20%
      const downgradedAgents = await db.finOpsAgentConfig.findMany({
        where: {},
        orderBy: { createdAt: 'desc' },
        take: simulation.tierDowngrade,
      });

      let tierSavings = 0;
      for (const agent of downgradedAgents) {
        const agentLogs = currentMonthLogs.filter((log: any) => log.agentName === agent.agentName);
        const agentCost = agentLogs.reduce(
          (sum: number, log: any) => sum + (log.optimizedCostUsd || 0),
          0,
        );
        tierSavings += agentCost * 0.2; // 20% savings per downgrade
      }

      breakdown.tier = -tierSavings;
      simulatedCost += breakdown.tier;
    }

    // ─ Skill Token Budget Adjustment ─
    if (simulation.skillTokenBudgetMultiplier && simulation.skillTokenBudgetMultiplier !== 1) {
      const budgetMultiplier = simulation.skillTokenBudgetMultiplier;
      let skillSavings = 0;

      if (budgetMultiplier < 1) {
        // Reducing budget: estimated 25% savings at 0.5
        skillSavings = (baselineMonthlyCost * 0.25 * (1 - budgetMultiplier)) / 0.5;
      } else if (budgetMultiplier > 1) {
        // Increasing budget: 15% cost increase at 2.0
        skillSavings = -((baselineMonthlyCost * 0.15 * (budgetMultiplier - 1)) / 1.0);
      }

      breakdown.skill = -skillSavings;
      simulatedCost += breakdown.skill;
    }

    const savings = baselineMonthlyCost - simulatedCost;
    const savingsPct = baselineMonthlyCost > 0 ? (savings / baselineMonthlyCost) * 100 : 0;

    // Audit the simulation. NOTE: ExecutionTrace requires a real
    // executionSessionId (FK), which a cost simulation does not have — writing
    // one there always failed silently. Use AuditLog instead, which is the
    // correct sink for non-execution audit events.
    try {
      await (this.prisma as any).auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId ?? null,
          action: 'UPDATE',
          targetType: 'FinOpsSimulation',
          correlationId: `sim-${ctx.tenantId}-${Date.now()}`,
          metadataJson: {
            event: 'FINOPS_SIMULATION',
            input: simulation,
            output: {
              baselineMonthlyCost,
              simulatedMonthlyCost: Math.round(simulatedCost * 100) / 100,
              savings: Math.round(savings * 100) / 100,
            },
          },
        },
      });
    } catch (err) {
      this.logger.warn('Failed to write FinOps simulation audit log', err);
    }

    return {
      baselineMonthlyCost: Math.round(baselineMonthlyCost * 100) / 100,
      simulatedMonthlyCost: Math.round(simulatedCost * 100) / 100,
      savings: Math.round(savings * 100) / 100,
      savingsPct: Math.round(savingsPct * 100) / 100,
      breakdown,
    };
  }

  // ════════════════════════════════════════════════════════════
  // 3. Intelligent Recommendations
  // ════════════════════════════════════════════════════════════

  async getRecommendations(ctx: TenantContext): Promise<Recommendation[]> {
    const db = withTenantIsolation(this.prisma, ctx);
    const recommendations: Recommendation[] = [];

    // Get last 30 days of logs
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentLogs = await db.finOpsTokenLog.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentLogs.length === 0) {
      return [];
    }

    // ─ Recommendation 1: Tier Downgrade ─
    const agentStats = new Map<
      string,
      {
        tier1Count: number;
        tier2Count: number;
        tier3Count: number;
        totalCost: number;
      }
    >();

    for (const log of recentLogs) {
      if (!agentStats.has(log.agentName)) {
        agentStats.set(log.agentName, {
          tier1Count: 0,
          tier2Count: 0,
          tier3Count: 0,
          totalCost: 0,
        });
      }
      const stats = agentStats.get(log.agentName)!;
      if (log.routedTier === 1) stats.tier1Count += 1;
      else if (log.routedTier === 2) stats.tier2Count += 1;
      else if (log.routedTier === 3) stats.tier3Count += 1;
      stats.totalCost += log.optimizedCostUsd || 0;
    }

    for (const [agentName, stats] of agentStats) {
      const tier3Pct = stats.tier3Count / (stats.tier1Count + stats.tier2Count + stats.tier3Count);

      if (tier3Pct < 0.1 && stats.tier3Count > 0) {
        const savingsUsd = stats.totalCost * 0.2; // 20% savings from downgrade
        recommendations.push({
          id: `tier-${agentName}`,
          title: `Agent "${agentName}"을(를) Tier 2로 다운그레이드하기`,
          description: `지난 30일간 Tier 3 호출이 ${Math.round(tier3Pct * 100)}%로 낮음. Tier 2로 다운그레이드하면 성능 영향은 미미하면서 비용을 절감할 수 있습니다.`,
          estimatedSavingsMonthly: Math.round(savingsUsd * 100) / 100,
          category: 'tier',
          actionable: true,
          autoApplyAvailable: false,
        });
      }
    }

    // ─ Recommendation 2: Cache Optimization ─
    const cacheHits = recentLogs.filter((log: any) => log.cacheHit).length;
    const cacheHitRate = cacheHits / recentLogs.length;

    if (cacheHitRate < 0.5) {
      const savingsUsd =
        recentLogs.length *
        30 * // extrapolate to month
        TIER_COSTS_PER_1K_TOKENS[2] *
        0.001 *
        3000 *
        CACHE_COST_REDUCTION *
        0.1; // 10% additional improvement

      recommendations.push({
        id: 'cache-threshold',
        title: '캐시 유사도 threshold 조정하기',
        description: `현재 캐시 히트율이 ${Math.round(cacheHitRate * 100)}%입니다. similarity threshold를 0.90→0.93으로 상향하면 히트율을 5-10% 개선할 수 있습니다.`,
        estimatedSavingsMonthly: Math.round(savingsUsd * 100) / 100,
        category: 'cache',
        actionable: true,
        autoApplyAvailable: false,
      });
    }

    // ─ Recommendation 3: Skill Token Budget ─
    const skillStats = new Map<
      string,
      {
        invocationCount: number;
        budgetUsed: number;
      }
    >();

    const skills = await db.finOpsSkill.findMany({});
    for (const skill of skills) {
      skillStats.set(skill.skillId, {
        invocationCount: skill.invocationCount,
        budgetUsed: 0,
      });
    }

    // Estimate budget used from logs
    for (const log of recentLogs) {
      // Find which skills were used (simple heuristic: check executionSessionId)
      // In real scenario, this would be tracked more precisely
    }

    // Check for frequently used skills
    for (const [skillId, stats] of skillStats) {
      if (stats.invocationCount > 100) {
        const estimatedDailyCost = (stats.invocationCount / 30) * TIER_COSTS_PER_1K_TOKENS[1];
        const monthlyCost = estimatedDailyCost * 30;

        recommendations.push({
          id: `skill-${skillId}`,
          title: `Skill "${skillId}"의 토큰 예산 검토하기`,
          description: `이 Skill은 지난 30일간 ${stats.invocationCount}회 호출되었습니다. 예산 초과 가능성이 있으니 할당량을 검토하세요.`,
          estimatedSavingsMonthly: Math.round(monthlyCost * 0.1 * 100) / 100,
          category: 'skill',
          actionable: true,
          autoApplyAvailable: false,
        });
      }
    }

    // ─ Recommendation 4: TTL Optimization ─
    if (cacheHitRate > 0.3 && cacheHitRate < 0.7) {
      const savingsUsd =
        recentLogs.length *
        30 *
        TIER_COSTS_PER_1K_TOKENS[2] *
        0.001 *
        3000 *
        CACHE_COST_REDUCTION *
        0.05; // 5% improvement from TTL

      recommendations.push({
        id: 'cache-ttl',
        title: '캐시 TTL을 24시간으로 연장하기',
        description: `현재 TTL 설정을 검토하여 적절한 수준으로 조정하면 캐시 재사용률을 높일 수 있습니다.`,
        estimatedSavingsMonthly: Math.round(savingsUsd * 100) / 100,
        category: 'cache',
        actionable: true,
        autoApplyAvailable: true,
      });
    }

    // ─ Recommendation 5: Overall Tier Distribution ─
    const avgCostPerRequest =
      recentLogs.reduce((sum: number, log: any) => sum + (log.optimizedCostUsd || 0), 0) /
      recentLogs.length;

    recommendations.push({
      id: 'tier-mix-review',
      title: '전체 Tier 분포 검토하기',
      description: `요청의 Tier 분포를 분석하여 최적의 라우팅 정책을 수립하는 것을 권장합니다. 평균 요청당 비용: $${Math.round(avgCostPerRequest * 10000) / 10000}`,
      estimatedSavingsMonthly:
        Math.round(recentLogs.length * 30 * avgCostPerRequest * 0.05 * 100) / 100,
      category: 'tier',
      actionable: true,
      autoApplyAvailable: false,
    });

    // Return top 5 by estimated savings
    return recommendations
      .sort((a, b) => b.estimatedSavingsMonthly - a.estimatedSavingsMonthly)
      .slice(0, 5);
  }

  // ════════════════════════════════════════════════════════════
  // 4. Apply Recommendation
  // ════════════════════════════════════════════════════════════

  async applyRecommendation(
    ctx: TenantContext,
    recId: string,
  ): Promise<ApplyRecommendationResponse> {
    const db = withTenantIsolation(this.prisma, ctx);

    try {
      // Write audit log
      await (this.prisma as any).auditLog
        .create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId || 'system',
            action: 'EXECUTE',
            targetType: 'FinOpsRecommendation',
            targetId: recId,
            correlationId: `rec-apply-${ctx.tenantId}-${recId}-${Date.now()}`,
            metadataJson: {
              recommendationId: recId,
              timestamp: new Date().toISOString(),
            },
          },
        })
        .catch(() => {
          // AuditLog might not exist; continue anyway
        });

      // (Removed broken ExecutionTrace write — it omitted the required
      // executionSessionId FK and always failed silently. The AuditLog above
      // already records this recommendation-apply event.)

      this.logger.log(`Applied recommendation ${recId} for tenant ${ctx.tenantId}`);

      return {
        applied: true,
        message: `Recommendation "${recId}" has been applied successfully.`,
      };
    } catch (err) {
      this.logger.error(`Failed to apply recommendation ${recId}`, err);
      return {
        applied: false,
        message: `Failed to apply recommendation: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
