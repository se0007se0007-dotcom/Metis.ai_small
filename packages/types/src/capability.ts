/**
 * Capability Model — Phase 2
 *
 * Every action in the system must be:
 *   1. Explicitly declared in a pack manifest
 *   2. Validated against capability boundaries
 *   3. Policy-checked before execution
 *   4. Auditable with full trace
 *
 * No implicit execution is allowed.
 */

// ── Action Types (6 mandatory types) ──

export const ACTION_TYPES = [
  'read', // Read data from source (DB, file, API)
  'write', // Write/modify data
  'execute', // Execute a computation or workflow
  'external-send', // Send data to external system (Slack, Email, Webhook)
  'deploy', // Deploy artifact to environment
  'delete', // Delete/remove resource
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

// ── Capability Definition ──

export interface CapabilityDefinition {
  /** Unique key within the pack (e.g., "send-slack-message") */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description of what this capability does */
  description?: string;
  /** Action type classification */
  actionType: ActionType;
  /** Required connectors for this capability */
  requiredConnectors?: string[];
  /** Input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>;
  /** Output schema (JSON Schema) */
  outputSchema?: Record<string, unknown>;
  /** Risk level affects policy enforcement */
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  /** Whether this capability is enabled */
  enabled?: boolean;
}

// ── Capability Execution Request ──

export interface CapabilityExecutionRequest {
  /** Capability key from pack manifest */
  capabilityKey: string;
  /** Action type (must match capability definition) */
  actionType: ActionType;
  /** Input data */
  input: Record<string, unknown>;
  /** Connector to invoke (if capability requires it) */
  connectorKey?: string;
  /** Execution context */
  context: {
    tenantId: string;
    userId: string;
    executionSessionId: string;
    packInstallationId?: string;
    correlationId: string;
  };
}

// ── Capability Execution Result ──

export interface CapabilityExecutionResult {
  success: boolean;
  output: Record<string, unknown>;
  actionType: ActionType;
  latencyMs: number;
  connectorUsed?: string;
  policyResult: 'PASS' | 'FAIL' | 'WARN';
  error?: string;
  trace: {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    startedAt: string;
    endedAt: string;
    cost?: number;
  };
}

// ── Action Type Risk Classification ──

export const ACTION_RISK_MAP: Record<ActionType, 'low' | 'medium' | 'high'> = {
  read: 'low',
  write: 'medium',
  execute: 'medium',
  'external-send': 'high',
  deploy: 'high',
  delete: 'high',
};

// ── Helpers ──

export function isValidActionType(action: string): action is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(action);
}

export function getActionRisk(action: ActionType): 'low' | 'medium' | 'high' {
  return ACTION_RISK_MAP[action] ?? 'medium';
}
