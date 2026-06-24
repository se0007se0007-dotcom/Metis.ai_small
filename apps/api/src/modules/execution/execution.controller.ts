/**
 * Execution Controller — Phase 2
 * Endpoints: CRUD + Kill Switch + Stats + SSE stream
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { Observable, interval, map, takeWhile, switchMap, from, of, concat } from 'rxjs';
import { ExecutionService } from './execution.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';
import { CreateExecutionDto, PaginationDto } from '../../common/dto';

@ApiTags('Executions')
@ApiBearerAuth()
@Controller('executions')
export class ExecutionController {
  constructor(private readonly executionService: ExecutionService) {}

  @Post()
  @Roles('OPERATOR')
  @Audit('EXECUTE', 'ExecutionSession')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Create execution (with policy pre-check)' })
  @ApiResponse({ status: 202, description: 'Execution queued' })
  @ApiResponse({ status: 403, description: 'Blocked by policy' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateExecutionDto) {
    return this.executionService.create(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List executions (paginated)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'packInstallationId', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('packInstallationId') packInstallationId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('days') days?: string,
  ) {
    return this.executionService.list(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      {
        status,
        packInstallationId,
        page: page ? +page : undefined,
        pageSize: pageSize ? +pageSize : undefined,
        days: days ? +days : undefined,
      },
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get execution statistics for current tenant' })
  async getStats(@CurrentUser() user: RequestUser) {
    return this.executionService.getStats({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
  }

  @Get(':executionId')
  @ApiOperation({ summary: 'Get execution detail with steps and traces' })
  async getById(@CurrentUser() user: RequestUser, @Param('executionId') id: string) {
    return this.executionService.getById(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  @Get(':executionId/trace')
  @ApiOperation({ summary: 'Get execution trace' })
  async getTrace(@CurrentUser() user: RequestUser, @Param('executionId') id: string) {
    return this.executionService.getTrace(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  @Post(':executionId/kill')
  @Roles('OPERATOR')
  @Audit('DELETE', 'ExecutionSession')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Kill switch — cancel running execution' })
  @ApiResponse({ status: 200, description: 'Execution cancelled' })
  async kill(
    @CurrentUser() user: RequestUser,
    @Param('executionId') executionId: string,
    @Body() body: { reason?: string },
  ) {
    return this.executionService.kill(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      executionId,
      body.reason,
    );
  }

  /**
   * SSE — Real-time execution progress stream
   * Client subscribes to GET /executions/:id/stream
   * Receives status updates every 2 seconds until terminal state.
   */
  @Sse(':executionId/stream')
  @ApiOperation({ summary: 'SSE stream for execution progress' })
  stream(
    @CurrentUser() user: RequestUser,
    @Param('executionId') executionId: string,
  ): Observable<MessageEvent> {
    const ctx = { tenantId: user.tenantId, userId: user.userId, role: user.role };
    const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'];

    let completed = false;

    return interval(2000).pipe(
      takeWhile(() => !completed),
      switchMap(() => from(this.executionService.getById(ctx, executionId).catch(() => null))),
      map((session) => {
        if (!session) {
          completed = true;
          return { data: { error: 'Execution not found' } } as MessageEvent;
        }

        if (TERMINAL_STATUSES.includes(session.status)) {
          completed = true;
        }

        return {
          data: {
            id: session.id,
            status: session.status,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            latencyMs: session.latencyMs,
            stepsCount: session.steps?.length ?? 0,
            stepsCompleted: session.steps?.filter((s: any) => s.status === 'SUCCEEDED').length ?? 0,
          },
        } as MessageEvent;
      }),
    );
  }
}
