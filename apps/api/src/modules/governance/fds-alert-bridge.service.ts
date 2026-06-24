/**
 * FDSAlertBridge — Patent 1 구성요소 (종속청구항 6).
 *
 * Converts governance decisions (policy violation / anomaly) into
 * FDSAlert rows so runtime agent risk flows into the existing FDS
 * Risk workspace. subjectType is 'WorkflowNodeExecution' and the
 * alert detail carries workflowKey / nodeKey / actionType / riskLevel
 * plus the full gate scores for investigation.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  GateResults,
  GovernanceDecisionResult,
  ResolvedNodeProfile,
  RuntimeGovernanceContext,
} from './governance-core.types';

/** Decisions that raise an alert (ALLOW/WARN stay silent). */
const ALERTING_DECISIONS = ['REQUIRE_APPROVAL', 'BLOCK', 'QUARANTINE'];

@Injectable()
export class FdsAlertBridgeService {
  private readonly logger = new Logger(FdsAlertBridgeService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async raiseIfNeeded(params: {
    ctx: RuntimeGovernanceContext;
    profile: ResolvedNodeProfile;
    decision: GovernanceDecisionResult;
    gateResults: GateResults;
  }): Promise<string[]> {
    const { ctx, profile, decision, gateResults } = params;
    if (!ALERTING_DECISIONS.includes(decision.decision)) return [];

    // Risk score: distance of the worst core gate from 1, amplified by anomaly.
    const worstGate = Math.min(
      gateResults.quality,
      gateResults.security,
      gateResults.cost,
      gateResults.policy,
    );
    const score = Math.max(0, Math.min(1, Math.max(1 - worstGate, gateResults.anomaly)));

    try {
      const alert = await this.prisma.fDSAlert.create({
        data: {
          tenantId: ctx.tenantId,
          severity: decision.severity,
          status: 'OPEN',
          subjectType: 'WorkflowNodeExecution',
          subjectId: ctx.executionStepId ?? ctx.executionSessionId,
          score,
          summary: `[governance] ${decision.decision} — ${ctx.workflowKey ?? ctx.workflowId ?? 'adhoc'}/${ctx.nodeKey} (${profile.actionType}/${profile.riskLevel})`,
          detailsJson: {
            workflowKey: ctx.workflowKey ?? null,
            workflowId: ctx.workflowId ?? null,
            nodeKey: ctx.nodeKey,
            actionType: profile.actionType,
            riskLevel: profile.riskLevel,
            dataClass: profile.dataClass ?? null,
            decision: decision.decision,
            reasons: decision.reasons,
            gateResults: gateResults as unknown as object,
            executionSessionId: ctx.executionSessionId,
            executionStepId: ctx.executionStepId ?? null,
            policyVersionHash: ctx.policyVersionHash ?? null,
          } as object,
          correlationId: ctx.executionSessionId,
        },
      });
      return [alert.id];
    } catch (err) {
      // Alerting must never break execution evaluation.
      this.logger.warn(`FDSAlert creation failed: ${(err as Error).message}`);
      return [];
    }
  }
}
