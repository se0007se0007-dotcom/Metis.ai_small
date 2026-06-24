/**
 * Connector Controller — Phase 3~4 (Upgraded)
 * Full CRUD + Health Check + Runtime Invocation + Lifecycle + Schema + Test + Governance
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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import {
  ConnectorService,
  CreateConnectorDto,
  ConnectorInvocationRequest,
} from './connector.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';

@ApiTags('Connectors')
@ApiBearerAuth()
@Controller('connectors')
export class ConnectorController {
  constructor(private readonly connectorService: ConnectorService) {}

  // ═══════════════════════════════════════════
  //  CRUD
  // ═══════════════════════════════════════════

  @Get()
  @ApiOperation({ summary: 'List connectors for current tenant' })
  async list(@CurrentUser() user: RequestUser) {
    const items = await this.connectorService.list({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
    return { items };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get connector by ID' })
  async getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.getById(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  @Post()
  @Roles('OPERATOR')
  @Audit('CREATE', 'Connector')
  @ApiOperation({ summary: 'Create a new connector' })
  @ApiResponse({ status: 201, description: 'Connector created' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateConnectorDto) {
    return this.connectorService.create(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  @Put(':id')
  @Roles('OPERATOR')
  @Audit('UPDATE', 'Connector')
  @ApiOperation({ summary: 'Update connector' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: Partial<CreateConnectorDto>,
  ) {
    return this.connectorService.update(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      dto,
    );
  }

  @Delete(':id')
  @Roles('TENANT_ADMIN')
  @Audit('DELETE', 'Connector')
  @ApiOperation({ summary: 'Delete connector' })
  async delete(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.delete(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  // ═══════════════════════════════════════════
  //  Health Check
  // ═══════════════════════════════════════════

  @Post(':id/health-check')
  @Roles('OPERATOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run health check on connector' })
  async healthCheck(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.healthCheck(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  // ═══════════════════════════════════════════
  //  Lifecycle Management (Start/Stop/Restart)
  // ═══════════════════════════════════════════

  @Post(':id/start')
  @Roles('OPERATOR')
  @Audit('EXECUTE', 'Connector')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start connector (MCP server connection)' })
  async start(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.startConnector(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  @Post(':id/stop')
  @Roles('OPERATOR')
  @Audit('STATUS_TRANSITION', 'Connector')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop connector' })
  async stop(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.stopConnector(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  @Post(':id/restart')
  @Roles('OPERATOR')
  @Audit('STATUS_TRANSITION', 'Connector')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restart connector' })
  async restart(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.restartConnector(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  // ═══════════════════════════════════════════
  //  Schema Discovery & Tools
  // ═══════════════════════════════════════════

  @Post(':id/discover')
  @Roles('OPERATOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Discover connector capabilities / schema' })
  async discover(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.discoverSchema(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  @Get(':id/tools')
  @ApiOperation({ summary: 'Get MCP tools list for connector' })
  async getTools(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.getTools(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  // ═══════════════════════════════════════════
  //  Test Pipeline
  // ═══════════════════════════════════════════

  @Post(':id/test')
  @Roles('OPERATOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run test pipeline on connector' })
  async test(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.connectorService.testConnector(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  // ═══════════════════════════════════════════
  //  Governed Invocation
  // ═══════════════════════════════════════════

  @Post('invoke')
  @Roles('OPERATOR')
  @Audit('EXECUTE', 'Connector')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invoke connector through governed runtime layer' })
  async invoke(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      connectorKey: string;
      actionType: string;
      method: string;
      payload: Record<string, unknown>;
      executionSessionId: string;
    },
  ) {
    return this.connectorService.invoke({
      connectorKey: body.connectorKey,
      actionType: body.actionType as any,
      method: body.method,
      payload: body.payload,
      executionContext: {
        tenantId: user.tenantId,
        userId: user.userId,
        executionSessionId: body.executionSessionId,
        correlationId: `conn-${Date.now()}`,
      },
    });
  }

  // ═══════════════════════════════════════════
  //  Governance Monitoring Endpoints
  // ═══════════════════════════════════════════

  @Get('governance/overview')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get governance monitoring overview' })
  async governanceOverview() {
    return this.connectorService.getGovernanceOverview();
  }

  @Get('governance/rate-limits')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get rate limiter stats' })
  async rateLimits(@Query('connectorId') connectorId?: string) {
    return this.connectorService.getRateLimitStats(connectorId);
  }

  @Get('governance/circuits')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get circuit breaker states' })
  async circuits(@Query('connectorId') connectorId?: string) {
    return this.connectorService.getCircuitBreakerStates(connectorId);
  }

  @Get('governance/call-logs')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Query call logs' })
  async callLogs(
    @CurrentUser() user: RequestUser,
    @Query('connectorId') connectorId?: string,
    @Query('success') success?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.connectorService.getCallLogs({
      connector_id: connectorId,
      tenant_id: user.tenantId,
      success: success !== undefined ? success === 'true' : undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
  }

  @Get('governance/call-stats')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get call statistics' })
  async callStats(@Query('connectorId') connectorId?: string, @Query('period') period?: string) {
    return this.connectorService.getCallStats(connectorId, period ? parseInt(period) : 60);
  }

  @Get('governance/lifecycle')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Get lifecycle statuses' })
  async lifecycleStatuses() {
    return this.connectorService.getLifecycleStatuses();
  }
}
