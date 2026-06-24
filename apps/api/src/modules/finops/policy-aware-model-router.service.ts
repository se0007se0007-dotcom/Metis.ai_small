/**
 * PolicyAwareModelRouterService — Patent 3 구성요소 (종속청구항 4·5).
 *
 * Model tier를 complexity만으로 고르지 않고 risk / 일일예산 압박 /
 * agent 허용 tier / 정책 최소 tier를 결합해 결정한다:
 *   risk > 0.8           → tier를 safeMinimumTier 이상으로 상향
 *   budgetPressure > 0.9 (risk < 0.5) → tier 1로 하향(THROTTLE성 절감)
 *   allowedTiers 제약    → 가장 가까운 허용 tier로 보정
 * 모든 보정 사유는 routeReason으로 반환되어 token log에 기록된다.
 */
import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

export interface RouteDecision {
  tier: number;
  model: string;
  reason: {
    complexity: number;
    risk: number;
    budgetPressure: number;
    allowedTiers: number[];
    adjustments: string[];
  };
}

export interface BudgetStatus {
  dailyLimitUsd: number;
  usedTodayUsd: number;
  budgetPressure: number; // used / limit (0..n)
  action: 'NONE' | 'DOWNGRADE' | 'THROTTLE';
}

const SAFE_MINIMUM_TIER = 2;

@Injectable()
export class PolicyAwareModelRouterService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /** 오늘 사용액 vs 일일 한도(config.alertDailyCostMax) → 예산 압박도. */
  async budgetStatus(tenantId: string, dailyLimitUsd: number): Promise<BudgetStatus> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const agg = await this.prisma.finOpsTokenLog.aggregate({
      where: { tenantId, createdAt: { gte: startOfDay } },
      _sum: { optimizedCostUsd: true },
    });
    const usedTodayUsd = agg._sum.optimizedCostUsd ?? 0;
    const limit = dailyLimitUsd > 0 ? dailyLimitUsd : 50;
    const budgetPressure = usedTodayUsd / limit;
    const action: BudgetStatus['action'] =
      budgetPressure >= 1 ? 'THROTTLE' : budgetPressure > 0.9 ? 'DOWNGRADE' : 'NONE';
    return { dailyLimitUsd: limit, usedTodayUsd, budgetPressure, action };
  }

  /** Pure tier selection — no I/O (특허 의사코드 구현). */
  route(input: {
    complexity: number;
    riskScore: number;
    budgetPressure: number;
    allowedTiers: number[];
    tierModels: Record<number, string[]>;
    fallbackTier: number;
  }): RouteDecision {
    const adjustments: string[] = [];
    const { complexity, riskScore, budgetPressure } = input;

    let tier = complexity > 0.7 ? 3 : complexity > 0.3 ? 2 : 1;
    adjustments.push(`complexity=${complexity.toFixed(2)} → base tier ${tier}`);

    // 고위험 노드는 저비용 모델로 내려보내지 않는다 (종속청구항 4).
    if (riskScore > 0.8 && tier < SAFE_MINIMUM_TIER) {
      tier = SAFE_MINIMUM_TIER;
      adjustments.push(`risk=${riskScore} > 0.8 → raised to safe minimum tier ${tier}`);
    }

    // 예산 소진 시 저위험 요청만 다운그레이드 (종속청구항 5).
    if (budgetPressure > 0.9 && riskScore < 0.5 && tier > 1) {
      tier = 1;
      adjustments.push(`budgetPressure=${budgetPressure.toFixed(2)} > 0.9 → downgraded to tier 1`);
    }

    // Agent 허용 tier 보정.
    const allowed = input.allowedTiers.length > 0 ? input.allowedTiers : [1, 2, 3];
    if (!allowed.includes(tier)) {
      const higher = allowed.filter((t) => t >= tier).sort((a, b) => a - b);
      const lower = allowed.filter((t) => t < tier).sort((a, b) => b - a);
      const next = higher[0] ?? lower[0] ?? input.fallbackTier;
      adjustments.push(`tier ${tier} not in allowedTiers [${allowed.join(',')}] → ${next}`);
      tier = next;
    }
    if (tier < 1 || tier > 3) {
      tier = input.fallbackTier || 2;
      adjustments.push(`tier out of range → fallback ${tier}`);
    }

    const models = input.tierModels[tier] ?? [];
    return {
      tier,
      model: models[0] ?? 'claude-sonnet-4.6',
      reason: {
        complexity,
        risk: riskScore,
        budgetPressure,
        allowedTiers: allowed,
        adjustments,
      },
    };
  }
}
