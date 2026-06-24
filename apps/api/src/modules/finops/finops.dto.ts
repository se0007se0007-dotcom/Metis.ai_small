import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  Min,
  Max,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ╔════════════════════════════════════════════╗
// ║         Config DTOs                        ║
// ╚════════════════════════════════════════════╝

export class UpdateFinOpsConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  cacheEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cacheBackend?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  cacheSimilarityThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  cacheTtlSeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cacheEmbeddingModel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  cacheMaxMemoryMb?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cacheWarmupEntries?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cacheExcludePatterns?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  routerEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  routerStage1Enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  routerStage2Enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  routerClassifierModel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(3)
  routerFallbackTier?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  routerTier1Models?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  routerTier2Models?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  routerTier3Models?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  packerEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  packerMaxTokensPerSkill?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  packerOutputFormat?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  alertCacheHitMinPct?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  alertDailyCostMax?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  alertTier3MaxPct?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  alertResponseDelayMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  alertSlackEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  alertSlackChannel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  alertEmailEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  alertEmailAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  alertPagerDutyEnabled?: boolean;
}

// ╔════════════════════════════════════════════╗
// ║         Agent Config DTOs                  ║
// ╚════════════════════════════════════════════╝

export class CreateAgentConfigDto {
  @ApiProperty()
  @IsString()
  agentName!: string;

