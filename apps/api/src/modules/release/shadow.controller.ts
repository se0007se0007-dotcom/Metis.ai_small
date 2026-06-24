/**
 * Shadow Controller — Phase 3 API Endpoints
 *
 * Endpoints:
 *   POST   /release/shadow/configs           — Create shadow config
 *   GET    /release/shadow/configs           — List shadow configs
 *   GET    /release/shadow/configs/:id       — Get config detail
 *   PATCH  /release/shadow/configs/:id/toggle — Activate/deactivate
 *   GET    /release/shadow/configs/:id/metrics — Aggregate comparison metrics
 *   GET    /release/shadow/pairs             — List shadow pairs
 *   GET    /release/shadow/pairs/:id         — Get pair detail
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ShadowService } from './shadow.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';

@Controller('release/shadow')
@UseGuards(RolesGuard)
export class ShadowController {
  constructor(private readonly shadowService: ShadowService) {}

  // ── Configs ──

  @Post('configs')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('SHADOW_CONFIG_CREATE', 'ShadowConfig')
  @HttpCode(201)
  async createConfig(@CurrentUser() user: any, @Body() body: any) {
    return this.shadowService.createConfig(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      body,
    );
  }

  @Get('configs')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async listConfigs(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.shadowService.listConfigs(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 20,
    );
  }

  @Get('configs/:id')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getConfig(@CurrentUser() user: any, @Param('id') id: string) {
    return this.shadowService.getConfig(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }

  @Patch('configs/:id/toggle')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @HttpCode(200)
  async toggleConfig(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    return this.shadowService.toggleConfig(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
      body.isActive,
    );
  }

  @Get('configs/:id/metrics')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getConfigMetrics(@CurrentUser() user: any, @Param('id') id: string) {
    return this.shadowService.getConfigMetrics(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }

  // ── Pairs ──

  @Get('pairs')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async listPairs(
    @CurrentUser() user: any,
    @Query('configId') configId?: string,
    @Query('verdict') verdict?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.shadowService.listPairs(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      {
        configId,
        verdict,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
    );
  }

  @Get('pairs/:id')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getPair(@CurrentUser() user: any, @Param('id') id: string) {
    return this.shadowService.getPair(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }

  // ── Stats ──

  @Get('stats')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getStats(@CurrentUser() user: any) {
    return this.shadowService.getStats({
      tenantId: user.tenantId,
      userId: user.userId ?? user.id,
      role: user.role ?? 'OPERATOR',
    });
  }
}
