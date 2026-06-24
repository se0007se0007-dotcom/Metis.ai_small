import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { PackService } from './pack.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';
import { PackImportDto } from '../../common/dto';

@ApiTags('Packs')
@ApiBearerAuth()
@Controller('packs')
export class PackController {
  constructor(private readonly packService: PackService) {}

  @Get()
  @ApiOperation({ summary: 'List packs (filtered by role visibility)' })
  @ApiQuery({ name: 'sourceType', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'search', required: false })
  async listPacks(
    @CurrentUser() user: RequestUser,
    @Query('sourceType') sourceType?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const items = await this.packService.listPacks({
      sourceType,
      status,
      search,
      role: user.role,
    });
    return { items };
  }

  @Post('import')
  @Roles('OPERATOR')
  @Audit('IMPORT', 'Pack')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Import pack from external source (async)' })
  @ApiResponse({ status: 202, description: 'Import queued' })
  async importPack(@Body() dto: PackImportDto, @CurrentUser() user: RequestUser) {
    return this.packService.importPack(dto, {
      userId: user.userId,
      tenantId: user.tenantId,
    });
  }

  @Get(':packId')
  @ApiOperation({ summary: 'Get pack details' })
  async getPackById(@Param('packId') packId: string) {
    return this.packService.getPackById(packId);
  }

  @Get(':packId/versions')
  @ApiOperation({ summary: 'List pack versions' })
  async getVersions(@Param('packId') packId: string) {
    const items = await this.packService.getPackVersions(packId);
    return { items };
  }
}
