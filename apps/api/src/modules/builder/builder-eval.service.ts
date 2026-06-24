/**
 * Builder Eval Service (BH-5 + BH-6)
 *
 * Responsibilities:
 *   - BH-5: Readiness scoring (5-axis evaluation, 0-100 weighted)
 *   - BH-6: Save/Repair loop — enforce save policies, apply one-click repairs
 *   - Persist eval results and repair actions
 */
import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { BuilderValidationService } from './builder-validation.service';
import type {
  BuilderEvalPreviewRequest,
  BuilderEvalPreviewResponse,
  BuilderSaveRequest,
  BuilderSaveResponse,
  BuilderRepairRequest,
  BuilderRepairResponse,
  HarnessTemplateNode,
  ReadinessScore,
  ReadinessSubScore,
  ReadinessBand,
  HarnessIssue,
  ConnectorGapEntry,
  PolicyInjectionResult,
  StructuralValidationResult,
} from '@metis/types';

/** Simulation result for a single sample run */
interface SimulationSample {
  sampleId: number;
  generated: boolean; // 생성 성공 여부
  executable: boolean; // 실행 가능 여부
  connectorMismatch: boolean; // 커넥터 불일치
  policyViolation: boolean; // 정책 위반
  humanEditNeeded: boolean; // 사람 수정 필요
  failureReason?: string;
}

/** Aggregated simulation metrics (5 metrics) */
export interface SimulationMetrics {
  sampleCount: number;
  generationSuccessRate: number; // 생성 성공률 (0-100)
  executionFeasibilityRate: number; // 실행 가능률 (0-100)
  connectorMismatchRate: number; // connector mismatch (0-100)
  policyViolationRisk: number; // policy violation risk (0-100)
  humanEditRate: number; // human edit 필요도 (0-100)
  samples: SimulationSample[];
}

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

@Injectable()
export class BuilderEvalService {
  private readonly logger = new Logger(BuilderEvalService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly validationService: BuilderValidationService,
  ) {}

  // ═══════════════════════════════════════════
  //  BH-5: Preview Eval / Readiness Scoring
  // ═══════════════════════════════════════════

