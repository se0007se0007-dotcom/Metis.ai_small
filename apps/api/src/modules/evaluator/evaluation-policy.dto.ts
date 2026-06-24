/**
 * DTOs for the EvaluationPolicy settings API (Phase 1).
 */
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/** Partial update of an evaluation policy — all fields optional. */
export class UpdateEvaluationPolicyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  agentGroup?: string;

  // ── 품질 Gate ──
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  qualityWeight?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  qualityHardGateMin?: number;

  @IsOptional()
  @IsBoolean()
  llmJudgeEnabled?: boolean;

  @IsOptional()
  @IsString()
  llmJudgeModel?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  llmJudgeBudgetPerDay?: number;

  // ── 보안 Gate ──
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  securityWeight?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  securityCriticalCap?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  securityHighCap?: number;

  @IsOptional()
  @IsBoolean()
  piiScanEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  promptInjectionEnabled?: boolean;

  // ── 이상탐지 Gate ──
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  anomalyWeight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  zScoreThreshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  iqrFactor?: number;

  // ── 비용 Gate ──
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  costWeight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyBudgetUsd?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  latencySlowMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  latencyCriticalMs?: number;

  // ── Canary 연동 ──
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  canaryQualityMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  canarySecurityMin?: number;

  // ── ORB 연동 ──
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  orbPassThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  orbConditionalMin?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
