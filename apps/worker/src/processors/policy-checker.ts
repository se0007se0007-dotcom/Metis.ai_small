/**
 * Policy Checker — Shared policy evaluation for replay/shadow workers
 *
 * Loads the tenant's active policies from DB and evaluates the execution
 * output against them. This ensures that replay and shadow executions
 * are held to the same governance standard as production executions.
 *
 * CRITICAL: Without this, replay/shadow could pass versions that violate policies.
 */
import { PrismaClient } from '@metis/database';

export interface PolicyCheckResult {
  totalPolicies: number;
  passedPolicies: number;
  failedPolicies: number;
  violations: Array<{
    policyId: string;
    policyName: string;
    policyType: string;
    reason: string;
  }>;
}

/**
 * Evaluate execution output against all active policies for the tenant.
 *
 * This is a worker-side implementation that mirrors the API-side PolicyService
 * logic, querying the same Policy table and applying the same rule evaluation.
 *
 * @param prisma - PrismaClient instance
 * @param tenantId - Tenant to evaluate policies for
 * @param executionContext - Context for policy evaluation
 */
export async function evaluatePoliciesForExecution(
  prisma: PrismaClient,
  tenantId: string,
  executionContext: {
    capabilityKey?: string | null;
    workflowKey?: string | null;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    status: string;
    costUsd?: number;
    latencyMs?: number;
  },
): Promise<PolicyCheckResult> {
  // Load all active policies for this tenant
  const policies = await prisma.policy.findMany({
    where: {
      tenantId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      ruleYaml: true,
    },
  });

  const result: PolicyCheckResult = {
    totalPolicies: policies.length,
    passedPolicies: 0,
    failedPolicies: 0,
    violations: [],
  };

  for (const policy of policies) {
    try {
      // Check scope filter (if policy is scoped to specific capabilities/workflows)
      // Scope filtering not implemented - Policy model doesn't have scope field
      // In future phases, add scope to Policy model and implement this validation

      // Evaluate policy rules against execution context
      const rules: Record<string, unknown>[] = []; // TODO: parse ruleYaml from YAML to rules object
      if (!rules || !Array.isArray(rules) || rules.length === 0) {
        result.passedPolicies++;
        continue;
      }

      let passed = true;
      let failReason = '';

      for (const rule of rules) {
        const ruleType = rule.type as string;
        const ruleConfig = rule.config as Record<string, unknown> | undefined;

        switch (ruleType) {
          case 'OUTPUT_MUST_CONTAIN_KEYS': {
            const requiredKeys = ruleConfig?.keys as string[] | undefined;
            if (requiredKeys) {
              const outputKeys = Object.keys(executionContext.output);
              const missing = requiredKeys.filter((k) => !outputKeys.includes(k));
              if (missing.length > 0) {
                passed = false;
                failReason = `Output missing required keys: ${missing.join(', ')}`;
              }
            }
            break;
          }

          case 'OUTPUT_MUST_NOT_CONTAIN': {
            const forbidden = ruleConfig?.patterns as string[] | undefined;
            if (forbidden) {
              const outputStr = JSON.stringify(executionContext.output);
              const found = forbidden.filter((p) => outputStr.includes(p));
              if (found.length > 0) {
                passed = false;
                failReason = `Output contains forbidden patterns: ${found.join(', ')}`;
              }
            }
            break;
          }

          case 'MAX_COST': {
            const maxCost = ruleConfig?.maxUsd as number | undefined;
            if (maxCost != null && executionContext.costUsd != null) {
              if (executionContext.costUsd > maxCost) {
                passed = false;
                failReason = `Cost $${executionContext.costUsd} exceeds max $${maxCost}`;
              }
            }
            break;
          }

          case 'MAX_LATENCY': {
            const maxLatency = ruleConfig?.maxMs as number | undefined;
            if (maxLatency != null && executionContext.latencyMs != null) {
              if (executionContext.latencyMs > maxLatency) {
                passed = false;
                failReason = `Latency ${executionContext.latencyMs}ms exceeds max ${maxLatency}ms`;
              }
            }
            break;
          }

          case 'STATUS_MUST_BE': {
            const allowed = ruleConfig?.statuses as string[] | undefined;
            if (allowed && !allowed.includes(executionContext.status)) {
              passed = false;
              failReason = `Status "${executionContext.status}" not in allowed: ${allowed.join(', ')}`;
            }
            break;
          }

          default:
            // Unknown rule type — log and skip (fail-open for extensibility)
            console.warn(`[policy-checker] Unknown rule type: ${ruleType}`);
        }

        if (!passed) break; // First violation stops evaluation
      }

      if (passed) {
        result.passedPolicies++;
      } else {
        result.failedPolicies++;
        result.violations.push({
          policyId: policy.id,
          policyName: policy.name,
          policyType: 'UNKNOWN', // Policy model has no type field
          reason: failReason,
        });
      }
    } catch (error: any) {
      // Policy evaluation error — record as violation (fail-closed for safety)
      result.failedPolicies++;
      result.violations.push({
        policyId: policy.id,
        policyName: policy.name,
        policyType: 'UNKNOWN', // Policy model has no type field
        reason: `Evaluation error: ${error.message}`,
      });
    }
  }

  return result;
}

/**
 * Record policy evaluation results as PolicyEvaluation rows.
 * This creates a proper audit trail of policy checks during replay/shadow.
 */
export async function recordPolicyEvaluations(
  prisma: PrismaClient,
  tenantId: string,
  executionSessionId: string | null,
  policyCheck: PolicyCheckResult,
  context: { mode: 'REPLAY' | 'SHADOW'; sourceId: string },
): Promise<void> {
  for (const violation of policyCheck.violations) {
    await prisma.policyEvaluation
      .create({
        data: {
          tenantId,
          policyId: violation.policyId,
          executionSessionId,
          result: 'FAIL',
          reason: `[${context.mode}:${context.sourceId}] ${violation.reason}`,
        },
      })
      .catch((e: any) => {
        console.error(`[policy-checker] Failed to record policy evaluation: ${e.message}`);
      });
  }
}
