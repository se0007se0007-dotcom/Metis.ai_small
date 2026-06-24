/**
 * Fraud Detection System — Controller
 *
 * RESTful API endpoints for:
 *   - Rule management (CRUD)
 *   - Alert listing, details, resolution
 *   - Real-time rule evaluation (testing)
 *   - Summary dashboards
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CurrentUser, RequestUser, Roles, Audit } from '../../common/decorators';
import { EndpointThrottleGuard } from '../../common/guards/endpoint-throttle.guard';
import { RuleEngineService } from './rule-engine.service';
import { AlertService } from './alert.service';
import { AnomalyService } from './anomaly.service';
import { RiskService } from './risk.service';

@ApiTags('FraudDetection')
@ApiBearerAuth()
@Controller('fds')
export class FdsController {
  constructor(
    private readonly ruleEngine: RuleEngineService,
    private readonly alertService: AlertService,
    private readonly anomalyService: AnomalyService,
    private readonly riskService: RiskService,
  ) {}

  // ─────────────────────────────────────────────────────────
  // Rule Management
  // ─────────────────────────────────────────────────────────

  @Get('rules')
  @Roles('OPERATOR', 'AUDITOR', 'TENANT_ADMIN')
  @ApiOperation({ summary: 'List all enabled rules for tenant' })
  async listRules(@CurrentUser() user: RequestUser) {
    const rules = await this.ruleEngine.listRules({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
    return { items: rules };
  }

  @Post('rules')
  @Roles('TENANT_ADMIN', 'DEVELOPER')
  @Audit('CREATE', 'FDSRule')
  @ApiOperation({ summary: 'Create a new fraud detection rule' })
  async createRule(@CurrentUser() user: RequestUser, @Body() dto: any) {
    if (!dto.name || !dto.conditions || typeof dto.weight !== 'number') {
      throw new BadRequestException(
        'Missing required fields: name, conditions (array), weight (number)',
      );
    }

    const rule = await this.ruleEngine.createRule(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      dto,
    );

    return rule;
  }

  @Put('rules/:id')
  @Roles('TENANT_ADMIN', 'DEVELOPER')
  @Audit('UPDATE', 'FDSRule')
  @ApiOperation({ summary: 'Update an existing rule' })
  async updateRule(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: any) {
    const rule = await this.ruleEngine.updateRule(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      id,
      dto,
    );

    return rule;
  }

  // ─────────────────────────────────────────────────────────
  // Agent Operational-Risk Dashboard
  // ─────────────────────────────────────────────────────────

  @Get('risk/overview')
  @Roles('AUDITOR', 'OPERATOR', 'TENANT_ADMIN')
  @ApiOperation({ summary: 'Agent operational-risk overview (totals + per-agent risk + trend)' })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Window (default 30)' })
  async getRiskOverview(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    const parsedDays = days ? Math.max(1, Math.min(365, parseInt(days, 10))) : 30;
    return this.riskService.getRiskOverview(user.tenantId, parsedDays);
  }

  // ─────────────────────────────────────────────────────────
  // Alert Management
  // ─────────────────────────────────────────────────────────

  @Get('alerts')
  @Roles('OPERATOR', 'AUDITOR', 'TENANT_ADMIN')
  @ApiOperation({ summary: 'List fraud alerts with filtering' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['OPEN', 'ESCALATED', 'BLOCKED', 'DISMISSED', 'RESOLVED'],
  })
  @ApiQuery({ name: 'severity', required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @ApiQuery({
    name: 'category',
    required: false,
    enum: ['security', 'quality', 'anomaly', 'cost', 'policy'],
  })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Time window in days' })
  @ApiQuery({ name: 'hours', required: false, type: Number, description: 'Time window in hours' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listAlerts(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('category') category?: string,
    @Query('subjectType') subjectType?: string,
    @Query('days') days?: string,
    @Query('hours') hours?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, summary } = await this.alertService.listAlertsWithSummary(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      {
        status,
        severity,
        category,
        subjectType,
        days: days ? parseInt(days, 10) : undefined,
        hours: hours ? parseInt(hours, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : 100,
      },
    );

    return { items, summary };
  }

  @Get('alerts/summary')
  @Roles('OPERATOR', 'AUDITOR', 'TENANT_ADMIN')
  @ApiOperation({ summary: 'Get alert summary (counts by status/severity)' })
  @ApiQuery({
    name: 'hours',
    required: false,
    type: Number,
    description: 'Time window (default 24)',
  })
  async getAlertSummary(@CurrentUser() user: RequestUser, @Query('hours') hours?: string) {
    const summary = await this.alertService.summary(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      hours ? parseInt(hours, 10) : 24,
    );

    return summary;
  }

  @Get('alerts/:id')
  @Roles('OPERATOR', 'AUDITOR', 'TENANT_ADMIN')
  @ApiOperation({ summary: 'Get alert details' })
  async getAlert(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const alert = await this.alertService.getAlertWithRelated(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      id,
    );

    return alert;
  }

  @Post('alerts')
  @Roles('OPERATOR', 'TENANT_ADMIN')
  @Audit('CREATE', 'FDSAlert')
  @ApiOperation({ summary: 'Manually create an alert (testing/debugging)' })
  async createAlert(@CurrentUser() user: RequestUser, @Body() dto: any) {
    if (!dto.subjectId || !dto.subjectType || typeof dto.score !== 'number' || !dto.summary) {
      throw new BadRequestException(
        'Missing required fields: subjectId, subjectType, score (0..1), summary',
      );
    }

    const alert = await this.alertService.createAlert(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      dto,
    );

    return alert;
  }

  @Post('alerts/:id/resolve')
  @Roles('OPERATOR', 'TENANT_ADMIN')
  @Audit('UPDATE', 'FDSAlert')
  @ApiOperation({ summary: 'Resolve an alert' })
  async resolveAlert(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: any) {
    const { decision, comment, feedbackToModel } = dto;

    if (!decision) {
      throw new BadRequestException(
        'Missing required field: decision (BLOCKED|DISMISSED|RESOLVED)',
      );
    }

    const alert = await this.alertService.resolve(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      id,
      decision,
      comment,
      feedbackToModel,
    );

    return alert;
  }

  @Post('alerts/:id/escalate')
  @Roles('OPERATOR', 'TENANT_ADMIN')
  @Audit('UPDATE', 'FDSAlert')
  @ApiOperation({ summary: 'Escalate an alert to another user' })
  async escalateAlert(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: any) {
    const { assignee } = dto;

    if (!assignee) {
      throw new BadRequestException('Missing required field: assignee (user ID or email)');
    }

    const alert = await this.alertService.escalate(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      id,
      assignee,
    );

    return alert;
  }

  @Post('alerts/:id/block')
  @Roles('OPERATOR', 'TENANT_ADMIN')
  @Audit('UPDATE', 'FDSAlert')
  @ApiOperation({ summary: 'Block the alert subject (status -> BLOCKED)' })
  async blockAlert(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: any) {
    return this.alertService.block(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      id,
      dto?.note ?? dto?.comment,
    );
  }

  @Post('alerts/:id/ignore')
  @Roles('OPERATOR', 'TENANT_ADMIN')
  @Audit('UPDATE', 'FDSAlert')
  @ApiOperation({ summary: 'Ignore/dismiss the alert (status -> DISMISSED)' })
  async ignoreAlert(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: any) {
    return this.alertService.ignore(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      id,
      dto?.feedback ?? dto?.comment,
    );
  }

  // ─────────────────────────────────────────────────────────
  // Testing & Evaluation
  // ─────────────────────────────────────────────────────────

  @Post('evaluate')
  @Roles('DEVELOPER', 'OPERATOR')
  // Expensive: evaluates every enabled rule. Tight per-user limit on top of the
  // global ThrottleGuard so a single caller cannot hammer the rule engine.
  @UseGuards(new EndpointThrottleGuard({ limit: 30, windowMs: 60_000, bucket: 'fds:evaluate' }))
  @ApiOperation({
    summary: 'Evaluate all rules against a subject (testing)',
    description: 'Body: { subject: {...} } — returns matched rules and aggregate score',
  })
  async evaluateSubject(
    @CurrentUser() user: RequestUser,
    @Body() dto: { subject: Record<string, any> },
  ) {
    if (!dto.subject || typeof dto.subject !== 'object') {
      throw new BadRequestException('Body must contain: { subject: {...} }');
    }

    const result = await this.ruleEngine.evaluateAll(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      dto.subject,
    );

    return result;
  }
}
