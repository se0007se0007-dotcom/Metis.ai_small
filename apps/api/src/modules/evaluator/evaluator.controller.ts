/**
 * Evaluator Controller — Agent Evaluation API Endpoints
 *
 * Endpoints:
 * - GET /evaluator/recent     — Recent evaluations with aggregated stats
 * - GET /evaluator/session/:id — Evaluations for a specific execution session
 * - GET /evaluator/trend       — Daily evaluation trend (for charts)
 * - GET /evaluator/streaming   — Real-time sliding window stats (1m/5m/1h)
 * - POST /evaluator/conversation — Multi-turn conversation evaluation
 * - POST /evaluator/demo       — Manual evaluation demo (for testing)
 */
import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { EvaluatorService } from './evaluator.service';
import { StreamingEvaluatorService } from './streaming-evaluator';
import { ConversationEvaluator } from './conversation-evaluator';
import { CurrentUser, RequestUser } from '../../common/decorators';

@ApiTags('Evaluator')
@ApiBearerAuth()
@Controller('evaluator')
export class EvaluatorController {
  constructor(
    private readonly evaluatorService: EvaluatorService,
    private readonly streamingEvaluator: StreamingEvaluatorService,
    private readonly conversationEvaluator: ConversationEvaluator,
  ) {}

  // ══════════════════════════════════════════════════════════════
  // Recent Evaluations
  // ══════════════════════════════════════════════════════════════

