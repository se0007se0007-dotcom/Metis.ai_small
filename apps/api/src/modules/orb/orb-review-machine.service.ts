/**
 * OrbGovernanceReviewMachine — Patent 2 등록 거버넌스 상태머신.
 *
 * DRAFT → TEMP_REGISTERED → NODE_RESOLVED → FINGERPRINTED →
 * SANDBOX_REPLAYED → AUTO_SCORED → (NEEDS_REPAIR → POLICY_INJECTED →
 * SANDBOX_REPLAYED) → HUMAN_REVIEW → APPROVED → PROMOTED → ACTIVE
 * Exception states: REJECTED, REVOKED, DRIFT_DETECTED, REVIEW_EXPIRED.
 *
 * Every transition is appended to historyJson so the full review path
 * is reproducible (특허 명세서의 심사 이력 증거화).
 */
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaClient, type Prisma } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { GovernanceFingerprintService } from '../governance/governance-fingerprint.service';
import { PolicyInjectionEngine } from '../governance/policy-injection.engine';
import { EvidencePackService } from '../governance/evidence-pack.service';
import { READINESS_THRESHOLDS } from '../governance/governance-core.types';
import { SandboxReplayService } from '../sandbox/sandbox-replay.service';

type OrbStatus =
  | 'DRAFT'
  | 'TEMP_REGISTERED'
  | 'NODE_RESOLVED'
  | 'FINGERPRINTED'
  | 'SANDBOX_REPLAYED'
  | 'AUTO_SCORED'
  | 'NEEDS_REPAIR'
  | 'POLICY_INJECTED'
  | 'HUMAN_REVIEW'
  | 'APPROVED'
  | 'PROMOTED'
  | 'ACTIVE'
  | 'REJECTED'
  | 'REVOKED'
  | 'DRIFT_DETECTED'
  | 'REVIEW_EXPIRED';

