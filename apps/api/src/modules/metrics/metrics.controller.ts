/**
 * Metrics Controller — MEASURED effectiveness-signal collection + inspection.
 *
 *   POST /metrics/effectiveness-signal   → record one DETECTION / COVERAGE signal
 *   GET  /metrics/effectiveness-signals   → recent signals for inspection
 *
 * Signals feed the MEASURED MTTD / coverage shown on /dashboard/effectiveness.
 *
 * @module metrics
 */
import { Controller, Get, Post, Body, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsIn, IsISO8601, Min, Max } from 'class-validator';
import { CurrentUser, RequestUser, Roles, Audit } from '../../common/decorators';
import { EffectivenessSignalService, RawEffectivenessSignal } from './effectiveness-signal.service';

export class EffectivenessSignalDto {
  @IsString()
  workflowKey!: string;

  @IsOptional()
  @IsString()
  stepKey?: string;

  @IsOptional()
  @IsString()
  executionSessionId?: string;

  @IsIn(['DETECTION', 'COVERAGE'])
  kind!: 'DETECTION' | 'COVERAGE';

  // DETECTION
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsISO8601()
  detectedAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  detectSeconds?: number;

  // COVERAGE
  @IsOptional()
  @IsNumber()
  @Min(0)
  testsTotal?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  testsPassed?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  coveragePct?: number;
}

@ApiTags('Metrics')
@ApiBearerAuth()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly signals: EffectivenessSignalService) {}

  @Post('effectiveness-signal')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'EffectivenessSignal')
  @ApiOperation({
    summary: 'Record a MEASURED effectiveness signal (DETECTION or COVERAGE)',
  })
  async record(@CurrentUser() user: RequestUser, @Body() dto: EffectivenessSignalDto) {
    if (dto.kind === 'DETECTION') {
      const hasGap = !!(dto.occurredAt && dto.detectedAt);
      if (!hasGap && (dto.detectSeconds == null || !Number.isFinite(dto.detectSeconds))) {
        throw new BadRequestException(
          'DETECTION requires occurredAt+detectedAt (ISO) or an explicit detectSeconds',
        );
      }
    } else {
      const hasPct = dto.coveragePct != null && Number.isFinite(dto.coveragePct);
      const hasCounts =
        dto.testsTotal != null &&
        dto.testsPassed != null &&
        Number.isFinite(dto.testsTotal) &&
        Number.isFinite(dto.testsPassed) &&
        dto.testsTotal > 0;
      if (!hasPct && !hasCounts) {
        throw new BadRequestException(
          'COVERAGE requires coveragePct or (testsTotal & testsPassed)',
        );
      }
    }

    const payload: RawEffectivenessSignal = { ...(dto as any), source: 'api' };
    const row = await this.signals.record(user.tenantId, payload);
    if (!row) throw new BadRequestException('Failed to persist effectiveness signal');
    return row;
  }

  @Get('effectiveness-signals')
  @Roles('OPERATOR', 'AUDITOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @ApiOperation({
    summary: 'List recent effectiveness signals (max 200) for inspection',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Window (default 30)',
  })
  @ApiQuery({ name: 'kind', required: false, enum: ['DETECTION', 'COVERAGE'] })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('kind') kind?: string,
  ) {
    const parsedDays = days ? Math.max(1, Math.min(365, parseInt(days, 10))) : 30;
    const since = new Date();
    since.setDate(since.getDate() - parsedDays);
    const k = kind === 'DETECTION' || kind === 'COVERAGE' ? kind : undefined;
    const items = await this.signals.listByTenant(user.tenantId, since, k, 200);
    return {
      window: { days: parsedDays, since: since.toISOString() },
      count: items.length,
      items,
    };
  }
}
