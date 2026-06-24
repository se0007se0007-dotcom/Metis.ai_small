/**
 * Evaluation Policy Controller — Phase 1: Gate 정책 설정 시스템
 *
 * Backs the "Governance > 정책 관리 > 평가 Gate 설정" UI.
 *   - GET    /governance/evaluation-policy        → load (creates default on first access)
 *   - PUT    /governance/evaluation-policy        → update thresholds/weights
 *   - POST   /governance/evaluation-policy/reset  → restore built-in defaults
 */
import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';
import { EvaluationPolicyService } from './evaluation-policy.service';
import { UpdateEvaluationPolicyDto } from './evaluation-policy.dto';

@ApiTags('Governance')
@ApiBearerAuth()
@Controller('governance/evaluation-policy')
export class EvaluationPolicyController {
  constructor(private readonly policyService: EvaluationPolicyService) {}

  @Get()
  @Roles('AUDITOR')
  @ApiOperation({ summary: 'Load the evaluation Gate policy (creates default if absent)' })
  @ApiQuery({ name: 'name', required: false })
  async getPolicy(@CurrentUser() user: RequestUser, @Query('name') name?: string) {
    const policy = await this.policyService.getOrCreatePolicy(
      user.tenantId,
      name && name.trim() ? name.trim() : 'default',
    );
    return { policy };
  }

  @Put()
  @Roles('TENANT_ADMIN')
  @ApiOperation({ summary: 'Update the evaluation Gate policy' })
  async updatePolicy(@CurrentUser() user: RequestUser, @Body() dto: UpdateEvaluationPolicyDto) {
    const name = dto.name && dto.name.trim() ? dto.name.trim() : 'default';
    const policy = await this.policyService.updatePolicy(user.tenantId, name, dto);
    return { policy };
  }

  @Post('reset')
  @Roles('TENANT_ADMIN')
  @ApiOperation({ summary: 'Reset the evaluation Gate policy to built-in defaults' })
  @ApiQuery({ name: 'name', required: false })
  async resetPolicy(@CurrentUser() user: RequestUser, @Query('name') name?: string) {
    const policy = await this.policyService.resetPolicy(
      user.tenantId,
      name && name.trim() ? name.trim() : 'default',
    );
    return { policy };
  }
}
