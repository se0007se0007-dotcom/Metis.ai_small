/**
 * DriftDetectionService — Patent 2 구성요소 (종속청구항 5).
 *
 * Compares the workflow's CURRENT governance fingerprint against the
 * latest APPROVED fingerprint. On mismatch the approved fingerprint is
 * marked DRIFTED, the governance review transitions to DRIFT_DETECTED,
 * and callers (runtime/promotion) must block execution or request
 * re-review.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { GovernanceFingerprintService } from './governance-fingerprint.service';

export interface DriftCheckResult {
  workflowId: string;
  drifted: boolean;
  approvedFingerprintHash?: string;
  currentFingerprintHash: string;
  /** Per-component diff to speed up re-review. */
  changedComponents: string[];
}

@Injectable()
export class DriftDetectionService {
  private readonly logger = new Logger(DriftDetectionService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly fingerprints: GovernanceFingerprintService,
  ) {}

  /**
   * Sweep every workflow with an APPROVED/PROMOTED/ACTIVE governance review
   * and detect drift in one pass (점검 H-2). Intended to run on a schedule
   * (e.g. daily) so post-approval changes are caught automatically instead of
   * relying on a manual drift-check click. Drifted reviews are flipped to
   * DRIFT_DETECTED and an FDS alert is raised. Best-effort per workflow.
   */
  async sweep(params: {
    tenantId: string;
    policyVersionHash: string;
  }): Promise<{ checked: number; drifted: string[] }> {
    const reviews = await this.prisma.orbGovernanceReview.findMany({
      where: {
        tenantId: params.tenantId,
        status: { in: ['APPROVED', 'PROMOTED', 'ACTIVE'] },
      },
      select: { workflowId: true },
      distinct: ['workflowId'],
    });

    const drifted: string[] = [];
    for (const r of reviews) {
      try {
        const result = await this.check({
          tenantId: params.tenantId,
          workflowId: r.workflowId,
          policyVersionHash: params.policyVersionHash,
          persist: true,
        });
        if (result.drifted) {
          drifted.push(r.workflowId);
          await this.raiseDriftAlert(params.tenantId, result);
        }
      } catch (err) {
        this.logger.warn(`drift sweep failed for ${r.workflowId}: ${(err as Error).message}`);
      }
    }
    this.logger.log(
      `[drift-sweep] tenant=${params.tenantId} checked=${reviews.length} drifted=${drifted.length}`,
    );
    return { checked: reviews.length, drifted };
  }

  private async raiseDriftAlert(tenantId: string, result: DriftCheckResult) {
    try {
      await this.prisma.fDSAlert.create({
        data: {
          tenantId,
          severity: 'HIGH',
          status: 'OPEN',
          subjectType: 'WorkflowGovernanceDrift',
          subjectId: result.workflowId,
          score: 0.8,
          summary: `[drift] 승인 이후 워크플로우 변경 감지 — ${result.workflowId} (변경: ${result.changedComponents.join(', ') || 'fingerprint'})`,
          detailsJson: {
            workflowId: result.workflowId,
            approvedFingerprintHash: result.approvedFingerprintHash ?? null,
            currentFingerprintHash: result.currentFingerprintHash,
            changedComponents: result.changedComponents,
          } as object,
          correlationId: `drift-${result.workflowId}`,
        },
      });
    } catch (err) {
      this.logger.warn(`drift alert creation failed: ${(err as Error).message}`);
    }
  }

  async check(params: {
    tenantId: string;
    workflowId: string;
    policyVersionHash: string;
    budgetPolicy?: unknown;
    /** When true, persists DRIFTED status + review transition. */
    persist?: boolean;
  }): Promise<DriftCheckResult> {
    const { tenantId, workflowId } = params;

    const input = await this.fingerprints.buildInputFromWorkflow(
      tenantId,
      workflowId,
      params.policyVersionHash,
      params.budgetPolicy,
    );
    const current = this.fingerprints.compute(input);

    const approved = await this.fingerprints.findApproved(tenantId, workflowId);
    if (!approved) {
      return {
        workflowId,
        drifted: false,
        currentFingerprintHash: current.fingerprintHash,
        changedComponents: [],
      };
    }

    const changedComponents = (
      [
        ['nodeGraphHash', approved.nodeGraphHash, current.nodeGraphHash],
        ['connectorScopeHash', approved.connectorScopeHash, current.connectorScopeHash],
        ['policyVersionHash', approved.policyVersionHash, current.policyVersionHash],
        ['modelTierHash', approved.modelTierHash, current.modelTierHash],
        ['dataClassHash', approved.dataClassHash, current.dataClassHash],
        ['budgetHash', approved.budgetHash, current.budgetHash],
        ['actionRiskHash', approved.actionRiskHash, current.actionRiskHash],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([name]) => name);

    const drifted = approved.fingerprintHash !== current.fingerprintHash;

    if (drifted && params.persist) {
      await this.prisma.$transaction(async (tx) => {
        await tx.governanceFingerprint.update({
          where: { id: approved.id },
          data: { status: 'DRIFTED' },
        });
        await tx.orbGovernanceReview.updateMany({
          where: { tenantId, workflowId, status: { in: ['APPROVED', 'PROMOTED', 'ACTIVE'] } },
          data: { status: 'DRIFT_DETECTED' },
        });
      });
      this.logger.warn(
        `[drift] workflow=${workflowId} approved=${approved.fingerprintHash.slice(0, 12)} current=${current.fingerprintHash.slice(0, 12)} changed=${changedComponents.join(',')}`,
      );
    }

    return {
      workflowId,
      drifted,
      approvedFingerprintHash: approved.fingerprintHash,
      currentFingerprintHash: current.fingerprintHash,
      changedComponents,
    };
  }
}
