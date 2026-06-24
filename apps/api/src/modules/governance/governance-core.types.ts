/**
 * Governance Core — shared types for runtime governance (Patent 1)
 * and registration governance (Patent 2).
 *
 * These types intentionally mirror the invention disclosure so the
 * implementation can serve as working evidence for the patent claims:
 *  - RuntimeGovernanceContext: 청구항의 "실행 평가 context"
 *  - GateResults: 품질/보안/비용/정책/이상탐지 복수 평가 gate 결과
 *  - GovernanceEvent: 등록~실행~조치~증거화 전 구간 이벤트
 */

// ── Node governance profile ────────────────────────────────────

export type ActionType =
  | 'READ'
  | 'WRITE'
  | 'EXTERNAL_SEND'
  | 'DELETE'
  | 'DEPLOY'
  | 'APPROVE'
  | 'PAYMENT'
  | 'PERMISSION_CHANGE'
  | 'TRANSFORM';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type DataClass =
  | 'PUBLIC'
  | 'INTERNAL'
  | 'PII'
  | 'SECRET'
  | 'CUSTOMER_CONFIDENTIAL';

export interface NodeGovernanceProfileInput {
  tenantId: string;
  workflowId: string;
  workflowVersionId?: string;
  nodeKey: string;
  executionType: string;
  capability?: string;
  connectorKey?: string;
  configJson?: Record<string, unknown>;
}

export interface ResolvedNodeProfile {
  nodeKey: string;
  executionType: string;
  capability?: string;
  actionType: ActionType;
  riskLevel: RiskLevel;
  dataClass?: DataClass;
  policyCheckpoint: boolean;
  humanApproval: boolean;
  connectorScopeHash?: string;
  /**
   * 보안 점검(모의해킹·취약점 스캔) 노드 여부. 이런 노드의 출력에는 공격
   * 패턴·비밀번호 예시가 정상적으로 포함되므로, 보안/정책/이상 게이트의
   * 위반을 BLOCK이 아닌 WARN으로 강등한다 (false-positive 차단 방지).
   */
  securityTesting: boolean;
}

// ── Runtime governance context (Patent 1) ─────────────────────

export interface RuntimeGovernanceContext {
  tenantId: string;
  executionSessionId: string;
  executionStepId?: string;
  workflowId?: string;
  workflowKey?: string;
  nodeKey: string;
  executionType: string;
  connectorKey?: string;
  modelId?: string;
  userId?: string;
  policyVersionHash?: string;
  input?: string;
  output?: string;
  tokensUsed?: number;
  estimatedCostUsd?: number;
  executionTimeMs?: number;
}

/** Normalized 0-1 gate scores (1 = best, anomaly 0 = best). */
export interface GateResults {
  quality: number;
  security: number;
  cost: number;
  policy: number;
  anomaly: number;
  details?: Record<string, unknown>;
}

export type GovernanceDecisionValue =
  | 'ALLOW'
  | 'WARN'
  | 'REQUIRE_APPROVAL'
  | 'BLOCK'
  | 'QUARANTINE';

export type AutoActionType =
  | 'NONE'
  | 'BLOCK'
  | 'THROTTLE'
  | 'QUARANTINE'
  | 'MODEL_DOWNGRADE'
  | 'CONNECTOR_DISABLE'
  | 'WORKFLOW_ROLLBACK'
  | 'REQUEST_HUMAN_APPROVAL';

export interface GovernanceDecisionResult {
  decisionId: string;
  decision: GovernanceDecisionValue;
  severity: RiskLevel;
  reasons: string[];
  autoAction: AutoActionType;
}

// ── Governance fingerprint (Patent 2) ─────────────────────────

export interface FingerprintNodeInput {
  nodeKey: string;
  executionType: string;
  capability?: string;
  actionType?: string;
  riskLevel?: string;
  connectorKey?: string;
  dataClass?: string;
  modelTier?: string;
  policyCheckpoint?: boolean;
  humanApproval?: boolean;
}

export interface FingerprintInput {
  tenantId: string;
  workflowId: string;
  workflowVersionId?: string;
  nodes: FingerprintNodeInput[];
  edges: Array<{ from: string; to: string }>;
  policyVersionHash: string;
  budgetPolicy?: unknown;
}

export interface ComputedFingerprint {
  nodeGraphHash: string;
  connectorScopeHash: string;
  policyVersionHash: string;
  modelTierHash: string;
  dataClassHash: string;
  budgetHash: string;
  actionRiskHash: string;
  fingerprintHash: string;
}

// ── Readiness scoring (Patent 2) ───────────────────────────────

export interface ReadinessScores {
  readinessScore: number;
  securityScore: number;
  policyScore: number;
  costScore: number;
  reliabilityScore: number;
  humanReviewScore: number;
}

/** readiness = security*0.30 + policy*0.30 + reliability*0.20 + cost*0.10 + humanReview*0.10 */
export const READINESS_WEIGHTS = {
  security: 0.3,
  policy: 0.3,
  reliability: 0.2,
  cost: 0.1,
  humanReview: 0.1,
} as const;

export const READINESS_THRESHOLDS = {
  autoApprove: 90,
  humanReview: 75,
  policyInjection: 60,
} as const;

// ── Governance events ──────────────────────────────────────────

export type GovernanceEvent =
  | 'WORKFLOW_TEMP_REGISTERED'
  | 'GOVERNANCE_FINGERPRINT_CREATED'
  | 'SANDBOX_REPLAY_COMPLETED'
  | 'GOVERNANCE_PATCH_APPLIED'
  | 'WORKFLOW_VERSION_APPROVED'
  | 'WORKFLOW_VERSION_PROMOTED'
  | 'WORKFLOW_DRIFT_DETECTED'
  | 'NODE_EXECUTION_EVALUATED'
  | 'POLICY_VIOLATION_DETECTED'
  | 'FDS_ALERT_RAISED'
  | 'AUTO_ACTION_EXECUTED'
  | 'EVIDENCE_PACK_CREATED'
  | 'FINOPS_CACHE_DECISION_CREATED'
  | 'FINOPS_MODEL_ROUTED';

export interface GovernanceEventPayload {
  tenantId: string;
  workflowId?: string;
  workflowVersionId?: string;
  executionSessionId?: string;
  executionStepId?: string;
  nodeKey?: string;
  policyHash?: string;
  governanceFingerprintHash?: string;
  riskLevel?: string;
  decision?: string;
  evidencePackId?: string;
  createdAt: string;
}
