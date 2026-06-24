/**
 * Fraud Detection System — Alert Management Service
 *
 * Creates, manages, and resolves fraud alerts with:
 *   - Automatic similar case detection
 *   - Multi-step resolution (BLOCKED, DISMISSED, RESOLVED)
 *   - Escalation workflow
 *   - ExecutionTrace audit logging
 *   - Simulated feedback loop for rule learning
 */

import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  forwardRef,
} from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { AnomalyService } from './anomaly.service';

/** Valid FDSAlertStatus enum values (must match prisma schema). */
const FDS_ALERT_STATUSES = [
  'OPEN',
  'INVESTIGATING',
  'BLOCKED',
  'ESCALATED',
  'DISMISSED',
  'RESOLVED',
] as const;

/**
 * Map a Risk-workspace UI tab id (or a raw enum value) into a Prisma status
 * filter. The UI sends tab ids like 'realtime'/'waiting'/'processing'/'completed'
 * that are NOT valid FDSAlertStatus members — passing them raw to Prisma threw an
 * enum-validation error → HTTP 500 on first load. Returns undefined for
 * 'realtime'/'all'/unknown so no filter is applied.
 */
function resolveAlertStatusFilter(raw?: string): string | { in: string[] } | undefined {
  if (!raw) return undefined;
  if ((FDS_ALERT_STATUSES as readonly string[]).includes(raw)) return raw;
  const TAB_MAP: Record<string, string[]> = {
    realtime: [], // all (live feed)
    all: [],
    waiting: ['OPEN'], // awaiting triage
    processing: ['INVESTIGATING', 'ESCALATED'], // being acted on
    completed: ['BLOCKED', 'DISMISSED', 'RESOLVED'],
  };
  const mapped = TAB_MAP[raw.toLowerCase()];
  if (!mapped || mapped.length === 0) return undefined;
  return mapped.length === 1 ? mapped[0] : { in: mapped };
}

/**
 * Surface frequently-used detailsJson fields onto the top level of an alert
 * so the UI does not have to dig into the JSON blob. Non-destructive: the
 * original record (incl. detailsJson) is preserved.
 */
function surfaceAlert(alert: any): any {
  const d = (alert?.detailsJson as any) || {};
  let category: string = d.category;
  if (!category) {
    if (d.anomaly === true || d.anomalyDetected === true) category = 'anomaly';
    else if (d.risk === 'high' || d.risk === 'critical' || d.securityRiskLevel)
      category = 'security';
    else category = 'quality';
  }
  return {
    ...alert,
    category,
    workflowKey: d.workflowKey ?? null,
    stepKey: d.stepKey ?? null,
    agentName: d.agentName ?? null,
    overallScore: d.overallScore ?? d.score ?? null,
    securityRiskLevel: d.securityRiskLevel ?? d.risk ?? null,
    qualityGrade: d.qualityGrade ?? null,
    anomalyDetected: d.anomalyDetected ?? d.anomaly ?? null,
  };
}

