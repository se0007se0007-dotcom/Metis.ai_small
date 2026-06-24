/**
 * Certification Controller
 * Endpoints for certifying pack versions.
 */
import { Controller, Get, Post, Delete, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { CertificationService } from './certification.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';

@ApiTags('Certifications')
@ApiBearerAuth()
@Controller('certifications')
export class CertificationController {
  constructor(private readonly certService: CertificationService) {}

  @Post()
  @Roles('TENANT_ADMIN')
  @Audit('CERTIFY', 'Certification')
  @ApiOperation({ summary: 'Certify a pack version' })
  @ApiResponse({ status: 201, description: 'Certification created' })
  async certify(
    @CurrentUser() user: RequestUser,
    @Body() body: { packVersionId: string; level?: string; notes?: string },
  ) {
    return this.certService.certify(
      {
        packVersionId: body.packVersionId,
        level: body.level ?? 'STANDARD',
        notes: body.notes,
      },
      user.userId,
    );
  }

  @Get('version/:packVersionId')
  @ApiOperation({ summary: 'List certifications for a pack version' })
  async listByVersion(@Param('packVersionId') packVersionId: string) {
    const items = await this.certService.listCertifications(packVersionId);
    return { items };
  }

  @Get(':certificationId')
  @ApiOperation({ summary: 'Get certification details' })
  async getById(@Param('certificationId') certificationId: string) {
    return this.certService.getCertification(certificationId);
  }

  @Delete(':certificationId')
  @Roles('PLATFORM_ADMIN')
  @Audit('REVOKE_CERTIFICATION', 'Certification')
  @ApiOperation({ summary: 'Revoke a certification (PLATFORM_ADMIN only)' })
  async revoke(@Param('certificationId') certificationId: string) {
    return this.certService.revokeCertification(certificationId);
  }
}
