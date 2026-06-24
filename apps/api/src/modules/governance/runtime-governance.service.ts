/**
 * RuntimeGovernanceService — Patent 1 핵심 오케스트레이터.
 *
 * 노드 실행 직후(평가 직후) 호출되어:
 *   1. NodeGovernanceProfiler  — 노드 거버넌스 프로파일 확보
 *   2. EvaluationResult → 정규화된 5-gate 점수 변환
 *      (내부 workflow / 외부 SDK ingest 모두 동일 schema — 종속청구항 2)
 *   3. PolicyDecisionEngine    — ALLOW…QUARANTINE 판정 + 영속화
 *   4. FDSAlertBridge          — 위반/이상 → FDSAlert
 *   5. AutoActionSelector      — 자동 조치 실행/기록
 *   6. EvidencePackService     — 해시체인 증거팩 생성
 *
 * 평가 실패는 파이프라인을 절대 막지 않지만(best-effort), BLOCK /
 * QUARANTINE / REQUIRE_APPROVAL 판정은 haltPipeline=true 로 후속
 * 노드 실행을 중단시킨다 (실행 중 자동 차단 — 독립청구항).
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import type { EvaluationResult } from '../evaluator/evaluator.service';
import {
  GateResults,
  GovernanceDecisionResult,
  RuntimeGovernanceContext,
} from './governance-core.types';
import { NodeGovernanceProfilerService } from './node-governance-profiler.service';
import { PolicyDecisionEngine } from './policy-decision.engine';
import { FdsAlertBridgeService } from './fds-alert-bridge.service';
import { AutoActionSelectorService, AutoActionDirective } from './auto-action-selector.service';
import { EvidencePackService } from './evidence-pack.service';
import { PolicyContextService } from './policy-context.service';

export interface GovernedStepResult {
  decision: GovernanceDecisionResult;
  gateResults: GateResults;
  fdsAlertIds: string[];
  autoAction: AutoActionDirective;
  evidencePackId: string | null;
  haltPipeline: boolean;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

@Injectable()
export class RuntimeGovernanceService {
  private readonly logger = new Logger(RuntimeGovernanceService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prismaClient: PrismaClient,
    private readonly profiler: NodeGovernanceProfilerService,
    private readonly decisionEngine: PolicyDecisionEngine,
    private readonly fdsBridge: FdsAlertBridgeService,
    private readonly autoActions: AutoActionSelectorService,
    private readonly evidencePacks: EvidencePackService,
    private readonly policyContext: PolicyContextService,
  ) {}

  /**
   * Evaluate one executed node and enforce governance.
   * Never throws — failures degrade to ALLOW with a warning log.
   */
  async evaluateStep(params: {
    ctx: RuntimeGovernanceContext;
    evaluation: EvaluationResult;
  }): Promise<GovernedStepResult | null> {
    const { ctx, evaluation } = params;
    try {
      // 1. Node profile (workflowId falls back to workflowKey for adhoc runs).
      const workflowId = ctx.workflowId ?? ctx.workflowKey ?? 'adhoc';
      const profile = await this.profiler.resolve({
        tenantId: ctx.tenantId,
        workflowId,
        nodeKey: ctx.nodeKey,
        executionType: ctx.executionType,
        connectorKey: ctx.connectorKey,
      });

      // 2. Policy version hash (cache-light: one query per step).
      const policyVersionHash =
        ctx.policyVersionHash ?? (await this.policyContext.getPolicyVersionHash(ctx.tenantId));

      // 3. Normalize evaluator output into 5 gates (0-1).
      const gateResults = this.toGateResults(evaluation);

      // 4. Decision (persisted with rationale).
      const decision = await this.decisionEngine.decide({
        ctx: { ...ctx, workflowId, policyVersionHash },
        profile,
        gateResults,
      });

      // 5. FDS alert on violation / anomaly.
      const fdsAlertIds = await this.fdsBridge.raiseIfNeeded({
        ctx: { ...ctx, workflowId, policyVersionHash },
        profile,
        decision,
        gateResults,
      });

      // 6. Auto action.
      const autoAction = await this.autoActions.execute({
        ctx: { ...ctx, workflowId, policyVersionHash },
        decision,
        alertIds: fdsAlertIds,
      });

      // 7. Evidence pack (hash chain).
      let evidencePackId: string | null = null;
      try {
        const pack = await this.evidencePacks.create({
          tenantId: ctx.tenantId,
          kind: 'RUNTIME',
          executionSessionId: ctx.executionSessionId,
          workflowId: ctx.workflowId,
          governanceDecisionId: decision.decisionId,
          policyVersionHash,
          modelId: ctx.modelId,
          evaluation: {
            nodeKey: ctx.nodeKey,
            actionType: profile.actionType,
            riskLevel: profile.riskLevel,
            overallScore: evaluation.overallScore,
            gateResults: gateResults as unknown as Record<string, unknown>,
            decision: decision.decision,
            reasons: decision.reasons,
          },
          fdsAlertIds,
          autoAction: {
            autoAction: autoAction.autoAction,
            autoActionId: autoAction.autoActionId,
            haltPipeline: autoAction.haltPipeline,
          },
        });
        evidencePackId = pack.id;
      } catch (err) {
        this.logger.warn(`Evidence pack creation failed: ${(err as Error).message}`);
      }

      return {
        decision,
        gateResults,
        fdsAlertIds,
        autoAction,
        evidencePackId,
        haltPipeline: autoAction.haltPipeline,
      };
    } catch (err) {
      this.logger.warn(
        `Runtime governance failed for ${ctx.nodeKey} (degraded to ALLOW): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Override a REQUIRE_APPROVAL / BLOCK / QUARANTINE decision — the human
   * approval path (특허 1 자동조치의 REQUEST_HUMAN_APPROVAL 종결 단계).
   *
   * Records the approver, reason and a new override EvidencePack so the
   * approval action itself is part of the audit chain, then resolves any
   * linked FDS alert. Returns the updated decision.
   */
  async overrideDecision(params: {
    tenantId: string;
    decisionId: string;
    approverId: string;
    approve: boolean; // true = APPROVE(=ALLOW), false = REJECT(=BLOCK)
    reason: string;
  }): Promise<{ decisionId: string; decision: string }> {
    const decision = await this.prismaClient.governanceDecision.findFirst({
      where: { id: params.decisionId, tenantId: params.tenantId },
    });
    if (!decision) {
      throw new Error(`GovernanceDecision not found: ${params.decisionId}`);
    }

    const newDecision = params.approve ? 'ALLOW' : 'BLOCK';
    const prevReason = (decision.reasonJson ?? {}) as Record<string, unknown>;

    const updated = await this.prismaClient.governanceDecision.update({
      where: { id: decision.id },
      data: {
        decision: newDecision as never,
        severity: params.approve ? 'LOW' : decision.severity,
        reasonJson: {
          ...prevReason,
          override: {
            by: params.approverId,
            at: new Date().toISOString(),
            from: decision.decision,
            to: newDecision,
            reason: params.reason,
          },
        } as object,
      },
    });

    // Override evidence — chained onto the tenant's evidence chain.
    await this.evidencePacks.create({
      tenantId: params.tenantId,
      kind: 'RUNTIME',
      executionSessionId: decision.executionSessionId,
      workflowId: decision.workflowId ?? undefined,
      governanceDecisionId: decision.id,
      policyVersionHash: decision.policyVersionHash ?? undefined,
      evaluation: {
        event: 'GOVERNANCE_DECISION_OVERRIDDEN',
        nodeKey: decision.nodeKey,
        from: decision.decision,
        to: newDecision,
        approverId: params.approverId,
        reason: params.reason,
      },
    });

    // Resolve the linked FDS alert(s) for this session, if any.
    try {
      await this.prismaClient.fDSAlert.updateMany({
        where: {
          tenantId: params.tenantId,
          subjectType: 'WorkflowNodeExecution',
          correlationId: decision.executionSessionId,
          status: 'OPEN',
        },
        data: { status: params.approve ? 'RESOLVED' : 'BLOCKED', resolvedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`FDS alert resolve on override failed: ${(err as Error).message}`);
    }

    return { decisionId: updated.id, decision: updated.decision };
  }

  /**
   * Map the evaluator's composite result onto normalized gate scores.
   * Same mapping for internal pipeline and external SDK ingest runs.
   */
  toGateResults(e: EvaluationResult): GateResults {
    const violations =
      (e.security?.inputThreatCount ?? 0) +
      (e.security?.outputLeakageCount ?? 0) +
      (e.security?.toolChainRisk ? 1 : 0);

    return {
      quality: clamp01((e.overallScore ?? 0) / 100),
      security: clamp01((e.security?.securityScore ?? 100) / 100),
      cost: clamp01(e.cost?.costEfficiency ?? 1),
      // Policy gate: detected threats/leakage are treated as policy violations.
      policy: clamp01(1 - violations * 0.34),
      // Anomaly gate: 0 = normal, 1 = certain anomaly.
      anomaly: e.anomaly?.anomalyDetected
        ? clamp01(0.8 + 0.05 * (e.anomaly.events?.length ?? 0))
        : 0.05,
      details: {
        qualityGrade: e.quality?.qualityGrade,
        securityRiskLevel: e.security?.securityRiskLevel,
        latencyGrade: e.cost?.latencyGrade,
        anomalyEvents: e.anomaly?.events?.length ?? 0,
      },
    };
  }
}
