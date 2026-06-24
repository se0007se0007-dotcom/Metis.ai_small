import { Controller, Get, Post, Delete, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { PackService } from './pack.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';
import { InstallPackDto } from '../../common/dto';

@ApiTags('Installations')
@ApiBearerAuth()
@Controller('installations')
export class InstallationController {
  constructor(private readonly packService: PackService) {}

  @Get()
  @ApiOperation({ summary: 'List installations for current tenant' })
  async list(@CurrentUser() user: RequestUser) {
    const items = await this.packService.getInstallations({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
    return { items };
  }

  @Post()
  @Roles('OPERATOR')
  @Audit('INSTALL', 'PackInstallation')
  @ApiOperation({ summary: 'Install pack into current tenant' })
  @ApiResponse({ status: 201, description: 'Pack installed' })
  async install(@CurrentUser() user: RequestUser, @Body() dto: InstallPackDto) {
    return this.packService.install(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto.packId,
      dto.packVersionId,
      dto.config,
    );
  }

  @Delete(':installationId')
  @Roles('OPERATOR')
  @Audit('UNINSTALL', 'PackInstallation')
  @ApiOperation({ summary: 'Uninstall pack from current tenant' })
  async uninstall(
    @CurrentUser() user: RequestUser,
    @Param('installationId') installationId: string,
  ) {
    return this.packService.uninstall(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      installationId,
    );
  }
}
