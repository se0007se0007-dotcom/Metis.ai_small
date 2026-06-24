/**
 * FinOps Controller — Phase 4: Token Optimization API Endpoints
 *
 * Endpoints:
 * - GET /finops/config — Get tenant FinOps config (upsert default if not exists)
 * - PUT /finops/config — Update tenant FinOps config
 * - GET /finops/agents — List agent configs
 * - PUT /finops/agents/:agentName — Update agent config
 * - GET /finops/skills — List skills
 * - POST /finops/skills — Register skill
 * - GET /finops/namespaces — List namespaces
 * - POST /finops/namespaces — Add namespace
 * - GET /finops/stats — Get today's stats
 * - GET /finops/stats/distribution — Get tier distribution
 * - GET /finops/token-logs — List recent token logs with pagination
 * - POST /finops/optimize — Main optimization endpoint (3-Gate pipeline)
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { FinOpsService } from './finops.service';
import { TokenOptimizerService } from './token-optimizer.service';
import { ModelPriceService, ModelPriceEntry } from './model-price.service';
import { FinOpsInsightService } from './finops-insight.service';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';
import {
  UpdateFinOpsConfigDto,
  CreateAgentConfigDto,
  UpdateAgentConfigDto,
  RegisterSkillDto,
  CreateNamespaceDto,
  OptimizeRequestDto,
  OptimizeResponseDto,
  FinOpsStatsDto,
  FinOpsDistributionDto,
  TokenLogDto,
} from './finops.dto';

@ApiTags('FinOps')
@ApiBearerAuth()
@Controller('finops')
export class FinOpsController {
  constructor(
    private readonly finOpsService: FinOpsService,
    private readonly tokenOptimizer: TokenOptimizerService,
    private readonly modelPrices: ModelPriceService,
    private readonly insight: FinOpsInsightService,
  ) {}

  // ══════════════════════════════════════════════════════════════
  // Model Price Endpoints (F1-2: DB-backed single source of truth)
  // ══════════════════════════════════════════════════════════════

  @Get('model-prices')
  @ApiOperation({ summary: 'List LLM model prices (DB-backed, builtin fallback)' })
  async listModelPrices() {
    return { items: await this.modelPrices.listPrices() };
  }

  @Roles('TENANT_ADMIN')
  @Put('model-prices/:modelId')
  @ApiOperation({ summary: 'Upsert a model price (USD per 1M tokens)' })
  async upsertModelPrice(@Param('modelId') modelId: string, @Body() dto: Partial<ModelPriceEntry>) {
    if (typeof dto.inputPerMUsd !== 'number' || typeof dto.outputPerMUsd !== 'number') {
      throw new BadRequestException('inputPerMUsd / outputPerMUsd (number) are required');
    }
    return this.modelPrices.upsertPrice({
      modelId,
      provider: dto.provider ?? 'unknown',
      inputPerMUsd: dto.inputPerMUsd,
      outputPerMUsd: dto.outputPerMUsd,
      cachedInputPerMUsd: dto.cachedInputPerMUsd ?? null,
      tier: dto.tier ?? 2,
      active: dto.active ?? true,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Quality-Cost Closed Loop Endpoints (F3)
  // ══════════════════════════════════════════════════════════════

  @Get('quality-cost')
  @ApiOperation({
    summary: 'Quality-per-dollar matrix (AgentEvaluation × FinOpsTokenLog, per agent×model)',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async qualityCost(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    const window = days ? Math.max(1, Math.min(180, parseInt(days, 10))) : 30;
    return { items: await this.insight.qualityCostMatrix(user.tenantId, window) };
  }

  @Get('quality-regressions')
  @ApiOperation({
    summary: 'Detect quality regressions caused by cheap-tier routing (guardrail findings)',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async qualityRegressions(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    const window = days ? Math.max(1, Math.min(90, parseInt(days, 10))) : 14;
    return { items: await this.insight.qualityRegressions(user.tenantId, window) };
  }

  @Roles('OPERATOR', 'TENANT_ADMIN')
  @Post('quality-guard/:agentName/revert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guardrail action: exclude Tier 1 for a degraded agent (allowedTiers → [2,3])',
  })
  async revertQualityGuard(@CurrentUser() user: RequestUser, @Param('agentName') agentName: string) {
    return this.insight.revertAgentToSafeTiers(user.tenantId, agentName);
  }

  // ══════════════════════════════════════════════════════════════
  // FOCUS 1.4 Cost Ledger Export (F4)
  // ══════════════════════════════════════════════════════════════

  @Get('export/focus')
  @ApiOperation({
    summary: 'Export cost ledger as FOCUS 1.4-compatible rows (+x_ token extensions)',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async exportFocus(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('format') format?: string,
  ) {
    const window = days ? Math.max(1, Math.min(365, parseInt(days, 10))) : 30;
    const fmt = format === 'csv' ? 'csv' : 'json';
    const result = await this.insight.exportFocus(user.tenantId, window, fmt);
    if (fmt === 'csv') {
      return { format: 'csv', rowCount: result.rows.length, csv: result.csv };
    }
    return { format: 'json', rowCount: result.rows.length, rows: result.rows };
  }

  // ══════════════════════════════════════════════════════════════
  // Config Endpoints
  // ══════════════════════════════════════════════════════════════

  @Get('config')
  @ApiOperation({ summary: 'Get tenant FinOps config (upserts default)' })
  @ApiResponse({ status: 200, description: 'FinOps config' })
  async getConfig(@CurrentUser() user: RequestUser) {
    return this.finOpsService.getOrCreateConfig(user.tenantId);
  }

  @Roles('TENANT_ADMIN')
  @Put('config')
  @ApiOperation({ summary: 'Update tenant FinOps config' })
  @ApiResponse({ status: 200, description: 'Updated config' })
  async updateConfig(@CurrentUser() user: RequestUser, @Body() dto: UpdateFinOpsConfigDto) {
    return this.finOpsService.updateConfig(user.tenantId, dto);
  }

  // ══════════════════════════════════════════════════════════════
  // Agent Config Endpoints
  // ══════════════════════════════════════════════════════════════

  @Get('agents')
  @ApiOperation({ summary: 'List agent configs' })
  @ApiResponse({ status: 200, description: 'List of agent configs' })
  async listAgentConfigs(@CurrentUser() user: RequestUser) {
    return this.finOpsService.listAgentConfigs(user.tenantId);
  }

  @Roles('OPERATOR')
  @Put('agents/:agentName')
  @ApiOperation({ summary: 'Update agent config' })
  @ApiResponse({ status: 200, description: 'Updated agent config' })
  async updateAgentConfig(
    @CurrentUser() user: RequestUser,
    @Param('agentName') agentName: string,
    @Body() dto: UpdateAgentConfigDto,
  ) {
    return this.finOpsService.upsertAgentConfig(user.tenantId, agentName, dto);
  }

  // ══════════════════════════════════════════════════════════════
  // Skill Endpoints
  // ══════════════════════════════════════════════════════════════

  @Get('skills')
  @ApiOperation({ summary: 'List skills' })
  @ApiResponse({ status: 200, description: 'List of skills' })
  async listSkills(@CurrentUser() user: RequestUser) {
    return this.finOpsService.listSkills(user.tenantId);
  }

  @Roles('OPERATOR')
  @Post('skills')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register skill' })
  @ApiResponse({ status: 201, description: 'Skill registered' })
  async registerSkill(@CurrentUser() user: RequestUser, @Body() dto: RegisterSkillDto) {
    return this.finOpsService.registerSkill(user.tenantId, dto);
  }

  // ══════════════════════════════════════════════════════════════
  // Namespace Endpoints
  // ══════════════════════════════════════════════════════════════

  @Get('namespaces')
  @ApiOperation({ summary: 'List namespaces' })
  @ApiResponse({ status: 200, description: 'List of namespaces' })
  async listNamespaces(@CurrentUser() user: RequestUser) {
    return this.finOpsService.listNamespaces(user.tenantId);
  }

  @Roles('OPERATOR')
  @Post('namespaces')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add namespace' })
  @ApiResponse({ status: 201, description: 'Namespace created' })
  async addNamespace(@CurrentUser() user: RequestUser, @Body() dto: CreateNamespaceDto) {
    return this.finOpsService.addNamespace(user.tenantId, dto);
  }

  // ══════════════════════════════════════════════════════════════
  // Statistics Endpoints
  // ══════════════════════════════════════════════════════════════

  @Get('stats')
  @ApiOperation({ summary: "Get today's FinOps statistics" })
  @ApiResponse({ status: 200, description: 'FinOps stats', type: FinOpsStatsDto })
  async getStats(@CurrentUser() user: RequestUser): Promise<FinOpsStatsDto> {
    return this.finOpsService.getStats(user.tenantId);
  }

  @Get('stats/distribution')
  @ApiOperation({ summary: 'Get tier distribution for today' })
  @ApiResponse({
    status: 200,
    description: 'Tier distribution stats',
    type: FinOpsDistributionDto,
  })
  async getDistribution(@CurrentUser() user: RequestUser): Promise<FinOpsDistributionDto> {
    return this.finOpsService.getDistribution(user.tenantId);
  }

  // ══════════════════════════════════════════════════════════════
  // Token Logs Endpoint
  // ══════════════════════════════════════════════════════════════

  @Get('token-logs')
  @ApiOperation({ summary: 'List recent token logs with pagination' })
  @ApiQuery({ name: 'agentName', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated token logs' })
  async getTokenLogs(
    @CurrentUser() user: RequestUser,
    @Query('agentName') agentName?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const pageSizeNum = pageSize ? Math.max(1, parseInt(pageSize, 10)) : 50;
    const offset = (pageNum - 1) * pageSizeNum;

    return this.finOpsService.getTokenLogs(user.tenantId, {
      agentName,
      limit: pageSizeNum,
      offset,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Main Optimization Endpoint
  // ══════════════════════════════════════════════════════════════

  @Post('optimize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run token optimization (3-Gate pipeline)',
    description:
      'Main endpoint that intercepts LLM/AI calls and optimizes them through the 3-gate pipeline: ' +
      '(1) Semantic Cache lookup, (2) Model Router selection, (3) Skill Packer optimization',
  })
  @ApiResponse({ status: 200, description: 'Optimization result', type: OptimizeResponseDto })
  async optimize(
    @CurrentUser() user: RequestUser,
    @Body() dto: OptimizeRequestDto,
  ): Promise<OptimizeResponseDto> {
    const result = await this.tokenOptimizer.optimize({
      tenantId: user.tenantId,
      agentName: dto.agentName,
      executionSessionId: dto.executionSessionId,
      nodeId: dto.nodeId,
      prompt: dto.prompt,
      requestedModel: dto.requestedModel,
      // Patent 3: policy-aware governance context
      dataClass: dto.dataClass,
      riskScore: dto.riskScore,
      workflowId: dto.workflowId,
      nodeKey: dto.nodeKey,
      skillId: dto.skillId,
    });

    return {
      cacheHit: result.cacheHit,
      cachedResponse: result.cachedResponse,
      routedTier: result.routedTier,
      routedModel: result.routedModel,
      originalModel: result.originalModel,
      estimatedCostReduction: result.estimatedCostReduction,
      optimizationApplied: result.optimizationApplied,
      responseTimeMs: result.responseTimeMs || 0,
      savedUsd: (result as any).savedUsd ?? 0,
      savedPct: (result as any).savedPct ?? 0,
      estimatedTokens: (result as any).estimatedTokens ?? 0,
      // Patent 3: policy-aware decision audit
      policyHash: result.policyHash,
      cachePolicyDecision: result.cachePolicyDecision,
      routeReason: result.routeReason,
      budget: result.budget as OptimizeResponseDto['budget'],
    };
  }

  // ══════════════════════════════════════════════════════════════
  // Patent 3: Policy-aware FinOps audit endpoints
  // ══════════════════════════════════════════════════════════════

  @Get('cache/decisions')
  @ApiOperation({ summary: 'Recent cache policy decisions (정책 인식형 캐시 판정 이력)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async cacheDecisions(@CurrentUser() user: RequestUser, @Query('limit') limit?: string) {
    const { logs } = await this.finOpsService.getTokenLogs(user.tenantId, {
      limit: limit ? Number(limit) : 50,
    });
    return (logs as any[]).map((l) => ({
      id: l.id,
      createdAt: l.createdAt,
      agentName: l.agentName,
      dataClass: l.dataClass,
      riskScore: l.riskScore,
      policyHash: l.policyHash,
      cacheKey: l.cacheKey,
      cacheHit: l.cacheHit,
      cachePolicyDecision: l.cachePolicyDecision,
      cacheDecisionReason: l.cacheDecisionReasonJson,
      routedTier: l.routedTier,
      routedModel: l.routedModel,
      routeReason: l.routeReasonJson,
      savedUsd: l.savedUsd,
      evidencePackId: l.evidencePackId,
    }));
  }

  @Get('budget/status')
  @ApiOperation({ summary: 'Daily budget pressure (예산 소진율 및 조치 단계)' })
  async budgetStatus(@CurrentUser() user: RequestUser) {
    const config = await this.finOpsService.getOrCreateConfig(user.tenantId);
    return this.tokenOptimizer.getBudgetStatus(
      user.tenantId,
      Number((config as any).alertDailyCostMax ?? 50),
    );
  }
}
