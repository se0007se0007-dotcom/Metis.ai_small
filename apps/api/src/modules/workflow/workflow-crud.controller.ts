/**
 * Workflow CRUD Controller — Phase 6 Step 2 (Server Persistence)
 *
 * REST endpoints for workflow lifecycle management:
 *   GET    /workflows                         — List workflows (with search/filter/pagination)
 *   POST   /workflows                         — Create new workflow
 *   GET    /workflows/:id                     — Get workflow detail (with nodes/edges)
 *   PUT    /workflows/:id                     — Update workflow (OCC protected)
 *   DELETE /workflows/:id                     — Soft delete workflow
 *   POST   /workflows/:id/publish             — Publish (create version snapshot)
 *   POST   /workflows/:id/archive             — Archive workflow
 *   POST   /workflows/:id/duplicate           — Duplicate workflow
 *   GET    /workflows/:id/versions            — List version history
 *   POST   /workflows/:id/versions/:vid/restore — Restore to a specific version
 *
 * Note: The execute-draft and resolve-nodes endpoints remain in WorkflowController
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiQuery,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min, Max, IsArray } from 'class-validator';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';
import {
  WorkflowPersistenceService,
  CreateWorkflowDto,
  UpdateWorkflowDto,
  WorkflowNodeDto,
  WorkflowEdgeDto,
} from './workflow-persistence.service';

// ── Request DTOs ──

class CreateWorkflowBody {
  @IsString() key!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() tags?: string[];
  @IsArray() nodes!: WorkflowNodeDto[];
  @IsOptional() @IsArray() edges?: WorkflowEdgeDto[];
}

class UpdateWorkflowBody {
  name?: string;
  description?: string;
  tags?: string[];
  nodes?: WorkflowNodeDto[];
  edges?: WorkflowEdgeDto[];
  expectedVersion!: number;
}

class PublishBody {
  label?: string;
}

class DuplicateBody {
  newKey!: string;
  newName!: string;
}

/**
 * SCENARIO 2 / OPS: editable per-agent effectiveness baseline + system assignment.
 * All fields OPTIONAL — only provided keys are merged into effectivenessJson.
 */
class UpdateEffectivenessBody {
  @ApiPropertyOptional({ description: 'Target system this agent serves' })
  @IsOptional()
  @IsString()
  system?: string;

