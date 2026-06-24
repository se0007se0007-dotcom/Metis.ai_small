/**
 * NodeGovernanceProfiler — derives the governance surface of each
 * workflow node (Patent 1 구성요소).
 *
 * For every node it resolves:
 *   executionType, capability, actionType, riskLevel, dataClass,
 *   policyCheckpoint, humanApproval, connectorScopeHash
 * from the node's uiType / config / connector scope, and persists the
 * profile (upsert) so runtime decisions and registration fingerprints
 * share one deterministic source of truth.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  ActionType,
  DataClass,
  NodeGovernanceProfileInput,
  ResolvedNodeProfile,
  RiskLevel,
} from './governance-core.types';

/** uiType/executionType keyword → actionType heuristics (config wins). */
const ACTION_TYPE_RULES: Array<{ pattern: RegExp; action: ActionType }> = [
  { pattern: /send|notify|slack|mail|sms|webhook|post/i, action: 'EXTERNAL_SEND' },
  { pattern: /delete|remove|purge|drop/i, action: 'DELETE' },
  { pattern: /deploy|release|rollout/i, action: 'DEPLOY' },
  { pattern: /approve|approval/i, action: 'APPROVE' },
  { pattern: /pay|invoice|billing|settle/i, action: 'PAYMENT' },
  { pattern: /permission|role|grant|acl|iam/i, action: 'PERMISSION_CHANGE' },
  { pattern: /write|create|update|patch|upsert|insert/i, action: 'WRITE' },
  { pattern: /transform|map|parse|format|llm|prompt/i, action: 'TRANSFORM' },
];

const HIGH_RISK_ACTIONS: ActionType[] = [
  'EXTERNAL_SEND',
  'DELETE',
  'DEPLOY',
  'APPROVE',
  'PAYMENT',
  'PERMISSION_CHANGE',
];

const SENSITIVE_DATA_CLASSES: DataClass[] = ['PII', 'SECRET', 'CUSTOMER_CONFIDENTIAL'];

@Injectable()
export class NodeGovernanceProfilerService {
  private readonly logger = new Logger(NodeGovernanceProfilerService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * Resolve (and persist) the governance profile of a node.
   * Deterministic: same node definition → same profile.
   */
  async resolve(input: NodeGovernanceProfileInput): Promise<ResolvedNodeProfile> {
    const profile = this.derive(input);

    try {
      await this.prisma.nodeGovernanceProfile.upsert({
        where: {
          tenantId_workflowId_nodeKey: {
            tenantId: input.tenantId,
            workflowId: input.workflowId,
            nodeKey: input.nodeKey,
          },
        },
        create: {
          tenantId: input.tenantId,
          workflowId: input.workflowId,
          workflowVersionId: input.workflowVersionId,
          nodeKey: profile.nodeKey,
          executionType: profile.executionType,
          capability: profile.capability,
          actionType: profile.actionType,
          riskLevel: profile.riskLevel,
          dataClass: profile.dataClass,
          policyCheckpoint: profile.policyCheckpoint,
          humanApproval: profile.humanApproval,
          connectorScopeHash: profile.connectorScopeHash,
        },
        update: {
          workflowVersionId: input.workflowVersionId,
          executionType: profile.executionType,
          capability: profile.capability,
          actionType: profile.actionType,
          riskLevel: profile.riskLevel,
          dataClass: profile.dataClass,
          policyCheckpoint: profile.policyCheckpoint,
          humanApproval: profile.humanApproval,
          connectorScopeHash: profile.connectorScopeHash,
        },
      });
    } catch (err) {
      // Profiling persistence is best-effort; resolution result still returned.
      this.logger.warn(
        `NodeGovernanceProfile upsert failed (${input.workflowId}/${input.nodeKey}): ${(err as Error).message}`,
      );
    }

    return profile;
  }

  /** Pure derivation — no I/O. Exposed for fingerprinting & tests. */
  derive(input: NodeGovernanceProfileInput): ResolvedNodeProfile {
    const config = input.configJson ?? {};
    const haystack = [
      input.nodeKey,
      input.executionType,
      input.capability ?? '',
      String((config as Record<string, unknown>).action ?? ''),
      String((config as Record<string, unknown>).operation ?? ''),
    ].join(' ');

    const explicitAction = (config as Record<string, unknown>).actionType as
      | ActionType
      | undefined;
    const actionType: ActionType =
      explicitAction ?? ACTION_TYPE_RULES.find((r) => r.pattern.test(haystack))?.action ?? 'READ';

    const explicitDataClass = (config as Record<string, unknown>).dataClass as
      | DataClass
      | undefined;
    const dataClass: DataClass | undefined =
      explicitDataClass ?? this.inferDataClass(haystack);

    const riskLevel = this.deriveRiskLevel(actionType, dataClass);

    // Checkpoint policy: high-risk actions and sensitive data classes
    // always get a policy checkpoint; CRITICAL additionally requires
    // human approval (청구항: 기준 미달/고위험 노드에 자동 삽입).
    const policyCheckpoint =
      Boolean((config as Record<string, unknown>).policyCheckpoint) ||
      HIGH_RISK_ACTIONS.includes(actionType) ||
      (dataClass != null && SENSITIVE_DATA_CLASSES.includes(dataClass));
    const humanApproval =
      Boolean((config as Record<string, unknown>).humanApproval) || riskLevel === 'CRITICAL';

    // 보안 점검(모의해킹·취약점 스캔) 노드: 출력에 공격 패턴이 정상 포함되므로
    // 별도 플래그로 표시해 보안/정책 게이트 위반을 BLOCK→WARN으로 강등한다.
    const securityTesting =
      Boolean((config as Record<string, unknown>).securityTesting) ||
      /pentest|모의\s*해킹|모의해킹|vuln|취약점|security[-_\s]?scan|보안\s*점검|보안점검|exploit|침투/i.test(
        haystack,
      );

    return {
      nodeKey: input.nodeKey,
      executionType: input.executionType,
      capability: input.capability,
      actionType,
      riskLevel,
      dataClass,
      policyCheckpoint,
      humanApproval,
      securityTesting,
      connectorScopeHash: input.connectorKey
        ? createHash('sha256').update(input.connectorKey).digest('hex')
        : undefined,
    };
  }

  private inferDataClass(haystack: string): DataClass | undefined {
    if (/secret|credential|password|token|apikey/i.test(haystack)) return 'SECRET';
    if (/pii|personal|주민|resident|ssn|phone|email-address/i.test(haystack)) return 'PII';
    if (/customer|고객/i.test(haystack)) return 'CUSTOMER_CONFIDENTIAL';
    return undefined;
  }

  private deriveRiskLevel(actionType: ActionType, dataClass?: DataClass): RiskLevel {
    const sensitiveData = dataClass != null && SENSITIVE_DATA_CLASSES.includes(dataClass);
    if (
      (HIGH_RISK_ACTIONS.includes(actionType) && sensitiveData) ||
      actionType === 'PAYMENT' ||
      actionType === 'PERMISSION_CHANGE'
    ) {
      return 'CRITICAL';
    }
    if (HIGH_RISK_ACTIONS.includes(actionType)) return 'HIGH';
    if (actionType === 'WRITE' || sensitiveData) return 'MEDIUM';
    return 'LOW';
  }
}
