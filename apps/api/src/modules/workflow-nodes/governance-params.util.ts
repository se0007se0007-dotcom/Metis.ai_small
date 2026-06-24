/**
 * Shared helper to derive Patent-3 governance params (dataClass / riskScore /
 * nodeKey) for a node executor's LLM call, so internal pipeline traffic goes
 * through the same policy-aware FinOps gates as the FinOps API (점검 H-1).
 */
import type { NodeExecutionInput } from './node-executor-registry';
import type { NodeGovernanceProfilerService } from '../governance/node-governance-profiler.service';
import type { RiskLevel } from '../governance/governance-core.types';

export function riskLevelToScore(level: RiskLevel): number {
  switch (level) {
    case 'CRITICAL':
      return 0.9;
    case 'HIGH':
      return 0.75;
    case 'MEDIUM':
      return 0.5;
    default:
      return 0.2;
  }
}

export interface GovernanceParams {
  dataClass?: string;
  riskScore?: number;
  nodeKey?: string;
}

/**
 * Best-effort: derive governance params from the node's settings via the
 * profiler. Returns an empty object when the profiler is unavailable so callers
 * can spread it unconditionally.
 */
export function deriveGovernanceParams(
  profiler: NodeGovernanceProfilerService | undefined,
  input: NodeExecutionInput | null,
  agentName: string,
): GovernanceParams {
  if (!profiler || !input) return {};
  try {
    const profile = profiler.derive({
      tenantId: input.tenantId,
      workflowId: agentName,
      nodeKey: input.nodeId,
      executionType: input.nodeType,
      configJson: (input.settings ?? {}) as Record<string, unknown>,
    });
    return {
      dataClass: profile.dataClass,
      riskScore: riskLevelToScore(profile.riskLevel),
      nodeKey: input.nodeId,
    };
  } catch {
    return { nodeKey: input.nodeId };
  }
}