  @ApiPropertyOptional({
    description: 'Manual minutes per run (baseline)',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  manualMinutesPerRun?: number;

  @ApiPropertyOptional({ description: 'Value label tag' })
  @IsOptional()
  @IsString()
  valueLabel?: string;

  @ApiPropertyOptional({ description: 'Domain label' })
  @IsOptional()
  @IsString()
  domain?: string;

  @ApiPropertyOptional({
    description: 'MTTD target percentage (0-100)',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  mttdTargetPct?: number;

  @ApiPropertyOptional({
    description: 'Coverage target multiplier (>= 0)',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  coverageTargetX?: number;

  @ApiPropertyOptional({
    description: 'Hourly rate (USD) used for ROI',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  hourlyRateUsd?: number;

  @ApiPropertyOptional({ description: 'Allowed autonomous tool names (allowlist)', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[];

  @ApiPropertyOptional({ description: 'Allowed external domains for browser/http', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedDomains?: string[];
}

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowCrudController {
  constructor(private readonly persistence: WorkflowPersistenceService) {}

  /**
   * GET /workflows
   * List saved workflows for the current tenant.
   */
  @Get()
  @Roles('OPERATOR', 'DEVELOPER', 'VIEWER')
  @ApiOperation({ summary: 'List saved workflows' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['updatedAt', 'createdAt', 'name'],
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  async listWorkflows(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('tags') tags?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.persistence.findAll(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      {
        status,
        search,
        tags: tags ? tags.split(',').map((t) => t.trim()) : undefined,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        sortBy: sortBy as any,
        sortOrder: sortOrder as any,
      },
    );
  }

  /**
   * POST /workflows
   * Create a new workflow.
   */
  @Post()
  @Roles('OPERATOR', 'DEVELOPER', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'Workflow')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new saved workflow' })
  @ApiResponse({
    status: 201,
    description: 'Created workflow with nodes and edges',
  })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 409, description: 'Duplicate key' })
  async createWorkflow(@CurrentUser() user: RequestUser, @Body() body: CreateWorkflowBody) {
    return this.persistence.create(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      body,
    );
  }

  /**
   * GET /workflows/:id
   * Get full workflow detail including nodes and edges.
   */
  @Get(':id')
  @Roles('OPERATOR', 'DEVELOPER', 'VIEWER')
  @ApiOperation({ summary: 'Get workflow detail with nodes and edges' })
  @ApiResponse({ status: 200, description: 'Workflow detail' })
  @ApiResponse({ status: 404, description: 'Workflow not found' })
  async getWorkflow(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.persistence.findOne(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  /**
   * PUT /workflows/:id
   * Update workflow. Requires expectedVersion for OCC.
   */
  @Put(':id')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('UPDATE', 'Workflow')
  @ApiOperation({ summary: 'Update workflow (OCC protected)' })
  @ApiResponse({ status: 200, description: 'Updated workflow' })
  @ApiResponse({ status: 404, description: 'Workflow not found' })
  @ApiResponse({ status: 409, description: 'Version conflict (OCC)' })
  async updateWorkflow(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: UpdateWorkflowBody,
  ) {
    return this.persistence.update(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      body,
    );
  }

  /**
   * DELETE /workflows/:id
   * Soft-delete a workflow.
   */
  @Delete(':id')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('DELETE', 'Workflow')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a workflow' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Workflow not found' })
  async deleteWorkflow(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.persistence.remove(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  /**
   * POST /workflows/:id/publish
   * Publish the current state as a new version snapshot.
   */
  @Post(':id/publish')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('PUBLISH', 'Workflow')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish workflow (create version snapshot)' })
  @ApiResponse({ status: 200, description: 'Published version info' })
  async publishWorkflow(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: PublishBody,
  ) {
    return this.persistence.publish(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      body.label,
    );
  }

  /**
   * POST /workflows/:id/archive
   * Archive a workflow (removes from active list, keeps data).
   */
  @Post(':id/archive')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('ARCHIVE', 'Workflow')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive a workflow' })
  async archiveWorkflow(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.persistence.archive(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  /**
   * POST /workflows/:id/duplicate
   * Duplicate a workflow with a new key and name.
   */
  @Post(':id/duplicate')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('CREATE', 'Workflow')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Duplicate a workflow' })
  async duplicateWorkflow(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: DuplicateBody,
  ) {
    return this.persistence.duplicate(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      body.newKey,
      body.newName,
    );
  }

  /**
   * GET /workflows/:id/versions
   * List version history for a workflow.
   */
  @Get(':id/versions')
  @Roles('OPERATOR', 'DEVELOPER', 'VIEWER')
  @ApiOperation({ summary: 'List workflow version history' })
  async listVersions(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.persistence.listVersions(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  /**
   * POST /workflows/:id/versions/:vid/restore
   * Restore workflow to a specific version.
   */
  @Post(':id/versions/:vid/restore')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('RESTORE', 'Workflow')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore workflow to a specific version' })
  async restoreVersion(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('vid') vid: string,
  ) {
    return this.persistence.restoreVersion(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      vid,
    );
  }

  /**
   * PATCH /workflows/by-key/:workflowKey/effectiveness
   * Edit the per-agent effectiveness baseline and/or target system assignment.
   * Resolved by (tenantId, key). Only provided fields are merged; untouched
   * effectivenessJson keys are preserved. `system` is also promoted onto the
   * Workflow.system column. Tenant-scoped.
   */
  @Patch('by-key/:workflowKey/effectiveness')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'PLATFORM_ADMIN')
  @Audit('UPDATE', 'Workflow')
  @ApiOperation({
    summary: 'Edit per-agent effectiveness baseline + system assignment',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated { workflowKey, system, effectivenessJson }',
  })
  @ApiResponse({ status: 404, description: 'Workflow not found' })
  async updateEffectiveness(
    @CurrentUser() user: RequestUser,
    @Param('workflowKey') workflowKey: string,
    @Body() body: UpdateEffectivenessBody,
  ) {
    return this.persistence.updateEffectiveness(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      workflowKey,
      body,
    );
  }

  /**
   * Sub-Agent → 메인 Agent 승격 (다중 메인 방지 가드 포함).
   */
  @Post('promote-sub')
  @Roles('TENANT_ADMIN', 'OPERATOR', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'Workflow')
  @ApiOperation({ summary: 'Sub-Agent를 메인 Agent로 승격 (하나의 메인만 허용)' })
  async promoteSub(
    @CurrentUser() user: RequestUser,
    @Body()
    body: { subKey: string; name?: string; nodeType: string; category?: string; settings?: Record<string, any> },
  ) {
    return this.persistence.promoteSubAgent(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      body,
    );
  }

  /**
   * 관리자 즉시 게시/미노출 — listed 전환(ORB 우회). body.listed 기본 true.
   */
  @Post('by-key/:workflowKey/listing')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('PUBLISH', 'Workflow')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Agent 즉시 게시/미노출 전환 (관리자, listed)' })
  async setAgentListing(
    @CurrentUser() user: RequestUser,
    @Param('workflowKey') workflowKey: string,
    @Body() body: { listed?: boolean },
  ) {
    return this.persistence.setAgentListed(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      workflowKey,
      body?.listed !== false,
    );
  }

  /**
   * Agent 기준정보 편집 — 메인 Agent 이름/코드/설명 + (선택)Sub-Agent 이름.
   */
  @Patch('by-key/:workflowKey/meta')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('UPDATE', 'Workflow')
  @ApiOperation({ summary: 'Agent 이름/코드/Sub-Agent 이름 편집 (기준정보)' })
  async updateAgentMeta(
    @CurrentUser() user: RequestUser,
    @Param('workflowKey') workflowKey: string,
    @Body()
    body: {
      name?: string;
      code?: string | null;
      description?: string | null;
      nodes?: Array<{ nodeKey: string; name: string }>;
      launchUrl?: string | null;
    },
  ) {
    return this.persistence.updateAgentMeta(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      workflowKey,
      body,
    );
  }
}
