/**
 * AutoActionSelector — Patent 1 구성요소.
 *
 * Executes the auto-action chosen by the PolicyDecisionEngine and
 * records it as an AutoAction row (existing self-healing audit table).
 * Returns a directive telling the pipeline whether to halt.
 *
 * v1 enforcement scope:
 *   BLOCK / QUARANTINE        → halt pipeline (subsequent nodes skipped)
 *   REQUEST_HUMAN_APPROVAL    → halt + escalation record
 *   THROTTLE / MODEL_DOWNGRADE→ recorded (advisory; FinOps router applies)
 *   CONNECTOR_DISABLE         → recorded as REMEDIATION (manual revert)
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  AutoActionType,
  GovernanceDecisionResult,
  RuntimeGovernanceContext,
} from './governance-core.types';

const KIND_MAP: Record<string, 'REMEDIATION' | 'ROLLBACK' | 'ESCALATION' | 'QUARANTINE' | 'RATE_ADJUST'> = {
  BLOCK: 'REMEDIATION',
  QUARANTINE: 'QUARANTINE',
  THROTTLE: 'RATE_ADJUST',
  MODEL_DOWNGRADE: 'RATE_ADJUST',
  CONNECTOR_DISABLE: 'REMEDIATION',
  WORKFLOW_ROLLBACK: 'ROLLBACK',
  REQUEST_HUMAN_APPROVAL: 'ESCALATION',
};

const HALTING_ACTIONS: AutoActionType[] = ['BLOCK', 'QUARANTINE', 'REQUEST_HUMAN_APPROVAL'];

export interface AutoActionDirective {
  autoAction: AutoActionType;
  autoActionId: string | null;
  haltPipeline: boolean;
}

@Injectable()
export class AutoActionSelectorService {
  private readonly logger = new Logger(AutoActionSelectorService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async execute(params: {
    ctx: RuntimeGovernanceContext;
    decision: GovernanceDecisionResult;
    alertIds: string[];
  }): Promise<AutoActionDirective> {
    const { ctx, decision } = params;
    const action = decision.autoAction;

    if (action === 'NONE') {
      return { autoAction: action, autoActionId: null, haltPipeline: false };
    }

    const haltPipeline = HALTING_ACTIONS.includes(action);
    let autoActionId: string | null = null;

    try {
      const row = await this.prisma.autoAction.create({
        data: {
          tenantId: ctx.tenantId,
          kind: KIND_MAP[action] ?? 'REMEDIATION',
          targetType: 'Execution',
          targetId: ctx.executionStepId ?? ctx.executionSessionId,
          triggerReason: `governance ${decision.decision}: ${decision.reasons.join('; ')}`,
          triggerRuleId: decision.decisionId,
          actionJson: {
            action,
            parameters: {
              workflowKey: ctx.workflowKey ?? null,
              nodeKey: ctx.nodeKey,
              haltPipeline,
              fdsAlertIds: params.alertIds,
            },
            reversible: !haltPipeline,
          } as object,
          status: 'EXECUTED',
          correlationId: ctx.executionSessionId,
        },
      });
      autoActionId = row.id;
    } catch (err) {
      this.logger.warn(`AutoAction persistence failed: ${(err as Error).message}`);
    }

    if (haltPipeline) {
      this.logger.warn(
        `[auto-action] ${action} — halting pipeline session=${ctx.executionSessionId} node=${ctx.nodeKey}`,
      );
    }

    return { autoAction: action, autoActionId, haltPipeline };
  }
}
