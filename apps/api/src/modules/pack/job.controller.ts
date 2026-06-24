/**
 * Job Status Controller
 * Query BullMQ job progress for async operations (import, etc.)
 */
import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { PackService } from './pack.service';
import { Roles } from '../../common/decorators';

@ApiTags('Jobs')
@ApiBearerAuth()
@Controller('jobs')
export class JobController {
  constructor(private readonly packService: PackService) {}

  @Get(':jobId')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get job status by ID' })
  @ApiResponse({ status: 200, description: 'Job status returned' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(@Param('jobId') jobId: string) {
    return this.packService.getJobStatus(jobId);
  }
}
