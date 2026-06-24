/**
 * GovernanceFingerprintService — Patent 2 core.
 *
 * Canonicalizes a workflow's governance-relevant surface (node graph,
 * connector scope, policy version, model tiers, data classes, budget,
 * action/risk profile) and hashes it. Properties:
 *   - deterministic: same workflow → same fingerprintHash
 *   - sensitive: any node/connector/policy/budget change → new hash
 * Only versions whose fingerprint matches an APPROVED fingerprint may
 * be promoted to ACTIVE (see ImmutableVersionPromotionService), and
 * runtime drift is detected by re-computing and comparing.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  ComputedFingerprint,
  FingerprintInput,
  FingerprintNodeInput,
} from './governance-core.types';
import { NodeGovernanceProfilerService } from './node-governance-profiler.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class GovernanceFingerprintService {
  private readonly logger = new Logger(GovernanceFingerprintService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly profiler: NodeGovernanceProfilerService,
  ) {}

  /** Pure computation — no I/O. */
  compute(input: FingerprintInput): ComputedFingerprint {
    const nodes = [...input.nodes].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
    const edges = [...input.edges].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    );

    const nodeGraphHash = sha256(
      stableStringify({
        nodes: nodes.map((n) => ({
          nodeKey: n.nodeKey,
          executionType: n.executionType,
          capability: n.capability ?? null,
          policyCheckpoint: n.policyCheckpoint ?? false,
          humanApproval: n.humanApproval ?? false,
        })),
        edges,
      }),
    );
    const connectorScopeHash = sha256(
      stableStringify(nodes.map((n) => n.connectorKey ?? null)),
    );
    const modelTierHash = sha256(stableStringify(nodes.map((n) => n.modelTier ?? null)));
    const dataClassHash = sha256(stableStringify(nodes.map((n) => n.dataClass ?? null)));
    const budgetHash = sha256(stableStringify(input.budgetPolicy ?? null));
    const actionRiskHash = sha256(
      stableStringify(
        nodes.map((n) => ({ a: n.actionType ?? null, r: n.riskLevel ?? null })),
      ),
    );

    const fingerprintHash = sha256(
      stableStringify({
        tenantId: input.tenantId,
        nodeGraphHash,
        connectorScopeHash,
        policyVersionHash: input.policyVersionHash,
        modelTierHash,
        dataClassHash,
        budgetHash,
        actionRiskHash,
      }),
    );

    return {
      nodeGraphHash,
      connectorScopeHash,
      policyVersionHash: input.policyVersionHash,
      modelTierHash,
      dataClassHash,
      budgetHash,
      actionRiskHash,
      fingerprintHash,
    };
  }

  /**
   * Build the fingerprint input straight from the persisted workflow
   * definition (nodes + edges + governance profiles).
   */
  async buildInputFromWorkflow(
    tenantId: string,
    workflowId: string,
    policyVersionHash: string,
    budgetPolicy?: unknown,
  ): Promise<FingerprintInput> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, tenantId, deletedAt: null },
      include: {
        nodes: { orderBy: { executionOrder: 'asc' } },
        edges: true,
      },
    });
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const nodes: FingerprintNodeInput[] = workflow.nodes.map((n) => {
      const config = (n.configJson ?? {}) as Record<string, unknown>;
      const profile = this.profiler.derive({
        tenantId,
        workflowId,
        nodeKey: n.nodeKey,
        executionType: n.uiType,
        capability: config.capability as string | undefined,
        connectorKey: config.connectorKey as string | undefined,
        configJson: config,
      });
      return {
        nodeKey: n.nodeKey,
        executionType: n.uiType,
        capability: profile.capability,
        actionType: profile.actionType,
        riskLevel: profile.riskLevel,
        connectorKey: config.connectorKey as string | undefined,
        dataClass: profile.dataClass,
        modelTier: config.modelTier as string | undefined,
        policyCheckpoint: profile.policyCheckpoint,
        humanApproval: profile.humanApproval,
      };
    });

    return {
      tenantId,
      workflowId,
      nodes,
      edges: workflow.edges.map((e) => ({ from: e.fromNodeKey, to: e.toNodeKey })),
      policyVersionHash,
      budgetPolicy,
    };
  }

  /** Compute + persist a DRAFT fingerprint for a workflow. */
  async createForWorkflow(params: {
    tenantId: string;
    workflowId: string;
    workflowVersionId?: string;
    policyVersionHash: string;
    budgetPolicy?: unknown;
  }) {
    const input = await this.buildInputFromWorkflow(
      params.tenantId,
      params.workflowId,
      params.policyVersionHash,
      params.budgetPolicy,
    );
    const computed = this.compute(input);

    const existing = await this.prisma.governanceFingerprint.findUnique({
      where: { fingerprintHash: computed.fingerprintHash },
    });
    if (existing) return existing;

    return this.prisma.governanceFingerprint.create({
      data: {
        tenantId: params.tenantId,
        workflowId: params.workflowId,
        workflowVersionId: params.workflowVersionId,
        ...computed,
        status: 'DRAFT',
      },
    });
  }

  async approve(tenantId: string, fingerprintHash: string, approvedById: string) {
    // Tenant-scoped lookup first — a fingerprint hash must never be
    // approvable across tenant boundaries.
    const fp = await this.prisma.governanceFingerprint.findFirst({
      where: { tenantId, fingerprintHash },
    });
    if (!fp) {
      throw new Error(`Fingerprint not found for tenant: ${fingerprintHash.slice(0, 12)}`);
    }
    return this.prisma.governanceFingerprint.update({
      where: { id: fp.id },
      data: { status: 'APPROVED', approvedById, approvedAt: new Date() },
    });
  }

  async findApproved(tenantId: string, workflowId: string) {
    return this.prisma.governanceFingerprint.findFirst({
      where: { tenantId, workflowId, status: 'APPROVED' },
      orderBy: { approvedAt: 'desc' },
    });
  }
}
