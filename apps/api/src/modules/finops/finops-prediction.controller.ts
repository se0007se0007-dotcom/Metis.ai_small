/**
 * FinOps Prediction Controller — Cost Forecasting & Simulation Endpoints
 *
 * Endpoints:
 * - GET /finops/predict/monthly — Monthly cost forecast with trend
 * - POST /finops/simulate — What-if scenario simulation
 * - GET /finops/recommendations — Get actionable cost reduction recommendations
 * - POST /finops/recommendations/:id/apply — Apply a specific recommendation (OPERATOR+)
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { FinOpsPredictionService } from './finops-prediction.service';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';
import {
  CostForecast,
  SimulationRequest,
  SimulationResult,
  Recommendation,
  ApplyRecommendationResponse,
} from './finops.dto';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('FinOps-Prediction')
@ApiBearerAuth()
@Controller('finops')
export class FinOpsPredictionController {
  constructor(private readonly predictionService: FinOpsPredictionService) {}

  // ══════════════════════════════════════════════════════════════
  // Monthly Cost Forecast
  // ══════════════════════════════════════════════════════════════

  @Get('predict/monthly')
  @ApiOperation({
    summary: 'Predict monthly cost with linear extrapolation',
    description:
      'Analyzes current month token logs and projects total cost based on daily average. ' +
      'Includes trend vs. previous month and confidence metric.',
  })
  @ApiResponse({
    status: 200,
    description: 'Monthly cost forecast',
    type: CostForecast,
  })
  async predictMonthlyCost(@CurrentUser() user: RequestUser): Promise<CostForecast> {
    return this.predictionService.predictMonthlyCost({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // What-If Simulation
  // ══════════════════════════════════════════════════════════════

  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Simulate what-if scenarios for cost optimization',
    description:
      'Estimates savings from potential optimizations: ' +
      'cache TTL increase (→hit rate), tier downgrade, skill budget adjustment. ' +
      'Returns breakdown by category.',
  })
  @ApiResponse({
    status: 200,
    description: 'Simulation result with breakdown',
    type: SimulationResult,
  })
  async simulateWhatIf(
    @CurrentUser() user: RequestUser,
    @Body() simulation: SimulationRequest,
  ): Promise<SimulationResult> {
    return this.predictionService.simulateWhatIf(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      simulation,
    );
  }

  // ══════════════════════════════════════════════════════════════
  // Get Recommendations
  // ══════════════════════════════════════════════════════════════

  @Get('recommendations')
  @ApiOperation({
    summary: 'Get actionable cost reduction recommendations',
    description:
      'Analyzes last 30 days of logs and generates up to 5 specific, ' +
      'actionable recommendations with estimated savings.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of recommendations sorted by estimated savings',
    type: [Recommendation],
  })
  async getRecommendations(@CurrentUser() user: RequestUser): Promise<Recommendation[]> {
    return this.predictionService.getRecommendations({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Apply Recommendation
  // ══════════════════════════════════════════════════════════════

  @Post('recommendations/:id/apply')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR', 'TENANT_ADMIN', 'PLATFORM_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply a specific recommendation (OPERATOR+)',
    description:
      'Marks recommendation as applied and creates audit trail. ' +
      'For actionable recommendations, may trigger automatic configuration changes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application result',
    type: ApplyRecommendationResponse,
  })
  async applyRecommendation(
    @CurrentUser() user: RequestUser,
    @Param('id') recId: string,
  ): Promise<ApplyRecommendationResponse> {
    return this.predictionService.applyRecommendation(
      {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      },
      recId,
    );
  }
}
