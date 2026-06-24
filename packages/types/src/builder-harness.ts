/**
 * Builder Harness — Shared Types (Phase 5)
 *
 * Types shared between:
 *   - NestJS API (apps/api)
 *   - Next.js Frontend (apps/web)
 *   - Worker (apps/worker — future)
 */

// ═══════════════════════════════════════════════════════════
//  Enums
// ═══════════════════════════════════════════════════════════

export type BuilderRequestStatus =
  | 'PLANNING'
  | 'VALIDATING'
  | 'EVALUATED'
  | 'SAVED'
  | 'REPAIR_LOOP'
  | 'REJECTED';

export type HarnessIssueSeverity = 'blocking' | 'warning' | 'info';

export type ReadinessBand = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export type RepairType =
  | 'add-node'
  | 'inject-retry'
  | 'add-approval'
  | 'add-policy-check'
  | 'replace-connector'
  | 'add-failure-path'
  | 'add-exit-node'
  | 'add-trigger'
  | 'add-monitor'
  | 'set-branch-predicate'
  | 'add-branch-paths';

export type ConnectorTier = 'tier1-must' | 'tier2-reporting' | 'tier3-knowledge';
export type ConnectorGapStatus = 'available' | 'placeholder' | 'missing';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PolicyAction = 'block' | 'warn' | 'log';
export type NodeActionType = 'read' | 'write' | 'execute' | 'external-send' | 'deploy' | 'delete';
export type NodeFailureAction = 'stop' | 'skip' | 'retry' | 'fallback';

// ═══════════════════════════════════════════════════════════
//  Core Domain Objects
// ═══════════════════════════════════════════════════════════

export interface HarnessIssue {
  id: string;
  severity: HarnessIssueSeverity;
  category: string;
  nodeId?: string;
  message: string;
  description: string;
  repairAction?: RepairAction;
}

export interface RepairAction {
  id: string;
  type: RepairType;
  label: string;
  description: string;
  autoApplicable: boolean;
  nodeId?: string;
  payload?: Record<string, unknown>;
}

export interface PolicyCheckpoint {
  id: string;
  name: string;
  when: string;
  riskLevel: RiskLevel;
  action: PolicyAction;
  description: string;
}

export interface WorkflowParameter {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean' | 'date-range';
  required: boolean;
  defaultValue?: string;
  options?: string[];
  description: string;
}

export interface HarnessTemplateNode {
  id: string;
  type: string;
  name: string;
  icon: string;
  color: string;
  order: number;
  connectorKey?: string;
  actionType: NodeActionType;
  policyCheckpoint?: string;
  failureAction: NodeFailureAction;
  retryCount?: number;
  humanApproval?: boolean;
  description: string;
  outputKeys: string[];
  settings: Record<string, unknown>;
}

export interface ConnectorGapEntry {
  connectorKey: string;
  connectorName: string;
  tier: ConnectorTier;
  status: ConnectorGapStatus;
  requiredSecrets: string[];
  resolution?: string;
}

export interface IntentClassificationResult {
  patternId: string;
  label: string;
  score: number;
  matchedKeywords: string[];
  templateIds: string[];
}

// ═══════════════════════════════════════════════════════════
//  Sub-Results
// ═══════════════════════════════════════════════════════════

export interface PolicyInjectionResult {
  insertedCheckpoints: PolicyCheckpoint[];
  injectedNodeIds: string[];
  issues: HarnessIssue[];
}

export interface StructuralValidationResult {
  isValid: boolean;
  canSaveWithWarnings: boolean;
  blockingErrors: HarnessIssue[];
  warnings: HarnessIssue[];
  repairActions: RepairAction[];
}

export interface ReadinessSubScore {
  label: string;
  score: number; // 0-100
  weight: number; // percentage
  issues: string[];
}

export interface ReadinessScore {
  overall: number; // 0-100
  band: ReadinessBand;
  executionReadiness: ReadinessSubScore;
  connectorValidity: ReadinessSubScore;
  policyCoverage: ReadinessSubScore;
  operatorUsability: ReadinessSubScore;
  monitoringVisibility: ReadinessSubScore;
  issues: HarnessIssue[];
  recommendedFixes: string[];
}

