/**
 * Workflow Controller — Phase 6 (Step 1: Execution Bridge)
 *
 * Endpoints:
 *   POST /workflows/execute-draft   — Execute builder canvas nodes via real backend pipeline
 *   POST /workflows/resolve-nodes   — Preview node resolution (uiType → capability) without executing
 */
import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';
import { WorkflowService } from './workflow.service';
import type { DraftNodeInput, DraftEdgeInput } from './workflow-execution-bridge.service';

// ── Request DTOs ──

class ExecuteDraftDto {
  title?: string;
  nodes!: DraftNodeInput[];
  edges?: DraftEdgeInput[];
}

class ResolveNodesDto {
  nodes!: DraftNodeInput[];
}

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  /**
   * POST /workflows/execute-draft
   *
   * Execute a draft workflow from the builder canvas.
   * This does NOT require a saved workflow — it takes raw builder nodes,
   * resolves them via NodeResolutionRegistry, and runs through the
   * real execution pipeline (WorkflowRunner → NodeRouter → ConnectorService/AgentDispatcher).
   *
   * Returns full execution results for each node.
   */
  @Post('execute-draft')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'Workflow')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Execute builder draft nodes via real backend pipeline',
    description:
      'Converts builder canvas nodes to execution format and runs through WorkflowRunner.',
  })
  @ApiResponse({ status: 200, description: 'Execution results' })
  @ApiResponse({ status: 400, description: 'Invalid node configuration' })
  async executeDraft(@CurrentUser() user: RequestUser, @Body() dto: ExecuteDraftDto) {
    return this.workflowService.executeDraft(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  /**
   * POST /workflows/resolve-nodes
   *
   * Preview how builder nodes will be resolved to execution types.
   * Useful for the UI to show capability badges and data flow arrows.
   */
  /**
   * POST /workflows/run-by-key
   * 저장된 Agent(워크플로우)를 빌더 이동 없이 즉시 실행. 노드별 4Gate 평가가 기록되고
   * execution.executionSessionId로 실행 상세(품질/보안/비용/이상)를 바로 열 수 있다.
   */
  @Post('run-by-key')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'Workflow')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '저장된 Agent를 key로 즉시 실행 (4Gate 평가 포함)' })
  async runByKey(
    @CurrentUser() user: RequestUser,
    @Body() dto: { workflowKey: string; input?: string },
  ) {
    return this.workflowService.runSavedWorkflow(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto.workflowKey,
      dto.input,
    );
  }

  /**
   * POST /workflows/run-external
   * 외부 전용 화면 Agent를 metis 안에서 실행 — metis 백엔드가 그 agent의 분석 기능을
   * 서버에서 호출하고 결과를 대시보드/이력에 기록한다.
   */
  @Post('run-external')
  @Roles('OPERATOR', 'DEVELOPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '외부 전용 화면 Agent 실행 + metis 기록(4Gate)' })
  async runExternal(
    @CurrentUser() user: RequestUser,
    @Body() dto: { workflowKey: string; filename?: string; code?: string; input?: string },
  ) {
    return this.workflowService.runExternalAgent(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto.workflowKey,
      dto,
    );
  }

  /**
   * POST /workflows/external-record
   * metis 안에 임베드된 외부 화면(iframe)이 실행을 끝낸 뒤 넘긴 결과를 대시보드/이력(4Gate)에 기록.
   */
  @Post('external-record')
  @Roles('OPERATOR', 'DEVELOPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '임베드 외부 화면 실행 결과 기록(4Gate)' })
  async externalRecord(
    @CurrentUser() user: RequestUser,
    @Body()
    dto: {
      workflowKey: string;
      input?: string;
      output?: string;
      model?: string;
      costUsd?: number;
      latencyMs?: number;
      steps?: Array<{ key: string; type?: string; ms?: number; status?: string }>;
      timings?: any;
    },
  ) {
    return this.workflowService.recordExternalRun(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  @Post('resolve-nodes')
  @Roles('OPERATOR', 'DEVELOPER', 'VIEWER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview node resolution (uiType → executionType + capability)',
  })
  async resolveNodes(@CurrentUser() user: RequestUser, @Body() dto: ResolveNodesDto) {
    return this.workflowService.resolveNodes(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto.nodes,
    );
  }
}
