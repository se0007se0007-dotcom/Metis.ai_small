/**
 * Promotion Controller — Phase 3 API Endpoints
 *
 * Endpoints:
 *   POST   /release/promotions             — Create promotion/rollback
 *   GET    /release/promotions             — List promotion history
 *   GET    /release/promotions/:id         — Get promotion detail
 */
import { Controller, Get, Post, Body, Param, Query, UseGuards, HttpCode } from '@nestjs/common';
import { PromotionService } from './promotion.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';

@Controller('release/promotions')
@UseGuards(RolesGuard)
export class PromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  @Post()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @HttpCode(201)
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.promotionService.promote(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      body,
    );
  }

  @Get()
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async list(
    @CurrentUser() user: any,
    @Query('packId') packId?: string,
    @Query('action') action?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.promotionService.listHistory(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      {
        packId,
        action,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
    );
  }

  @Get(':id')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getById(@CurrentUser() user: any, @Param('id') id: string) {
    return this.promotionService.getById(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }

  // ── Stats ──

  @Get('stats/summary')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getStats(@CurrentUser() user: any) {
    return this.promotionService.getStats({
      tenantId: user.tenantId,
      userId: user.userId ?? user.id,
      role: user.role ?? 'OPERATOR',
    });
  }
}