  @ApiPropertyOptional({ default: '운영' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  cacheEnabled?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  routerEnabled?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  packerEnabled?: boolean;

  @ApiPropertyOptional({ default: [1, 2, 3] })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  allowedTiers?: number[];

  @ApiPropertyOptional({ default: 'default' })
  @IsOptional()
  @IsString()
  namespace?: string;

  @ApiPropertyOptional({ default: 10.0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  dailyLimitUsd?: number;
}

export class UpdateAgentConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  cacheEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  routerEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  packerEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  allowedTiers?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  namespace?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  dailyLimitUsd?: number;
}

// ╔════════════════════════════════════════════╗
// ║         Skill DTOs                         ║
// ╚════════════════════════════════════════════╝

export class RegisterSkillDto {
  @ApiProperty()
  @IsString()
  skillId!: string;

  @ApiProperty()
  @IsString()
  name!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(3)
  defaultTier?: number;

  @ApiPropertyOptional({ default: '활성' })
  @IsOptional()
  @IsString()
  status?: string;
}

// ╔════════════════════════════════════════════╗
// ║         Namespace DTOs                     ║
// ╚════════════════════════════════════════════╝

export class CreateNamespaceDto {
  @ApiProperty()
  @IsString()
  namespace!: string;

  @ApiPropertyOptional({ default: '24h' })
  @IsOptional()
  @IsString()
  ttlPolicy?: string;

  @ApiPropertyOptional({ default: '활성' })
  @IsOptional()
  @IsString()
  status?: string;
}

// ╔════════════════════════════════════════════╗
// ║         Optimization DTOs                  ║
// ╚════════════════════════════════════════════╝

export class OptimizeRequestDto {
  @ApiProperty({ description: 'Agent identifier' })
  @IsString()
  agentName!: string;

  @ApiProperty({ description: 'Input prompt/query' })
  @IsString()
  prompt!: string;

  @ApiPropertyOptional({ description: 'Requested model (if any)' })
  @IsOptional()
  @IsString()
  requestedModel?: string;

  @ApiPropertyOptional({ description: 'Execution session ID for tracking' })
  @IsOptional()
  @IsString()
  executionSessionId?: string;

  @ApiPropertyOptional({ description: 'Node ID in workflow' })
  @IsOptional()
  @IsString()
  nodeId?: string;

  // ── Patent 3: policy-aware governance context ──
  @ApiPropertyOptional({
    description: 'Data classification: PUBLIC | INTERNAL | PII | SECRET | CUSTOMER_CONFIDENTIAL',
  })
  @IsOptional()
  @IsString()
  dataClass?: string;

  @ApiPropertyOptional({ description: 'Node risk score 0..1 (>=0.7 denies cache reuse)' })
  @IsOptional()
  @IsNumber()
  riskScore?: number;

  @ApiPropertyOptional({ description: 'Workflow ID for governance binding' })
  @IsOptional()
  @IsString()
  workflowId?: string;

  @ApiPropertyOptional({ description: 'Node key for governance binding' })
  @IsOptional()
  @IsString()
  nodeKey?: string;

  @ApiPropertyOptional({ description: 'Skill ID for cache-key scoping' })
  @IsOptional()
  @IsString()
  skillId?: string;
}

export class OptimizeResponseDto {
  @ApiProperty({ description: 'Whether cached response was used' })
  cacheHit!: boolean;

  @ApiProperty({ description: 'Cached response if available' })
  cachedResponse!: string | null;

  @ApiProperty({ description: 'Routed tier (1, 2, or 3)' })
  routedTier!: number;

  @ApiProperty({ description: 'Model selected by router' })
  routedModel!: string;

  @ApiProperty({ description: 'Original requested model' })
  originalModel!: string;

  @ApiProperty({ description: 'Estimated cost reduction percentage' })
  estimatedCostReduction!: number;

  @ApiProperty({ description: 'Array of optimizations applied' })
  optimizationApplied!: string[];

  @ApiProperty({ description: 'Processing time in milliseconds' })
  responseTimeMs!: number;

  @ApiProperty({ description: 'USD saved vs Tier-2 baseline (avoided cost)' })
  savedUsd?: number;

  @ApiProperty({ description: 'Savings percentage vs Tier-2 baseline' })
  savedPct?: number;

  @ApiProperty({ description: 'Estimated token count for the prompt' })
  estimatedTokens?: number;

  // ── Patent 3: policy-aware decision audit ──
  @ApiPropertyOptional({ description: 'Policy surface hash bound to this request' })
  policyHash?: string;

  @ApiPropertyOptional({ description: 'Cache reuse policy decision (ALLOW / DENY_*)' })
  cachePolicyDecision?: { decision: string; cacheAllowed: boolean; reasons: string[] };

  @ApiPropertyOptional({ description: 'Routing rationale (complexity/risk/budget/adjustments)' })
  routeReason?: unknown;

  @ApiPropertyOptional({ description: 'Daily budget status at decision time' })
  budget?: { dailyLimitUsd: number; usedTodayUsd: number; budgetPressure: number; action: string };
}

// ╔════════════════════════════════════════════╗
// ║         Statistics DTOs                    ║
// ╚════════════════════════════════════════════╝

export class FinOpsStatsDto {
  @ApiProperty({ description: 'Total requests today' })
  totalRequests!: number;

  @ApiProperty({ description: 'Cache hit rate percentage' })
  cacheHitRate!: number;

  @ApiProperty({ description: 'Estimated daily cost in USD' })
  estimatedDailyCostUsd!: number;

  @ApiProperty({ description: 'Estimated savings in USD' })
  estimatedSavingsUsd!: number;

  @ApiProperty({ description: 'Average response time in milliseconds' })
  avgResponseTimeMs!: number;

  @ApiProperty({ description: 'Number of requests per tier' })
  requestsByTier!: {
    tier1: number;
    tier2: number;
    tier3: number;
  };

  @ApiProperty({ description: 'Top agents by request count' })
  topAgents!: Array<{
    agentName: string;
    requestCount: number;
    cacheHitRate: number;
    savedUsd: number;
  }>;

  @ApiProperty({ description: 'Last 6 hours hourly stats' })
  hourlyTrend!: Array<{
    hour: string;
    requests: number;
    cacheHits: number;
    avgCostUsd: number;
  }>;
}

export class FinOpsDistributionDto {
  @ApiProperty()
  tier1Count!: number;

  @ApiProperty()
  tier2Count!: number;

  @ApiProperty()
  tier3Count!: number;

  @ApiProperty()
  cacheHitCount!: number;

  @ApiProperty()
  cacheMissCount!: number;

  @ApiProperty()
  totalRequests!: number;

  @ApiProperty()
  cacheHitPercentage!: number;
}

// ╔════════════════════════════════════════════╗
// ║         Token Log DTOs                     ║
// ╚════════════════════════════════════════════╝

export class TokenLogDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty()
  agentName!: string;

  @ApiProperty()
  executionSessionId?: string;

  @ApiProperty()
  nodeId?: string;

  @ApiProperty()
  promptText?: string;

  @ApiProperty()
  promptTokens!: number;

  @ApiProperty()
  completionTokens!: number;

  @ApiProperty()
  totalTokens!: number;

  @ApiProperty()
  cacheHit!: boolean;

  @ApiProperty()
  cachedResponseUsed!: boolean;

  @ApiProperty()
  routedTier!: number;

  @ApiProperty()
  routedModel!: string;

  @ApiProperty()
  originalCostUsd!: number;

  @ApiProperty()
  optimizedCostUsd!: number;

  @ApiProperty()
  savedUsd!: number;

  @ApiProperty()
  responseTimeMs!: number;

  @ApiProperty()
  createdAt!: Date;
}

// ╔════════════════════════════════════════════╗
// ║         Prediction & Forecast DTOs         ║
// ╚════════════════════════════════════════════╝

export class CostForecast {
  @ApiProperty({ description: 'Actual cost incurred in current month so far (USD)' })
  currentMonthActual!: number;

  @ApiProperty({ description: 'Projected total cost for entire current month (USD)' })
  projectedMonthTotal!: number;

  @ApiProperty({ description: 'Total cost from previous month (USD)' })
  previousMonthTotal!: number;

  @ApiProperty({ description: 'Month-over-month growth percentage' })
  monthOverMonthPct!: number;

  @ApiProperty({ description: 'Number of days elapsed in current month' })
  daysElapsed!: number;

  @ApiProperty({ description: 'Total days in current month' })
  totalDays!: number;

  @ApiProperty({
    description: 'Confidence level of forecast (0-1)',
    example: 0.95,
  })
  confidence!: number;

  @ApiProperty({
    description: 'Method used for prediction',
    example: 'linear_extrapolation',
  })
  method!: string;
}

export class SimulationRequest {
  @ApiPropertyOptional({
    description: 'Cache TTL multiplier (e.g., 2 = double TTL)',
    example: 2,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(5)
  cacheTTLMultiplier?: number;

  @ApiPropertyOptional({
    description: 'Number of agents to downgrade by one tier',
    example: 2,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(50)
  tierDowngrade?: number;

  @ApiPropertyOptional({
    description: 'Skill token budget multiplier (e.g., 0.5 = half budget)',
    example: 0.5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(5)
  skillTokenBudgetMultiplier?: number;
}

export class SimulationBreakdown {
  @ApiProperty({ description: 'Impact from cache optimization (USD)' })
  cache!: number;

  @ApiProperty({ description: 'Impact from tier downgrade (USD)' })
  tier!: number;

  @ApiProperty({ description: 'Impact from skill budget adjustment (USD)' })
  skill!: number;
}

export class SimulationResult {
  @ApiProperty({ description: 'Baseline monthly cost before optimizations (USD)' })
  baselineMonthlyCost!: number;

  @ApiProperty({ description: 'Simulated monthly cost after optimizations (USD)' })
  simulatedMonthlyCost!: number;

  @ApiProperty({ description: 'Absolute savings (USD)' })
  savings!: number;

  @ApiProperty({ description: 'Savings percentage (0-100)' })
  savingsPct!: number;

  @ApiProperty({ description: 'Breakdown by optimization category' })
  breakdown!: SimulationBreakdown;
}

export class Recommendation {
  @ApiProperty({ description: 'Unique recommendation ID' })
  id!: string;

  @ApiProperty({ description: 'Short title' })
  title!: string;

  @ApiProperty({ description: 'Detailed description' })
  description!: string;

  @ApiProperty({ description: 'Estimated monthly savings (USD)' })
  estimatedSavingsMonthly!: number;

  @ApiProperty({
    description: 'Category of recommendation',
    enum: ['tier', 'cache', 'skill'],
  })
  category!: 'tier' | 'cache' | 'skill';

  @ApiProperty({
    description: 'Whether the recommendation is actionable',
  })
  actionable!: boolean;

  @ApiProperty({
    description: 'Whether automatic application is available',
  })
  autoApplyAvailable!: boolean;
}

export class ApplyRecommendationResponse {
  @ApiProperty({ description: 'Whether recommendation was successfully applied' })
  applied!: boolean;

  @ApiProperty({ description: 'Status message' })
  message!: string;
}
