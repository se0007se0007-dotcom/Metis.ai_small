/**
 * Policy Feedback Controller — Phase 2
 *
 * Backs "Governance > 정책 제안" review UI and the analysis trigger.
 *   - POST /governance/policy-suggestions/analyze   → run pattern analysis now
 *   - GET  /governance/policy-suggestions           → list (optional ?status=)
 *   - POST /governance/policy-suggestions/:id/approve → apply + mark applied
 *   - POST /governance/policy-suggestions/:id/reject  → mark rejected
 *   - GET  /governance/policy-suggestions/sampling    → adaptive sampling snapshot
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CurrentUser, RequestUser, Roles } from '../../../common/decorators';
import { PolicyFeedbackService } from './policy-feedback.service';
import { AdaptiveSamplingService } from './adaptive-sampling.service';

@ApiTags('Governance')
@ApiBearerAuth()
@Controller('governance/policy-suggestions')
export class PolicyFeedbackController {
  constructor(
    private readonly feedback: PolicyFeedbackService,
    private readonly sampling: AdaptiveSamplingService,
  ) {}

  @Post('analyze')
  @Roles('TENANT_ADMIN')
  @ApiOperation({ summary: '최근 평가 이력을 분석해 정책 제안 생성' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async analyze(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    const parsed = days ? Math.max(1, Math.min(180, parseInt(days, 10))) : 30;
    const created = await this.feedback.analyzeAndSuggest(user.tenantId, { days: parsed });
    return { created, count: created.length };
  }

  @Get()
  @Roles('AUDITOR')
  @ApiOperation({ summary: '정책 제안 목록' })
  @ApiQuery({ name: 'status', required: false })
  async list(@CurrentUser() user: RequestUser, @Query('status') status?: string) {
    const items = await this.feedback.listSuggestions(user.tenantId, { status });
    return { items };
  }

  @Post(':id/approve')
  @Roles('TENANT_ADMIN')
  @ApiOperation({ summary: '정책 제안 승인 및 적용' })
  async approve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.feedback.approveSuggestion(user.tenantId, id, user.userId);
  }

  @Post(':id/reject')
  @Roles('TENANT_ADMIN')
  @ApiOperation({ summary: '정책 제안 거부' })
  async reject(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.feedback.rejectSuggestion(user.tenantId, id, user.userId);
  }

  @Get('sampling')
  @Roles('AUDITOR')
  @ApiOperation({ summary: '적응형 샘플링 현황 스냅샷' })
  async samplingSnapshot() {
    return { rates: this.sampling.snapshot() };
  }
}
