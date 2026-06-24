import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AutonomousOpsService, CreateAutoActionDto } from './autonomous-ops.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';

@ApiTags('AutonomousOps')
@ApiBearerAuth()
@Controller('auto-actions')
export class AutonomousOpsController {
  constructor(private readonly service: AutonomousOpsService) {}

  @Get()
  @ApiOperation({ summary: 'List auto-actions' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('targetType') targetType?: string,
    @Query('hours') hours?: string,
    @Query('limit') limit?: string,
  ) {
    const items = await this.service.list(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      {
        status,
        targetType,
        hours: hours ? parseInt(hours) : undefined,
        limit: limit ? parseInt(limit) : undefined,
      },
    );
    return { items };
  }

  @Get('summary')
  @ApiOperation({ summary: 'Auto-action summary stats' })
  async summary(@CurrentUser() user: RequestUser, @Query('hours') hours?: string) {
    return this.service.summary(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      hours ? parseInt(hours) : 24,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get auto-action detail' })
  async getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.service.getById(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  @Post()
  @Roles('OPERATOR')
  @Audit('EXECUTE', 'AutoAction')
  @ApiOperation({ summary: 'Execute an autonomous action' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateAutoActionDto) {
    return this.service.executeAction(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  @Post(':id/verify')
  @Roles('OPERATOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record post-action verification result' })
  async verify(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { result: Record<string, any> },
  ) {
    return this.service.verify(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      body.result,
    );
  }

  @Post(':id/revert')
  @Roles('OPERATOR')
  @Audit('STATUS_TRANSITION', 'AutoAction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revert an auto-action (within grace window)' })
  async revert(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.service.revert(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }
}