  /**
   * POST /builder/eval/preview
   * Compute readiness score from persisted plan + validation + connector gaps.
   */
  async evalPreview(
    ctx: TenantContext,
    dto: BuilderEvalPreviewRequest,
  ): Promise<BuilderEvalPreviewResponse> {
    const db = withTenantIsolation(this.prisma, ctx);

    const request = await db.builderRequest.findUnique({
      where: { id: dto.requestId },
      include: {
        plan: true,
        connectorGaps: true,
        validationResult: true,
      },
    });
    if (!request) throw new NotFoundException('Builder request not found');

    const nodes = (request.plan?.nodesJson as HarnessTemplateNode[] | null) || [];
    const connectorGaps = (request.connectorGaps || []).map((g: any) => ({
      connectorKey: g.connectorKey,
      connectorName: g.connectorName,
      tier: g.tier,
      status: g.status,
      requiredSecrets: g.requiredSecrets || [],
    })) as ConnectorGapEntry[];

    const validationIssues = (request.validationResult?.issuesJson as HarnessIssue[] | null) || [];
    const blockingErrors = validationIssues.filter((i) => i.severity === 'blocking');
    const warnings = validationIssues.filter((i) => i.severity === 'warning');

    // Run policy injection analysis
    const policyResult = this.validationService.injectPolicies(nodes);

    const structuralResult: StructuralValidationResult = {
      blockingErrors,
      warnings,
      repairActions: [],
      isValid: blockingErrors.length === 0,
      canSaveWithWarnings: blockingErrors.length === 0 && warnings.length > 0,
    };

    // Compute readiness score
    const readiness = this.computeReadiness(nodes, connectorGaps, policyResult, structuralResult);

    // Run simulation (10-50 samples)
    const simulation = this.runSimulation(nodes, connectorGaps, policyResult, structuralResult);

    const canSave = blockingErrors.length === 0;
    const requiresAcknowledgement = canSave && warnings.length > 0;

    // Persist eval result
    await this.prisma.builderEvalResult.upsert({
      where: { requestId: dto.requestId },
      create: {
        requestId: dto.requestId,
        overallScore: readiness.overall,
        band: readiness.band.toUpperCase() as any,
        executionReadiness: readiness.executionReadiness.score,
        connectorValidity: readiness.connectorValidity.score,
        policyCoverage: readiness.policyCoverage.score,
        operatorUsability: readiness.operatorUsability.score,
        monitoringVisibility: readiness.monitoringVisibility.score,
        subScoresJson: [
          readiness.executionReadiness,
          readiness.connectorValidity,
          readiness.policyCoverage,
          readiness.operatorUsability,
          readiness.monitoringVisibility,
        ] as any,
        issuesJson: readiness.issues as any,
        recommendedFixes: readiness.recommendedFixes as any,
        canSave,
        requiresAcknowledgement,
        simulationJson: {
          sampleCount: simulation.sampleCount,
          generationSuccessRate: simulation.generationSuccessRate,
          executionFeasibilityRate: simulation.executionFeasibilityRate,
          connectorMismatchRate: simulation.connectorMismatchRate,
          policyViolationRisk: simulation.policyViolationRisk,
          humanEditRate: simulation.humanEditRate,
        } as any,
      },
      update: {
        overallScore: readiness.overall,
        band: readiness.band.toUpperCase() as any,
        executionReadiness: readiness.executionReadiness.score,
        connectorValidity: readiness.connectorValidity.score,
        policyCoverage: readiness.policyCoverage.score,
        operatorUsability: readiness.operatorUsability.score,
        monitoringVisibility: readiness.monitoringVisibility.score,
        subScoresJson: [
          readiness.executionReadiness,
          readiness.connectorValidity,
          readiness.policyCoverage,
          readiness.operatorUsability,
          readiness.monitoringVisibility,
        ] as any,
        issuesJson: readiness.issues as any,
        recommendedFixes: readiness.recommendedFixes as any,
        canSave,
        requiresAcknowledgement,
        simulationJson: {
          sampleCount: simulation.sampleCount,
          generationSuccessRate: simulation.generationSuccessRate,
          executionFeasibilityRate: simulation.executionFeasibilityRate,
          connectorMismatchRate: simulation.connectorMismatchRate,
          policyViolationRisk: simulation.policyViolationRisk,
          humanEditRate: simulation.humanEditRate,
        } as any,
      },
    });

    // Update request status
    await this.prisma.builderRequest.update({
      where: { id: dto.requestId },
      data: { status: 'EVALUATED', evalDoneAt: new Date() },
    });

    this.logger.log(
      `Eval preview for ${dto.requestId}: score=${readiness.overall}, band=${readiness.band}, canSave=${canSave}`,
    );

    return {
      requestId: dto.requestId,
      readinessScore: readiness,
      simulation: {
        sampleCount: simulation.sampleCount,
        generationSuccessRate: simulation.generationSuccessRate,
        executionFeasibilityRate: simulation.executionFeasibilityRate,
        connectorMismatchRate: simulation.connectorMismatchRate,
        policyViolationRisk: simulation.policyViolationRisk,
        humanEditRate: simulation.humanEditRate,
      },
      canSave,
      requiresAcknowledgement,
    };
  }

  // ═══════════════════════════════════════════
  //  BH-6: Save (with policy enforcement)
  // ═══════════════════════════════════════════

