/**
 * SandboxReplayService — Patent 2 구성요소.
 *
 * Pre-production "shadow" assessment of a workflow: every node is
 * profiled and scored across security / policy / cost / reliability
 * without touching production systems or external connectors. When a
 * ReplayDataset is supplied its cases drive the reliability estimate.
 *
 * v1 deliberately performs a static + heuristic dry-run (no real
 * connector calls) so it is safe to run at registration time; the
 * result schema is identical to what a full executing replay would
 * produce, so the engine can later be swapped for PipelineEngine
 * dry-run execution without changing consumers.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  READINESS_WEIGHTS,
  ReadinessScores,
} from '../governance/governance-core.types';
import { NodeGovernanceProfilerService } from '../governance/node-governance-profiler.service';

export interface NodeReplayResult {
  nodeKey: string;
  actionType: string;
  riskLevel: string;
  nodeScore: number; // 0-100
  policyViolations: number;
  estimatedCostUsd: number;
  failed: boolean;
  notes: string[];
}

export interface SandboxReplayResult extends ReadinessScores {
  runId: string;
  status: 'PASSED' | 'FAILED';
  fingerprintHash: string;
  nodes: NodeReplayResult[];
  replayResultHash: string;
}

const RISK_BASE_SCORE: Record<string, number> = {
  LOW: 95,
  MEDIUM: 85,
  HIGH: 70,
  CRITICAL: 55,
};

@Injectable()
export class SandboxReplayService {
  private readonly logger = new Logger(SandboxReplayService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly profiler: NodeGovernanceProfilerService,
  ) {}

  async run(params: {
    tenantId: string;
    workflowId: string;
    fingerprintHash: string;
    datasetId?: string;
  }): Promise<SandboxReplayResult> {
    const { tenantId, workflowId } = params;

    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, tenantId, deletedAt: null },
      include: {
        nodes: { orderBy: { executionOrder: 'asc' } },
        edges: true,
      },
    });
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

    // Optional replay dataset → reliability evidence (ITO synthetic
    // tickets / incidents / deployments — 종속청구항 2).
    let datasetCaseCount = 0;
    if (params.datasetId) {
      datasetCaseCount = await this.prisma.replayCase.count({
        where: { datasetId: params.datasetId },
      });
    }

    const nodes: NodeReplayResult[] = workflow.nodes.map((node) => {
      const config = (node.configJson ?? {}) as Record<string, unknown>;
      const governance = (config.governance ?? {}) as Record<string, unknown>;
      const profile = this.profiler.derive({
        tenantId,
        workflowId,
        nodeKey: node.nodeKey,
        executionType: node.uiType,
        configJson: config,
      });

      const notes: string[] = [];
      let score = RISK_BASE_SCORE[profile.riskLevel] ?? 80;
      let violations = 0;

      // Risky action without a checkpoint = policy violation candidate.
      const hasCheckpoint =
        governance.policyCheckpoint === true || profile.policyCheckpoint;
      if (profile.riskLevel === 'HIGH' || profile.riskLevel === 'CRITICAL') {
        if (!hasCheckpoint) {
          violations += 1;
          score -= 15;
          notes.push('high-risk action without policy checkpoint');
        }
        if (governance.humanApproval !== true && profile.riskLevel === 'CRITICAL') {
          violations += 1;
          score -= 10;
          notes.push('critical action without human approval');
        }
      }

      // Sensitive data class handling.
      if (
        profile.dataClass &&
        ['PII', 'SECRET', 'CUSTOMER_CONFIDENTIAL'].includes(profile.dataClass) &&
        !hasCheckpoint
      ) {
        violations += 1;
        score -= 10;
        notes.push(`sensitive dataClass=${profile.dataClass} without checkpoint`);
      }

      // Resilience: fallback/timeout wiring.
      if (!governance.fallback && profile.riskLevel !== 'LOW') {
        score -= 5;
        notes.push('no fallback/retry policy');
      }

      // Static cost estimate (model tier proxy; refined by FinOps later).
      const modelTier = Number((config as Record<string, unknown>).modelTier ?? 1);
      const estimatedCostUsd = 0.002 * Math.max(1, modelTier) * Math.max(1, datasetCaseCount || 1);

      return {
        nodeKey: node.nodeKey,
        actionType: profile.actionType,
        riskLevel: profile.riskLevel,
        nodeScore: Math.max(0, Math.min(100, score)),
        policyViolations: violations,
        estimatedCostUsd,
        failed: score < 40,
        notes,
      };
    });

    const scores = this.aggregate(nodes, workflow.edges.length, datasetCaseCount);
    const status: 'PASSED' | 'FAILED' = scores.readinessScore >= 60 ? 'PASSED' : 'FAILED';

    const resultJson = { nodes, datasetCaseCount, edgeCount: workflow.edges.length };
    const replayResultHash = createHash('sha256')
      .update(JSON.stringify(resultJson))
      .digest('hex');

    const run = await this.prisma.sandboxReplayRun.create({
      data: {
        tenantId,
        workflowId,
        fingerprintHash: params.fingerprintHash,
        datasetId: params.datasetId,
        status,
        readinessScore: scores.readinessScore,
        securityScore: scores.securityScore,
        policyScore: scores.policyScore,
        costScore: scores.costScore,
        reliabilityScore: scores.reliabilityScore,
        humanReviewScore: scores.humanReviewScore,
        replayResultHash,
        resultJson: resultJson as object,
      },
    });

    this.logger.log(
      `[sandbox-replay] workflow=${workflowId} readiness=${scores.readinessScore.toFixed(1)} status=${status}`,
    );

    return { runId: run.id, status, fingerprintHash: params.fingerprintHash, nodes, replayResultHash, ...scores };
  }

  private aggregate(
    nodes: NodeReplayResult[],
    edgeCount: number,
    datasetCaseCount: number,
  ): ReadinessScores {
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    const securityScore = avg(
      nodes.map((n) =>
        Math.max(0, n.nodeScore - (n.riskLevel === 'CRITICAL' ? 10 : 0)),
      ),
    );
    const totalViolations = nodes.reduce((a, n) => a + n.policyViolations, 0);
    const policyScore = Math.max(0, 100 - totalViolations * 15);
    const totalCost = nodes.reduce((a, n) => a + n.estimatedCostUsd, 0);
    const costScore = totalCost <= 0.5 ? 95 : totalCost <= 2 ? 80 : totalCost <= 10 ? 65 : 50;
    const failedCount = nodes.filter((n) => n.failed).length;
    const graphPenalty = nodes.length > 0 && edgeCount === 0 && nodes.length > 1 ? 10 : 0;
    const reliabilityScore = Math.max(
      0,
      100 - failedCount * 25 - graphPenalty + Math.min(10, datasetCaseCount),
    );
    // Share of nodes already wired for human review where required.
    const needingApproval = nodes.filter((n) => n.riskLevel === 'CRITICAL').length;
    const humanReviewScore = needingApproval === 0 ? 90 : Math.max(40, 90 - needingApproval * 10);

    const readinessScore =
      securityScore * READINESS_WEIGHTS.security +
      policyScore * READINESS_WEIGHTS.policy +
      reliabilityScore * READINESS_WEIGHTS.reliability +
      costScore * READINESS_WEIGHTS.cost +
      humanReviewScore * READINESS_WEIGHTS.humanReview;

    return {
      readinessScore,
      securityScore,
      policyScore,
      costScore,
      reliabilityScore,
      humanReviewScore,
    };
  }
}