  @Get('recent')
  @ApiOperation({ summary: 'Get recent evaluations with aggregated stats' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max evaluations to return (default: 50)',
  })
  @ApiQuery({ name: 'teamId', required: false, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'PLATFORM_ADMIN 전용' })
  @ApiResponse({ status: 200, description: 'Recent evaluations and stats' })
  async getRecent(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('teamId') teamId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const parsedLimit = limit ? Math.max(1, Math.min(200, parseInt(limit, 10))) : 50;
    return this.evaluatorService.getRecentEvaluations(user.tenantId, parsedLimit, {
      teamId: teamId?.trim() || undefined,
      tenantId: tenantId?.trim() || undefined,
      role: user.role,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Session Evaluations
  // ══════════════════════════════════════════════════════════════

  @Get('session/:sessionId')
  @ApiOperation({ summary: 'Get evaluations for a specific execution session' })
  @ApiResponse({ status: 200, description: 'Session evaluations' })
  async getSessionEvaluations(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.evaluatorService.getSessionEvaluations(user.tenantId, sessionId);
  }

  // ══════════════════════════════════════════════════════════════
  // Evaluation Trend
  // ══════════════════════════════════════════════════════════════

  @Get('trend')
  @ApiOperation({ summary: 'Get daily evaluation trend for charts' })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Number of days to look back (default: 7)',
  })
  @ApiQuery({ name: 'teamId', required: false, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'PLATFORM_ADMIN 전용' })
  @ApiResponse({ status: 200, description: 'Daily evaluation trend data' })
  async getTrend(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('teamId') teamId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const parsedDays = days ? Math.max(1, Math.min(90, parseInt(days, 10))) : 7;
    return this.evaluatorService.getEvaluationTrend(user.tenantId, parsedDays, {
      teamId: teamId?.trim() || undefined,
      tenantId: tenantId?.trim() || undefined,
      role: user.role,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Anomalies (Agent operational-risk — Anomalies page)
  // ══════════════════════════════════════════════════════════════

  @Get('anomalies')
  @ApiOperation({
    summary: 'List detected anomalies (flattened) with summary + heatmap',
    description:
      'Reads AgentEvaluation rows where anomalyDetected=true in the window and ' +
      'flattens anomalyEvents[] into individual items. Filter by workflowKey/severity/type.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Window (default 30)' })
  @ApiQuery({ name: 'workflowKey', required: false, type: String })
  @ApiQuery({ name: 'severity', required: false, enum: ['critical', 'warning', 'info'] })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['latency_trend', 'accuracy_drift', 'token_spike', 'error_surge', 'security_pattern'],
  })
  @ApiResponse({ status: 200, description: 'Anomaly items, summary, heatmap' })
  async getAnomalies(
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
    @Query('workflowKey') workflowKey?: string,
    @Query('severity') severity?: string,
    @Query('type') type?: string,
    @Query('teamId') teamId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const parsedDays = days ? Math.max(1, Math.min(365, parseInt(days, 10))) : 30;
    return this.evaluatorService.getAnomalies(user.tenantId, {
      days: parsedDays,
      workflowKey,
      severity,
      type,
      teamId: teamId?.trim() || undefined,
      tenantId: tenantId?.trim() || undefined,
      role: user.role,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Streaming (Real-time Sliding Window)
  // ══════════════════════════════════════════════════════════════

  @Get('streaming')
  @ApiOperation({ summary: 'Get real-time sliding window stats (1m/5m/1h)' })
  @ApiResponse({ status: 200, description: 'Streaming stats for all windows' })
  async getStreamingStats() {
    return this.streamingEvaluator.getAllStats();
  }

  // ══════════════════════════════════════════════════════════════
  // Conversation Evaluation
  // ══════════════════════════════════════════════════════════════

  @Post('conversation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Evaluate a multi-turn conversation session' })
  @ApiResponse({ status: 200, description: 'Conversation quality metrics' })
  async evaluateConversation(
    @Body()
    body: {
      sessionId: string;
      turns: Array<{
        turnIndex: number;
        user: string;
        agent: string;
        metadata?: Record<string, any>;
      }>;
    },
  ) {
    return this.conversationEvaluator.evaluate(body.sessionId, body.turns);
  }

  // ══════════════════════════════════════════════════════════════
  // Demo Evaluation
  // ══════════════════════════════════════════════════════════════

  @Post('demo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a manual evaluation demo',
    description:
      'Evaluate a given output against optional input, ground truth, and context. ' +
      'Useful for testing the evaluation pipeline without running a full workflow.',
  })
  @ApiResponse({ status: 200, description: 'Evaluation result' })
  async demoEvaluate(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      input?: string;
      output: string;
      groundTruth?: string;
      context?: string;
      agentName?: string;
      model?: string;
    },
  ) {
    const result = await this.evaluatorService.evaluate({
      tenantId: user.tenantId,
      executionSessionId: `demo-${Date.now()}`,
      stepKey: 'demo-step',
      nodeType: 'demo',
      agentName: body.agentName || 'demo-agent',
      input: body.input,
      output: body.output,
      groundTruth: body.groundTruth,
      context: body.context,
      model: body.model,
    });

    // Flatten nested structure for frontend compatibility
    // Compute overall grade from overall score (not quality-specific grade)
    const overallGrade =
      result.overallScore >= 90
        ? 'A'
        : result.overallScore >= 80
          ? 'B'
          : result.overallScore >= 70
            ? 'C'
            : result.overallScore >= 60
              ? 'D'
              : 'F';

    return {
      id: result.recordId ?? `demo-${Date.now()}`,
      overallScore: result.overallScore,
      // Quality (flat)
      accuracyScore: result.quality.accuracyScore,
      hallucinationRate: result.quality.hallucinationRate,
      responseQuality: result.quality.responseQuality,
      qualityGrade: overallGrade, // Use OVERALL grade, not quality-specific
      completionScore: result.quality.completionScore,
      // Security (flat)
      securityScore: result.security.securityScore,
      inputThreatCount: result.security.inputThreatCount,
      outputLeakageCount: result.security.outputLeakageCount,
      toolChainRisk: result.security.toolChainRisk,
      securityRiskLevel: result.security.securityRiskLevel,
      // Cost (flat)
      estimatedCostUsd: result.cost.costUsd,
      costEfficiency: result.cost.costEfficiency,
      latencyGrade: result.cost.latencyGrade,
      tokensUsed: 0,
      executionTimeMs: 0,
      // Anomaly (flat)
      anomalyDetected: result.anomaly.anomalyDetected,
      anomalyEvents: result.anomaly.events,
      // Meta
      gatesApplied: result.gatesApplied,
      llmJudge: result.llmJudge, // 품질 게이트가 외부 LLM(Claude/OpenAI)을 호출했는지 + 모델/비용
      recommendations: result.cost.recommendations,
      createdAt: new Date().toISOString(),
      agentName: body.agentName || 'demo-agent',
      nodeType: 'demo',
      stepKey: 'demo-step',
    };
  }
}