  /**
   * POST /builder/save
   * Enforce save policy: block if blocking errors exist; require acknowledgement for warnings.
   */
  async save(ctx: TenantContext, dto: BuilderSaveRequest): Promise<BuilderSaveResponse> {
    const db = withTenantIsolation(this.prisma, ctx);

    const request = await db.builderRequest.findUnique({
      where: { id: dto.requestId },
      include: { evalResult: true, validationResult: true, plan: true },
    });
    if (!request) throw new NotFoundException('Builder request not found');

    // Check eval result exists
    if (!request.evalResult) {
      throw new BadRequestException(
        'Eval has not been run yet. Call POST /builder/eval/preview first.',
      );
    }

    // Enforce save policy: blocking errors
    if (!request.evalResult.canSave) {
      return {
        requestId: dto.requestId,
        saved: false,
        workflowId: null,
        reason: '차단 오류가 있습니다. 수정 후 다시 시도하세요.',
        readinessScore: request.evalResult.overallScore,
      };
    }

    // Enforce save policy: warnings require acknowledgement
    if (request.evalResult.requiresAcknowledgement && !dto.acknowledgeWarnings) {
      return {
        requestId: dto.requestId,
        saved: false,
        workflowId: null,
        reason: '경고사항을 확인(acknowledgeWarnings)해야 저장할 수 있습니다.',
        readinessScore: request.evalResult.overallScore,
      };
    }

    // Create audit log for save
    await this.prisma.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        action: 'EXECUTE',
        targetType: 'BuilderRequest',
        targetId: dto.requestId,
        actorUserId: ctx.userId,
        correlationId: dto.requestId,
        metadataJson: {
          type: 'builder_save',
          workflowName: dto.workflowName,
          readinessScore: request.evalResult.overallScore,
          band: request.evalResult.band,
          acknowledged: dto.acknowledgeWarnings || false,
        },
      },
    });

    // Update request status
    await this.prisma.builderRequest.update({
      where: { id: dto.requestId },
      data: { status: 'SAVED', savedAt: new Date() },
    });

    const workflowId = `wf-saved-${Date.now()}`;

    this.logger.log(
      `Builder save: ${dto.requestId} as "${dto.workflowName}", score=${request.evalResult.overallScore}`,
    );

    return {
      requestId: dto.requestId,
      saved: true,
      workflowId,
      readinessScore: request.evalResult.overallScore,
    };
  }

  // ═══════════════════════════════════════════
  //  BH-6: Repair
  // ═══════════════════════════════════════════

  /**
   * POST /builder/repair
   * Apply a single repair action, re-validate, and re-score.
   */
  async repair(ctx: TenantContext, dto: BuilderRepairRequest): Promise<BuilderRepairResponse> {
    const db = withTenantIsolation(this.prisma, ctx);

    const request = await db.builderRequest.findUnique({
      where: { id: dto.requestId },
      include: { plan: true, validationResult: true },
    });
    if (!request) throw new NotFoundException('Builder request not found');
    if (!request.plan) throw new BadRequestException('No plan exists for this request');

    const currentNodes = (request.plan.nodesJson as unknown as HarnessTemplateNode[]) || [];
    const validationIssues =
      (request.validationResult?.issuesJson as unknown as HarnessIssue[] | null) || [];

    // Find the repair action from validation result
    const allRepairActions = validationIssues
      .filter((i) => i.repairAction)
      .map((i) => i.repairAction!);
    const repairAction = allRepairActions.find((a) => a.id === dto.repairActionId);

    if (!repairAction) {
      throw new NotFoundException(`Repair action ${dto.repairActionId} not found`);
    }

    // Apply repair
    const updatedNodes = this.applyRepairAction(currentNodes, repairAction);

    // Re-validate
    const newValidation = this.validationService.validateStructure(updatedNodes);

    // Compute new readiness
    const policyResult = this.validationService.injectPolicies(updatedNodes);
    const connectorGaps: ConnectorGapEntry[] = [];
    const newReadiness = this.computeReadiness(
      updatedNodes,
      connectorGaps,
      policyResult,
      newValidation,
    );

    // Persist updated plan
    await this.prisma.builderPlan.update({
      where: { requestId: dto.requestId },
      data: { nodesJson: updatedNodes as any },
    });

    // Persist repair action record
    await this.prisma.builderRepairAction.create({
      data: {
        requestId: dto.requestId,
        repairType: repairAction.type,
        label: repairAction.label,
        description: repairAction.description,
        targetNodeId: repairAction.nodeId,
        applied: true,
        appliedAt: new Date(),
        resultJson: {
          previousNodeCount: currentNodes.length,
          newNodeCount: updatedNodes.length,
          newReadinessScore: newReadiness.overall,
        },
      },
    });

    // Update request status
    await this.prisma.builderRequest.update({
      where: { id: dto.requestId },
      data: { status: 'REPAIR_LOOP' },
    });

    this.logger.log(
      `Repair applied: ${repairAction.type} on ${dto.requestId}, new score=${newReadiness.overall}`,
    );

    return {
      requestId: dto.requestId,
      applied: true,
      repairType: repairAction.type,
      updatedNodes,
      newValidation,
      newReadinessScore: newReadiness,
    };
  }

  // ═══════════════════════════════════════════
  //  BH-7: Simulation Engine (10-50 samples)
  // ═══════════════════════════════════════════

  /**
   * Run 10-50 simulated sample inputs against the workflow to produce 5 key metrics.
   * Sample count scales with workflow complexity.
   */
  private runSimulation(
    nodes: HarnessTemplateNode[],
    connectorGaps: ConnectorGapEntry[],
    policyResult: PolicyInjectionResult,
    structuralResult: StructuralValidationResult,
  ): SimulationMetrics {
    // Determine sample count: base 10, +5 per risky node, +3 per branch, +2 per connector gap, capped at 50
    const riskyNodes = nodes.filter(
      (n) => RISKY_ACTION_TYPES.has(n.actionType as any) || HIGH_RISK_NODE_TYPES.has(n.type),
    );
    const branchNodes = nodes.filter(
      (n) =>
        n.type === 'condition' ||
        n.type === 'branch' ||
        n.type === 'if-else' ||
        n.type === 'switch',
    );
    const sampleCount = Math.min(
      50,
      Math.max(10, 10 + riskyNodes.length * 5 + branchNodes.length * 3 + connectorGaps.length * 2),
    );

    // Pre-compute structural properties for simulation
    const missingConnectors = new Set(
      connectorGaps.filter((g) => g.status === 'missing').map((g) => g.connectorKey),
    );
    const placeholderConnectors = new Set(
      connectorGaps.filter((g) => g.status === 'placeholder').map((g) => g.connectorKey),
    );
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
        (n.actionType === 'deploy' ||
          n.actionType === 'delete' ||
          DEPLOY_DELETE_TYPES.has(n.type)) &&
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

    const samples: SimulationSample[] = [];

    for (let i = 0; i < sampleCount; i++) {
      // Each sample simulates a different execution scenario with probabilistic variation
      const variationSeed = (i * 7 + 13) % 100; // deterministic pseudo-random for reproducibility

      // 1. Generation success: fails if no nodes, or blocking errors exist
      const generated = nodes.length > 0 && !hasBlockingErrors;

      // 2. Execution feasibility: depends on trigger, exit, retry, connectors
      let executable = generated;
      let failureReason: string | undefined;

      if (executable) {
        // No trigger → 80% chance of failure in simulation
        if (!hasTrigger && variationSeed < 80) {
          executable = false;
          failureReason = '트리거 노드 누락으로 실행 불가';
        }
        // Missing connector → proportional failure rate
        if (executable) {
          const nodeConnectors = nodes.filter(
            (n) => n.connectorKey && missingConnectors.has(n.connectorKey),
          );
          if (
            nodeConnectors.length > 0 &&
            variationSeed < (nodeConnectors.length / nodes.length) * 100 + 30
          ) {
            executable = false;
            failureReason = `커넥터 누락: ${nodeConnectors[0].connectorKey}`;
          }
        }
        // Nodes without retry on external actions → intermittent failure simulation
        if (executable && nodesWithoutRetry.length > 0) {
          const failProb = Math.min(40, nodesWithoutRetry.length * 12);
          if (variationSeed % 100 < failProb && i > sampleCount * 0.6) {
            executable = false;
            failureReason = `retry 미설정 노드에서 간헐적 실패 (${nodesWithoutRetry[0].name})`;
          }
        }
        // Branch without predicate → uncertain path
        if (executable && branchesWithoutPredicate.length > 0 && variationSeed < 60) {
          executable = false;
          failureReason = `분기 조건 미정의: ${branchesWithoutPredicate[0].name}`;
        }
      }

      // 3. Connector mismatch
      const connectorMismatch = nodes.some(
        (n) =>
          n.connectorKey &&
          (missingConnectors.has(n.connectorKey) || placeholderConnectors.has(n.connectorKey)),
      );

      // 4. Policy violation: risky nodes without coverage or deploy without approval
      const policyViolation =
        (uncoveredRiskyNodes.length > 0 && variationSeed < 40 + uncoveredRiskyNodes.length * 15) ||
        (deployNoApproval.length > 0 && variationSeed < 60);

      // 5. Human edit needed: complex branches, missing params, or unclear flow
      const humanEditNeeded =
        branchesWithoutPredicate.length > 0 ||
        (!hasExit && nodes.length >= 3) ||
        (policyResult.injectedNodeIds.length > 2 && variationSeed < 50);

      samples.push({
        sampleId: i + 1,
        generated,
        executable,
        connectorMismatch,
        policyViolation,
        humanEditNeeded,
        failureReason,
      });
    }

    // Aggregate metrics
    const generationSuccessRate = Math.round(
      (samples.filter((s) => s.generated).length / sampleCount) * 100,
    );
    const executionFeasibilityRate = Math.round(
      (samples.filter((s) => s.executable).length / sampleCount) * 100,
    );
    const connectorMismatchRate = Math.round(
      (samples.filter((s) => s.connectorMismatch).length / sampleCount) * 100,
    );
    const policyViolationRisk = Math.round(
      (samples.filter((s) => s.policyViolation).length / sampleCount) * 100,
    );
    const humanEditRate = Math.round(
      (samples.filter((s) => s.humanEditNeeded).length / sampleCount) * 100,
    );

    this.logger.log(
      `Simulation complete: ${sampleCount} samples, gen=${generationSuccessRate}%, exec=${executionFeasibilityRate}%, ` +
        `connMismatch=${connectorMismatchRate}%, policyRisk=${policyViolationRisk}%, humanEdit=${humanEditRate}%`,
    );

    return {
      sampleCount,
      generationSuccessRate,
      executionFeasibilityRate,
      connectorMismatchRate,
      policyViolationRisk,
      humanEditRate,
      samples,
    };
  }

  // ═══════════════════════════════════════════
  //  Private: Readiness Scoring Engine
  // ═══════════════════════════════════════════

  private computeReadiness(
    nodes: HarnessTemplateNode[],
    connectorGaps: ConnectorGapEntry[],
    policyResult: PolicyInjectionResult,
    structuralResult: StructuralValidationResult,
  ): ReadinessScore {
    const recommendedFixes: string[] = [];

    // Axis 1: Execution Readiness (30%)
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
      recommendedFixes.push('주요 노드에 retry/fallback 설정하세요');
    }
    if (nodes.length < 2) {
      execScore -= 20;
      execIssues.push('최소 노드 수 미달');
    }
    execScore = Math.max(0, Math.min(100, execScore));

    // Axis 2: Connector Validity (20%)
    let connScore = 100;
    const connIssues: string[] = [];
    if (connectorGaps.length > 0) {
      const missing = connectorGaps.filter((g) => g.status === 'missing').length;
      const placeholder = connectorGaps.filter((g) => g.status === 'placeholder').length;
      if (missing > 0) {
        connScore -= missing * 30;
        connIssues.push(`${missing}개 커넥터 누락`);
        recommendedFixes.push('누락된 커넥터를 설치하세요');
      }
      if (placeholder > 0) {
        connScore -= placeholder * 10;
        connIssues.push(`${placeholder}개 커넥터 설정 필요`);
      }
    } else {
      connScore = 70;
      connIssues.push('커넥터 분석 없음');
    }
    connScore = Math.max(0, Math.min(100, connScore));

    // Axis 3: Policy Coverage (20%)
    let polScore = 100;
    const polIssues: string[] = [];
    const riskyNodes = nodes.filter(
      (n) => RISKY_ACTION_TYPES.has(n.actionType as any) || HIGH_RISK_NODE_TYPES.has(n.type),
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
        (n.actionType === 'deploy' ||
          n.actionType === 'delete' ||
          DEPLOY_DELETE_TYPES.has(n.type)) &&
        !n.humanApproval,
    );
    if (deployNoApproval.length > 0) {
      polScore -= deployNoApproval.length * 15;
      polIssues.push(`${deployNoApproval.length}개 배포/삭제 승인 없음`);
      recommendedFixes.push('배포/삭제 앞에 승인 노드를 추가하세요');
    }
    polScore = Math.max(0, Math.min(100, polScore));

    // Axis 4: Operator Usability (15%)
    let usabScore = 100;
    const usabIssues: string[] = [];
    const hasNotif = nodes.some(
      (n) => n.type === 'notification' || n.type === 'slack-message' || n.type === 'email-send',
    );
    if (!hasNotif && nodes.length >= 3) {
      usabScore -= 20;
      usabIssues.push('운영자 알림 없음');
    }
    const hasApproval = nodes.some((n) => n.humanApproval || n.type === 'wait-approval');
    if (riskyNodes.length > 0 && !hasApproval) {
      usabScore -= 15;
      usabIssues.push('수동 개입 지점 없음');
    }
    usabScore = Math.max(0, Math.min(100, usabScore));

    // Axis 5: Monitoring Visibility (15%)
    let monScore = 100;
    const monIssues: string[] = [];
    const hasAudit = nodes.some(
      (n) => n.connectorKey === 'metis-audit' || n.type === 'log-monitor',
    );
    if (!hasAudit) {
      monScore -= 30;
      monIssues.push('감사 로그 없음');
      recommendedFixes.push('감사 로그 노드를 추가하세요');
    }
    const hasEvidence = nodes.some((n) => n.connectorKey === 'metis-evidence');
    if (!hasEvidence && nodes.length >= 5) {
      monScore -= 15;
      monIssues.push('Evidence Pack 없음');
    }
    const hasMonitor = nodes.some((n) => n.type === 'log-monitor');
    if (!hasMonitor && nodes.length >= 4) {
      monScore -= 15;
      monIssues.push('모니터링 연계 없음');
    }
    monScore = Math.max(0, Math.min(100, monScore));

    const overall = Math.round(
      execScore * 0.3 + connScore * 0.2 + polScore * 0.2 + usabScore * 0.15 + monScore * 0.15,
    );

    const band: ReadinessBand =
      overall >= 90
        ? 'excellent'
        : overall >= 75
          ? 'good'
          : overall >= 55
            ? 'fair'
            : overall >= 35
              ? 'poor'
              : 'critical';

    return {
      overall,
      band,
      executionReadiness: {
        label: '실행 준비도',
        score: execScore,
        weight: 30,
        issues: execIssues,
      },
      connectorValidity: {
        label: '커넥터 유효성',
        score: connScore,
        weight: 20,
        issues: connIssues,
      },
      policyCoverage: { label: '정책 적용률', score: polScore, weight: 20, issues: polIssues },
      operatorUsability: {
        label: '운영자 사용성',
        score: usabScore,
        weight: 15,
        issues: usabIssues,
      },
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

  // ═══════════════════════════════════════════
  //  Private: Repair Action Application
  // ═══════════════════════════════════════════

  private applyRepairAction(nodes: HarnessTemplateNode[], action: any): HarnessTemplateNode[] {
    const result = [...nodes];

    switch (action.type) {
      case 'add-trigger': {
        const trigger: HarnessTemplateNode = {
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
        };
        result.unshift(trigger);
        result.forEach((n, i) => {
          n.order = i + 1;
        });
        break;
      }
      case 'add-exit-node': {
        const exit: HarnessTemplateNode = {
          id: `node-repair-exit-${Date.now()}`,
          type: 'notification',
          name: '완료 알림',
          icon: '🔔',
          color: '#228B22',
          order: result.length + 1,
          actionType: 'write',
          failureAction: 'skip',
          description: 'Harness 자동 추가 종료 노드',
          outputKeys: ['notification_sent'],
          settings: { channel: 'push', recipient: '', messageTemplate: '워크플로우 완료' },
        };
        result.push(exit);
        break;
      }
      case 'add-monitor': {
        const mon: HarnessTemplateNode = {
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
        };
        result.push(mon);
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
            const approval: HarnessTemplateNode = {
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
            };
            result.splice(idx, 0, approval);
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
}
