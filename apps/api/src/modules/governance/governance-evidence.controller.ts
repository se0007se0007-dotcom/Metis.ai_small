/**
 * Evidence Pack API — 감사용 증거팩 조회/무결성 검증 (Patent 1/2 공통).
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';
import { EvidencePackService } from './evidence-pack.service';

@ApiTags('Governance')
@ApiBearerAuth()
@Controller('governance/evidence-packs')
export class GovernanceEvidenceController {
  constructor(private readonly evidencePacks: EvidencePackService) {}

  @Get()
  @Roles('AUDITOR', 'TENANT_ADMIN', 'OPERATOR')
  @ApiOperation({ summary: '증거팩 목록 (kind/기간 필터 + 페이지네이션)' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('kind') kind?: string,
    @Query('hours') hours?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const from = hours ? new Date(Date.now() - Number(hours) * 3600_000) : undefined;
    return this.evidencePacks.list(user.tenantId, {
      kind,
      from,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('verify-chain')
  @Roles('AUDITOR', 'TENANT_ADMIN')
  @ApiOperation({ summary: '테넌트 증거팩 해시체인 무결성 검증' })
  async verifyChain(@CurrentUser() user: RequestUser, @Query('limit') limit?: string) {
    return this.evidencePacks.verifyChain(user.tenantId, limit ? Number(limit) : undefined);
  }

  @Get('sessions/:sessionId')
  @Roles('AUDITOR', 'TENANT_ADMIN', 'OPERATOR')
  @ApiOperation({ summary: '실행 세션의 증거팩 조회' })
  async bySession(@CurrentUser() user: RequestUser, @Param('sessionId') sessionId: string) {
    return this.evidencePacks.findBySession(user.tenantId, sessionId);
  }
}
