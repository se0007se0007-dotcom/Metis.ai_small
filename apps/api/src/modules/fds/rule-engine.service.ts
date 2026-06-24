/**
 * Fraud Detection System — Rule Engine
 *
 * Evaluates rules against subjects (transactions, accounts, etc) with:
 *   - Condition-based matching (field operators)
 *   - Weight accumulation and normalization
 *   - Aggregate scoring across rule sets
 *   - Full tenant isolation via withTenantIsolation
 */

import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

/** Supported condition operators */
export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'regex'
  | 'velocity_gt';

/** Single condition in a rule */
export interface Condition {
  field: string;
  operator: ConditionOperator;
  value: any;
}

/** Complete rule definition (matches FDSRule in DB) */
export interface RuleDefinition {
  id?: string;
  name: string;
  description?: string;
  enabled: boolean;
  weight: number;
  conditions: Condition[];
  logic?: 'AND' | 'OR';
}

/** Rule evaluation result */
export interface RuleEvaluationResult {
  matched: boolean;
  score: number;
  evidence: any;
}

/** Aggregate evaluation across all tenant rules */
export interface AggregateEvaluationResult {
  matchedRules: Array<{
    ruleId: string;
    ruleName: string;
    matched: boolean;
    score: number;
    evidence: any;
  }>;
  aggregateScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * List all enabled rules for the tenant
   */
  async listRules(ctx: TenantContext) {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);
      const rules = await tenantPrisma.fDSRule.findMany({
        where: { enabled: true },
        orderBy: { createdAt: 'desc' },
      });
      return rules;
    } catch (error) {
      this.logger.error(`Failed to list rules for tenant ${ctx.tenantId}: ${error}`);
      throw error;
    }
  }

  /**
   * Get a specific rule by ID
   */
  async getRule(ctx: TenantContext, id: string) {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);
      const rule = await tenantPrisma.fDSRule.findUnique({
        where: { id },
      });
      if (!rule) {
        throw new NotFoundException(`Rule ${id} not found`);
      }
      return rule;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get rule ${id}: ${error}`);
      throw error;
    }
  }

  /**
   * Create a new FDS rule
   */
  async createRule(ctx: TenantContext, dto: any) {
    try {
      // Validate DTO
      if (!dto.name || !Array.isArray(dto.conditions) || typeof dto.weight !== 'number') {
        throw new BadRequestException(
          'Invalid rule definition: name, conditions, and weight required',
        );
      }

      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      const rule = await tenantPrisma.fDSRule.create({
        data: {
          tenantId: ctx.tenantId,
          key: dto.key || `rule-${Date.now()}`,
          name: dto.name,
          description: dto.description,
          enabled: dto.enabled ?? true,
          weight: dto.weight,
          severity: dto.severity || 'MEDIUM',
          conditionsJson: {
            conditions: dto.conditions,
            logic: dto.logic ?? 'AND',
          } as any,
        },
      });

      this.logger.log(`Created rule ${rule.id} for tenant ${ctx.tenantId}`);
      return rule;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Failed to create rule: ${error}`);
      throw error;
    }
  }

  /**
   * Update an existing rule
   */
  async updateRule(ctx: TenantContext, id: string, dto: any) {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      // Verify rule exists and belongs to tenant
      const existing = await tenantPrisma.fDSRule.findUnique({
        where: { id },
      });
      if (!existing) {
        throw new NotFoundException(`Rule ${id} not found`);
      }

      const rule = await tenantPrisma.fDSRule.update({
        where: { id },
        data: {
          name: dto.name ?? existing.name,
          description: dto.description ?? existing.description,
          enabled: dto.enabled ?? existing.enabled,
          weight: dto.weight ?? existing.weight,
          severity: dto.severity ?? existing.severity,
          conditionsJson: (dto.conditions
            ? {
                conditions: dto.conditions,
                logic: dto.logic ?? 'AND',
              }
            : existing.conditionsJson) as any,
        },
      });

      this.logger.log(`Updated rule ${rule.id} for tenant ${ctx.tenantId}`);
      return rule;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to update rule ${id}: ${error}`);
      throw error;
    }
  }

  /**
   * Evaluate a single rule against a subject
   *
   * Returns score (0..1) and evidence of matched conditions
   */
  evaluate(rule: any, subject: Record<string, any>): RuleEvaluationResult {
    try {
      const conditionsJson = rule.conditionsJson || { conditions: [], logic: 'AND' };
      const conditions: Condition[] = conditionsJson.conditions || [];
      const logic = conditionsJson.logic || 'AND';

      if (!conditions || conditions.length === 0) {
        return { matched: false, score: 0, evidence: { reason: 'No conditions defined' } };
      }

      // Evaluate all conditions
      const conditionResults = conditions.map((condition) =>
        this.evaluateCondition(condition, subject),
      );

      // Aggregate based on logic
      let matched: boolean;
      if (logic === 'OR') {
        matched = conditionResults.some((r) => r.matched);
      } else {
        // Default AND
        matched = conditionResults.every((r) => r.matched);
      }

      // Calculate score: matched conditions / total conditions * weight
      const matchedCount = conditionResults.filter((r) => r.matched).length;
      const baseScore = conditions.length > 0 ? matchedCount / conditions.length : 0;
      const normalizedScore = Math.min(baseScore * (rule.weight || 1.0), 1.0);

      const evidence = {
        logic,
        totalConditions: conditions.length,
        matchedConditions: matchedCount,
        weight: rule.weight,
        conditions: conditions.map((cond, idx) => ({
          field: cond.field,
          operator: cond.operator,
          value: cond.value,
          matched: conditionResults[idx].matched,
        })),
      };

      return {
        matched,
        score: matched ? normalizedScore : 0,
        evidence,
      };
    } catch (error) {
      this.logger.error(`Error evaluating rule: ${error}`);
      return {
        matched: false,
        score: 0,
        evidence: { error: error instanceof Error ? error.message : 'Evaluation failed' },
      };
    }
  }

  /**
   * Evaluate all enabled rules for a tenant against a subject
   *
   * Returns matched rules, aggregate score, and risk level
   */
  async evaluateAll(
    ctx: TenantContext,
    subject: Record<string, any>,
  ): Promise<AggregateEvaluationResult> {
    try {
      const rules = await this.listRules(ctx);

      const results = rules.map((rule) => {
        const evalResult = this.evaluate(rule, subject);
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          matched: evalResult.matched,
          score: evalResult.score,
          evidence: evalResult.evidence,
        };
      });

      // Aggregate score: average of matched rule scores
      const matchedRules = results.filter((r) => r.matched);
      const aggregateScore =
        matchedRules.length > 0
          ? matchedRules.reduce((sum, r) => sum + r.score, 0) / matchedRules.length
          : 0;

      // Risk level mapping
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      if (aggregateScore >= 0.9) {
        riskLevel = 'CRITICAL';
      } else if (aggregateScore >= 0.7) {
        riskLevel = 'HIGH';
      } else if (aggregateScore >= 0.5) {
        riskLevel = 'MEDIUM';
      } else {
        riskLevel = 'LOW';
      }

      return {
        matchedRules: results,
        aggregateScore,
        riskLevel,
      };
    } catch (error) {
      this.logger.error(`Failed to evaluate all rules: ${error}`);
      throw error;
    }
  }

  /**
   * Evaluate a single condition against subject data
   *
   * Pure function supporting all operators
   */
  private evaluateCondition(
    condition: Condition,
    subject: Record<string, any>,
  ): { matched: boolean } {
    const fieldValue = subject[condition.field];

    try {
      switch (condition.operator) {
        case 'eq':
          return { matched: fieldValue === condition.value };

        case 'neq':
          return { matched: fieldValue !== condition.value };

        case 'gt':
          return { matched: typeof fieldValue === 'number' && fieldValue > condition.value };

        case 'lt':
          return { matched: typeof fieldValue === 'number' && fieldValue < condition.value };

        case 'in':
          return {
            matched: Array.isArray(condition.value) && condition.value.includes(fieldValue),
          };

        case 'not_in':
          return {
            matched: Array.isArray(condition.value) && !condition.value.includes(fieldValue),
          };

        case 'contains':
          return {
            matched: typeof fieldValue === 'string' && fieldValue.includes(condition.value),
          };

        case 'regex':
          try {
            const regex = new RegExp(condition.value);
            return {
              matched: typeof fieldValue === 'string' && regex.test(fieldValue),
            };
          } catch {
            return { matched: false };
          }

        case 'velocity_gt':
          // Velocity: count of transactions in specified time window
          // Expected: condition.value = { count: number, windowHours: number }
          return {
            matched: typeof fieldValue === 'number' && fieldValue > (condition.value?.count ?? 0),
          };

        default:
          this.logger.warn(`Unknown operator: ${condition.operator}`);
          return { matched: false };
      }
    } catch (error) {
      this.logger.error(`Error evaluating condition: ${error}`);
      return { matched: false };
    }
  }
}
