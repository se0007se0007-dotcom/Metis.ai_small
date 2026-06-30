import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { GovernanceService } from './governance.service';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';

@ApiTags('Governance')
@ApiBearerAuth()
@Controller('governance')
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  @Get('audit-logs')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Search audit logs' })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'correlationId', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async getAuditLogs(
    @CurrentUser() user: RequestUser,
    @Query('action') action?: string,
    @Query('correlationId') correlationId?: string,
    @Query('q') q?: string,
    @Query('targetType') targetType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.governanceService.getAuditLogs(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      {
        action,
        correlationId,
        q,
        targetType,
        from,
        to,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
    );
  }

  @Get('audit-logs/summary')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Audit log summary facets (totals, action breakdown, active actors)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getAuditSummary(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    return this.governanceService.getAuditSummary(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      days ? parseInt(days, 10) : 7,
    );
  }

  @Get('policies')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'List policies' })
  async getPolicies(@CurrentUser() user: RequestUser) {
    const items = await this.governanceService.getPolicies({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
    return { items };
  }

  @Get('policy-violations/recent')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Tenant-wide recent policy violations (non-PASS evaluations)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getRecentViolations(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    return this.governanceService.getRecentViolations(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      { days: days ? parseInt(days, 10) : undefined, limit: limit ? parseInt(limit, 10) : undefined },
    );
  }

  @Get('policy-field-options')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Selectable key values for the policy rule builder (workflows/capabilities)' })
  async getPolicyFieldOptions(@CurrentUser() user: RequestUser) {
    return this.governanceService.getPolicyFieldOptions({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
  }

  @Get('policy-stats')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Policy call/violation stats (overall + per-policy + daily timeseries)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getPolicyStats(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    return this.governanceService.getPolicyStats(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      days ? parseInt(days, 10) : undefined,
    );
  }

  @Get('policy-evaluations')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Policy evaluation history (filter by policy/result/period, paginated)' })
  @ApiQuery({ name: 'policyId', required: false })
  @ApiQuery({ name: 'result', required: false })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async getPolicyEvaluations(
    @CurrentUser() user: RequestUser,
    @Query('policyId') policyId?: string,
    @Query('result') result?: string,
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.governanceService.getPolicyEvaluations(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      {
        policyId,
        result,
        days: days ? parseInt(days, 10) : undefined,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
    );
  }

  @Get('policies/:id/violations')
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Recent evaluation/violation history for a policy' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'onlyViolations', required: false, type: Boolean })
  async getPolicyViolations(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('onlyViolations') onlyViolations?: string,
  ) {
    const items = await this.governanceService.getPolicyViolations(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      {
        limit: limit ? parseInt(limit, 10) : undefined,
        onlyViolations: onlyViolations === 'true',
      },
    );
    return { items };
  }

  @Post('policies')
  @Roles('TENANT_ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a policy' })
  async createPolicy(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      name: string;
      type?: string;
      isActive?: boolean;
      scope?: Record<string, unknown>;
      rules?: unknown[];
      description?: string;
      scopeLevel?: string;
    },
  ) {
    return this.governanceService.createPolicy(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      body,
    );
  }

  @Patch('policies/:id')
  @Roles('TENANT_ADMIN')
  @ApiOperation({ summary: 'Update a policy (toggle active or edit)' })
  async updatePolicy(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      type?: string;
      isActive?: boolean;
      scope?: Record<string, unknown>;
      rules?: unknown[];
      description?: string;
    },
  ) {
    return this.governanceService.updatePolicy(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      body,
    );
  }
}
