/**
 * Policy Enforcement Engine — Phase 2
 *
 * Rule evaluation flow:
 *   1. Load all active policies for tenant
 *   2. For each policy, parse ruleYaml
 *   3. Evaluate rules against execution context
 *   4. Record PolicyEvaluation for audit
 *   5. Return aggregate result (PASS / FAIL / WARN)
 *
 * Rule YAML format:
 *   conditions:
 *     - field: "actionType"
 *       operator: "in"
 *       value: ["delete", "deploy"]
 *   effect: "deny"  (or "warn" or "allow")
 *
 * Special rules:
 *   - action-block: Block specific action types
 *   - capability-block: Block specific capabilities
 *   - time-window: Allow only during business hours
 *   - max-cost: Block if estimated cost exceeds threshold
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

interface PolicyRule {
  conditions: Array<{
    field: string;
    operator: 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'lt' | 'contains' | 'exists';
    value: unknown;
  }>;
  effect: 'deny' | 'warn' | 'allow';
  message?: string;
}

interface EvaluationContext {
  targetType: string;
  targetId?: string;
  action: string;
  metadata?: Record<string, unknown>;
}

interface EvaluationResult {
  policyId: string;
  policyKey: string;
  result: 'PASS' | 'FAIL' | 'WARN';
  reason: string;
}

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * Evaluate all active policies for a tenant against a given context.
   */
  async evaluate(
    tenantId: string,
    context: EvaluationContext,
  ): Promise<{ result: 'PASS' | 'FAIL' | 'WARN'; evaluations: EvaluationResult[] }> {
    const policies = await this.prisma.policy.findMany({
      where: { tenantId, isActive: true },
    });

    const evaluations: EvaluationResult[] = [];

    for (const policy of policies) {
      let evalResult: EvaluationResult;

      try {
        const rules = this.parseRuleYaml(policy.ruleYaml);
        evalResult = this.evaluatePolicy(policy.id, policy.key, rules, context);
      } catch (err: any) {
        this.logger.error(`Policy "${policy.key}" rule parse error: ${err.message}`);
        evalResult = {
          policyId: policy.id,
          policyKey: policy.key,
          result: 'FAIL',
          reason: `Rule parse error (fail-closed): ${err.message}`,
        };
      }

      evaluations.push(evalResult);

      // Record evaluation in database
      await this.prisma.policyEvaluation.create({
        data: {
          tenantId,
          policyId: policy.id,
          executionSessionId: context.targetId ?? null,
          result: evalResult.result,
          reason: evalResult.reason,
        },
      });
    }

    this.logger.debug(
      `Policy evaluation for ${context.targetType}/${context.action}: ` +
        `${evaluations.length} policies evaluated`,
    );

    // Aggregate: FAIL > WARN > PASS
    const results = evaluations.map((e) => e.result);
    const overallResult = results.includes('FAIL')
      ? ('FAIL' as const)
      : results.includes('WARN')
        ? ('WARN' as const)
        : ('PASS' as const);

    return { result: overallResult, evaluations };
  }

  /**
   * Parse ruleYaml into structured rules.
   * Supports a simplified YAML-like JSON format for Phase 2.
   */
  private parseRuleYaml(ruleYaml: string): PolicyRule[] {
    try {
      // Try JSON parse first (Phase 2 uses JSON rules stored as YAML field)
      const parsed = JSON.parse(ruleYaml);

      if (Array.isArray(parsed)) {
        return parsed as PolicyRule[];
      }

      if (parsed.rules && Array.isArray(parsed.rules)) {
        return parsed.rules as PolicyRule[];
      }

      // Single rule object
      if (parsed.conditions) {
        return [parsed as PolicyRule];
      }

      // Legacy: simple key-value rules
      return this.convertLegacyRules(parsed);
    } catch {
      // Fallback: try to parse as simple YAML-like format
      return this.parseSimpleYaml(ruleYaml);
    }
  }

  /**
   * Evaluate a single policy's rules against the context.
   */
  private evaluatePolicy(
    policyId: string,
    policyKey: string,
    rules: PolicyRule[],
    context: EvaluationContext,
  ): EvaluationResult {
    // Build flat context object for rule evaluation
    const evalContext: Record<string, unknown> = {
      targetType: context.targetType,
      action: context.action,
      targetId: context.targetId,
      ...(context.metadata ?? {}),
    };

    for (const rule of rules) {
      const allMatch = rule.conditions.every((cond) => this.evaluateCondition(cond, evalContext));

      if (allMatch) {
        switch (rule.effect) {
          case 'deny':
            return {
              policyId,
              policyKey,
              result: 'FAIL',
              reason: rule.message ?? `Policy "${policyKey}" denied: conditions matched`,
            };
          case 'warn':
            return {
              policyId,
              policyKey,
              result: 'WARN',
              reason: rule.message ?? `Policy "${policyKey}" warning: conditions matched`,
            };
          case 'allow':
            // Explicit allow — skip remaining rules
            return {
              policyId,
              policyKey,
              result: 'PASS',
              reason: `Policy "${policyKey}" explicitly allowed`,
            };
        }
      }
    }

    // No rules matched = default allow
    return {
      policyId,
      policyKey,
      result: 'PASS',
      reason: `Policy "${policyKey}" passed (no matching rules)`,
    };
  }

  /**
   * Evaluate a single condition against the context.
   */
  private evaluateCondition(
    condition: { field: string; operator: string; value: unknown },
    context: Record<string, unknown>,
  ): boolean {
    const fieldValue = context[condition.field];

    switch (condition.operator) {
      case 'eq':
        return fieldValue === condition.value;
      case 'neq':
        return fieldValue !== condition.value;
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(fieldValue);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(fieldValue);
      case 'gt':
        return typeof fieldValue === 'number' && fieldValue > (condition.value as number);
      case 'lt':
        return typeof fieldValue === 'number' && fieldValue < (condition.value as number);
      case 'contains':
        return typeof fieldValue === 'string' && fieldValue.includes(condition.value as string);
      case 'exists':
        return condition.value
          ? fieldValue !== undefined && fieldValue !== null
          : fieldValue === undefined || fieldValue === null;
      default:
        this.logger.warn(`Unknown operator: ${condition.operator}`);
        return false;
    }
  }

  /**
   * Convert legacy simple rules to PolicyRule format.
   */
  private convertLegacyRules(parsed: Record<string, unknown>): PolicyRule[] {
    const rules: PolicyRule[] = [];

    if (parsed.blockedActions && Array.isArray(parsed.blockedActions)) {
      rules.push({
        conditions: [{ field: 'actionType', operator: 'in', value: parsed.blockedActions }],
        effect: 'deny',
        message: `Action type blocked by policy`,
      });
    }

    if (parsed.blockedCapabilities && Array.isArray(parsed.blockedCapabilities)) {
      rules.push({
        conditions: [{ field: 'capabilityKey', operator: 'in', value: parsed.blockedCapabilities }],
        effect: 'deny',
        message: `Capability blocked by policy`,
      });
    }

    if (parsed.requireApprovalFor && Array.isArray(parsed.requireApprovalFor)) {
      rules.push({
        conditions: [{ field: 'actionType', operator: 'in', value: parsed.requireApprovalFor }],
        effect: 'warn',
        message: `Action requires approval`,
      });
    }

    return rules;
  }

  /**
   * Parse simple YAML-like format (key: value pairs).
   */
  private parseSimpleYaml(yaml: string): PolicyRule[] {
    // Very simple parser for Phase 2
    // Format: "block: delete, deploy" or "warn: external-send"
    const rules: PolicyRule[] = [];
    const lines = yaml.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();

      if (key.trim() === 'block') {
        const actions = value.split(',').map((v) => v.trim());
        rules.push({
          conditions: [{ field: 'actionType', operator: 'in', value: actions }],
          effect: 'deny',
          message: `Blocked action types: ${actions.join(', ')}`,
        });
      } else if (key.trim() === 'warn') {
        const actions = value.split(',').map((v) => v.trim());
        rules.push({
          conditions: [{ field: 'actionType', operator: 'in', value: actions }],
          effect: 'warn',
          message: `Warning for action types: ${actions.join(', ')}`,
        });
      }
    }

    return rules;
  }
}
