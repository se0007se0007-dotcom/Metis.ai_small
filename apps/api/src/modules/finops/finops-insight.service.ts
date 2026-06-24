/**
 * FinOpsInsightService — quality-cost closed loop (F3) + FOCUS export (F4).
 *
 * 1. Quality-per-dollar matrix: joins AgentEvaluation × FinOpsTokenLog by
 *    executionSessionId and aggregates per (agentName × model) so operators
 *    can SEE whether cheaper routing degraded quality — the question no OSS
 *    FinOps tool answers today.
 *
 * 2. Quality-regression guardrail: compares the avg evaluation score of
 *    Tier-1/downshifted calls against Tier-2+ calls of the SAME agent. A drop
 *    beyond the threshold yields a regression finding (audit-logged); the
 *    operator (or automation) can then revert the agent to higher tiers via
 *    revertAgentToSafeTiers().
 *
 * 3. FOCUS 1.4-compatible export: normalizes FinOpsTokenLog rows into FOCUS
 *    columns + x_ token-extension columns (FOCUS 1.5 token-native costs are
 *    not ratified yet — we ship the extension ahead of the standard).
 *
 * All queries are read-mostly, bounded windows, best-effort.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

export interface QualityCostCell {
  agentName: string;
  model: string;
  tier: number | null;
  calls: number;
  evaluatedCalls: number;
  totalCostUsd: number;
  avgScore: number | null;
  /** avgScore per $1 spent — headline "quality-per-dollar" metric */
  qualityPerDollar: number | null;
}

export interface QualityRegression {
  agentName: string;
  lowTierModel: string;
  lowTierAvgScore: number;
  highTierAvgScore: number;
  dropPct: number;
  lowTierCalls: number;
  highTierCalls: number;
  recommendation: string;
}

const REGRESSION_DROP_PCT = 10; // alert when low-tier score is ≥10% below high-tier
const MIN_CALLS_FOR_SIGNAL = 3;