/** Allowed transitions (state machine integrity guard). */
const TRANSITIONS: Record<OrbStatus, OrbStatus[]> = {
  DRAFT: ['TEMP_REGISTERED', 'REJECTED'],
  TEMP_REGISTERED: ['NODE_RESOLVED', 'REJECTED'],
  NODE_RESOLVED: ['FINGERPRINTED', 'REJECTED'],
  FINGERPRINTED: ['SANDBOX_REPLAYED', 'REJECTED'],
  SANDBOX_REPLAYED: ['AUTO_SCORED', 'REJECTED'],
  AUTO_SCORED: ['NEEDS_REPAIR', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED'],
  NEEDS_REPAIR: ['POLICY_INJECTED', 'REJECTED'],
  POLICY_INJECTED: ['FINGERPRINTED', 'REJECTED'],
  HUMAN_REVIEW: ['APPROVED', 'REJECTED', 'REVIEW_EXPIRED'],
  APPROVED: ['PROMOTED', 'REVOKED', 'DRIFT_DETECTED'],
  PROMOTED: ['ACTIVE', 'REVOKED', 'DRIFT_DETECTED'],
  ACTIVE: ['REVOKED', 'DRIFT_DETECTED'],
  REJECTED: [],
  REVOKED: [],
  DRIFT_DETECTED: ['FINGERPRINTED'],
  REVIEW_EXPIRED: ['HUMAN_REVIEW'],
};

@Injectable()
export class OrbReviewMachineService {
  private readonly logger = new Logger(OrbReviewMachineService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly fingerprints: GovernanceFingerprintService,
    private readonly policyInjection: PolicyInjectionEngine,
    private readonly sandboxReplay: SandboxReplayService,
    private readonly evidencePacks: EvidencePackService,
  ) {}

  // ── lifecycle ────────────────────────────────────────────────

  /** 임시등록: create the review in TEMP_REGISTERED. */
  async register(tenantId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, tenantId, deletedAt: null },
      include: { nodes: true },
    });
    if (!workflow) throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    if (workflow.nodes.length === 0) {
      throw new BadRequestException('노드가 없는 워크플로우는 심사 등록할 수 없습니다.');
    }

    const review = await this.prisma.orbGovernanceReview.create({
      data: {
        tenantId,
        workflowId,
        status: 'TEMP_REGISTERED',
        historyJson: [this.historyEntry('DRAFT', 'TEMP_REGISTERED', 'temp registration')],
      },
    });
    // Node definitions already resolved by builder — move on.
    return this.transition(tenantId, review.id, 'NODE_RESOLVED', 'nodes resolved from builder');
  }

  /** Fingerprint 생성 단계. */
  async fingerprint(tenantId: string, reviewId: string, policyVersionHash: string) {
    const review = await this.getReview(tenantId, reviewId);
    this.assertTransition(review.status as OrbStatus, 'FINGERPRINTED');

    const fp = await this.fingerprints.createForWorkflow({
      tenantId,
      workflowId: review.workflowId,
      policyVersionHash,
    });

    await this.prisma.orbGovernanceReview.update({
      where: { id: reviewId },
      data: {
        status: 'FINGERPRINTED',
        fingerprintHash: fp.fingerprintHash,
        historyJson: this.appendHistory(review, review.status, 'FINGERPRINTED', {
          fingerprintHash: fp.fingerprintHash,
        }),
      },
    });
    return fp;
  }

  /** Sandbox replay + auto scoring 단계. */
  async replayAndScore(tenantId: string, reviewId: string, datasetId?: string) {
    const review = await this.getReview(tenantId, reviewId);
    this.assertTransition(review.status as OrbStatus, 'SANDBOX_REPLAYED');
    if (!review.fingerprintHash) {
      throw new BadRequestException('fingerprint가 먼저 생성되어야 합니다.');
    }

    const result = await this.sandboxReplay.run({
      tenantId,
      workflowId: review.workflowId,
      fingerprintHash: review.fingerprintHash,
      datasetId,
    });

    // AUTO_SCORED → branch by readiness thresholds.
    const score = result.readinessScore;
    let next: OrbStatus;
    if (score >= READINESS_THRESHOLDS.autoApprove) next = 'APPROVED';
    else if (score >= READINESS_THRESHOLDS.humanReview) next = 'HUMAN_REVIEW';
    else if (score >= READINESS_THRESHOLDS.policyInjection) next = 'NEEDS_REPAIR';
    else next = 'REJECTED';

    const history = [
      this.historyEntry(review.status, 'SANDBOX_REPLAYED', `replayRun=${result.runId}`),
      this.historyEntry('SANDBOX_REPLAYED', 'AUTO_SCORED', `readiness=${score.toFixed(1)}`),
      this.historyEntry('AUTO_SCORED', next, this.scoreRationale(score)),
    ];

    await this.prisma.orbGovernanceReview.update({
      where: { id: reviewId },
      data: {
        status: next,
        replayRunId: result.runId,
        readinessScore: score,
        rejectionReason: next === 'REJECTED' ? `readiness ${score.toFixed(1)} < 60` : undefined,
        historyJson: [...this.history(review), ...history],
      },
    });

    return { ...result, nextStatus: next };
  }

  /** NEEDS_REPAIR → 자동 정책 삽입 → fingerprint 재생성 필요 상태로 복귀. */
  async applyGovernancePatches(tenantId: string, reviewId: string) {
    const review = await this.getReview(tenantId, reviewId);
    this.assertTransition(review.status as OrbStatus, 'POLICY_INJECTED');

    const replayRun = review.replayRunId
      ? await this.prisma.sandboxReplayRun.findUnique({ where: { id: review.replayRunId } })
      : null;
    const nodeReadiness = replayRun
      ? ((replayRun.resultJson as { nodes?: Array<{ nodeKey: string; nodeScore: number; policyViolations: number; failed: boolean }> }).nodes ?? [])
      : [];

    const result = await this.policyInjection.injectForWorkflow({
      tenantId,
      workflowId: review.workflowId,
      nodeReadiness,
    });

    // Workflow definition changed → fingerprint must be regenerated.
    await this.prisma.orbGovernanceReview.update({
      where: { id: reviewId },
      data: {
        status: 'POLICY_INJECTED',
        historyJson: this.appendHistory(review, review.status, 'POLICY_INJECTED', {
          patches: result.patchesCreated,
          nodes: result.patchedNodeKeys,
        }),
      },
    });
    return result;
  }

  /** 심사자 승인: fingerprint를 APPROVED로 승격, approvalHash 기록. */
  async approve(tenantId: string, reviewId: string, reviewerId: string) {
    const review = await this.getReview(tenantId, reviewId);
    this.assertTransition(review.status as OrbStatus, 'APPROVED');
    if (!review.fingerprintHash) {
      throw new BadRequestException('승인할 fingerprint가 없습니다.');
    }

    await this.fingerprints.approve(tenantId, review.fingerprintHash, reviewerId);

    const approvalHash = createHash('sha256')
      .update(
        JSON.stringify({
          reviewId,
          fingerprintHash: review.fingerprintHash,
          reviewerId,
          replayRunId: review.replayRunId,
          at: new Date().toISOString(),
        }),
      )
      .digest('hex');

    const updated = await this.prisma.orbGovernanceReview.update({
      where: { id: reviewId },
      data: {
        status: 'APPROVED',
        reviewerId,
        approvalHash,
        approvedAt: new Date(),
        historyJson: this.appendHistory(review, review.status, 'APPROVED', {
          reviewerId,
          approvalHash,
        }),
      },
    });

    // Registration-side evidence pack (심사 이력 증거화).
    await this.evidencePacks.create({
      tenantId,
      kind: 'REGISTRATION',
      workflowId: review.workflowId,
      orbGovernanceReviewId: reviewId,
      workflowHash: review.fingerprintHash,
      evaluation: {
        readinessScore: review.readinessScore,
        replayRunId: review.replayRunId,
        approvalHash,
        reviewerId,
      },
    });

    return updated;
  }

  async markStatus(
    tenantId: string,
    reviewId: string,
    next: OrbStatus,
    note: string,
    extra?: Partial<{ promotedVersionId: string; rejectionReason: string }>,
  ) {
    const review = await this.getReview(tenantId, reviewId);
    this.assertTransition(review.status as OrbStatus, next);
    return this.prisma.orbGovernanceReview.update({
      where: { id: reviewId },
      data: {
        status: next,
        promotedVersionId: extra?.promotedVersionId,
        rejectionReason: extra?.rejectionReason,
        historyJson: this.appendHistory(review, review.status, next, { note }),
      },
    });
  }

  async getReview(tenantId: string, reviewId: string) {
    const review = await this.prisma.orbGovernanceReview.findFirst({
      where: { id: reviewId, tenantId },
    });
    if (!review) throw new NotFoundException('거버넌스 심사를 찾을 수 없습니다.');
    return review;
  }

  async listReviews(tenantId: string, workflowId?: string) {
    return this.prisma.orbGovernanceReview.findMany({
      where: { tenantId, ...(workflowId ? { workflowId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ── helpers ──────────────────────────────────────────────────

  private async transition(tenantId: string, reviewId: string, next: OrbStatus, note: string) {
    const review = await this.getReview(tenantId, reviewId);
    this.assertTransition(review.status as OrbStatus, next);
    return this.prisma.orbGovernanceReview.update({
      where: { id: reviewId },
      data: {
        status: next,
        historyJson: this.appendHistory(review, review.status, next, { note }),
      },
    });
  }

  private assertTransition(from: OrbStatus, to: OrbStatus) {
    if (!TRANSITIONS[from]?.includes(to)) {
      throw new BadRequestException(`허용되지 않는 상태 전이: ${from} → ${to}`);
    }
  }

  private scoreRationale(score: number): string {
    if (score >= READINESS_THRESHOLDS.autoApprove) return 'auto-approve candidate (>=90)';
    if (score >= READINESS_THRESHOLDS.humanReview) return 'human review required (75-89)';
    if (score >= READINESS_THRESHOLDS.policyInjection) return 'policy injection then re-replay (60-74)';
    return 'rejected (<60)';
  }

  private history(review: { historyJson: unknown }): Prisma.InputJsonObject[] {
    return Array.isArray(review.historyJson)
      ? (review.historyJson as unknown as Prisma.InputJsonObject[])
      : [];
  }

  private historyEntry(
    from: string,
    to: string,
    note: Prisma.InputJsonValue,
  ): Prisma.InputJsonObject {
    return { from, to, note, at: new Date().toISOString() };
  }

  private appendHistory(
    review: { historyJson: unknown },
    from: string,
    to: string,
    note: Prisma.InputJsonValue,
  ): Prisma.InputJsonObject[] {
    return [...this.history(review), this.historyEntry(from, to, note)];
  }
}