// ═══════════════════════════════════════════════════════════
//  Simulation (Eval/Replay Harness)
// ═══════════════════════════════════════════════════════════

export interface SimulationMetrics {
  sampleCount: number;
  generationSuccessRate: number; // 생성 성공률 (0-100)
  executionFeasibilityRate: number; // 실행 가능률 (0-100)
  connectorMismatchRate: number; // connector mismatch (0-100)
  policyViolationRisk: number; // policy violation risk (0-100)
  humanEditRate: number; // human edit 필요도 (0-100)
}

// ═══════════════════════════════════════════════════════════
//  Full Harness Result
// ═══════════════════════════════════════════════════════════

export interface HarnessResult {
  policyInjection: PolicyInjectionResult;
  structuralValidation: StructuralValidationResult;
  readinessScore: ReadinessScore;
  simulation?: SimulationMetrics;
  canSave: boolean;
  requiresAcknowledgement: boolean;
  allIssues: HarnessIssue[];
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════
//  API Request / Response DTOs
// ═══════════════════════════════════════════════════════════

// POST /builder/plan
export interface BuilderPlanRequest {
  userPrompt: string;
  templateId?: string; // optional: force a specific template
}

export interface BuilderPlanResponse {
  requestId: string;
  detectedIntents: IntentClassificationResult[];
  matchedTemplateId: string | null;
  matchedTemplateName: string | null;
  plan: {
    nodes: HarnessTemplateNode[];
    connectors: string[];
    policies: PolicyCheckpoint[];
    parameters: WorkflowParameter[];
    metadata: Record<string, unknown>;
  } | null;
}

// POST /builder/params/extract
export interface BuilderParamsExtractRequest {
  requestId: string;
  userPrompt: string;
}

export interface BuilderParamsExtractResponse {
  requestId: string;
  parameters: Array<{
    key: string;
    label: string;
    value: string | null;
    resolved: boolean;
  }>;
  unresolvedCount: number;
}

// POST /builder/connectors/check
export interface BuilderConnectorsCheckRequest {
  requestId: string;
  connectorKeys: string[];
}

export interface BuilderConnectorsCheckResponse {
  requestId: string;
  gaps: ConnectorGapEntry[];
  availableCount: number;
  placeholderCount: number;
  missingCount: number;
}

// POST /builder/validate
export interface BuilderValidateRequest {
  requestId: string;
  nodes: HarnessTemplateNode[];
}

export interface BuilderValidateResponse {
  requestId: string;
  validation: StructuralValidationResult;
  policyInjection: PolicyInjectionResult;
}

// POST /builder/eval/preview
export interface BuilderEvalPreviewRequest {
  requestId: string;
}

export interface BuilderEvalPreviewResponse {
  requestId: string;
  readinessScore: ReadinessScore;
  simulation: SimulationMetrics;
  canSave: boolean;
  requiresAcknowledgement: boolean;
}

// POST /builder/save
export interface BuilderSaveRequest {
  requestId: string;
  workflowName: string;
  acknowledgeWarnings?: boolean;
}

export interface BuilderSaveResponse {
  requestId: string;
  saved: boolean;
  workflowId: string | null;
  reason?: string;
  readinessScore: number;
}

// POST /builder/repair
export interface BuilderRepairRequest {
  requestId: string;
  repairActionId: string;
}

export interface BuilderRepairResponse {
  requestId: string;
  applied: boolean;
  repairType: string;
  updatedNodes: HarnessTemplateNode[];
  newValidation: StructuralValidationResult;
  newReadinessScore: ReadinessScore;
}

// ═══════════════════════════════════════════════════════════
//  Builder Request DTO (for list/get)
// ═══════════════════════════════════════════════════════════

export interface BuilderRequestDto {
  id: string;
  tenantId: string;
  userId: string;
  status: BuilderRequestStatus;
  userPrompt: string;
  detectedIntents: IntentClassificationResult[] | null;
  matchedTemplate: string | null;
  readinessScore?: number;
  readinessBand?: ReadinessBand;
  createdAt: string;
  updatedAt: string;
}
