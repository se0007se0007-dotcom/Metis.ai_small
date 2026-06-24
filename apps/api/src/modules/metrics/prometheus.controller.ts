/**
 * Prometheus Exposition Controller — GET /metrics/prometheus
 *
 * Dependency-free Prometheus text-format (v0.0.4) exposition built from DB
 * aggregates, so a Prometheus/Grafana stack can scrape platform health without
 * any OTel SDK. Gauges cover the four pillars the platform watches:
 *   - executions (by status, 24h) + avg latency
 *   - quality (avg evaluation score, 24h)
 *   - cost (FinOps spend + saved, 24h)
 *   - security/anomaly (open FDS alerts by severity)
 *
 * Auth: the endpoint is @Public (scrapers don't do JWT) but protected by a
 * static bearer token when METRICS_TOKEN is set in the environment:
 *   curl -H "Authorization: Bearer $METRICS_TOKEN" /metrics/prometheus
 * When METRICS_TOKEN is unset the endpoint is open — fine for local dev,
 * set the token in production.
 *
 * Numbers are PLATFORM-WIDE (cross-tenant) — operational telemetry only, no
 * tenant-identifiable content is exposed (counts/averages only).
 */
import { Controller, Get, Header, Inject, Req, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { Public } from '../../common/decorators';

/** Render one metric family in Prometheus exposition format. */
export function renderMetric(
  name: string,
  help: string,
  type: 'gauge' | 'counter',
  samples: Array<{ labels?: Record<string, string>; value: number }>,
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    const labelStr =
      s.labels && Object.keys(s.labels).length > 0
        ? `{${Object.entries(s.labels)
            .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
            .join(',')}}`
        : '';
    const value = Number.isFinite(s.value) ? s.value : 0;
    lines.push(`${name}${labelStr} ${value}`);
  }
  return lines.join('\n');
}

@ApiTags('Metrics')
@Controller('metrics')
export class PrometheusController {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  @Get('prometheus')
  @Public()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({
    summary: 'Prometheus exposition endpoint (platform-wide operational gauges)',
  })
  async scrape(@Req() req: any): Promise<string> {
    // Static-token gate (scrapers cannot do JWT). Open when METRICS_TOKEN unset.
    const requiredToken = process.env.METRICS_TOKEN || '';
    if (requiredToken) {
      const auth: string = req.headers?.authorization || '';
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (presented !== requiredToken) {
        throw new UnauthorizedException('METRICS_TOKEN required');
      }
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const p = this.prisma as any;

    // All queries best-effort and parallel; a failed aggregate renders as 0.
    const [
      execByStatus,
      avgLatency,
      avgQuality,
      finops,
      alertsBySeverity,
      agentsTotal,
      knowledgeActive,
    ] = await Promise.all([
      p.executionSession
        .groupBy({
          by: ['status'],
          where: { createdAt: { gte: since24h } },
          _count: { _all: true },
        })
        .catch(() => []),
      p.executionSession
        .aggregate({
          _avg: { latencyMs: true },
          where: { createdAt: { gte: since24h }, status: 'SUCCEEDED' },
        })
        .catch(() => ({ _avg: { latencyMs: 0 } })),
      p.agentEvaluation
        .aggregate({
          _avg: { overallScore: true },
          _count: { _all: true },
          where: { createdAt: { gte: since24h } },
        })
        .catch(() => ({ _avg: { overallScore: 0 }, _count: { _all: 0 } })),
      p.finOpsTokenLog
        .aggregate({
          _sum: { optimizedCostUsd: true, savedUsd: true, totalTokens: true },
          where: { createdAt: { gte: since24h } },
        })
        .catch(() => ({ _sum: { optimizedCostUsd: 0, savedUsd: 0, totalTokens: 0 } })),
      p.fDSAlert
        ?.groupBy({
          by: ['severity'],
          where: { status: { in: ['OPEN', 'ESCALATED'] } },
          _count: { _all: true },
        })
        .catch(() => []) ?? Promise.resolve([]),
      p.agentDefinition.count().catch(() => 0),
      p.knowledgeArtifact.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
    ]);

    const blocks: string[] = [];

    blocks.push(
      renderMetric(
        'metis_executions_24h',
        'Execution sessions created in the last 24h by status',
        'gauge',
        (execByStatus as any[]).map((row) => ({
          labels: { status: String(row.status).toLowerCase() },
          value: row._count?._all ?? 0,
        })),
      ),
    );

    blocks.push(
      renderMetric(
        'metis_execution_avg_latency_ms',
        'Average latency of SUCCEEDED executions over the last 24h',
        'gauge',
        [{ value: Math.round(avgLatency?._avg?.latencyMs ?? 0) }],
      ),
    );

    blocks.push(
      renderMetric(
        'metis_evaluation_avg_score_24h',
        'Average AgentEvaluation overallScore (0-100) over the last 24h',
        'gauge',
        [{ value: Math.round((avgQuality?._avg?.overallScore ?? 0) * 100) / 100 }],
      ),
    );
    blocks.push(
      renderMetric(
        'metis_evaluations_24h_total',
        'Number of agent evaluations recorded in the last 24h',
        'gauge',
        [{ value: avgQuality?._count?._all ?? 0 }],
      ),
    );

    blocks.push(
      renderMetric('metis_finops_cost_usd_24h', 'LLM spend (optimized) over the last 24h', 'gauge', [
        { value: Math.round((finops?._sum?.optimizedCostUsd ?? 0) * 1e6) / 1e6 },
      ]),
    );
    blocks.push(
      renderMetric('metis_finops_saved_usd_24h', 'LLM cost saved over the last 24h', 'gauge', [
        { value: Math.round((finops?._sum?.savedUsd ?? 0) * 1e6) / 1e6 },
      ]),
    );
    blocks.push(
      renderMetric('metis_finops_tokens_24h', 'Total LLM tokens over the last 24h', 'gauge', [
        { value: finops?._sum?.totalTokens ?? 0 },
      ]),
    );

    blocks.push(
      renderMetric(
        'metis_fds_open_alerts',
        'Open/escalated FDS alerts by severity',
        'gauge',
        (alertsBySeverity as any[]).map((row) => ({
          labels: { severity: String(row.severity).toLowerCase() },
          value: row._count?._all ?? 0,
        })),
      ),
    );

    blocks.push(
      renderMetric('metis_agents_registered_total', 'Registered agent definitions', 'gauge', [
        { value: agentsTotal ?? 0 },
      ]),
    );
    blocks.push(
      renderMetric('metis_knowledge_active_total', 'ACTIVE knowledge artifacts', 'gauge', [
        { value: knowledgeActive ?? 0 },
      ]),
    );

    return blocks.join('\n\n') + '\n';
  }
}
