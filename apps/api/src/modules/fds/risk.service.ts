/**
 * METIS Agent-Operational-Risk Service (FDS extension)
 *
 * Computes the agent-risk dashboard payloads from this tenant's
 * persisted AgentEvaluation + FDSAlert data. All queries are tenant-scoped
 * via withTenantIsolation; tenant ids are validated through resolveTenantId
 * (throws ForbiddenException on an unknown tenant — never falls back to
 * another tenant, consistent with the rest of the codebase).
 *
 * NOTE: this replaces the fraud-oriented framing of FDS with agent
 * operational risk. The underlying tables (AgentEvaluation, FDSAlert) are
 * reused as-is — no schema changes.
 */
import { Injectable, Inject, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

// ────────────────────────────────────────────────────────────────
// Pure helpers (no I/O) — unit tested in scripts/test-risk-anomaly.mjs
// ────────────────────────────────────────────────────────────────

export interface AgentRiskAccumulator {
  workflowKey: string;
  agentName: string;
  evaluations: number;
  sumQualityGap: number; // sum of (100 - overallScore)
  sumSecurityGap: number; // sum of (100 - securityScore)
  anomalyCount: number;
  qualityFailCount: number; // grade F or score < 60
  worstSecurity: string; // low|medium|high|critical
  openAlerts: number;
}

const SECURITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Pick the worst (highest) of two security risk levels. */
export function worseSecurity(a: string, b: string): string {
  const av = SECURITY_ORDER[a] ?? 0;
  const bv = SECURITY_ORDER[b] ?? 0;
  return av >= bv ? a : b;
}

/**
 * Derive a 0-100 risk score (higher = riskier) for one agent from its
 * accumulated evaluation metrics. Blends four signals:
 *   - avg quality gap   (100 - overallScore)   weight 0.35
 *   - avg security gap  (100 - securityScore)  weight 0.30
 *   - anomaly rate * 100                        weight 0.20
 *   - open-alert pressure (min(openAlerts,5)/5*100) weight 0.15
 */
export function computeAgentRiskScore(acc: AgentRiskAccumulator): number {
  const n = acc.evaluations > 0 ? acc.evaluations : 1;
  const avgQualityGap = acc.sumQualityGap / n;
  const avgSecurityGap = acc.sumSecurityGap / n;
  const anomalyRate = (acc.anomalyCount / n) * 100;
  const alertPressure = (Math.min(acc.openAlerts, 5) / 5) * 100;

  const score =
    avgQualityGap * 0.35 + avgSecurityGap * 0.3 + anomalyRate * 0.2 + alertPressure * 0.15;

  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Map an FDSAlert detailsJson into a high-level risk category. */
export function categoryOf(details: any, subjectType?: string): string {
  const c = details?.category;
  if (c === 'security' || c === 'quality' || c === 'anomaly' || c === 'cost' || c === 'policy') {
    return c;
  }
  // Heuristic fallbacks for legacy / seed alerts without a category
  if (details?.anomaly === true || details?.anomalyDetected === true) return 'anomaly';
  if (details?.risk === 'high' || details?.risk === 'critical' || details?.securityRiskLevel)
    return 'security';
  return 'quality';
}

/** Bucket a Date into a YYYY-MM-DD (UTC) string. */
export function dayBucket(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}

const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const;

/** Normalize a FDSSeverity enum value to a lowercase bucket key. */
export function severityKey(sev: string): (typeof SEVERITY_KEYS)[number] {
  const s = (sev || '').toLowerCase();
  return (SEVERITY_KEYS as readonly string[]).includes(s)
    ? (s as (typeof SEVERITY_KEYS)[number])
    : 'low';
}

// ────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * Resolve a (possibly slug/legacy) tenant identifier to a real Tenant.id.
   * NEVER falls back to another tenant — throws on an unknown id.
   */
  private async resolveTenantId(tenantId: string): Promise<string> {
    const tenant = await (this.prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (tenant) return tenant.id;
    throw new ForbiddenException('Invalid tenant');
  }

  /**
   * GET /fds/risk/overview — agent operational-risk dashboard payload.
   */
  async getRiskOverview(rawTenantId: string, days = 30): Promise<any> {
    const tenantId = await this.resolveTenantId(rawTenantId);
    const ctx: TenantContext = { tenantId, userId: 'system', role: 'AUDITOR' } as any;
    const tp = withTenantIsolation(this.prisma as any, ctx);
    const windowDays = Math.max(1, Math.min(365, days || 30));
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const [evaluations, alerts] = await Promise.all([
      tp.agentEvaluation.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: {
          workflowKey: true,
          agentName: true,
          overallScore: true,
          securityScore: true,
          securityRiskLevel: true,
          qualityGrade: true,
          anomalyDetected: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      }),
      tp.fDSAlert.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: {
          severity: true,
          status: true,
          subjectType: true,
          detailsJson: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      }),
    ]);

    // ── Totals over alerts ──
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    const byCategory = { security: 0, quality: 0, anomaly: 0, cost: 0, policy: 0 };
    let open = 0;
    for (const a of alerts) {
      bySeverity[severityKey(a.severity)]++;
      const cat = categoryOf(a.detailsJson, a.subjectType);
      if ((byCategory as any)[cat] !== undefined) (byCategory as any)[cat]++;
      if (a.status === 'OPEN') open++;
    }

    // ── Open-alert counts keyed by workflowKey (for per-agent pressure) ──
    const openByWorkflow: Record<string, number> = {};
    for (const a of alerts) {
      if (a.status !== 'OPEN') continue;
      const wk = (a.detailsJson as any)?.workflowKey || '';
      if (!wk) continue;
      openByWorkflow[wk] = (openByWorkflow[wk] || 0) + 1;
    }

    // ── Per-agent accumulation ──
    const accMap = new Map<string, AgentRiskAccumulator>();
    for (const e of evaluations) {
      const wk = e.workflowKey || 'unknown';
      const name = e.agentName || wk;
      const key = `${wk}::${name}`;
      let acc = accMap.get(key);
      if (!acc) {
        acc = {
          workflowKey: wk,
          agentName: name,
          evaluations: 0,
          sumQualityGap: 0,
          sumSecurityGap: 0,
          anomalyCount: 0,
          qualityFailCount: 0,
          worstSecurity: 'low',
          openAlerts: openByWorkflow[wk] || 0,
        };
        accMap.set(key, acc);
      }
      acc.evaluations++;
      acc.sumQualityGap += 100 - (e.overallScore ?? 0);
      acc.sumSecurityGap += 100 - (e.securityScore ?? 100);
      if (e.anomalyDetected) acc.anomalyCount++;
      if (e.qualityGrade === 'F' || (e.overallScore ?? 100) < 60) acc.qualityFailCount++;
      acc.worstSecurity = worseSecurity(acc.worstSecurity, e.securityRiskLevel || 'low');
    }

    const agentRisk = Array.from(accMap.values())
      .map((acc) => ({
        workflowKey: acc.workflowKey,
        agentName: acc.agentName,
        evaluations: acc.evaluations,
        riskScore: computeAgentRiskScore(acc),
        securityRiskLevel: acc.worstSecurity,
        qualityFailRate:
          acc.evaluations > 0
            ? Math.round((acc.qualityFailCount / acc.evaluations) * 1000) / 1000
            : 0,
        anomalyCount: acc.anomalyCount,
        openAlerts: acc.openAlerts,
      }))
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10);

    // ── Timeseries (alerts per day) ──
    const tsMap = new Map<string, { alerts: number; critical: number; high: number }>();
    for (const a of alerts) {
      const day = dayBucket(a.createdAt);
      let bucket = tsMap.get(day);
      if (!bucket) {
        bucket = { alerts: 0, critical: 0, high: 0 };
        tsMap.set(day, bucket);
      }
      bucket.alerts++;
      const sk = severityKey(a.severity);
      if (sk === 'critical') bucket.critical++;
      if (sk === 'high') bucket.high++;
    }
    const timeseries = Array.from(tsMap.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return {
      window: { days: windowDays, since: since.toISOString() },
      totals: {
        totalAlerts: alerts.length,
        open,
        bySeverity,
        byCategory,
      },
      agentRisk,
      timeseries,
    };
  }
}
