/**
 * Dashboard Controller — home dashboard aggregation API.
 *   GET /dashboard/overview        → 3 axes (KPI/quality/health) + main-agent rollups
 *   GET /dashboard/agents          → agent launcher list (workflows + status)
 *   GET /dashboard/agents/:key     → single main agent detail (sub-agent rollups)
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CurrentUser, RequestUser } from '../../common/decorators';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  private parseDays(days?: string): number {
    const n = days ? parseInt(days, 10) : 30;
    return Math.max(1, Math.min(180, Number.isFinite(n) ? n : 30));
  }

  /** PLATFORM_ADMIN만 다른 테넌트를 조회할 수 있다. 그 외에는 본인 테넌트로 고정. */
  private effectiveTenant(user: RequestUser, tenantId?: string): string {
    return user.role === 'PLATFORM_ADMIN' && tenantId?.trim() ? tenantId.trim() : user.tenantId;
  }

  @Get('nav-counts')
  @ApiOperation({ summary: 'Real counts for left-nav badges' })
  async navCounts(@CurrentUser() user: RequestUser) {
    return this.dashboard.getNavCounts(user.tenantId);
  }

  @Get('system-usage')
  @ApiOperation({
    summary: '활용 시스템 상세 — 활용 Agent를 시스템/팀/테넌트로 그룹핑 (PLATFORM_ADMIN은 교차-테넌트)',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async systemUsage(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    return this.dashboard.getSystemUsage(
      { tenantId: user.tenantId, role: user.role },
      this.parseDays(days),
    );
  }

  @Get('overview')
  @ApiOperation({ summary: 'Dashboard 3-axis overview + main-agent rollups (메인/Sub-Agent 필터)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'workflowKey', required: false, type: String })
  @ApiQuery({ name: 'subAgent', required: false, type: String })
  @ApiQuery({ name: 'teamId', required: false, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'PLATFORM_ADMIN 전용 테넌트 전환' })
  async overview(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('workflowKey') workflowKey?: string,
    @Query('subAgent') subAgent?: string,
    @Query('teamId') teamId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.dashboard.getOverview(this.effectiveTenant(user, tenantId), this.parseDays(days), {
      workflowKey: workflowKey || undefined,
      agentName: subAgent || undefined,
      teamId: teamId?.trim() || undefined,
    });
  }

  @Get('effectiveness')
  @ApiOperation({ summary: 'Per-agent effectiveness table + tenant summary (SCENARIO 2)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'teamId', required: false, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'PLATFORM_ADMIN 전용' })
  async effectiveness(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('teamId') teamId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.dashboard.getEffectiveness(this.effectiveTenant(user, tenantId), this.parseDays(days), {
      teamId: teamId?.trim() || undefined,
    });
  }

  @Get('nodes')
  @ApiOperation({
    summary: 'Sub-agent node list (WorkflowNodeDef) across listed workflows (SCENARIO 4)',
  })
  async nodes(@CurrentUser() user: RequestUser) {
    return this.dashboard.getNodes(user.tenantId);
  }

  @Get('nodes/eval-history')
  @ApiOperation({ summary: 'Sub-agent 단독 실행(테스트) 4게이트 평가 이력' })
  @ApiQuery({ name: 'agentName', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async nodeEvalHistory(
    @CurrentUser() user: RequestUser,
    @Query('agentName') agentName?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dashboard.getNodeTestHistory(
      user.tenantId,
      agentName,
      limit ? Math.max(1, Math.min(100, parseInt(limit, 10) || 20)) : 20,
    );
  }

  @Get('agents')
  @ApiOperation({ summary: 'Agent launcher list (workflows with status)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'includeUnlisted', required: false, type: Boolean })
  @ApiQuery({ name: 'teamId', required: false, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'PLATFORM_ADMIN 전용' })
  async agents(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('category') category?: string,
    @Query('includeUnlisted') includeUnlisted?: string,
    @Query('teamId') teamId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    // 기준정보(관리) 화면은 심사 전(listed=false) Agent도 봐야 하므로 includeUnlisted=true 를 보낸다.
    return this.dashboard.getAgents(
      this.effectiveTenant(user, tenantId),
      this.parseDays(days),
      category?.trim() || undefined,
      includeUnlisted === 'true' || includeUnlisted === '1',
      teamId?.trim() || undefined,
    );
  }

  @Get('history')
  @ApiOperation({ summary: 'Recent execution history (optional category filter)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'mine', required: false, type: Boolean })
  async history(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('mine') mine?: string,
  ) {
    const d = this.parseDays(days);
    let workflowKeys: string[] | undefined;
    if (category?.trim()) {
      const agents = await this.dashboard.getAgents(user.tenantId, d, category.trim());
      workflowKeys = agents.items.map((a: any) => a.key);
      if (workflowKeys.length === 0) return { items: [] };
    }
    // Personalization: mine=1|true → only the logged-in user's executions.
    const onlyMine = mine === '1' || mine === 'true';
    return this.dashboard.getExecutionHistory(user.tenantId, {
      workflowKeys,
      days: d,
      limit: limit ? parseInt(limit, 10) : 100,
      triggeredById: onlyMine ? user.userId : undefined,
    });
  }

  @Get('agents/:key')
  @ApiOperation({ summary: 'Single main agent detail (sub-agent node rollups)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async agentDetail(
    @CurrentUser() user: RequestUser,
    @Param('key') key: string,
    @Query('days') days?: string,
  ) {
    return this.dashboard.getAgentDetail(user.tenantId, key, this.parseDays(days));
  }

  @Get('executions/:id')
  @ApiOperation({
    summary: 'Full execution detail (quality/security/cost/error/runtime/policy/knowledge)',
  })
  async executionDetail(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.dashboard.getExecutionDetail(user.tenantId, id);
  }
}
