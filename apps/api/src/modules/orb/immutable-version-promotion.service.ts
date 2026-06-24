/**
 * ImmutableVersionPromotionService — Patent 2 핵심 청구 단계.
 *
 * "승인된 fingerprint와 일치하는 경우에만 immutable workflow version
 * 으로 승격" — before publishing, the CURRENT workflow definition is
 * re-fingerprinted and compared byte-for-byte against the APPROVED
 * fingerprint. Mismatch (drift between approval and promotion) blocks
 * the promotion and flips the review to DRIFT_DETECTED.
 */
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaClient, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { GovernanceFingerprintService } from '../governance/governance-fingerprint.service';
import { EvidencePackService } from '../governance/evidence-pack.service';
import { WorkflowPersistenceService } from '../workflow/workflow-persistence.service';
import { OrbReviewMachineService } from './orb-review-machine.service';

@Injectable()
export class ImmutableVersionPromotionService {
  private readonly logger = new Logger(ImmutableVersionPromotionService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly fingerprints: GovernanceFingerprintService,
    private readonly evidencePacks: EvidencePackService,
    private readonly persistence: WorkflowPersistenceService,
    private readonly reviewMachine: OrbReviewMachineService,
  ) {}

  async promote(ctx: TenantContext, reviewId: string, policyVersionHash: string) {
    const review = await this.reviewMachine.getReview(ctx.tenantId, reviewId);
    if (review.status !== 'APPROVED') {
      throw new BadRequestException(
        `APPROVED 상태에서만 승격할 수 있습니다 (현재: ${review.status}).`,
      );
    }
    if (!review.fingerprintHash) {
      throw new BadRequestException('승인된 fingerprint가 없습니다.');
    }

    // 1. Re-compute the fingerprint of the workflow AS IT IS NOW.
    const input = await this.fingerprints.buildInputFromWorkflow(
      ctx.tenantId,
      review.workflowId,
      policyVersionHash,
    );
    const current = this.fingerprints.compute(input);

    // 2. Approved fingerprint must match the current definition.
    if (current.fingerprintHash !== review.fingerprintHash) {
      await this.reviewMachine.markStatus(
        ctx.tenantId,
        reviewId,
        'DRIFT_DETECTED',
        `promotion blocked: approved=${review.fingerprintHash.slice(0, 12)} current=${current.fingerprintHash.slice(0, 12)}`,
      );
      throw new ConflictException(
        '승인 이후 워크플로우가 변경되었습니다(drift). 재심사가 필요합니다.',
      );
    }

    // 3. Publish → immutable WorkflowVersion (snapshot) + ACTIVE.
    //    governanceApproved=true: fingerprint match was just validated above,
    //    so the publish guard must not re-check / block.
    const { workflow, version } = await this.persistence.publish(
      ctx,
      review.workflowId,
      `orb-approved ${review.fingerprintHash.slice(0, 12)}`,
      { governanceApproved: true },
    );

    // 4. Bind the fingerprint to the promoted version & advance review.
    await this.prisma.governanceFingerprint.update({
      where: { fingerprintHash: review.fingerprintHash },
      data: { workflowVersionId: version.id },
    });
    await this.reviewMachine.markStatus(ctx.tenantId, reviewId, 'PROMOTED', 'published', {
      promotedVersionId: version.id,
    });
    const activated = await this.reviewMachine.markStatus(
      ctx.tenantId,
      reviewId,
      'ACTIVE',
      'active version serving',
    );

    // 5. Promotion evidence pack (승인자/시각/fingerprint/replay 해시 포함).
    await this.evidencePacks.create({
      tenantId: ctx.tenantId,
      kind: 'REGISTRATION',
      workflowId: review.workflowId,
      workflowVersionId: version.id,
      orbGovernanceReviewId: reviewId,
      workflowHash: review.fingerprintHash,
      policyVersionHash,
      evaluation: {
        event: 'WORKFLOW_VERSION_PROMOTED',
        approvalHash: review.approvalHash,
        approvedAt: review.approvedAt,
        reviewerId: review.reviewerId,
        replayRunId: review.replayRunId,
        versionNumber: version.versionNumber,
      },
    });

    this.logger.log(
      `[promotion] workflow=${review.workflowId} version=${version.versionNumber} fingerprint=${review.fingerprintHash.slice(0, 12)}`,
    );

    return { workflow, version, review: activated };
  }
}
