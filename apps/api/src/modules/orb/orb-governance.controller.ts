/**
 * ORB Governance Review API — Patent 2 등록/게시 거버넌스 엔드포인트.
 *
 * POST /orb/governance-reviews                          임시등록
 * GET  /orb/governance-reviews                          목록
 * GET  /orb/governance-reviews/:id                      상세(+이력)
 * POST /orb/governance-reviews/:id/fingerprint          fingerprint 생성
 * POST /orb/governance-reviews/:id/sandbox-replay       replay + auto score
 * POST /orb/governance-reviews/:id/apply-governance-patches  정책 자동 삽입
 * POST /orb/governance-reviews/:id/approve              심사자 승인
 * POST /orb/governance-reviews/:id/promote              immutable 승격
 * GET  /orb/governance-reviews/:id/drift-check          drift 검사
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';
import { OrbReviewMachineService } from './orb-review-machine.service';
import { ImmutableVersionPromotionService } from './immutable-version-promotion.service';
import { DriftDetectionService } from '../governance/drift-detection.service';
import { PolicyContextService } from '../governance/policy-context.service';

@ApiTags('ORB Governance')
@ApiBearerAuth()
@Controller('orb/governance-reviews')
export class OrbGovernanceController {
  constructor(
    private readonly machine: OrbReviewMachineService,
    private readonly promotion: ImmutableVersionPromotionService,
    private readonly drift: DriftDetectionService,
    private readonly policyContext: PolicyContextService,
  ) {}

  @Post()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN', 'OPERATOR', 'DEVELOPER')
  @ApiOperation({ summary: '워크플로우 거버넌스 심사 임시등록' })
  async register(@CurrentUser() user: RequestUser, @Body() body: { workflowId: string }) {
    return this.machine.register(user.tenantId, body.workflowId);
  }

  @Get()
  @Roles('TENANT_ADMIN', 'OPERATOR', 'DEVELOPER', 'AUDITOR', 'VIEWER')
  @ApiOperation({ summary: '거버넌스 심사 목록' })
  async list(@CurrentUser() user: RequestUser, @Query('workflowId') workflowId?: string) {
    return this.machine.listReviews(user.tenantId, workflowId);
  }

  @Post('drift-sweep')
  @Roles('TENANT_ADMIN', 'OPERATOR')
  @ApiOperation({ summary: '승인된 전체 워크플로우 drift 일괄 검사 (스케줄/수동)' })
  async driftSweep(@CurrentUser() user: RequestUser) {
    const policyVersionHash = await this.policyContext.getPolicyVersionHash(user.tenantId);
    return this.drift.sweep({ tenantId: user.tenantId, policyVersionHash });
  }

  @Get(':id')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'DEVELOPER', 'AUDITOR', 'VIEWER')
  @ApiOperation({ summary: '거버넌스 심사 상세 (상태 전이 이력 포함)' })
  async detail(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.machine.getReview(user.tenantId, id);
  }

  @Post(':id/fingerprint')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'DEVELOPER')
  @ApiOperation({ summary: 'Governance fingerprint 생성' })
  async fingerprint(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const policyVersionHash = await this.policyContext.getPolicyVersionHash(user.tenantId);
    return this.machine.fingerprint(user.tenantId, id, policyVersionHash);
  }

  @Post(':id/sandbox-replay')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'DEVELOPER')
  @ApiOperation({ summary: 'Sandbox replay 실행 + readiness 자동 채점' })
  async sandboxReplay(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { datasetId?: string },
  ) {
    return this.machine.replayAndScore(user.tenantId, id, body?.datasetId);
  }

  @Post(':id/apply-governance-patches')
  @Roles('TENANT_ADMIN', 'OPERATOR')
  @ApiOperation({ summary: '기준 미달 노드에 정책 체크포인트/승인/fallback 자동 삽입' })
  async applyPatches(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.machine.applyGovernancePatches(user.tenantId, id);
  }

  @Post(':id/approve')
  @Roles('TENANT_ADMIN', 'OPERATOR')
  @ApiOperation({ summary: '심사 승인 (fingerprint APPROVED + approvalHash 기록)' })
  async approve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.machine.approve(user.tenantId, id, user.userId);
  }

  @Post(':id/promote')
  @Roles('TENANT_ADMIN', 'OPERATOR')
  @ApiOperation({ summary: '승인 fingerprint 일치 시에만 immutable version 승격' })
  async promote(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const policyVersionHash = await this.policyContext.getPolicyVersionHash(user.tenantId);
    return this.promotion.promote(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      policyVersionHash,
    );
  }

  @Get(':id/drift-check')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'AUDITOR')
  @ApiOperation({ summary: '운영 정의와 승인 fingerprint 간 drift 검사' })
  async driftCheck(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const review = await this.machine.getReview(user.tenantId, id);
    const policyVersionHash = await this.policyContext.getPolicyVersionHash(user.tenantId);
    return this.drift.check({
      tenantId: user.tenantId,
      workflowId: review.workflowId,
      policyVersionHash,
      persist: true,
    });
  }
}
