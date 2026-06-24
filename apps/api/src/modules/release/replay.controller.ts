/**
 * Replay Controller — Phase 3 API Endpoints
 *
 * Endpoints:
 *   POST   /release/replay/datasets        — Create dataset from historical executions
 *   GET    /release/replay/datasets         — List datasets
 *   GET    /release/replay/datasets/:id     — Get dataset detail with cases
 *   POST   /release/replay/datasets/:id/golden  — Mark/unmark golden tasks
 *   GET    /release/replay/datasets/:id/golden  — List golden tasks
 *   POST   /release/replay/runs             — Start replay run
 *   GET    /release/replay/runs             — List replay runs
 *   GET    /release/replay/runs/:id         — Get run detail with case results
 */
import { Controller, Get, Post, Body, Param, Query, UseGuards, HttpCode } from '@nestjs/common';
import { ReplayService } from './replay.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';

@Controller('release/replay')
@UseGuards(RolesGuard)
export class ReplayController {
  constructor(private readonly replayService: ReplayService) {}

  // ── Datasets ──

  @Post('datasets')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('REPLAY_DATASET_CREATE', 'ReplayDataset')
  @HttpCode(201)
  async createDataset(@CurrentUser() user: any, @Body() body: any) {
    return this.replayService.createDataset(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      body,
    );
  }

  @Get('datasets')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async listDatasets(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.replayService.listDatasets(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 20,
    );
  }

  @Get('datasets/:id')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getDataset(@CurrentUser() user: any, @Param('id') id: string) {
    return this.replayService.getDataset(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }

  @Post('datasets/:id/golden')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @HttpCode(200)
  async markGolden(@CurrentUser() user: any, @Param('id') datasetId: string, @Body() body: any) {
    return this.replayService.markGolden(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      datasetId,
      body,
    );
  }

  @Get('datasets/:id/golden')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async listGoldenCases(@CurrentUser() user: any, @Param('id') datasetId: string) {
    return this.replayService.listGoldenCases(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      datasetId,
    );
  }

  // ── Runs ──

  @Post('runs')
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('REPLAY_RUN_START', 'ReplayRun')
  @HttpCode(202)
  async startRun(@CurrentUser() user: any, @Body() body: any) {
    return this.replayService.startRun(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      body,
    );
  }

  @Get('runs')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async listRuns(
    @CurrentUser() user: any,
    @Query('datasetId') datasetId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.replayService.listRuns(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      {
        datasetId,
        status,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
    );
  }

  @Get('runs/:id')
  @Roles('DEVELOPER', 'OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  async getRun(@CurrentUser() user: any, @Param('id') id: string) {
    return this.replayService.getRun(
      { tenantId: user.tenantId, userId: user.userId ?? user.id, role: user.role ?? 'OPERATOR' },
      id,
    );
  }
}
