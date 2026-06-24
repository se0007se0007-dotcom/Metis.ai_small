/**
 * Builder Validation Service (BH-3 + BH-4)
 *
 * Responsibilities:
 *   - BH-3: Policy/Approval injection for risky actions
 *   - BH-4: Structural graph validation
 *   - Persist validation results
 */
import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import type {
  BuilderValidateRequest,
  BuilderValidateResponse,
  HarnessTemplateNode,
  HarnessIssue,
  RepairAction,
  PolicyCheckpoint,
  PolicyInjectionResult,
  StructuralValidationResult,
  NodeActionType,
} from '@metis/types';

const RISKY_ACTION_TYPES = new Set<NodeActionType>(['deploy', 'delete', 'external-send', 'write']);
const HIGH_RISK_NODE_TYPES = new Set([
  'git-deploy',
  'email-send',
  'slack-message',
  'notification',
  'api-call',
  'webhook',
]);
const DEPLOY_DELETE_TYPES = new Set(['git-deploy']);

@Injectable()
export class BuilderValidationService {
  private readonly logger = new Logger(BuilderValidationService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * POST /builder/validate
   * Run BH-3 (policy injection) + BH-4 (structural validation).
   */
  async validate(
    ctx: TenantContext,
    dto: BuilderValidateRequest,
  ): Promise<BuilderValidateResponse> {
    const db = withTenantIsolation(this.prisma, ctx);

    const request = await db.builderRequest.findUnique({ where: { id: dto.requestId } });
    if (!request) throw new NotFoundException('Builder request not found');

    // BH-3: Policy Injection
    const policyResult = this.injectPolicies(dto.nodes);

    // BH-4: Structural Validation
    const validation = this.validateStructure(dto.nodes);

    // Persist validation result
    await this.prisma.builderValidationResult.upsert({
      where: { requestId: dto.requestId },
      create: {
        requestId: dto.requestId,
        isValid: validation.isValid,
        canSaveWithWarnings: validation.canSaveWithWarnings,
        blockingErrorCount: validation.blockingErrors.length,
        warningCount: validation.warnings.length,
        issuesJson: [...validation.blockingErrors, ...validation.warnings] as any,
        repairActionsJson: validation.repairActions as any,
      },
      update: {
        isValid: validation.isValid,
        canSaveWithWarnings: validation.canSaveWithWarnings,
        blockingErrorCount: validation.blockingErrors.length,
        warningCount: validation.warnings.length,
        issuesJson: [...validation.blockingErrors, ...validation.warnings] as any,
        repairActionsJson: validation.repairActions as any,
      },
    });

    // Update request status
    await this.prisma.builderRequest.update({
      where: { id: dto.requestId },
      data: { status: 'VALIDATING', validationDoneAt: new Date() },
    });

    this.logger.log(
      `Validation complete for ${dto.requestId}: valid=${validation.isValid}, ` +
        `blocking=${validation.blockingErrors.length}, warnings=${validation.warnings.length}`,
    );

    return {
      requestId: dto.requestId,
      validation,
      policyInjection: policyResult,
    };
  }

  // ═══════════════════════════════════════════
  //  BH-3: Policy / Approval Injector
  // ═══════════════════════════════════════════

  injectPolicies(nodes: HarnessTemplateNode[]): PolicyInjectionResult {
    const issues: HarnessIssue[] = [];
    const insertedCheckpoints: PolicyCheckpoint[] = [];
    const injectedNodeIds: string[] = [];

    const coveredNodeIds = new Set(nodes.filter((n) => n.policyCheckpoint).map((n) => n.id));
    const approvalNodeIds = new Set(nodes.filter((n) => n.humanApproval).map((n) => n.id));

    for (const node of nodes) {
      const isRisky =
        RISKY_ACTION_TYPES.has(node.actionType) || HIGH_RISK_NODE_TYPES.has(node.type);
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
        const checkpoint: PolicyCheckpoint = {
          id: `pol-auto-${node.id}`,
          name: `${node.name} 실행 전 정책 점검`,
          when: `${node.name} 실행 전`,
          riskLevel: isDeploy ? 'critical' : isExternalSend ? 'high' : 'medium',
          action: isDeploy ? 'block' : 'warn',
          description: `위험 액션(${node.actionType}) 실행 전 거버넌스 정책 확인 필요`,
        };
        insertedCheckpoints.push(checkpoint);
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
          description: `배포/삭제 액션은 프로덕션 환경에서 관리자 승인을 필요로 합니다.`,
          repairAction: {
            id: `repair-approval-${node.id}`,
            type: 'add-approval',
            label: '승인 노드 추가',
            description: `${node.name} 앞에 관리자 승인 노드를 추가합니다.`,
            autoApplicable: true,
            nodeId: node.id,
          },
        });
      }
    }

    return { insertedCheckpoints, injectedNodeIds, issues };
  }

  // ═══════════════════════════════════════════
  //  BH-4: Structural Validator
  // ═══════════════════════════════════════════

  validateStructure(nodes: HarnessTemplateNode[]): StructuralValidationResult {
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
        repairAction: {
          id: 'repair-add-trigger',
          type: 'add-trigger',
          label: '트리거 노드 추가',
          description: '워크플로우 시작을 위한 트리거 노드를 추가합니다.',
          autoApplicable: false,
        },
      });
      return {
        blockingErrors,
        warnings,
        repairActions,
        isValid: false,
        canSaveWithWarnings: false,
      };
    }

    // 1. Trigger node check
    const triggerTypes = new Set(['schedule', 'webhook']);
    if (!triggerTypes.has(nodes[0].type)) {
      const action: RepairAction = {
        id: 'repair-add-trigger',
        type: 'add-trigger',
        label: '트리거 노드 추가',
        description: '워크플로우 앞에 Schedule 트리거를 추가합니다.',
        autoApplicable: true,
        payload: { position: 0, type: 'schedule' },
      };
      warnings.push({
        id: 'warn-no-trigger',
        severity: 'warning',
        category: 'structure',
        nodeId: nodes[0].id,
        message: '트리거 노드가 없습니다',
        description: '워크플로우 시작이 Schedule/Webhook이 아닙니다.',
        repairAction: action,
      });
      repairActions.push(action);
    }

    // 2. Exit node check
    const exitTypes = new Set([
      'data-storage',
      'notification',
      'email-send',
      'slack-message',
      'log-monitor',
    ]);
    const lastNode = nodes[nodes.length - 1];
    if (!exitTypes.has(lastNode.type)) {
      warnings.push({
        id: 'warn-no-exit',
        severity: 'warning',
        category: 'structure',
        nodeId: lastNode.id,
        message: '명시적 종료/출력 노드가 없습니다',
        description: '마지막 노드가 결과 전달 노드가 아닙니다.',
        repairAction: {
          id: 'repair-add-exit',
          type: 'add-exit-node',
          label: '종료 노드 추가',
          description: '알림/저장 노드를 마지막에 추가합니다.',
          autoApplicable: true,
        },
      });
    }

    // 3. Failure paths
    const noFailure = nodes.filter((n) => !n.failureAction || n.failureAction === 'stop').length;
    if (noFailure > nodes.length * 0.5) {
      warnings.push({
        id: 'warn-no-failure-paths',
        severity: 'warning',
        category: 'resilience',
        message: `${noFailure}개 노드에 실패 복구 경로가 없습니다`,
        description: 'retry/fallback 설정을 권장합니다.',
        repairAction: {
          id: 'repair-add-retry',
          type: 'inject-retry',
          label: 'Retry 설정 추가',
          description: '주요 노드에 retry(2회) 설정',
          autoApplicable: true,
        },
      });
    }

    // 4. Retry on critical write/external-send nodes
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
        message: `"${cn.name}"에 retry 설정이 없습니다`,
        description: `쓰기/외부전송 노드는 retry 설정을 권장합니다.`,
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

    // 5. Monitoring / audit node
    const hasAuditNode = nodes.some(
      (n) =>
        n.connectorKey === 'metis-audit' || n.type === 'log-monitor' || n.type === 'data-storage',
    );
    if (!hasAuditNode && nodes.length >= 3) {
      warnings.push({
        id: 'warn-no-monitoring',
        severity: 'warning',
        category: 'observability',
        message: '감사 로그/모니터링 노드가 없습니다',
        description: '감사 로그 또는 모니터링 노드 추가를 권장합니다.',
        repairAction: {
          id: 'repair-add-monitor',
          type: 'add-monitor',
          label: '감사 로그 노드 추가',
          description: '워크플로우 끝에 감사 로그 기록 노드 추가',
          autoApplicable: true,
        },
      });
    }

    // 6. Branch condition validation
    const branchNodes = nodes.filter(
      (n) =>
        n.type === 'condition' ||
        n.type === 'branch' ||
        n.type === 'if-else' ||
        n.type === 'switch',
    );
    for (const bn of branchNodes) {
      // Check predicate is defined
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

      // Check true/false paths exist (branches should have outputKeys for each path)
      const hasTrue =
        bn.settings?.trueBranch ||
        bn.outputKeys?.includes('true') ||
        bn.outputKeys?.includes('yes');
      const hasFalse =
        bn.settings?.falseBranch ||
        bn.outputKeys?.includes('false') ||
        bn.outputKeys?.includes('no');
      if (!hasTrue || !hasFalse) {
        const missingPaths: string[] = [];
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

    // 7. Notify-only flow check
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
        message: '실행/처리 노드 없이 알림만 있는 워크플로우입니다',
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
}
