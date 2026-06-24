/**
 * PolicyDecisionEngine — converts multi-gate evaluation results into a
 * single governance decision (Patent 1 구성요소).
 *
 * Input : node profile (actionType/riskLevel) + normalized gate scores
 * Output: ALLOW | WARN | REQUIRE_APPROVAL | BLOCK | QUARANTINE,
 *         persisted as a GovernanceDecision row with full rationale
 *         so every decision is reproducible at audit time.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  AutoActionType,
  GateResults,
  GovernanceDecisionResult,
  GovernanceDecisionValue,
  ResolvedNodeProfile,
  RiskLevel,
  RuntimeGovernanceContext,
} from './governance-core.types';

/** Tenant-overridable thresholds (defaults). */
export interface DecisionThresholds {
  blockBelow: number; // any core gate below → BLOCK
  warnBelow: number; // any core gate below → WARN
  anomalyQuarantineAbove: number; // anomaly score above → QUARANTINE
  approvalRiskLevels: RiskLevel[]; // riskLevels that force approval on WARN
}

const DEFAULT_THRESHOLDS: DecisionThresholds = {
  blockBelow: 0.4,
  warnBelow: 0.7,
  anomalyQuarantineAbove: 0.8,
  approvalRiskLevels: ['HIGH', 'CRITICAL'],
};

const SEVERITY_BY_DECISION: Record<GovernanceDecisionValue, RiskLevel> = {
  ALLOW: 'LOW',
  WARN: 'MEDIUM',
  REQUIRE_APPROVAL: 'HIGH',
  BLOCK: 'HIGH',
  QUARANTINE: 'CRITICAL',
};

@Injectable()
export class PolicyDecisionEngine {
  private readonly logger = new Logger(PolicyDecisionEngine.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async decide(params: {
    ctx: RuntimeGovernanceContext;
    profile: ResolvedNodeProfile;
    gateResults: GateResults;
    thresholds?: Partial<DecisionThresholds>;
  }): Promise<GovernanceDecisionResult> {
    const { ctx, profile, gateResults } = params;
    const t: DecisionThresholds = { ...DEFAULT_THRESHOLDS, ...params.thresholds };

    const { decision, reasons } = this.evaluate(profile, gateResults, t);
    const autoAction = this.selectAutoAction(decision, profile);
    const severity = SEVERITY_BY_DECISION[decision];

    const row = await this.prisma.governanceDecision.create({
      data: {
        tenantId: ctx.tenantId,
        executionSessionId: ctx.executionSessionId,
        executionStepId: ctx.executionStepId,
        workflowId: ctx.workflowId,
        nodeKey: ctx.nodeKey,
        policyVersionHash: ctx.policyVersionHash,
        decision,
        severity,
        reasonJson: { reasons, thresholds: t as unknown } as object,
        gateResultsJson: gateResults as unknown as object,
        autoActionJson: { autoAction },
      },
    });

    return { decisionId: row.id, decision, severity, reasons, autoAction };
  }

  /** Pure rule evaluation — no I/O. */
  evaluate(
    profile: ResolvedNodeProfile,
    gates: GateResults,
    t: DecisionThresholds,
  ): { decision: GovernanceDecisionValue; reasons: string[] } {
    const reasons: string[] = [];

    // 보안 점검(모의해킹·취약점 스캔) 노드: 출력의 공격 패턴·비밀번호 예시는
    // 정상 업무 산출물이다. 보안·정책·이상 게이트가 이를 위협으로 오인해 노드를
    // 차단·격리하지 않도록, 해당 게이트는 판정 전에 통과 처리(1.0)한다.
    // 품질·비용 게이트는 그대로 적용된다 (출력 품질 자체는 계속 평가).
    const isSecTest = profile.securityTesting;
    const effective: GateResults = isSecTest
      ? { ...gates, security: 1, policy: 1, anomaly: Math.min(gates.anomaly, 0.4) }
      : gates;
    if (isSecTest) {
      reasons.push('security-testing node: security/policy/anomaly gates neutralized (BLOCK→WARN)');
    }

    // 1. Anomaly gate dominates: suspected abnormal behaviour is isolated.
    if (effective.anomaly >= t.anomalyQuarantineAbove) {
      reasons.push(`anomaly score ${effective.anomaly.toFixed(2)} >= ${t.anomalyQuarantineAbove}`);
      return { decision: 'QUARANTINE', reasons };
    }

    const coreGates: Array<[name: string, score: number]> = [
      ['quality', effective.quality],
      ['security', effective.security],
      ['cost', effective.cost],
      ['policy', effective.policy],
    ];

    // 2. Hard violation → BLOCK.  단, 보안 점검 노드는 BLOCK을 WARN으로 강등한다
    //    (자기 출력 때문에 파이프라인이 멈추는 false-positive 방지).
    const blocked = coreGates.filter(([, s]) => s < t.blockBelow);
    if (blocked.length > 0) {
      blocked.forEach(([name, s]) =>
        reasons.push(`${name} gate ${s.toFixed(2)} < block threshold ${t.blockBelow}`),
      );
      if (isSecTest) {
        reasons.push('downgraded BLOCK→WARN for security-testing node');
        return { decision: 'WARN', reasons };
      }
      return { decision: 'BLOCK', reasons };
    }

    // 3. Soft violation → WARN, escalated to REQUIRE_APPROVAL on
    //    high-risk nodes or nodes flagged as policy checkpoints.
    const warned = coreGates.filter(([, s]) => s < t.warnBelow);
    if (warned.length > 0) {
      warned.forEach(([name, s]) =>
        reasons.push(`${name} gate ${s.toFixed(2)} < warn threshold ${t.warnBelow}`),
      );
      // 보안 점검 노드는 승인요청으로 격상하지 않고 WARN으로 통과 (자동 진행).
      const escalate =
        !isSecTest &&
        (t.approvalRiskLevels.includes(profile.riskLevel) ||
          profile.policyCheckpoint ||
          profile.humanApproval);
      if (escalate) {
        reasons.push(
          `escalated: riskLevel=${profile.riskLevel} actionType=${profile.actionType} checkpoint=${profile.policyCheckpoint}`,
        );
        return { decision: 'REQUIRE_APPROVAL', reasons };
      }
      return { decision: 'WARN', reasons };
    }

    // 4. Human-approval nodes never silently pass.
    if (profile.humanApproval) {
      reasons.push('node requires human approval by governance profile');
      return { decision: 'REQUIRE_APPROVAL', reasons };
    }

    reasons.push('all gates passed');
    return { decision: 'ALLOW', reasons };
  }

  private selectAutoAction(
    decision: GovernanceDecisionValue,
    profile: ResolvedNodeProfile,
  ): AutoActionType {
    switch (decision) {
      case 'QUARANTINE':
        return 'QUARANTINE';
      case 'BLOCK':
        return profile.actionType === 'EXTERNAL_SEND' ? 'CONNECTOR_DISABLE' : 'BLOCK';
      case 'REQUIRE_APPROVAL':
        return 'REQUEST_HUMAN_APPROVAL';
      case 'WARN':
        return 'THROTTLE';
      default:
        return 'NONE';
    }
  }
}
