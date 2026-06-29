/**
 * ORB (Ops.AI Review Board) Controller
 *
 * REST endpoints for managing Agent registration reviews:
 *
 *   GET    /orb/reviews          — List all reviews for tenant (with filters)
 *   GET    /orb/reviews/:id      — Get single review detail
 *   POST   /orb/reviews          — Submit new review request
 *   PUT    /orb/reviews/:id/score   — Score a review (5-area scores + mandatory checks)
 *   PUT    /orb/reviews/:id/verdict — Set verdict (approved/conditional/rejected)
 *   GET    /orb/stats            — Summary stats
 *   POST   /orb/auto-evaluate    — Run auto-evaluation on sample I/O
 *
 * @module orb
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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';
import { OrbService, SubmitReviewDto, ScoreReviewDto, VerdictDto } from './orb.service';

@ApiTags('ORB')
@ApiBearerAuth()
@Controller('orb')
export class OrbController {
  constructor(private readonly orbService: OrbService) {}

  // ══════════════════════════════════════════════════════════════
  // List reviews
  // ══════════════════════════════════════════════════════════════

  @Get('reviews')
  @ApiOperation({
    summary: 'List all ORB reviews for tenant',
    description: 'Returns reviews with optional filters by status and agentKey.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Filter by status (pending, in_review, completed)',
  })
  @ApiQuery({ name: 'agentKey', required: false, type: String, description: 'Filter by agent key' })
  @ApiResponse({ status: 200, description: 'List of ORB reviews' })
  async listReviews(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('agentKey') agentKey?: string,
  ) {
    return this.orbService.listReviews(user.tenantId, {
      status: status || undefined,
      agentKey: agentKey || undefined,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Get single review
  // ══════════════════════════════════════════════════════════════

  @Get('reviews/:id')
  @ApiOperation({ summary: 'Get single ORB review detail' })
  @ApiResponse({ status: 200, description: 'ORB review detail' })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async getReview(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orbService.getReview(user.tenantId, id);
  }

  @Get('reviews/:id/evidence')
  @ApiOperation({ summary: '채점 근거(실측) — 보안 유출/위협·이상·저품질 상세' })
  @ApiResponse({ status: 200, description: 'Auto-score evidence' })
  async getReviewEvidence(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orbService.getReviewEvidence(user.tenantId, id);
  }

  // ══════════════════════════════════════════════════════════════
  // Submit new review
  // ══════════════════════════════════════════════════════════════

  @Post('reviews')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit new ORB review request',
    description:
      'Creates a pending review for an agent. The agent must already be registered as an AgentDefinition.',
  })
  @ApiResponse({ status: 201, description: 'Review created' })
  @ApiResponse({ status: 400, description: 'Agent not found or invalid input' })
  async submitReview(@CurrentUser() user: RequestUser, @Body() body: SubmitReviewDto) {
    return this.orbService.submitReview(user.tenantId, body);
  }

  // ══════════════════════════════════════════════════════════════
  // Score review
  // ══════════════════════════════════════════════════════════════

  @Roles('OPERATOR')
  @Put('reviews/:id/score')
  @ApiOperation({
    summary: 'Score an ORB review',
    description:
      'Fills 5-area item scores (1-5 each), mandatory checks, and computes area scores ' +
      'and total score using weight factors: Quality=6, Performance=4, Security=5, DataStd=3, Scalability=2.',
  })
  @ApiResponse({ status: 200, description: 'Review scored' })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async scoreReview(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: ScoreReviewDto,
  ) {
    return this.orbService.scoreReview(user.tenantId, id, body);
  }

  // ══════════════════════════════════════════════════════════════
  // Set verdict
  // ══════════════════════════════════════════════════════════════

  @Roles('TENANT_ADMIN')
  @Put('reviews/:id/verdict')
  @ApiOperation({
    summary: 'Set ORB review verdict',
    description:
      'Sets the final verdict (approved/conditional/rejected) with reason. ' +
      'If mandatory checks failed, verdict is auto-overridden to rejected.',
  })
  @ApiResponse({ status: 200, description: 'Verdict set' })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async setVerdict(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: VerdictDto,
  ) {
    return this.orbService.setVerdict(user.tenantId, id, body);
  }

  // ══════════════════════════════════════════════════════════════
  // Stats
  // ══════════════════════════════════════════════════════════════

  @Get('stats')
  @ApiOperation({
    summary: 'Get ORB review summary statistics',
    description:
      'Returns counts of total, pending, approved, conditional, rejected reviews and average score.',
  })
  @ApiResponse({ status: 200, description: 'ORB stats' })
  async getStats(@CurrentUser() user: RequestUser) {
    return this.orbService.getStats(user.tenantId);
  }

  // ══════════════════════════════════════════════════════════════
  // Auto-score (5-area defaults from telemetry)
  // ══════════════════════════════════════════════════════════════

  @Get('reviews/:id/auto-score')
  @ApiOperation({
    summary: 'Compute auto-scored 5-area defaults for a review',
    description:
      "Aggregates the agent's recent evaluation/execution history (sample-based " +
      'fallback when no history) to produce default 1-5 scores per item, mandatory ' +
      'check pass flags, source and confidence. Used to (re)fill the review form.',
  })
  @ApiResponse({ status: 200, description: 'Auto-score result' })
  async autoScoreReview(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orbService.autoScoreForReview(user.tenantId, id);
  }
}