@Injectable()
export class FinOpsInsightService {
  private readonly logger = new Logger(FinOpsInsightService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ════════════════════════════════════════════════════════════
  // F3-1: Quality-per-dollar matrix
  // ════════════════════════════════════════════════════════════

  async qualityCostMatrix(tenantId: string, days = 30): Promise<QualityCostCell[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const p = this.prisma as any;

    const logs = await p.finOpsTokenLog.findMany({
      where: { tenantId, createdAt: { gte: since }, routedModel: { not: '' } },
      select: {
        agentName: true,
        routedModel: true,
        routedTier: true,
        optimizedCostUsd: true,
        executionSessionId: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const sessionIds = Array.from(
      new Set(logs.map((l: any) => l.executionSessionId).filter(Boolean)),
    );
    const evals = sessionIds.length
      ? await p.agentEvaluation.findMany({
          where: { tenantId, executionSessionId: { in: sessionIds as string[] } },
          select: { executionSessionId: true, overallScore: true },
        })
      : [];

    // sessionId → avg evaluation score
    const scoreBySession = new Map<string, { sum: number; n: number }>();
    for (const e of evals as any[]) {
      const cur = scoreBySession.get(e.executionSessionId) ?? { sum: 0, n: 0 };
      cur.sum += e.overallScore ?? 0;
      cur.n += 1;
      scoreBySession.set(e.executionSessionId, cur);
    }

    const cells = new Map<
      string,
      { agentName: string; model: string; tier: number | null; calls: number; evaluated: number; cost: number; scoreSum: number }
    >();
    for (const l of logs as any[]) {
      const key = `${l.agentName}|${l.routedModel}`;
      const cell =
        cells.get(key) ??
        ({ agentName: l.agentName, model: l.routedModel, tier: l.routedTier ?? null, calls: 0, evaluated: 0, cost: 0, scoreSum: 0 } as any);
      cell.calls += 1;
      cell.cost += l.optimizedCostUsd ?? 0;
      const s = l.executionSessionId ? scoreBySession.get(l.executionSessionId) : undefined;
      if (s && s.n > 0) {
        cell.evaluated += 1;
        cell.scoreSum += s.sum / s.n;
      }
      cells.set(key, cell);
    }

    return Array.from(cells.values())
      .map((c) => {
        const avgScore = c.evaluated > 0 ? c.scoreSum / c.evaluated : null;
        return {
          agentName: c.agentName,
          model: c.model,
          tier: c.tier,
          calls: c.calls,
          evaluatedCalls: c.evaluated,
          totalCostUsd: Math.round(c.cost * 1e6) / 1e6,
          avgScore: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
          qualityPerDollar:
            avgScore !== null && c.cost > 0.000001
              ? Math.round((avgScore / c.cost) * 100) / 100
              : null,
        };
      })
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  // ════════════════════════════════════════════════════════════
  // F3-2: Quality-regression guardrail
  // ════════════════════════════════════════════════════════════

  async qualityRegressions(tenantId: string, days = 14): Promise<QualityRegression[]> {
    const matrix = await this.qualityCostMatrix(tenantId, days);

    // Group cells per agent: low tier (1) vs high tier (>=2)
    const byAgent = new Map<string, QualityCostCell[]>();
    for (const cell of matrix) {
      const list = byAgent.get(cell.agentName) ?? [];
      list.push(cell);
      byAgent.set(cell.agentName, list);
    }

    const regressions: QualityRegression[] = [];
    for (const [agentName, cells] of byAgent) {
      const low = cells.filter(
        (c) => c.tier === 1 && c.avgScore !== null && c.evaluatedCalls >= MIN_CALLS_FOR_SIGNAL,
      );
      const high = cells.filter(
        (c) => (c.tier ?? 2) >= 2 && c.avgScore !== null && c.evaluatedCalls >= MIN_CALLS_FOR_SIGNAL,
      );
      if (low.length === 0 || high.length === 0) continue;

      const lowAvg =
        low.reduce((s, c) => s + (c.avgScore ?? 0) * c.evaluatedCalls, 0) /
        low.reduce((s, c) => s + c.evaluatedCalls, 0);
      const highAvg =
        high.reduce((s, c) => s + (c.avgScore ?? 0) * c.evaluatedCalls, 0) /
        high.reduce((s, c) => s + c.evaluatedCalls, 0);
      if (highAvg <= 0) continue;

      const dropPct = ((highAvg - lowAvg) / highAvg) * 100;
      if (dropPct >= REGRESSION_DROP_PCT) {
        regressions.push({
          agentName,
          lowTierModel: low[0].model,
          lowTierAvgScore: Math.round(lowAvg * 100) / 100,
          highTierAvgScore: Math.round(highAvg * 100) / 100,
          dropPct: Math.round(dropPct * 10) / 10,
          lowTierCalls: low.reduce((s, c) => s + c.evaluatedCalls, 0),
          highTierCalls: high.reduce((s, c) => s + c.evaluatedCalls, 0),
          recommendation: `Tier 1 라우팅 품질이 상위 티어 대비 ${Math.round(dropPct)}% 낮습니다. allowedTiers에서 1을 제외(복귀)하는 것을 권장합니다.`,
        });
      }
    }

    // Audit each finding (best-effort, once per call site invocation).
    for (const r of regressions) {
      await (this.prisma as any).auditLog
        .create({
          data: {
            actorUserId: null,
            tenantId,
            action: 'POLICY_CHECK',
            targetType: 'FinOpsAgentConfig',
            targetId: r.agentName,
            correlationId: `finops-quality-regression-${Date.now()}`,
            metadataJson: { kind: 'QUALITY_REGRESSION', ...r },
          },
        })
        .catch(() => {});
    }

    return regressions;
  }

  /**
   * Guardrail action: revert an agent to safe tiers (exclude Tier 1) so the
   * router stops sending it to the degraded cheap model. Operator-invoked
   * (POST /finops/quality-guard/:agentName/revert).
   */
  async revertAgentToSafeTiers(tenantId: string, agentName: string) {
    const updated = await (this.prisma as any).finOpsAgentConfig.update({
      where: { tenantId_agentName: { tenantId, agentName } },
      data: { allowedTiers: [2, 3] },
    });
    this.logger.warn(
      `[FinOps] quality guard: agent "${agentName}" reverted to tiers [2,3] (Tier 1 excluded)`,
    );
    await (this.prisma as any).auditLog
      .create({
        data: {
          actorUserId: null,
          tenantId,
          action: 'UPDATE',
          targetType: 'FinOpsAgentConfig',
          targetId: agentName,
          correlationId: `finops-quality-revert-${Date.now()}`,
          metadataJson: { kind: 'QUALITY_GUARD_REVERT', allowedTiers: [2, 3] },
        },
      })
      .catch(() => {});
    return updated;
  }

  // ════════════════════════════════════════════════════════════
  // F4: FOCUS 1.4-compatible cost ledger export (+ token extensions)
  // ════════════════════════════════════════════════════════════

  async exportFocus(
    tenantId: string,
    days = 30,
    format: 'json' | 'csv' = 'json',
  ): Promise<{ rows: Record<string, unknown>[]; csv?: string }> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const logs = await (this.prisma as any).finOpsTokenLog.findMany({
      where: { tenantId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    const providerOf = (model: string): string => {
      if (!model) return 'Unknown';
      if (model.startsWith('claude')) return 'Anthropic';
      if (model.startsWith('gpt') || model.startsWith('o3') || model.startsWith('o1'))
        return 'OpenAI';
      if (model.startsWith('gemini')) return 'Google';
      return 'Unknown';
    };

    // FOCUS 1.4 core columns + x_ extension columns (token-native, pre-1.5).
    const rows = (logs as any[]).map((l) => ({
      // ── FOCUS core ──
      BilledCost: l.optimizedCostUsd ?? 0,
      EffectiveCost: l.optimizedCostUsd ?? 0,
      ListCost: l.originalCostUsd ?? 0,
      BillingCurrency: 'USD',
      ChargePeriodStart: l.createdAt?.toISOString?.() ?? String(l.createdAt),
      ChargePeriodEnd: l.createdAt?.toISOString?.() ?? String(l.createdAt),
      ChargeCategory: 'Usage',
      ChargeDescription: `LLM call (${l.routedModel || 'unknown'}) by agent ${l.agentName}`,
      ProviderName: providerOf(l.routedModel),
      PublisherName: providerOf(l.routedModel),
      ServiceName: 'LLM Inference',
      ServiceCategory: 'AI and Machine Learning',
      ResourceId: l.agentName,
      ResourceType: 'AI Agent',
      SubAccountId: tenantId,
      // ── x_ token extensions (FOCUS 1.5 forerunner) ──
      x_Model: l.routedModel || null,
      x_ModelTier: l.routedTier ?? null,
      x_TokensInput: l.promptTokens ?? 0,
      x_TokensOutput: l.completionTokens ?? 0,
      x_TokensTotal: l.totalTokens ?? 0,
      x_CacheHit: !!l.cacheHit,
      x_SavedCost: l.savedUsd ?? 0,
      x_ExecutionSessionId: l.executionSessionId ?? null,
      x_WorkflowId: l.workflowId ?? null,
      x_PolicyHash: l.policyHash ?? null,
      x_DataClass: l.dataClass ?? null,
    }));

    if (format === 'csv') {
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      const escape = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [
        headers.join(','),
        ...rows.map((r) => headers.map((h) => escape((r as any)[h])).join(',')),
      ].join('\n');
      return { rows, csv };
    }
    return { rows };
  }
}
