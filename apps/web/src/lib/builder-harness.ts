/**
 * Metis.AI Builder Harness — Frontend Client Module
 *
 * Dual-mode architecture:
 *   1. API Mode — calls NestJS backend (POST /builder/*) with tenant isolation
 *   2. Local Mode — runs harness engine in-browser for demo / offline use
 *
 * The Builder page uses this module as a single entry point.
 * When the API server is available, all operations are persisted server-side.
 * When the API server is unavailable, the local engine provides identical results.
 *
 * Re-exports shared types from @metis/types for UI consumption.
 */

import { api } from './api-client';
import type {
  WorkflowTemplate,
  TemplateNode,
  PolicyCheckpoint,
  ConnectorContract,
} from './starter-workflows';

// ── Re-export shared types (from packages/types) ──
// These are duplicated here for the frontend build since the monorepo
// type import may not resolve in all Next.js configurations.

export type IssueSeverity = 'blocking' | 'warning' | 'info';
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

export interface HarnessIssue {
  id: string;
  severity: IssueSeverity;
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

export interface PolicyInjectionResult {
  insertedCheckpoints: PolicyCheckpoint[];
  injectedNodeIds: string[];
  issues: HarnessIssue[];
}

export interface StructuralValidationResult {
  blockingErrors: HarnessIssue[];
  warnings: HarnessIssue[];
  repairActions: RepairAction[];
  isValid: boolean;
  canSaveWithWarnings: boolean;
}

export interface ReadinessSubScore {
  label: string;
  score: number;
  weight: number;
  issues: string[];
}

export interface ReadinessScore {
  overall: number;
  executionReadiness: ReadinessSubScore;
  connectorValidity: ReadinessSubScore;
  policyCoverage: ReadinessSubScore;
  operatorUsability: ReadinessSubScore;
  monitoringVisibility: ReadinessSubScore;
  band: ReadinessBand;
  issues: HarnessIssue[];
  recommendedFixes: string[];
}

export interface SimulationMetrics {
  sampleCount: number;
  generationSuccessRate: number; // 생성 성공률 (0-100)
  executionFeasibilityRate: number; // 실행 가능률 (0-100)
  connectorMismatchRate: number; // connector mismatch (0-100)
  policyViolationRisk: number; // policy violation risk (0-100)
  humanEditRate: number; // human edit 필요도 (0-100)
}

export interface HarnessResult {
  requestId?: string; // present when API-backed
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
//  Risk Classification Constants
// ═══════════════════════════════════════════════════════════

const RISKY_ACTION_TYPES = new Set(['deploy', 'delete', 'external-send', 'write']);
const HIGH_RISK_NODE_TYPES = new Set([
  'git-deploy',
  'email-send',
  'slack-message',
  'notification',
  'api-call',
  'webhook',
]);
const DEPLOY_DELETE_TYPES = new Set(['git-deploy']);

// ═══════════════════════════════════════════════════════════
//  API Client — calls NestJS backend (when available)
// ═══════════════════════════════════════════════════════════

export const builderApi = {
  /** POST /builder/plan */
  async createPlan(userPrompt: string, templateId?: string) {
    return api.post<any>('/builder/plan', { userPrompt, templateId });
  },

  /** POST /builder/params/extract */
  async extractParams(requestId: string, userPrompt: string) {
    return api.post<any>('/builder/params/extract', { requestId, userPrompt });
  },

  /** POST /builder/connectors/check */
  async checkConnectors(requestId: string, connectorKeys: string[]) {
    return api.post<any>('/builder/connectors/check', { requestId, connectorKeys });
  },

  /** POST /builder/validate */
  async validate(requestId: string, nodes: TemplateNode[]) {
    return api.post<any>('/builder/validate', { requestId, nodes });
  },

  /** POST /builder/eval/preview */
  async evalPreview(requestId: string) {
    return api.post<any>('/builder/eval/preview', { requestId });
  },

  /** POST /builder/save */
  async save(requestId: string, workflowName: string, acknowledgeWarnings?: boolean) {
    return api.post<any>('/builder/save', { requestId, workflowName, acknowledgeWarnings });
  },

  /** POST /builder/repair */
  async repair(requestId: string, repairActionId: string) {
    return api.post<any>('/builder/repair', { requestId, repairActionId });
  },
};

// ═══════════════════════════════════════════════════════════
//  Local Engine — BH-3: Policy Injector
// ═══════════════════════════════════════════════════════════

export function injectPolicies(
  nodes: TemplateNode[],
  _existingPolicies: PolicyCheckpoint[],
): PolicyInjectionResult {
  const issues: HarnessIssue[] = [];
  const insertedCheckpoints: PolicyCheckpoint[] = [];
  const injectedNodeIds: string[] = [];

  const coveredNodeIds = new Set(nodes.filter((n) => n.policyCheckpoint).map((n) => n.id));
  const approvalNodeIds = new Set(nodes.filter((n) => n.humanApproval).map((n) => n.id));

  for (const node of nodes) {
    const isRisky = RISKY_ACTION_TYPES.has(node.actionType) || HIGH_RISK_NODE_TYPES.has(node.type);
    const isDeploy =
      DEPLOY_DELETE_TYPES.has(node.type) ||
      node.actionType === 'deploy' ||
      node.actionType === 'delete';
    const isExternalSend =
      node.actionType === 'external-send' ||
      node.type === 'email-send' ||
      node.type === 'slack-message';
    if (!isRisky) continue;

    if (!coveredNodeIds.has(node.id)) {
      insertedCheckpoints.push({
        id: `pol-auto-${node.id}`,
        name: `${node.name} 실행 전 정책 점검`,
        when: `${node.name} 실행 전`,
        riskLevel: isDeploy ? 'critical' : isExternalSend ? 'high' : 'medium',
        action: isDeploy ? 'block' : 'warn',
        description: `위험 액션(${node.actionType}) 실행 전 거버넌스 정책 확인 필요`,
      });
      injectedNodeIds.push(node.id);
      issues.push({
        id: `policy-inject-${node.id}`,
        severity: 'info',
        category: 'policy',
        nodeId: node.id,
        message: `"${node.name}" 앞에 정책 점검 자동 삽입`,
        description: `위험 액션(${node.actionType})에 대한 거버넌스 정책 점검이 자동 추가되었습니다.`,
      });
    }

    if (isDeploy && !approvalNodeIds.has(node.id)) {
      issues.push({
        id: `approval-missing-${node.id}`,
        severity: 'warning',
        category: 'approval',
        nodeId: node.id,
        message: `"${node.name}" 앞에 관리자 승인이 필요합니다`,
        description: `배포/삭제 액션은 관리자 승인을 필요로 합니다.`,
        repairAction: {
          id: `repair-approval-${node.id}`,
          type: 'add-approval',
          label: '승인 노드 추가',
          description: `${node.name} 앞에 승인 노드 추가`,
          autoApplicable: true,
          nodeId: node.id,
        },
      });
    }
  }

  return { insertedCheckpoints, injectedNodeIds, issues };
}

// ═══════════════════════════════════════════════════════════
//  Local Engine — BH-4: Structural Validator
// ═══════════════════════════════════════════════════════════

export function validateStructure(nodes: TemplateNode[]): StructuralValidationResult {
  const blockingErrors: HarnessIssue[] = [];
  const warnings: HarnessIssue[] = [];
  const repairActions: RepairAction[] = [];

  if (nodes.length === 0) {
    blockingErrors.push({
      id: 'err-no-nodes',
      severity: 'blocking',
      category: 'structure',
      message: '워크플로우에 노드가 없습니다',
      description: '최소 1개 이상의 노드가 필요합니다.',
    });
    return { blockingErrors, warnings, repairActions, isValid: false, canSaveWithWarnings: false };
  }

  const triggerTypes = new Set(['schedule', 'webhook']);
  if (!triggerTypes.has(nodes[0].type)) {
    const action: RepairAction = {
      id: 'repair-add-trigger',
      type: 'add-trigger',
      label: '트리거 노드 추가',
      description: '워크플로우 앞에 Schedule 트리거 추가',
      autoApplicable: true,
      payload: { position: 0 },
    };
    warnings.push({
      id: 'warn-no-trigger',
      severity: 'warning',
      category: 'structure',
      nodeId: nodes[0].id,
      message: '트리거 노드가 없습니다',
      description: '수동 실행 전용 워크플로우가 됩니다.',
      repairAction: action,
    });
    repairActions.push(action);
  }

  const exitTypes = new Set([
    'data-storage',
    'notification',
    'email-send',
    'slack-message',
    'log-monitor',
  ]);
  if (!exitTypes.has(nodes[nodes.length - 1].type)) {
    warnings.push({
      id: 'warn-no-exit',
      severity: 'warning',
      category: 'structure',
      nodeId: nodes[nodes.length - 1].id,
      message: '명시적 종료 노드가 없습니다',
      description: '결과 전달 노드가 아닙니다.',
      repairAction: {
        id: 'repair-add-exit',
        type: 'add-exit-node',
        label: '종료 노드 추가',
        description: '알림/저장 노드를 마지막에 추가',
        autoApplicable: true,
      },
    });
  }

  const noFailure = nodes.filter((n) => !n.failureAction || n.failureAction === 'stop').length;
  if (noFailure > nodes.length * 0.5) {
    warnings.push({
      id: 'warn-no-failure-paths',
      severity: 'warning',
      category: 'resilience',
      message: `${noFailure}개 노드에 실패 복구 경로 없음`,
      description: 'retry/fallback 설정 권장',
      repairAction: {
        id: 'repair-add-retry',
        type: 'inject-retry',
        label: 'Retry 설정 추가',
        description: '주요 노드에 retry(2회) 설정',
        autoApplicable: true,
      },
    });
  }

  const criticalNoRetry = nodes.filter(
    (n) =>
      (n.actionType === 'write' || n.actionType === 'external-send') &&
      (!n.retryCount || n.retryCount === 0),
  );
  for (const cn of criticalNoRetry) {
    warnings.push({
      id: `warn-no-retry-${cn.id}`,
      severity: 'warning',
      category: 'resilience',
      nodeId: cn.id,
      message: `"${cn.name}" retry 없음`,
      description: '쓰기/외부전송 노드는 retry 권장',
      repairAction: {
        id: `repair-retry-${cn.id}`,
        type: 'inject-retry',
        label: 'Retry 추가',
        description: `${cn.name}에 retry(2회) 설정`,
        autoApplicable: true,
        nodeId: cn.id,
      },
    });
  }

  const hasAuditNode = nodes.some(
    (n) =>
      n.connectorKey === 'metis-audit' || n.type === 'log-monitor' || n.type === 'data-storage',
  );
  if (!hasAuditNode && nodes.length >= 3) {
    warnings.push({
      id: 'warn-no-monitoring',
      severity: 'warning',
      category: 'observability',
      message: '감사 로그/모니터링 노드 없음',
      description: '감사 로그 추가 권장',
      repairAction: {
        id: 'repair-add-monitor',
        type: 'add-monitor',
        label: '감사 로그 추가',
        description: '워크플로우 끝에 감사 로그 노드 추가',
        autoApplicable: true,
      },
    });
  }

  // Branch condition validation
  const branchNodes = nodes.filter(
    (n) =>
      n.type === 'condition' || n.type === 'branch' || n.type === 'if-else' || n.type === 'switch',
  );
  for (const bn of branchNodes) {
    const hasPredicate =
      bn.settings?.condition || bn.settings?.predicate || bn.settings?.expression;
    if (!hasPredicate) {
      blockingErrors.push({
        id: `err-branch-no-predicate-${bn.id}`,
        severity: 'blocking',
        category: 'branch',
        nodeId: bn.id,
        message: `"${bn.name}" 분기 노드에 조건식이 정의되지 않았습니다`,
        description: '분기 노드는 반드시 평가 조건(predicate/expression)이 필요합니다.',
        repairAction: {
          id: `repair-branch-predicate-${bn.id}`,
          type: 'set-branch-predicate',
          label: '기본 조건식 설정',
          description: `${bn.name}에 기본 조건식(true)을 설정합니다.`,
          autoApplicable: true,
          nodeId: bn.id,
        },
      });
    }
    const hasTrue =
      bn.settings?.trueBranch || bn.outputKeys?.includes('true') || bn.outputKeys?.includes('yes');
    const hasFalse =
      bn.settings?.falseBranch || bn.outputKeys?.includes('false') || bn.outputKeys?.includes('no');
    if (!hasTrue || !hasFalse) {
      const missingPaths = [];
      if (!hasTrue) missingPaths.push('true');
      if (!hasFalse) missingPaths.push('false');
      warnings.push({
        id: `warn-branch-path-${bn.id}`,
        severity: 'warning',
        category: 'branch',
        nodeId: bn.id,
        message: `"${bn.name}" 분기 노드에 ${missingPaths.join('/')} 경로가 없습니다`,
        description: '분기 노드는 true/false 양쪽 경로가 정의되어야 합니다.',
        repairAction: {
          id: `repair-branch-paths-${bn.id}`,
          type: 'add-branch-paths',
          label: '분기 경로 추가',
          description: `${bn.name}에 누락된 ${missingPaths.join('/')} 경로를 추가합니다.`,
          autoApplicable: true,
          nodeId: bn.id,
        },
      });
    }
  }

  const actionNodes = nodes.filter(
    (n) =>
      n.actionType === 'execute' ||
      n.actionType === 'write' ||
      n.actionType === 'deploy' ||
      n.actionType === 'delete',
  );
  if (actionNodes.length === 0 && nodes.length > 1) {
    warnings.push({
      id: 'warn-notify-only',
      severity: 'warning',
      category: 'structure',
      message: '실행 노드 없이 알림만 있음',
      description: '핵심 액션 노드가 없습니다.',
    });
  }

  const allRepairActions = [
    ...repairActions,
    ...blockingErrors.filter((e) => e.repairAction).map((e) => e.repairAction!),
    ...warnings.filter((w) => w.repairAction).map((w) => w.repairAction!),
  ];
  return {
    blockingErrors,
    warnings,
    repairActions: allRepairActions,
    isValid: blockingErrors.length === 0,
    canSaveWithWarnings: blockingErrors.length === 0 && warnings.length > 0,
  };
}

// ═══════════════════════════════════════════════════════════
//  Local Engine — BH-5: Readiness Scoring
// ═══════════════════════════════════════════════════════════

function scoreBand(score: number): ReadinessBand {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  if (score >= 35) return 'poor';
  return 'critical';
}

export function evaluateReadiness(
  nodes: TemplateNode[],
  template: WorkflowTemplate | null,
  connectorGaps: {
    available: ConnectorContract[];
    placeholder: ConnectorContract[];
    missing: string[];
  } | null,
  policyResult: PolicyInjectionResult,
  structuralResult: StructuralValidationResult,
): ReadinessScore {
  const recommendedFixes: string[] = [];

  let execScore = 100;
  const execIssues: string[] = [];
  execScore -= structuralResult.blockingErrors.length * 40;
  const hasTrigger =
    nodes.length > 0 && (nodes[0].type === 'schedule' || nodes[0].type === 'webhook');
  if (!hasTrigger && nodes.length > 0) {
    execScore -= 15;
    execIssues.push('트리거 노드 없음');
    recommendedFixes.push('Schedule/Webhook 트리거를 추가하세요');
  }
  const exitTypes = new Set([
    'data-storage',
    'notification',
    'email-send',
    'slack-message',
    'log-monitor',
  ]);
  if (nodes.length > 0 && !exitTypes.has(nodes[nodes.length - 1].type)) {
    execScore -= 10;
    execIssues.push('종료 노드 없음');
  }
  const noFailure = nodes.filter((n) => !n.failureAction || n.failureAction === 'stop').length;
  if (noFailure > nodes.length * 0.5) {
    execScore -= 15;
    execIssues.push(`${noFailure}개 노드 실패 복구 없음`);
    recommendedFixes.push('주요 노드에 retry/fallback을 설정하세요');
  }
  if (nodes.length < 2) {
    execScore -= 20;
    execIssues.push('최소 노드 수 미달');
  }
  execScore = Math.max(0, Math.min(100, execScore));

  let connScore = 100;
  const connIssues: string[] = [];
  if (connectorGaps) {
    if (connectorGaps.missing.length > 0) {
      connScore -= connectorGaps.missing.length * 30;
      connIssues.push(`${connectorGaps.missing.length}개 커넥터 누락`);
      recommendedFixes.push(`누락 커넥터 설치: ${connectorGaps.missing.join(', ')}`);
    }
    if (connectorGaps.placeholder.length > 0) {
      connScore -= connectorGaps.placeholder.length * 10;
      connIssues.push(`${connectorGaps.placeholder.length}개 커넥터 설정 필요`);
    }
  } else {
    connScore = 70;
    connIssues.push('커넥터 분석 없음');
  }
  connScore = Math.max(0, Math.min(100, connScore));

  let polScore = 100;
  const polIssues: string[] = [];
  const riskyNodes = nodes.filter(
    (n) => RISKY_ACTION_TYPES.has(n.actionType) || HIGH_RISK_NODE_TYPES.has(n.type),
  );
  const coveredByPolicy =
    nodes.filter((n) => n.policyCheckpoint).length + policyResult.insertedCheckpoints.length;
  if (riskyNodes.length > 0) {
    const ratio = coveredByPolicy / riskyNodes.length;
    if (ratio < 1) {
      polScore -= Math.round((1 - ratio) * 40);
      polIssues.push(`위험 액션 ${riskyNodes.length}개 중 ${coveredByPolicy}개만 정책 적용`);
    }
  }
  const deployNoApproval = nodes.filter(
    (n) =>
      (n.actionType === 'deploy' || n.actionType === 'delete' || DEPLOY_DELETE_TYPES.has(n.type)) &&
      !n.humanApproval,
  );
  if (deployNoApproval.length > 0) {
    polScore -= deployNoApproval.length * 15;
    polIssues.push(`${deployNoApproval.length}개 배포/삭제 승인 없음`);
    recommendedFixes.push('배포/삭제 앞에 승인 노드를 추가하세요');
  }
  polScore = Math.max(0, Math.min(100, polScore));

  let usabScore = 100;
  const usabIssues: string[] = [];
  const hasNotif = nodes.some(
    (n) => n.type === 'notification' || n.type === 'slack-message' || n.type === 'email-send',
  );
  if (!hasNotif && nodes.length >= 3) {
    usabScore -= 20;
    usabIssues.push('운영자 알림 없음');
  }
  if (riskyNodes.length > 0 && !nodes.some((n) => n.humanApproval || n.type === 'wait-approval')) {
    usabScore -= 15;
    usabIssues.push('수동 개입 지점 없음');
  }
  usabScore = Math.max(0, Math.min(100, usabScore));

  let monScore = 100;
  const monIssues: string[] = [];
  if (!nodes.some((n) => n.connectorKey === 'metis-audit' || n.type === 'log-monitor')) {
    monScore -= 30;
    monIssues.push('감사 로그 없음');
    recommendedFixes.push('감사 로그 노드를 추가하세요');
  }
  if (!nodes.some((n) => n.connectorKey === 'metis-evidence') && nodes.length >= 5) {
    monScore -= 15;
    monIssues.push('Evidence Pack 없음');
  }
  if (!nodes.some((n) => n.type === 'log-monitor') && nodes.length >= 4) {
    monScore -= 15;
    monIssues.push('모니터링 연계 없음');
  }
  monScore = Math.max(0, Math.min(100, monScore));

  const overall = Math.round(
    execScore * 0.3 + connScore * 0.2 + polScore * 0.2 + usabScore * 0.15 + monScore * 0.15,
  );

  return {
    overall,
    band: scoreBand(overall),
    executionReadiness: { label: '실행 준비도', score: execScore, weight: 30, issues: execIssues },
    connectorValidity: { label: '커넥터 유효성', score: connScore, weight: 20, issues: connIssues },
    policyCoverage: { label: '정책 적용률', score: polScore, weight: 20, issues: polIssues },
    operatorUsability: { label: '운영자 사용성', score: usabScore, weight: 15, issues: usabIssues },
    monitoringVisibility: {
      label: '모니터링 가시성',
      score: monScore,
      weight: 15,
      issues: monIssues,
    },
    issues: [],
    recommendedFixes,
  };
}

// ═══════════════════════════════════════════════════════════
//  Local Engine — BH-7: Simulation (10-50 samples)
// ═══════════════════════════════════════════════════════════

export function runLocalSimulation(
  nodes: TemplateNode[],
  connectorGaps: {
    available: ConnectorContract[];
    placeholder: ConnectorContract[];
    missing: string[];
  } | null,
  policyResult: PolicyInjectionResult,
  structuralResult: StructuralValidationResult,
): SimulationMetrics {
  const riskyNodes = nodes.filter(
    (n) => RISKY_ACTION_TYPES.has(n.actionType) || HIGH_RISK_NODE_TYPES.has(n.type),
  );
  const branchNodes = nodes.filter(
    (n) =>
      n.type === 'condition' || n.type === 'branch' || n.type === 'if-else' || n.type === 'switch',
  );
  const missingCount = connectorGaps?.missing?.length || 0;
  const sampleCount = Math.min(
    50,
    Math.max(10, 10 + riskyNodes.length * 5 + branchNodes.length * 3 + missingCount * 2),
  );

  const missingConnectors = new Set(connectorGaps?.missing || []);
  const placeholderKeys = new Set((connectorGaps?.placeholder || []).map((c) => c.key));
  const hasTrigger =
    nodes.length > 0 && (nodes[0].type === 'schedule' || nodes[0].type === 'webhook');
  const exitTypes = new Set([
    'data-storage',
    'notification',
    'email-send',
    'slack-message',
    'log-monitor',
  ]);
  const hasExit = nodes.length > 0 && exitTypes.has(nodes[nodes.length - 1].type);
  const hasBlockingErrors = structuralResult.blockingErrors.length > 0;
  const uncoveredRiskyNodes = riskyNodes.filter((n) => !n.policyCheckpoint);
  const deployNoApproval = nodes.filter(
    (n) =>
      (n.actionType === 'deploy' || n.actionType === 'delete' || DEPLOY_DELETE_TYPES.has(n.type)) &&
      !n.humanApproval,
  );
  const nodesWithoutRetry = nodes.filter(
    (n) =>
      (n.actionType === 'write' || n.actionType === 'external-send') &&
      (!n.retryCount || n.retryCount === 0),
  );
  const branchesWithoutPredicate = branchNodes.filter((n) => {
    const s = n.settings || {};
    return !s.condition && !s.predicate && !s.expression;
  });

  let genOk = 0,
    execOk = 0,
    connMismatch = 0,
    polViolation = 0,
    humanEdit = 0;

  for (let i = 0; i < sampleCount; i++) {
    const seed = (i * 7 + 13) % 100;
    const generated = nodes.length > 0 && !hasBlockingErrors;
    if (generated) genOk++;

    let executable = generated;
    if (executable && !hasTrigger && seed < 80) executable = false;
    if (executable) {
      const nodeConn = nodes.filter((n) => n.connectorKey && missingConnectors.has(n.connectorKey));
      if (nodeConn.length > 0 && seed < (nodeConn.length / nodes.length) * 100 + 30)
        executable = false;
    }
    if (
      executable &&
      nodesWithoutRetry.length > 0 &&
      seed % 100 < Math.min(40, nodesWithoutRetry.length * 12) &&
      i > sampleCount * 0.6
    )
      executable = false;
    if (executable && branchesWithoutPredicate.length > 0 && seed < 60) executable = false;
    if (executable) execOk++;

    if (
      nodes.some(
        (n) =>
          n.connectorKey &&
          (missingConnectors.has(n.connectorKey) || placeholderKeys.has(n.connectorKey)),
      )
    )
      connMismatch++;

    if (
      (uncoveredRiskyNodes.length > 0 && seed < 40 + uncoveredRiskyNodes.length * 15) ||
      (deployNoApproval.length > 0 && seed < 60)
    )
      polViolation++;

    if (
      branchesWithoutPredicate.length > 0 ||
      (!hasExit && nodes.length >= 3) ||
      (policyResult.injectedNodeIds.length > 2 && seed < 50)
    )
      humanEdit++;
  }

  return {
    sampleCount,
    generationSuccessRate: Math.round((genOk / sampleCount) * 100),
    executionFeasibilityRate: Math.round((execOk / sampleCount) * 100),
    connectorMismatchRate: Math.round((connMismatch / sampleCount) * 100),
    policyViolationRisk: Math.round((polViolation / sampleCount) * 100),
    humanEditRate: Math.round((humanEdit / sampleCount) * 100),
  };
}

// ═══════════════════════════════════════════════════════════
//  Local Engine — BH-6: Repair
// ═══════════════════════════════════════════════════════════

export function applyRepair(nodes: TemplateNode[], action: RepairAction): TemplateNode[] {
  const result = [...nodes];
  switch (action.type) {
    case 'add-trigger': {
      result.unshift({
        id: `node-repair-trigger-${Date.now()}`,
        type: 'schedule',
        name: 'Schedule Trigger',
        icon: '⏰',
        color: '#FF6B6B',
        order: 0,
        actionType: 'read',
        failureAction: 'stop',
        description: 'Harness 자동 추가 트리거',
        outputKeys: ['trigger_event'],
        settings: {
          scheduleType: '즉시 실행',
          scheduleTime: '09:00',
          scheduleWeekday: '매일',
          timezone: 'Asia/Seoul',
        },
      });
      result.forEach((n, i) => {
        n.order = i + 1;
      });
      break;
    }
    case 'add-exit-node': {
      result.push({
        id: `node-repair-exit-${Date.now()}`,
        type: 'notification',
        name: '완료 알림',
        icon: '🔔',
        color: '#228B22',
        order: result.length + 1,
        actionType: 'write',
        failureAction: 'skip',
        description: 'Harness 자동 추가 종료',
        outputKeys: ['notification_sent'],
        settings: {
          notifyChannel: 'email',
          channel: 'email',
          recipientType: 'me',
          notifyTemplate: 'success',
          slackChannel: '#general',
          customRecipients: '',
          messageTemplate: '워크플로우 완료',
        },
      });
      break;
    }
    case 'add-monitor': {
      result.push({
        id: `node-repair-monitor-${Date.now()}`,
        type: 'log-monitor',
        name: '감사 로그 기록',
        icon: '📊',
        color: '#20B2AA',
        order: result.length + 1,
        connectorKey: 'metis-audit',
        actionType: 'write',
        failureAction: 'skip',
        description: 'Harness 자동 추가 감사 로그',
        outputKeys: ['audit_id'],
        settings: { logLevel: 'info', destination: 'audit' },
      });
      result.forEach((n, i) => {
        n.order = i + 1;
      });
      break;
    }
    case 'inject-retry': {
      if (action.nodeId) {
        const t = result.find((n) => n.id === action.nodeId);
        if (t) {
          t.failureAction = 'retry';
          t.retryCount = 2;
        }
      } else {
        for (const n of result) {
          if (
            (n.actionType === 'write' || n.actionType === 'external-send') &&
            (!n.retryCount || n.retryCount === 0)
          ) {
            n.failureAction = 'retry';
            n.retryCount = 2;
          }
        }
      }
      break;
    }
    case 'set-branch-predicate': {
      if (action.nodeId) {
        const t = result.find((n) => n.id === action.nodeId);
        if (t) {
          t.settings = {
            ...(t.settings || {}),
            condition: 'true',
            predicate: 'default',
            expression: 'true',
          };
        }
      }
      break;
    }
    case 'add-branch-paths': {
      if (action.nodeId) {
        const t = result.find((n) => n.id === action.nodeId);
        if (t) {
          t.outputKeys = [...(t.outputKeys || []), 'true', 'false'].filter(
            (v, i, a) => a.indexOf(v) === i,
          );
          t.settings = {
            ...(t.settings || {}),
            trueBranch: t.settings?.trueBranch || 'continue',
            falseBranch: t.settings?.falseBranch || 'skip',
          };
        }
      }
      break;
    }
    case 'add-approval': {
      if (action.nodeId) {
        const idx = result.findIndex((n) => n.id === action.nodeId);
        if (idx >= 0) {
          result.splice(idx, 0, {
            id: `node-repair-approval-${Date.now()}`,
            type: 'wait-approval',
            name: '관리자 승인',
            icon: '⏳',
            color: '#D62828',
            order: idx + 1,
            actionType: 'read',
            humanApproval: true,
            failureAction: 'stop',
            description: 'Harness 자동 추가 승인',
            outputKeys: ['approval_result'],
            settings: { waitType: 'approval', timeoutMinutes: 60 },
          });
          result.forEach((n, i) => {
            n.order = i + 1;
          });
        }
      }
      break;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
//  Unified Pipeline — runs locally or via API
// ═══════════════════════════════════════════════════════════

/**
 * Run the complete harness pipeline locally (no API required).
 * This is the primary entry point for the Builder UI.
 */
export function runHarness(
  nodes: TemplateNode[],
  template: WorkflowTemplate | null,
  connectorGaps: {
    available: ConnectorContract[];
    placeholder: ConnectorContract[];
    missing: string[];
  } | null,
): HarnessResult {
  const policyResult = injectPolicies(nodes, template?.policies || []);
  const structuralResult = validateStructure(nodes);
  const readiness = evaluateReadiness(
    nodes,
    template,
    connectorGaps,
    policyResult,
    structuralResult,
  );
  const simulation = runLocalSimulation(nodes, connectorGaps, policyResult, structuralResult);
  const allIssues: HarnessIssue[] = [
    ...policyResult.issues,
    ...structuralResult.blockingErrors,
    ...structuralResult.warnings,
  ];
  const hasBlocking = structuralResult.blockingErrors.length > 0;
  const hasWarnings =
    structuralResult.warnings.length > 0 ||
    policyResult.issues.some((i) => i.severity === 'warning');
  return {
    policyInjection: policyResult,
    structuralValidation: structuralResult,
    readinessScore: readiness,
    simulation,
    canSave: !hasBlocking,
    requiresAcknowledgement: !hasBlocking && hasWarnings,
    allIssues,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run the full harness pipeline via API (with tenant isolation and persistence).
 * Falls back to local engine if API is unavailable.
 */
export async function runHarnessViaApi(
  nodes: TemplateNode[],
  template: WorkflowTemplate | null,
  connectorGaps: {
    available: ConnectorContract[];
    placeholder: ConnectorContract[];
    missing: string[];
  } | null,
  userPrompt: string,
): Promise<HarnessResult & { requestId?: string }> {
  try {
    // Step 1: Create plan
    const planRes = await builderApi.createPlan(userPrompt, template?.id);
    const requestId = planRes.requestId;

    // Step 2: Check connectors
    if (template?.connectors && template.connectors.length > 0) {
      await builderApi.checkConnectors(requestId, template.connectors);
    }

    // Step 3: Validate
    const validateRes = await builderApi.validate(requestId, nodes);

    // Step 4: Eval preview
    const evalRes = await builderApi.evalPreview(requestId);

    return {
      requestId,
      policyInjection: validateRes.policyInjection,
      structuralValidation: validateRes.validation,
      readinessScore: evalRes.readinessScore,
      simulation: evalRes.simulation,
      canSave: evalRes.canSave,
      requiresAcknowledgement: evalRes.requiresAcknowledgement,
      allIssues: [
        ...validateRes.policyInjection.issues,
        ...validateRes.validation.blockingErrors,
        ...validateRes.validation.warnings,
      ],
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    // Fallback to local engine
    console.warn('Builder Harness API unavailable, falling back to local engine:', error);
    return runHarness(nodes, template, connectorGaps);
  }
}

/**
 * Convert Builder WorkflowNode → TemplateNode for harness analysis.
 */
export function builderNodesToTemplateNodes(
  builderNodes: Array<{
    id: string;
    type: string;
    name: string;
    order: number;
    settings: Record<string, any>;
  }>,
): TemplateNode[] {
  return builderNodes.map((n) => {
    let actionType: TemplateNode['actionType'] = 'read';
    switch (n.type) {
      case 'ai-processing':
      case 'data-transform':
        actionType = 'execute';
        break;
      case 'email-send':
      case 'slack-message':
        actionType = 'external-send';
        break;
      case 'git-deploy':
        actionType = 'deploy';
        break;
      case 'data-storage':
      case 'log-monitor':
      case 'file-operation':
      case 'notification':
        actionType = 'write';
        break;
    }
    return {
      id: n.id,
      type: n.type,
      name: n.name,
      icon: '',
      color: '',
      order: n.order,
      actionType,
      failureAction: n.settings?.failureAction || 'stop',
      retryCount: n.settings?.retryCount || 0,
      humanApproval: n.settings?.humanApproval || n.type === 'wait-approval',
      policyCheckpoint: n.settings?.policyCheckpoint,
      connectorKey: n.settings?.connectorKey,
      description: n.settings?.description || n.name,
      outputKeys: [],
      settings: n.settings || {},
    };
  });
}
