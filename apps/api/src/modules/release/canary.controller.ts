/**
 * Canary Controller — Phase 3 API Endpoints
 *
 * Endpoints:
 *   POST   /release/canary                 — Create canary deployment
 *   GET    /release/canary                 — List canary deployments
 *   GET    /release/canary/:id             — Get canary detail (with gates + metrics)
 *   POST   /release/canary/:id/start       — Start canary rollout
 *   POST   /release/canary/:id/promote     — Manual promote
 *   POST   /release/canary/:id/rollback    — Manual rollback
 *   POST   /release/canary/:id/evaluate    — Manual gate evaluation
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { CanaryService } from './canary.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import type { ComparisonMetrics } from '@metis/types';

/** Required metric keys for gate evaluation input validation */
const REQUIRED_METRIC_KEYS: (keyof ComparisonMetrics)[] = [
  'successRate',
  'errorRate',
  'policyViolationCount',
  'avgLatencyMs',
  'p99LatencyMs',
  'totalCostUsd',
  'retryCount',
  'invalidOutputCount',
  'totalExecutions',
];

function validateMetricsInput(metrics: any): ComparisonMetrics {
  if (!metrics || typeof metrics !== 'object') {
    throw new BadRequestException(
      'metrics must be a non-null object with ComparisonMetrics fields',
    );
  }
  for (const key of REQUIRED_METRIC_KEYS) {
    if (metrics[key] == null || typeof metrics[key] !== 'number' || Number.isNaN(metrics[key])) {
      throw new BadRequestException(
        `metrics.${String(key)} must be a valid number, got: ${metrics[key]}`,
      );
    }
  }
  if (metrics.successRate < 0 || metrics.successRate > 1) {
    throw new BadRequestException('metrics.successRate must be between 0 and 1');
  }
  if (metrics.errorRate < 0 || metrics.errorRate > 1) {
    throw new BadRequestException('metrics.errorRate must be between 0 and 1');
  }
  return metrics as ComparisonMetrics;
}

@Controller('release/canary')
@UseGuards(RolesGuard)
export class CanaryController {
  constructor(private readonly canaryService: CanaryService) {}

  @Post()
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CANARY_START', 'CanaryDeployment')
  @HttpCode(201)
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.canaryService.create(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      body,
    );
  }

  @Get()
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async list(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('packId') packId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.canaryService.list(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      {
        status,
        packId,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
    );
  }

  @Get(':id')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getById(@CurrentUser() user: any, @Param('id') id: string) {
    return this.canaryService.getById(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }

  @Post(':id/start')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @HttpCode(200)
  async start(@CurrentUser() user: any, @Param('id') id: string) {
    return this.canaryService.start(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }

  @Post(':id/promote')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CANARY_PROMOTE', 'CanaryDeployment')
  @HttpCode(200)
  async promote(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.canaryService.promote(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
      body.reason,
    );
  }

  @Post(':id/rollback')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CANARY_ROLLBACK', 'CanaryDeployment')
  @HttpCode(200)
  async rollback(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.canaryService.rollback(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
      body.reason,
    );
  }

  @Post(':id/evaluate')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CANARY_GATE_EVALUATE', 'CanaryGate')
  @HttpCode(200)
  async evaluate(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { windowNumber: number; metrics: any },
  ) {
    if (!body.windowNumber || typeof body.windowNumber !== 'number' || body.windowNumber < 1) {
      throw new BadRequestException('windowNumber must be a positive integer');
    }
    const validatedMetrics = validateMetricsInput(body.metrics);
    return this.canaryService.evaluateGate(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
      body.windowNumber,
      validatedMetrics,
    );
  }

  // ── Stats ──

  @Get('stats')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getStats(@CurrentUser() user: any) {
    return this.canaryService.getStats({
      tenantId: user.tenantId,
      userId: user.userId ?? user.id,
      role: user.role ?? 'OPERATOR',
    });
  }
}
