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

  @Get('nav-counts')
  @ApiOperation({ summary: 'Real counts for left-nav badges' })
  async navCounts(@CurrentUser() user: RequestUser) {
    return this.dashboard.getNavCounts(user.tenantId);
  }

  @Get('overview')
  @ApiOperation({ summary: 'Dashboard 3-axis overview + main-agent rollups (메인/Sub-Agent 필터)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'workflowKey', required: false, type: String })
  @ApiQuery({ name: 'subAgent', required: false, type: String })
  async overview(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('workflowKey') workflowKey?: string,
    @Query('subAgent') subAgent?: string,
  ) {
    return this.dashboard.getOverview(user.tenantId, this.parseDays(days), {
      workflowKey: workflowKey || undefined,
      agentName: subAgent || undefined,
    });
  }

  @Get('effectiveness')
  @ApiOperation({ summary: 'Per-agent effectiveness table + tenant summary (SCENARIO 2)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async effectiveness(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    return this.dashboard.getEffectiveness(user.tenantId, this.parseDays(days));
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
  async agents(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('category') category?: string,
    @Query('includeUnlisted') includeUnlisted?: string,
  ) {
    // 기준정보(관리) 화면은 심사 전(listed=false) Agent도 봐야 하므로 includeUnlisted=true 를 보낸다.
    return this.dashboard.getAgents(
      user.tenantId,
      this.parseDays(days),
      category?.trim() || undefined,
      includeUnlisted === 'true' || includeUnlisted === '1',
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
