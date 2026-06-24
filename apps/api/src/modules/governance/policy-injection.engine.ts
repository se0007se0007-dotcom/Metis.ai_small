/**
 * PolicyInjectionEngine — Patent 2 구성요소.
 *
 * For nodes that fall below readiness thresholds (or whose actionType
 * is inherently risky: external-send, delete, deploy, approve,
 * payment, permission-change), automatically generates and applies
 * governance patches:
 *   ADD_POLICY_CHECKPOINT — force runtime policy gate on the node
 *   ADD_HUMAN_APPROVAL    — require approval before the node runs
 *   ADD_FALLBACK          — attach fallback/retry/timeout settings
 * Patches are persisted (before/after/reason) so the repair itself is
 * auditable, then written into WorkflowNodeDef.configJson.governance.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { NodeGovernanceProfilerService } from './node-governance-profiler.service';

const PRIORITY_ACTIONS = [
  'EXTERNAL_SEND',
  'DELETE',
  'DEPLOY',
  'APPROVE',
  'PAYMENT',
  'PERMISSION_CHANGE',
];

export interface NodeReadinessInput {
  nodeKey: string;
  /** 0-100 per-node readiness from sandbox replay (lower = riskier). */
  nodeScore?: number;
  policyViolations?: number;
  failed?: boolean;
}

export interface PolicyInjectionResult {
  workflowId: string;
  patchesCreated: number;
  patchesApplied: number;
  patchedNodeKeys: string[];
}

@Injectable()
export class PolicyInjectionEngine {
  private readonly logger = new Logger(PolicyInjectionEngine.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly profiler: NodeGovernanceProfilerService,
  ) {}

  /**
   * Plan + apply governance patches for a workflow.
   * @param nodeReadiness optional per-node replay results; when absent
   *        only the static action-type rules apply.
   */
  async injectForWorkflow(params: {
    tenantId: string;
    workflowId: string;
    nodeReadiness?: NodeReadinessInput[];
    scoreThreshold?: number; // node below this gets a checkpoint (default 75)
  }): Promise<PolicyInjectionResult> {
    const { tenantId, workflowId } = params;
    const threshold = params.scoreThreshold ?? 75;
    const readinessByNode = new Map(
      (params.nodeReadiness ?? []).map((r) => [r.nodeKey, r]),
    );

    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, tenantId, deletedAt: null },
      include: { nodes: { orderBy: { executionOrder: 'asc' } } },
    });
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

    let created = 0;
    let applied = 0;
    const patchedNodeKeys: string[] = [];

    for (const node of workflow.nodes) {
      const config = (node.configJson ?? {}) as Record<string, unknown>;
      const governance = { ...((config.governance as Record<string, unknown>) ?? {}) };
      const profile = this.profiler.derive({
        tenantId,
        workflowId,
        nodeKey: node.nodeKey,
        executionType: node.uiType,
        configJson: config,
      });
      const readiness = readinessByNode.get(node.nodeKey);

      const reasons: string[] = [];
      const plans: Array<'ADD_POLICY_CHECKPOINT' | 'ADD_HUMAN_APPROVAL' | 'ADD_FALLBACK'> = [];

      // Rule 1 — priority action types always get a checkpoint (종속청구항 4).
      if (
        PRIORITY_ACTIONS.includes(profile.actionType) &&
        governance.policyCheckpoint !== true
      ) {
        plans.push('ADD_POLICY_CHECKPOINT');
        reasons.push(`priority actionType=${profile.actionType}`);
      }

      // Rule 2 — replay score below threshold → checkpoint + approval.
      if (readiness?.nodeScore != null && readiness.nodeScore < threshold) {
        if (governance.policyCheckpoint !== true && !plans.includes('ADD_POLICY_CHECKPOINT')) {
          plans.push('ADD_POLICY_CHECKPOINT');
        }
        if (governance.humanApproval !== true && profile.riskLevel !== 'LOW') {
          plans.push('ADD_HUMAN_APPROVAL');
        }
        reasons.push(`replay nodeScore=${readiness.nodeScore} < ${threshold}`);
      }

      // Rule 3 — replay failures or policy violations → fallback wiring.
      if ((readiness?.failed || (readiness?.policyViolations ?? 0) > 0) && !governance.fallback) {
        plans.push('ADD_FALLBACK');
        reasons.push(
          `replay failed=${readiness?.failed ?? false} violations=${readiness?.policyViolations ?? 0}`,
        );
      }

      if (plans.length === 0) continue;

      const before = { governance: (config.governance as object) ?? null };
      const nextGovernance: Record<string, unknown> = { ...governance };
      for (const plan of plans) {
        if (plan === 'ADD_POLICY_CHECKPOINT') nextGovernance.policyCheckpoint = true;
        if (plan === 'ADD_HUMAN_APPROVAL') nextGovernance.humanApproval = true;
        if (plan === 'ADD_FALLBACK') {
          nextGovernance.fallback = {
            retry: { maxAttempts: 2, backoffMs: 1000 },
            timeoutMs: 60_000,
            onFailure: 'HALT_AND_NOTIFY',
          };
        }
      }
      const after = { governance: nextGovernance };

      // Persist one patch row per patch type, then apply atomically.
      await this.prisma.$transaction(async (tx) => {
        for (const plan of plans) {
          await tx.governancePatch.create({
            data: {
              tenantId,
              workflowId,
              nodeKey: node.nodeKey,
              patchType: plan,
              beforeJson: before as object,
              afterJson: after as object,
              reasonJson: { reasons },
              applied: true,
              appliedAt: new Date(),
            },
          });
          created += 1;
        }
        await tx.workflowNodeDef.update({
          where: { id: node.id },
          data: { configJson: { ...config, governance: nextGovernance } as object },
        });
        applied += plans.length;
      });

      patchedNodeKeys.push(node.nodeKey);
      this.logger.log(
        `[policy-injection] workflow=${workflowId} node=${node.nodeKey} patches=${plans.join(',')}`,
      );
    }

    return { workflowId, patchesCreated: created, patchesApplied: applied, patchedNodeKeys };
  }
}
