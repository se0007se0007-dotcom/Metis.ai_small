/**
 * Promotion Service — Phase 3: Version Promotion / Rollback
 *
 * Responsibilities:
 *   - Manual version promotion (outside canary flow)
 *   - Manual rollback (emergency or planned)
 *   - Promotion/rollback history and audit trail
 *   - Evaluation summary capture at decision time
 */
import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import type { PromotionRequest } from '@metis/types';

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ═══════════════════════════════════════════
  //  Manual Promotion
  // ═══════════════════════════════════════════

  async promote(ctx: TenantContext, req: PromotionRequest) {
    const db = withTenantIsolation(this.prisma, ctx);

    // Validate versions exist
    // (In production, validate against PackVersion records)

    // Capture evaluation summary if replay/canary source is referenced
    let evaluationSummary: Record<string, unknown> | null = null;
    if (req.sourceType === 'REPLAY' && req.sourceId) {
      const run = await db.replayRun.findFirst({ where: { id: req.sourceId } });
      if (run) {
        evaluationSummary = {
          type: 'REPLAY',
          runId: run.id,
          status: run.status,
          totalCases: run.totalCases,
          passedCases: run.passedCases,
          failedCases: run.failedCases,
          metrics: run.metricsJson,
        };
      }
    } else if (req.sourceType === 'CANARY' && req.sourceId) {
      const canary = await db.canaryDeployment.findFirst({
        where: { id: req.sourceId },
        include: { gates: { orderBy: { windowNumber: 'desc' }, take: 1 } },
      });
      if (canary) {
        evaluationSummary = {
          type: 'CANARY',
          deploymentId: canary.id,
          status: canary.status,
          finalTrafficPct: canary.currentTrafficPct,
          lastGateResult: canary.gates[0]?.result,
        };
      }
    }

    const promotion = await db.versionPromotion.create({
      data: {
        tenantId: ctx.tenantId,
        packId: req.packId,
        fromVersionId: req.fromVersionId,
        toVersionId: req.toVersionId,
        action: req.action,
        reason: req.reason ?? (req.action === 'PROMOTE' ? 'Manual promotion' : 'Manual rollback'),
        sourceType: req.sourceType ?? 'MANUAL',
        sourceId: req.sourceId,
        evaluationSummaryJson: evaluationSummary
          ? JSON.parse(JSON.stringify(evaluationSummary))
          : undefined,
        decidedById: ctx.userId,
        isEmergency: req.isEmergency ?? false,
        ...(req.action === 'ROLLBACK' ? { rollbackFromVersionId: req.fromVersionId } : {}),
      },
    });

    const auditAction = req.action === 'PROMOTE' ? 'VERSION_PROMOTE' : 'VERSION_ROLLBACK';
    await this.writeAudit(ctx, auditAction, 'VersionPromotion', promotion.id, {
      packId: req.packId,
      fromVersionId: req.fromVersionId,
      toVersionId: req.toVersionId,
      action: req.action,
      reason: req.reason,
      isEmergency: req.isEmergency,
      sourceType: req.sourceType,
    });

    this.logger.log(
      `Version ${req.action}: ${req.fromVersionId} → ${req.toVersionId} (pack: ${req.packId})`,
    );

    return promotion;
  }

  // ═══════════════════════════════════════════
  //  History
  // ═══════════════════════════════════════════

  async listHistory(
    ctx: TenantContext,
    filters: {
      packId?: string;
      action?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const db = withTenantIsolation(this.prisma, ctx);
    const ps = Math.min(filters.pageSize ?? 20, 100);
    const page = Math.max(filters.page ?? 1, 1);
    const where: any = {};
    if (filters.packId) where.packId = filters.packId;
    if (filters.action) where.action = filters.action;

    const [items, total] = await Promise.all([
      db.versionPromotion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * ps,
        take: ps,
      }),
      db.versionPromotion.count({ where }),
    ]);

    return { items, total, page, pageSize: ps, hasMore: page * ps < total };
  }

  async getById(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const promotion = await db.versionPromotion.findFirst({ where: { id } });
    if (!promotion) throw new NotFoundException(`Promotion record ${id} not found`);
    return promotion;
  }

  // ── Audit Helper ──

  private async writeAudit(
    ctx: TenantContext,
    action: string,
    targetType: string,
    targetId: string,
    metadata: any,
  ) {
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: action as any,
          targetType,
          targetId,
          correlationId: `release-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          metadataJson: metadata,
        },
      })
      .catch((e: any) => {
        this.logger.warn(`Audit write failed for ${action}: ${e.message}`);
      });
  }

  // ── Aggregated Stats ──

  async getStats(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);

    const promotions = await db.versionPromotion.findMany({});

    const totalPromotions = promotions.length;
    const actionCounts = {
      PROMOTE: promotions.filter((p: any) => p.action === 'PROMOTE').length,
      ROLLBACK: promotions.filter((p: any) => p.action === 'ROLLBACK').length,
    };

    const sourceCounts = {
      CANARY: promotions.filter((p: any) => p.sourceType === 'CANARY').length,
      REPLAY: promotions.filter((p: any) => p.sourceType === 'REPLAY').length,
      MANUAL: promotions.filter((p: any) => p.sourceType === 'MANUAL').length,
      UNKNOWN: promotions.filter((p: any) => !p.sourceType).length,
    };

    const emergencyCount = promotions.filter((p: any) => p.isEmergency).length;
    const recentCount = promotions.filter((p: any) => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      return p.decidedAt >= dayAgo;
    }).length;

    return {
      totalPromotions,
      actionDistribution: actionCounts,
      sourceDistribution: sourceCounts,
      emergencyRollbackCount: emergencyCount,
      recentPromotions24h: recentCount,
      rollbackRate:
        totalPromotions > 0 ? Math.round((actionCounts.ROLLBACK / totalPromotions) * 100) / 100 : 0,
    };
  }
}
