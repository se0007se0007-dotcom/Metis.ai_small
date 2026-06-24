/**
 * Runtime Governance API — 실행 중 거버넌스 판정 조회·승인 (Patent 1).
 *
 * GET  /governance/runtime/decisions?hours=               최근 판정 목록
 * GET  /governance/runtime/sessions/:sessionId/decisions  세션별 판정
 * GET  /governance/runtime/risk-summary?hours=            판정 분포 요약
 * POST /governance/runtime/decisions/:id/override         승인/반려 (사람 승인 경로)
 */
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';
import { RuntimeGovernanceService } from './runtime-governance.service';

@ApiTags('Governance')
@ApiBearerAuth()
@Controller('governance/runtime')
export class RuntimeGovernanceController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly runtimeGovernance: RuntimeGovernanceService,
  ) {}

  @Post('decisions/:id/override')
  @Roles('TENANT_ADMIN', 'OPERATOR')
  @ApiOperation({ summary: 'REQUIRE_APPROVAL/BLOCK 판정 승인 또는 반려 (사람 승인 경로)' })
  async overrideDecision(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { approve: boolean; reason?: string },
  ) {
    return this.runtimeGovernance.overrideDecision({
      tenantId: user.tenantId,
      decisionId: id,
      approverId: user.userId,
      approve: body.approve,
      reason: body.reason ?? (body.approve ? '운영자 승인' : '운영자 반려'),
    });
  }

  @Get('decisions')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'AUDITOR', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: '최근 런타임 거버넌스 판정 목록' })
  async recentDecisions(
    @CurrentUser() user: RequestUser,
    @Query('hours') hours?: string,
    @Query('decision') decision?: string,
  ) {
    const since = new Date(Date.now() - Number(hours ?? 24) * 3600_000);
    return this.prisma.governanceDecision.findMany({
      where: {
        tenantId: user.tenantId,
        createdAt: { gte: since },
        ...(decision ? { decision: decision as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Get('sessions/:sessionId/decisions')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'AUDITOR', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: '실행 세션의 노드별 거버넌스 판정' })
  async sessionDecisions(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.prisma.governanceDecision.findMany({
      where: { tenantId: user.tenantId, executionSessionId: sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get('risk-summary')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'AUDITOR', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: '기간 내 판정 유형별 집계' })
  async riskSummary(@CurrentUser() user: RequestUser, @Query('hours') hours?: string) {
    const since = new Date(Date.now() - Number(hours ?? 24) * 3600_000);
    const grouped = await this.prisma.governanceDecision.groupBy({
      by: ['decision'],
      where: { tenantId: user.tenantId, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const alerts = await this.prisma.fDSAlert.count({
      where: {
        tenantId: user.tenantId,
        subjectType: 'WorkflowNodeExecution',
        createdAt: { gte: since },
      },
    });
    return {
      since,
      decisions: Object.fromEntries(grouped.map((g) => [g.decision, g._count._all])),
      governanceAlerts: alerts,
    };
  }
}
