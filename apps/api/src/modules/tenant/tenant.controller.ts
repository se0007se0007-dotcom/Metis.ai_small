import { Controller, Get, Patch, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { CurrentUser, RequestUser, Roles, Audit } from '../../common/decorators';

@ApiTags('Tenant')
@ApiBearerAuth()
@Controller('tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get('current')
  @ApiOperation({ summary: 'Get current tenant context' })
  async getCurrent(@CurrentUser() user: RequestUser) {
    return this.tenantService.findById(user.tenantId);
  }

  @Get('current/members')
  @ApiOperation({ summary: 'List members of current tenant' })
  async getMembers(@CurrentUser() user: RequestUser) {
    return this.tenantService.getMemberships(user.tenantId);
  }

  // ── 운영 기준값(기준정보) ─────────────────────────────────────

  @Get('current/ops-reference')
  @ApiOperation({ summary: '현재 조직 운영 기준값(시급·근무시간·health 임계값·등급)' })
  async getOpsReference(@CurrentUser() user: RequestUser) {
    return this.tenantService.getOpsReference(user.tenantId);
  }

  @Put('current/ops-reference')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('UPDATE', 'OpsReference')
  @ApiOperation({ summary: '운영 기준값 저장' })
  async updateOpsReference(@CurrentUser() user: RequestUser, @Body() body: Record<string, any>) {
    return this.tenantService.updateOpsReference(user.tenantId, body);
  }

  /**
   * G6a (governance): toggle per-tenant settings. TENANT_ADMIN only.
   * Currently supports `externalLlmDisabled` — when true, external LLM API
   * calls for this tenant are blocked and replaced with local fallbacks.
   */
  @Patch('settings')
  @Roles('TENANT_ADMIN')
  @ApiOperation({ summary: 'Update current tenant settings (TENANT_ADMIN)' })
  async updateSettings(
    @CurrentUser() user: RequestUser,
    @Body() body: { externalLlmDisabled?: boolean },
  ) {
    return this.tenantService.updateSettings(user.tenantId, {
      externalLlmDisabled: body?.externalLlmDisabled,
    });
  }

  // ── 테넌트(조직)·팀 기준정보 ──────────────────────────────────

  @Get('current/org')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: '현재 조직(테넌트) + 소속 팀 목록' })
  async getOrg(@CurrentUser() user: RequestUser) {
    return this.tenantService.getOrgWithTeams(user.tenantId);
  }

  @Post('current/teams')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'Team')
  @ApiOperation({ summary: '팀 생성' })
  async createTeam(@CurrentUser() user: RequestUser, @Body() body: { name: string }) {
    return this.tenantService.createTeam(user.tenantId, body?.name);
  }

  @Patch('current/teams/:teamId')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('UPDATE', 'Team')
  @ApiOperation({ summary: '팀 이름 변경' })
  async updateTeam(
    @CurrentUser() user: RequestUser,
    @Param('teamId') teamId: string,
    @Body() body: { name: string },
  ) {
    return this.tenantService.updateTeam(user.tenantId, teamId, body?.name);
  }

  @Delete('current/teams/:teamId')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('DELETE', 'Team')
  @ApiOperation({ summary: '팀 삭제' })
  async deleteTeam(@CurrentUser() user: RequestUser, @Param('teamId') teamId: string) {
    return this.tenantService.deleteTeam(user.tenantId, teamId);
  }

  // ── 조직(테넌트) 다건 관리 (기준정보) ─────────────────────────

  @Get('all')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: '전체 조직(테넌트) 목록' })
  async listAll() {
    return this.tenantService.listAllTenants();
  }

  @Post()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'Tenant')
  @ApiOperation({ summary: '조직(테넌트) 생성' })
  async createTenant(@Body() body: { name: string; slug?: string }) {
    return this.tenantService.createTenant(body?.name, body?.slug);
  }

  // 특정 조직의 조직+팀 조회/관리 (by-id — current 와 경로 충돌 없음)
  @Get('by-id/:tenantId/org')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: '특정 조직 + 팀 목록' })
  async getOrgById(@Param('tenantId') tenantId: string) {
    return this.tenantService.getOrgWithTeams(tenantId);
  }

  @Post('by-id/:tenantId/teams')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'Team')
  @ApiOperation({ summary: '특정 조직에 팀 생성' })
  async createTeamFor(@Param('tenantId') tenantId: string, @Body() body: { name: string }) {
    return this.tenantService.createTeam(tenantId, body?.name);
  }

  @Patch('by-id/:tenantId/teams/:teamId')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('UPDATE', 'Team')
  @ApiOperation({ summary: '특정 조직의 팀 이름 변경' })
  async updateTeamFor(
    @Param('tenantId') tenantId: string,
    @Param('teamId') teamId: string,
    @Body() body: { name: string },
  ) {
    return this.tenantService.updateTeam(tenantId, teamId, body?.name);
  }

  @Delete('by-id/:tenantId/teams/:teamId')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('DELETE', 'Team')
  @ApiOperation({ summary: '특정 조직의 팀 삭제' })
  async deleteTeamFor(@Param('tenantId') tenantId: string, @Param('teamId') teamId: string) {
    return this.tenantService.deleteTeam(tenantId, teamId);
  }

  @Delete('by-id/:tenantId')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('DELETE', 'Tenant')
  @ApiOperation({ summary: '조직(테넌트) 삭제 — 본인 조직 불가, 데이터 없는 조직만' })
  async deleteTenant(@CurrentUser() user: RequestUser, @Param('tenantId') tenantId: string) {
    return this.tenantService.deleteTenant(user.tenantId, tenantId);
  }
}
