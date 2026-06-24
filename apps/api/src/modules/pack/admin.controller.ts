/**
 * Pack Admin Controller
 * Admin-only endpoints for pack lifecycle management:
 * - Status transitions (BLOCK, DEPRECATE, promote)
 * - Pack CRUD
 * - Version management
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { PackService } from './pack.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';
import { PackStatus } from './domain';

@ApiTags('Pack Admin')
@ApiBearerAuth()
@Controller('admin/packs')
export class PackAdminController {
  constructor(private readonly packService: PackService) {}

  @Get()
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'List all packs (admin view, all statuses)' })
  @ApiQuery({ name: 'sourceType', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'search', required: false })
  async listAll(
    @Query('sourceType') sourceType?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const items = await this.packService.listPacks({
      sourceType,
      status,
      search,
      role: 'PLATFORM_ADMIN', // bypass visibility filter
    });
    return { items };
  }

  @Get(':packId')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get pack details (admin view)' })
  async getPackDetail(@Param('packId') packId: string) {
    return this.packService.getPackById(packId);
  }

  @Get(':packId/versions')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'List all versions of a pack' })
  async listVersions(@Param('packId') packId: string) {
    const items = await this.packService.getPackVersions(packId);
    return { items };
  }

  @Get('versions/:versionId')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get version details' })
  async getVersionDetail(@Param('versionId') versionId: string) {
    return this.packService.getPackVersionById(versionId);
  }

  @Post('versions/:versionId/transition')
  @Roles('TENANT_ADMIN')
  @Audit('STATUS_TRANSITION', 'PackVersion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition pack version status' })
  @ApiResponse({ status: 200, description: 'Status transitioned' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  async transitionStatus(
    @Param('versionId') versionId: string,
    @CurrentUser() user: RequestUser,
    @Body() body: { targetStatus: PackStatus },
  ) {
    return this.packService.transitionVersionStatus(versionId, body.targetStatus, user.role);
  }

  @Post('versions/:versionId/block')
  @Roles('PLATFORM_ADMIN')
  @Audit('BLOCK', 'PackVersion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a pack version (PLATFORM_ADMIN only)' })
  async blockVersion(
    @Param('versionId') versionId: string,
    @CurrentUser() user: RequestUser,
    @Body() body: { reason?: string },
  ) {
    return this.packService.transitionVersionStatus(versionId, 'BLOCKED', user.role);
  }

  @Post('versions/:versionId/deprecate')
  @Roles('TENANT_ADMIN')
  @Audit('DEPRECATE', 'PackVersion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deprecate a published pack version' })
  async deprecateVersion(@Param('versionId') versionId: string, @CurrentUser() user: RequestUser) {
    return this.packService.transitionVersionStatus(versionId, 'DEPRECATED', user.role);
  }
}
