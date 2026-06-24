/**
 * FinOps Service — Phase 4: Token Optimization
 *
 * Responsibilities:
 *   - CRUD operations for FinOps configurations
 *   - Agent config management
 *   - Skill registration and tracking
 *   - Namespace management for cache organization
 *   - Token usage logging and statistics
 *   - Tenant isolation enforcement
 */
import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { EmailService } from '../email/email.service';
import {
  UpdateFinOpsConfigDto,
  CreateAgentConfigDto,
  UpdateAgentConfigDto,
  RegisterSkillDto,
  CreateNamespaceDto,
  FinOpsStatsDto,
  FinOpsDistributionDto,
  TokenLogDto,
} from './finops.dto';

@Injectable()
export class FinOpsService {
  private readonly logger = new Logger(FinOpsService.name);

  /**
   * P2-D budget-alert dedup: tenantId → last YYYY-MM-DD an over-budget email
   * was sent. In-memory (single-node); multi-replica setups may send one email
   * per replica per day, which is acceptable for an alert.
   */
  private readonly budgetAlertSentDay = new Map<string, string>();

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Optional() private readonly emailService?: EmailService,
  ) {}

  // ════════════════════════════════════════════════════════════
  // FinOps Config — Get/Upsert/Update
  // ════════════════════════════════════════════════════════════

  async getOrCreateConfig(tenantId: string) {
    // Try direct lookup first (fast path)
    let config = await (this.prisma as any).finOpsConfig.findUnique({
      where: { tenantId },
    });
    if (config) return config;

    // Resolve to a valid tenant — prevents FK constraint violation
    const resolvedTenantId = await this.resolveTenantId(tenantId);

    // Check again with resolved tenant (may differ from original)
    if (resolvedTenantId !== tenantId) {
      config = await (this.prisma as any).finOpsConfig.findUnique({
        where: { tenantId: resolvedTenantId },
      });
      if (config) return config;
    }

    // Still no config — check if any tenant exists at all
    const tenantExists = await (this.prisma as any).tenant.findUnique({
      where: { id: resolvedTenantId },
      select: { id: true },
    });

    if (!tenantExists) {
      // No valid tenant — return safe in-memory defaults
      this.logger.warn('No valid tenant found. Returning in-memory default FinOpsConfig.');
      return this.getDefaultConfig(tenantId);
    }

    // Create config with the valid tenant
    try {
      config = await (this.prisma as any).finOpsConfig.create({
        data: {
          tenantId: resolvedTenantId,
          cacheEnabled: true,
          routerEnabled: true,
          packerEnabled: true,
        },
      });
      this.logger.log(`Created default FinOpsConfig for tenant ${resolvedTenantId}`);
    } catch (createErr: any) {
      // P2002 = unique constraint (race condition), P2003 = FK violation
      if (createErr.code === 'P2002') {
        config = await (this.prisma as any).finOpsConfig.findUnique({
          where: { tenantId: resolvedTenantId },
        });
      } else if (createErr.code === 'P2003') {
        this.logger.warn(`FK violation creating FinOpsConfig. Returning in-memory defaults.`);
        return this.getDefaultConfig(tenantId);
      } else {
        throw createErr;
      }
    }

    return config;
  }

  /** Safe in-memory defaults when DB config cannot be created */
  private getDefaultConfig(tenantId: string) {
    return {
      id: 'default-inmemory',
      tenantId,
      cacheEnabled: true,
      cacheBackend: 'redis',
      cacheSimilarityThreshold: 0.93,
      cacheTtlSeconds: 86400,
      cacheEmbeddingModel: 'text-embedding-3-small',
      cacheMaxMemoryMb: 1024,
      cacheWarmupEntries: 100,
      cacheExcludePatterns: [],
      routerEnabled: true,
      routerStage1Enabled: true,
      routerStage2Enabled: true,
      routerClassifierModel: 'claude-haiku-4.5',
      routerFallbackTier: 2,
      routerTier1Models: ['claude-haiku-4.5', 'gemini-3-flash', 'gpt-4o-mini'],
      routerTier2Models: ['claude-sonnet-4.6', 'gpt-4o', 'gemini-3.1-pro'],
      routerTier3Models: ['claude-opus-4.6', 'o3', 'gpt-5'],
      packerEnabled: true,
      packerMaxTokensPerSkill: 2000,
      packerOutputFormat: 'JSON',
      alertCacheHitMinPct: 20,
      alertDailyCostMax: 50.0,
      alertTier3MaxPct: 30,
      alertResponseDelayMs: 5000,
      alertSlackEnabled: false,
      alertSlackChannel: '#finops-alerts',
      alertEmailEnabled: false,
      alertEmailAddress: '',
      alertPagerDutyEnabled: false,
    };
  }

  async getConfig(tenantId: string) {
    return this.getOrCreateConfig(tenantId);
  }

  async updateConfig(tenantId: string, data: UpdateFinOpsConfigDto) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);

    const config = await (this.prisma as any).finOpsConfig.findUnique({
      where: { tenantId: resolvedTenantId },
    });

    if (!config) {
      // If no config exists yet, create one with the update data
      try {
        return await (this.prisma as any).finOpsConfig.create({
          data: {
            tenantId: resolvedTenantId,
            ...data,
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2003') {
          this.logger.warn(
            `FK violation in updateConfig for tenant "${resolvedTenantId}", returning default config`,
          );
          return { ...this.getDefaultConfig(resolvedTenantId), ...data };
        }
        throw err;
      }
    }

    return (this.prisma as any).finOpsConfig.update({
      where: { tenantId: resolvedTenantId },
      data,
    });
  }

  // ════════════════════════════════════════════════════════════
  // Agent Configs
  // ════════════════════════════════════════════════════════════

  async listAgentConfigs(tenantId: string) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    return (this.prisma as any).finOpsAgentConfig.findMany({
      where: { tenantId: resolvedTenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAgentConfig(tenantId: string, agentName: string) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const config = await (this.prisma as any).finOpsAgentConfig.findUnique({
      where: { tenantId_agentName: { tenantId: resolvedTenantId, agentName } },
    });

    if (!config) {
      throw new NotFoundException(`Agent config not found for agent "${agentName}"`);
    }

    return config;
  }

  async upsertAgentConfig(
    tenantId: string,
    agentName: string,
    data: CreateAgentConfigDto | UpdateAgentConfigDto,
  ) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);

    return (this.prisma as any).finOpsAgentConfig.upsert({
      where: { tenantId_agentName: { tenantId: resolvedTenantId, agentName } },
      create: {
        tenantId: resolvedTenantId,
        agentName,
        ...data,
      },
      update: data,
    });
  }

  /**
   * Resolve tenantId — validate the JWT tenantId exists in the Tenant table.
   * If it does not exist, THROW (never fall back to another tenant, which would
   * be a cross-tenant data breach). Prevents FK constraint violations too.
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

  // ════════════════════════════════════════════════════════════
  // Skills
  // ════════════════════════════════════════════════════════════

  async listSkills(tenantId: string) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    return (this.prisma as any).finOpsSkill.findMany({
      where: { tenantId: resolvedTenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async registerSkill(tenantId: string, data: RegisterSkillDto) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    return (this.prisma as any).finOpsSkill.upsert({
      where: { tenantId_skillId: { tenantId: resolvedTenantId, skillId: data.skillId } },
      create: {
        tenantId: resolvedTenantId,
        ...data,
      },
      update: {
        name: data.name,
        defaultTier: data.defaultTier ?? undefined,
        status: data.status ?? undefined,
      },
    });
  }

  async updateSkillInvocationCount(tenantId: string, skillId: string, increment = 1) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    return (this.prisma as any).finOpsSkill
      .update({
        where: { tenantId_skillId: { tenantId: resolvedTenantId, skillId } },
        data: {
          invocationCount: {
            increment,
          },
        },
      })
      .catch(() => {
        // Skill not found, skip update
        return null;
      });
  }

  // ════════════════════════════════════════════════════════════
  // Namespaces
  // ════════════════════════════════════════════════════════════

  async listNamespaces(tenantId: string) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    return (this.prisma as any).finOpsNamespace.findMany({
      where: { tenantId: resolvedTenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addNamespace(tenantId: string, data: CreateNamespaceDto) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    return (this.prisma as any).finOpsNamespace.create({
      data: {
        tenantId: resolvedTenantId,
        ...data,
      },
    });
  }

  async getNamespace(tenantId: string, namespace: string) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const ns = await (this.prisma as any).finOpsNamespace.findUnique({
      where: { tenantId_namespace: { tenantId: resolvedTenantId, namespace } },
    });

    if (!ns) {
      throw new NotFoundException(`Namespace "${namespace}" not found`);
    }

    return ns;
  }

  async updateNamespaceMetrics(
    tenantId: string,
    namespace: string,
    cacheEntries: number,
    hitRate: number,
  ) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    return (this.prisma as any).finOpsNamespace
      .update({
        where: { tenantId_namespace: { tenantId: resolvedTenantId, namespace } },
        data: {
          cacheEntries,
          hitRate,
        },
      })
      .catch(() => {
        // Namespace not found, skip update
        return null;
      });
  }

  // ════════════════════════════════════════════════════════════
  // Token Logging
  // ════════════════════════════════════════════════════════════

  async logTokenUsage(
    tenantId: string,
    logData: {
      agentName: string;
      executionSessionId?: string;
      nodeId?: string;
      promptText?: string;
      promptEmbedding?: number[];
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cacheHit?: boolean;
      cachedResponseUsed?: boolean;
      routedTier?: number;
      routedModel?: string;
      originalCostUsd?: number;
      optimizedCostUsd?: number;
      savedUsd?: number;
      responseTimeMs?: number;
      // ── Patent 3: policy-aware FinOps audit fields ──
      policyHash?: string;
      governanceFingerprintHash?: string;
      dataClass?: string;
      riskScore?: number;
      cacheKey?: string;
      cachePolicyDecision?: string;
      cacheDecisionReasonJson?: unknown;
      promptHash?: string;
      routeReasonJson?: unknown;
      evidencePackId?: string;
      workflowId?: string;
      nodeKey?: string;
      skillId?: string;
    },
  ) {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const created = await (this.prisma as any).finOpsTokenLog.create({
      data: {
        tenantId: resolvedTenantId,
        ...logData,
      },
    });
    // P2-D: best-effort daily budget check — never blocks the log write.
    void this.checkDailyBudget(resolvedTenantId).catch(() => {});
    return created;
  }

  /**
   * P2-D: when today's spend exceeds FinOpsConfig.alertDailyCostMax, send the
   * configured alert email (once per tenant per day). Previously the alert
   * thresholds were saved but nothing ever fired.
   */
  private async checkDailyBudget(tenantId: string): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    if (this.budgetAlertSentDay.get(tenantId) === today) return;

    const config = await (this.prisma as any).finOpsConfig.findUnique({ where: { tenantId } });
    if (!config?.alertEmailEnabled || !config?.alertEmailAddress) return;
    const limit = Number(config.alertDailyCostMax ?? 0);
    if (!(limit > 0)) return;

    const since = new Date(`${today}T00:00:00.000Z`);
    const agg = await (this.prisma as any).finOpsTokenLog.aggregate({
      _sum: { optimizedCostUsd: true },
      where: { tenantId, createdAt: { gte: since } },
    });
    const spent = agg?._sum?.optimizedCostUsd ?? 0;
    if (spent < limit) return;

    // Mark BEFORE sending so a slow/failing SMTP cannot trigger duplicates.
    this.budgetAlertSentDay.set(tenantId, today);

    this.logger.warn(
      `[finops] Daily budget exceeded for tenant ${tenantId}: $${spent.toFixed(4)} >= $${limit}`,
    );

    if (this.emailService) {
      const result = await this.emailService
        .sendEmail({
          to: config.alertEmailAddress,
          subject: `[Metis.AI FinOps] 일일 비용 한도 초과 — $${spent.toFixed(2)} / $${limit}`,
          body:
            `오늘(${today}) LLM 사용 비용이 설정된 일일 한도를 초과했습니다.\n\n` +
            `- 현재 지출: $${spent.toFixed(4)}\n` +
            `- 일일 한도: $${limit}\n\n` +
            `FinOps 대시보드에서 에이전트별 사용량을 확인하세요.`,
        } as any)
        .catch((err: any) => ({ success: false, error: err.message }));
      if (!(result as any)?.success) {
        this.logger.warn(`[finops] budget alert email failed: ${(result as any)?.error ?? 'unknown'}`);
      }
    }

    // Audit trail regardless of email outcome.
    await (this.prisma as any).auditLog
      .create({
        data: {
          actorUserId: null,
          tenantId,
          action: 'POLICY_CHECK', // closest AuditAction enum member for a budget alert
          targetType: 'FinOpsConfig',
          targetId: tenantId,
          correlationId: `finops-budget-${today}`,
          metadataJson: { kind: 'DAILY_BUDGET_EXCEEDED', spentUsd: spent, limitUsd: limit },
        },
      })
      .catch(() => {});
  }

  async getTokenLogs(
    tenantId: string,
    options: {
      agentName?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const { agentName, limit = 50, offset = 0 } = options;
    const resolvedTenantId = await this.resolveTenantId(tenantId);

    const where: any = { tenantId: resolvedTenantId };
    if (agentName) {
      where.agentName = agentName;
    }

    const logs = await (this.prisma as any).finOpsTokenLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    });

    const total = await (this.prisma as any).finOpsTokenLog.count({ where });

    return {
      logs: logs as TokenLogDto[],
      total,
      limit,
      offset,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Statistics
  // ════════════════════════════════════════════════════════════

  async getStats(tenantId: string): Promise<FinOpsStatsDto> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all logs for today
    const logs = await (this.prisma as any).finOpsTokenLog.findMany({
      where: {
        tenantId: resolvedTenantId,
        createdAt: { gte: today },
      },
    });

    const totalRequests = logs.length;
    const cacheHits = logs.filter((l: any) => l.cacheHit).length;
    const cacheHitRate = totalRequests > 0 ? (cacheHits / totalRequests) * 100 : 0;

    const estimatedDailyCostUsd = logs.reduce(
      (sum: number, l: any) => sum + (l.optimizedCostUsd || 0),
      0,
    );
    const estimatedSavingsUsd = logs.reduce((sum: number, l: any) => sum + (l.savedUsd || 0), 0);

    const avgResponseTimeMs =
      totalRequests > 0
        ? logs.reduce((sum: number, l: any) => sum + (l.responseTimeMs || 0), 0) / totalRequests
        : 0;

    // Get requests by tier
    const requestsByTier = {
      tier1: logs.filter((l: any) => l.routedTier === 1).length,
      tier2: logs.filter((l: any) => l.routedTier === 2).length,
      tier3: logs.filter((l: any) => l.routedTier === 3).length,
    };

    // Get top agents
    const agentStats = new Map<string, any>();
    for (const log of logs) {
      if (!agentStats.has(log.agentName)) {
        agentStats.set(log.agentName, {
          agentName: log.agentName,
          requestCount: 0,
          cacheHits: 0,
          savedUsd: 0,
        });
      }
      const stats = agentStats.get(log.agentName);
      stats.requestCount += 1;
      if (log.cacheHit) stats.cacheHits += 1;
      stats.savedUsd += log.savedUsd || 0;
    }

    const topAgents = Array.from(agentStats.values())
      .map((stats) => ({
        ...stats,
        cacheHitRate: stats.requestCount > 0 ? (stats.cacheHits / stats.requestCount) * 100 : 0,
      }))
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, 10);

    // Hourly trend (last 6 hours)
    const hourlyTrend: any[] = [];
    for (let i = 5; i >= 0; i--) {
      const hour = new Date(today);
      hour.setHours(today.getHours() - i);
      const nextHour = new Date(hour);
      nextHour.setHours(hour.getHours() + 1);

      const hourLogs = logs.filter((l: any) => l.createdAt >= hour && l.createdAt < nextHour);

      hourlyTrend.push({
        hour: hour.toISOString().substring(0, 13),
        requests: hourLogs.length,
        cacheHits: hourLogs.filter((l: any) => l.cacheHit).length,
        avgCostUsd:
          hourLogs.length > 0
            ? hourLogs.reduce((sum: number, l: any) => sum + (l.optimizedCostUsd || 0), 0) /
              hourLogs.length
            : 0,
      });
    }

    return {
      totalRequests,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      estimatedDailyCostUsd: Math.round(estimatedDailyCostUsd * 100) / 100,
      estimatedSavingsUsd: Math.round(estimatedSavingsUsd * 100) / 100,
      avgResponseTimeMs: Math.round(avgResponseTimeMs),
      requestsByTier,
      topAgents,
      hourlyTrend,
    };
  }

  async getDistribution(tenantId: string): Promise<FinOpsDistributionDto> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const logs = await (this.prisma as any).finOpsTokenLog.findMany({
      where: {
        tenantId: resolvedTenantId,
        createdAt: { gte: today },
      },
    });

    const tier1Count = logs.filter((l: any) => l.routedTier === 1).length;
    const tier2Count = logs.filter((l: any) => l.routedTier === 2).length;
    const tier3Count = logs.filter((l: any) => l.routedTier === 3).length;
    const cacheHitCount = logs.filter((l: any) => l.cacheHit).length;
    const cacheMissCount = logs.length - cacheHitCount;
    const totalRequests = logs.length;

    return {
      tier1Count,
      tier2Count,
      tier3Count,
      cacheHitCount,
      cacheMissCount,
      totalRequests,
      cacheHitPercentage:
        totalRequests > 0 ? Math.round((cacheHitCount / totalRequests) * 100 * 100) / 100 : 0,
    };
  }
}