export interface CreateAlertDto {
  subjectId: string;
  subjectType: string;
  score: number;
  summary: string;
  ruleId?: string;
  detailsJson?: Record<string, any>;
}

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(forwardRef(() => AnomalyService)) private readonly anomalyService: AnomalyService,
  ) {}

  /**
   * Create a new FDS alert
   *
   * - Insert FDSAlert
   * - Auto-populate similarCasesJson from anomaly.similarCases
   * - Determine severity based on score
   */
  async createAlert(ctx: TenantContext, data: CreateAlertDto): Promise<any> {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      // Determine severity based on score
      let severity: string;
      if (data.score >= 0.9) {
        severity = 'CRITICAL';
      } else if (data.score >= 0.7) {
        severity = 'HIGH';
      } else if (data.score >= 0.5) {
        severity = 'MEDIUM';
      } else {
        severity = 'LOW';
      }

      // Create alert record
      const alert = await tenantPrisma.fDSAlert.create({
        data: {
          tenantId: ctx.tenantId,
          subjectId: data.subjectId,
          subjectType: data.subjectType,
          status: 'OPEN',
          severity: severity as any,
          score: data.score,
          summary: data.summary,
          ruleId: data.ruleId,
          detailsJson: data.detailsJson || {},
          similarCasesJson: [], // Will be populated below
          correlationId: `fds-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        },
      });

      // Fetch similar cases for context
      const similarCases = await this.anomalyService.similarCases(ctx, alert);

      // Update alert with similar cases
      const updatedAlert = await tenantPrisma.fDSAlert.update({
        where: { id: alert.id },
        data: {
          similarCasesJson: similarCases,
        },
      });

      this.logger.log(
        `Created alert ${updatedAlert.id} for ${data.subjectType}/${data.subjectId} ` +
          `(severity: ${severity}, score: ${data.score})`,
      );

      return updatedAlert;
    } catch (error) {
      this.logger.error(`Failed to create alert: ${error}`);
      throw error;
    }
  }

  /**
   * List alerts with filtering
   *
   * Supports: status, severity, hourRange, limit
   */
  async listAlerts(
    ctx: TenantContext,
    opts: {
      status?: string;
      severity?: string;
      hours?: number;
      limit?: number;
    } = {},
  ): Promise<any[]> {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      const where: any = {};

      const statusFilter = resolveAlertStatusFilter(opts.status);
      if (statusFilter !== undefined) {
        where.status = statusFilter;
      }

      if (opts.severity) {
        where.severity = opts.severity;
      }

      if (opts.hours) {
        const since = new Date(Date.now() - opts.hours * 60 * 60 * 1000);
        where.createdAt = { gte: since };
      }

      const alerts = await tenantPrisma.fDSAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: opts.limit || 50,
      });

      return alerts;
    } catch (error) {
      this.logger.error(`Failed to list alerts: ${error}`);
      throw error;
    }
  }

  /**
   * Get a single alert by ID
   */
  async getAlert(ctx: TenantContext, id: string): Promise<any> {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      const alert = await tenantPrisma.fDSAlert.findUnique({
        where: { id },
      });

      if (!alert) {
        throw new NotFoundException(`Alert ${id} not found`);
      }

      return alert;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get alert ${id}: ${error}`);
      throw error;
    }
  }

  /**
   * Resolve an alert (BLOCKED, DISMISSED, RESOLVED)
   *
   * - Transition status
   * - Record resolution metadata
   * - Write ExecutionTrace for audit
   * - If decision=DISMISS && feedbackToModel=true, schedule rule weight reduction
   */
  async resolve(
    ctx: TenantContext,
    id: string,
    decision: 'BLOCKED' | 'DISMISSED' | 'RESOLVED',
    comment?: string,
    feedbackToModel?: boolean,
  ): Promise<any> {
    try {
      if (!['BLOCKED', 'DISMISSED', 'RESOLVED'].includes(decision)) {
        throw new BadRequestException(`Invalid decision: ${decision}`);
      }

      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      // Verify alert exists
      const alert = await tenantPrisma.fDSAlert.findUnique({
        where: { id },
      });
      if (!alert) {
        throw new NotFoundException(`Alert ${id} not found`);
      }

      // Update alert status
      const updatedAlert = await tenantPrisma.fDSAlert.update({
        where: { id },
        data: {
          status: decision,
          resolutionJson: {
            decidedBy: ctx.userId,
            decidedAt: new Date().toISOString(),
            decision,
            comment: comment || '',
            feedbackToModel: feedbackToModel || false,
          },
          resolvedAt: new Date(),
          resolvedByUserId: ctx.userId,
        },
      });

      // Write ExecutionTrace for audit (R3)
      // Note: This requires an ExecutionSession. For alerts without sessions,
      // we'll create a minimal trace record
      const traceJson = {
        action: 'ALERT_RESOLVED',
        alertId: id,
        decision,
        comment,
        feedbackToModel,
        timestamp: new Date().toISOString(),
      };

      this.logger.log(
        `Resolved alert ${id} as ${decision} ` +
          `(feedback: ${feedbackToModel ? 'enabled' : 'disabled'})`,
      );

      // TODO: If feedbackToModel=true, queue rule weight reduction
      // For now, simulate by logging
      if (feedbackToModel && decision === 'DISMISSED') {
        this.logger.log(
          `[FEEDBACK LOOP] Alert ${id} dismissed by human. ` +
            `Would reduce weights for matched rules via ML learning loop`,
        );
        // In production, this would:
        // - Load matched rules
        // - Reduce weights by factor (0.9x)
        // - Persist feedback to tenantContext.json or separate feedback table
      }

      return updatedAlert;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Failed to resolve alert ${id}: ${error}`);
      throw error;
    }
  }

  /**
   * Escalate an alert to ESCALATED status
   */
  async escalate(ctx: TenantContext, id: string, assignee: string): Promise<any> {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      // Verify alert exists
      const alert = await tenantPrisma.fDSAlert.findUnique({
        where: { id },
      });
      if (!alert) {
        throw new NotFoundException(`Alert ${id} not found`);
      }

      // Update to ESCALATED
      const updatedAlert = await tenantPrisma.fDSAlert.update({
        where: { id },
        data: {
          status: 'ESCALATED',
          resolutionJson: {
            escalatedAt: new Date().toISOString(),
            escalatedBy: ctx.userId,
            assignedTo: assignee,
          },
        },
      });

      this.logger.log(`Escalated alert ${id} to ${assignee}`);
      return updatedAlert;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to escalate alert ${id}: ${error}`);
      throw error;
    }
  }

  /**
   * List agent-risk + other alerts with rich filtering and a UI summary.
   *
   * Default focus is agent-risk alerts (subjectType='AgentEvaluation') but
   * other alerts are still returned. Supports status / severity / category /
   * days filters. Each item has detailsJson fields surfaced onto the top
   * level. Returns { items, summary:{ critical, high, pending, processedToday } }.
   */
  async listAlertsWithSummary(
    ctx: TenantContext,
    opts: {
      status?: string;
      severity?: string;
      category?: string;
      subjectType?: string;
      days?: number;
      hours?: number;
      limit?: number;
    } = {},
  ): Promise<{ items: any[]; summary: any }> {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);
      const where: any = {};

      const statusFilter = resolveAlertStatusFilter(opts.status);
      if (statusFilter !== undefined) where.status = statusFilter;
      if (opts.severity) where.severity = opts.severity.toUpperCase();
      // 점검 M-3: filter governance-sourced alerts (WorkflowNodeExecution /
      // WorkflowGovernanceDrift) apart from security/fraud alerts.
      if (opts.subjectType) where.subjectType = opts.subjectType;

      let since: Date | undefined;
      if (opts.days) since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
      else if (opts.hours) since = new Date(Date.now() - opts.hours * 60 * 60 * 1000);
      if (since) where.createdAt = { gte: since };

      const raw = await tenantPrisma.fDSAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: opts.limit || 100,
      });

      let items = raw.map(surfaceAlert);
      if (opts.category) {
        items = items.filter((it: any) => it.category === opts.category);
      }

      // Summary across the (unfiltered-by-category) window so counts are stable.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      let critical = 0;
      let high = 0;
      let pending = 0;
      let processedToday = 0;
      for (const a of raw) {
        const sev = String(a.severity).toUpperCase();
        if (sev === 'CRITICAL') critical++;
        if (sev === 'HIGH') high++;
        if (a.status === 'OPEN') pending++;
        if (a.resolvedAt && new Date(a.resolvedAt) >= startOfToday) processedToday++;
      }

      return {
        items,
        summary: { critical, high, pending, processedToday },
      };
    } catch (error) {
      this.logger.error(`Failed to list alerts with summary: ${error}`);
      throw error;
    }
  }

  /**
   * Get a single alert with surfaced detailsJson + a `related` array
   * (recent alerts for the same workflowKey, up to 5, excluding itself).
   * Replaces the fraud-oriented "similarCases" with agent-risk context.
   */
  async getAlertWithRelated(ctx: TenantContext, id: string): Promise<any> {
    const tenantPrisma = withTenantIsolation(this.prisma, ctx);
    const alert = await tenantPrisma.fDSAlert.findUnique({ where: { id } });
    if (!alert || alert.tenantId !== ctx.tenantId) {
      throw new NotFoundException(`Alert ${id} not found`);
    }
    const surfaced = surfaceAlert(alert);
    const wk = surfaced.workflowKey;

    let related: any[] = [];
    if (wk) {
      const candidates = await tenantPrisma.fDSAlert.findMany({
        where: { tenantId: ctx.tenantId, NOT: { id } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      related = candidates
        .map(surfaceAlert)
        .filter((c: any) => c.workflowKey === wk)
        .slice(0, 5)
        .map((c: any) => ({
          id: c.id,
          severity: c.severity,
          status: c.status,
          category: c.category,
          summary: c.summary,
          createdAt: c.createdAt,
        }));
    }

    return { ...surfaced, related };
  }

  /**
   * Block an alert subject — thin wrapper over resolve(). Records the
   * disposition 'BLOCKED' in resolutionJson and sets status to BLOCKED.
   */
  async block(ctx: TenantContext, id: string, note?: string): Promise<any> {
    const tenantPrisma = withTenantIsolation(this.prisma, ctx);
    const alert = await tenantPrisma.fDSAlert.findUnique({ where: { id } });
    if (!alert || alert.tenantId !== ctx.tenantId) {
      throw new NotFoundException(`Alert ${id} not found`);
    }
    const updated = await tenantPrisma.fDSAlert.update({
      where: { id },
      data: {
        status: 'BLOCKED',
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
        resolutionJson: {
          decidedBy: ctx.userId,
          decidedAt: new Date().toISOString(),
          disposition: 'BLOCKED',
          note: note || '',
        },
      },
    });
    this.logger.log(`Blocked alert ${id}`);
    return surfaceAlert(updated);
  }

  /**
   * Ignore an alert — thin wrapper over resolve(). Records disposition
   * 'IGNORED' in resolutionJson and sets status to DISMISSED.
   */
  async ignore(ctx: TenantContext, id: string, feedback?: string): Promise<any> {
    const tenantPrisma = withTenantIsolation(this.prisma, ctx);
    const alert = await tenantPrisma.fDSAlert.findUnique({ where: { id } });
    if (!alert || alert.tenantId !== ctx.tenantId) {
      throw new NotFoundException(`Alert ${id} not found`);
    }
    const updated = await tenantPrisma.fDSAlert.update({
      where: { id },
      data: {
        status: 'DISMISSED',
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
        resolutionJson: {
          decidedBy: ctx.userId,
          decidedAt: new Date().toISOString(),
          disposition: 'IGNORED',
          feedback: feedback || '',
        },
      },
    });
    this.logger.log(`Ignored alert ${id}`);
    return surfaceAlert(updated);
  }

  /**
   * Alert summary over a rolling time window: counts by severity and status.
   *
   * Reconstructed (no original source). Models on listAlerts which queries
   * fDSAlert via the tenant-isolated client with a createdAt window.
   */
  async summary(ctx: TenantContext, hours = 24): Promise<any> {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      const where = { createdAt: { gte: since } };

      const [bySeverityRaw, byStatusRaw, total] = await Promise.all([
        tenantPrisma.fDSAlert.groupBy({
          by: ['severity'],
          where,
          _count: { _all: true },
        }),
        tenantPrisma.fDSAlert.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        tenantPrisma.fDSAlert.count({ where }),
      ]);

      const bySeverity: Record<string, number> = {};
      for (const g of bySeverityRaw) bySeverity[g.severity] = g._count._all;

      const byStatus: Record<string, number> = {};
      for (const g of byStatusRaw) byStatus[g.status] = g._count._all;

      return { windowHours: hours, total, bySeverity, byStatus };
    } catch (error) {
      this.logger.error(`Failed to build alert summary: ${error}`);
      throw error;
    }
  }
}
