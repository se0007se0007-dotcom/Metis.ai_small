/**
 * Workflow Execution Bridge — converts builder canvas nodes into
 * RunWorkflowInput for the WorkflowRunnerService.
 *
 * This is the critical link between:
 *   - Frontend builder nodes (uiType + configJson)
 *   - Backend execution pipeline (WorkflowRunnerService → NodeRouter → ConnectorService/AgentDispatcher)
 *
 * Responsibilities:
 *   1. Resolve each builder node's uiType → executionType + capability (via NodeResolutionRegistry)
 *   2. Infer inputMapping between nodes (data flow)
 *   3. Validate connector availability for the tenant
 *   4. Build the RunWorkflowInput structure
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { NodeResolutionRegistry, ResolvedNode } from './node-resolution.registry';
import type { WorkflowNode } from '../execution/node-router.service';
import type { RunWorkflowInput } from '../execution/workflow-runner.service';

// ── Input DTO (from frontend) ──

export interface DraftNodeInput {
  nodeKey: string;
  uiType: string;
  name: string;
  executionOrder: number;
  config: Record<string, any>;
  dependsOn?: string[];
  inputMapping?: Record<string, string>;
}

export interface DraftEdgeInput {
  from: string;
  to: string;
  type?: 'SEQUENCE' | 'CONDITIONAL' | 'ERROR';
  condition?: string;
}

export interface ExecuteDraftInput {
  title?: string;
  nodes: DraftNodeInput[];
  edges?: DraftEdgeInput[];
}

// ── Output ──

export interface ConnectorValidationResult {
  valid: boolean;
  missingConnectors: Array<{
    connectorKey: string;
    requiredByNode: string;
    nodeName: string;
  }>;
  availableConnectors: string[];
}

export interface BridgeResult {
  runInput: RunWorkflowInput;
  resolvedNodes: ResolvedNode[];
  connectorValidation: ConnectorValidationResult;
  warnings: string[];
}

@Injectable()
export class WorkflowExecutionBridge {
  private readonly logger = new Logger(WorkflowExecutionBridge.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly registry: NodeResolutionRegistry,
  ) {}

  /**
   * Convert frontend builder nodes → RunWorkflowInput for WorkflowRunnerService.
   *
   * Steps:
   *   1. Sort nodes by executionOrder
   *   2. Resolve each node's executionType + capability via registry
   *   3. Infer inputMapping between sequential nodes
   *   4. Check connector availability
   *   5. Build the final RunWorkflowInput
   */
  async buildRunInput(ctx: TenantContext, input: ExecuteDraftInput): Promise<BridgeResult> {
    const warnings: string[] = [];

    // 1. Sort by execution order
    const sortedNodes = [...input.nodes].sort((a, b) => a.executionOrder - b.executionOrder);

    // 2. Resolve each node
    const resolvedNodes: ResolvedNode[] = [];
    const resolvedByKey = new Map<string, ResolvedNode>();

    for (const draftNode of sortedNodes) {
      const resolution = this.registry.resolve(draftNode.uiType, draftNode.config);

      // Build upstream info for inputMapping inference using actual nodeKeys for JSON path references
      const upstreamForMapping = resolvedNodes.map((r) => ({
        nodeKey:
          sortedNodes.find((n) => {
            const res = resolvedByKey.get(n.nodeKey);
            return res === r;
          })?.nodeKey || r.uiType,
        outputKeys: r.outputKeys,
      }));

      const inputMapping = this.registry.inferInputMapping(
        draftNode.uiType,
        draftNode.config,
        upstreamForMapping,
        draftNode.inputMapping,
      );

      const resolved: ResolvedNode = {
        uiType: draftNode.uiType,
        executionType: resolution.executionType,
        capability: resolution.capability,
        intentCategory: resolution.intentCategory,
        riskLevel: resolution.riskLevel,
        inputMapping,
        outputKeys: resolution.defaultOutputKeys,
      };

      resolvedNodes.push(resolved);
      resolvedByKey.set(draftNode.nodeKey, resolved);
    }

    // 3. Check connector availability
    const connectorValidation = await this.validateConnectors(ctx, sortedNodes, resolvedNodes);
    if (!connectorValidation.valid) {
      for (const missing of connectorValidation.missingConnectors) {
        warnings.push(
          `커넥터 "${missing.connectorKey}" 미설치 — 노드 "${missing.nodeName}"이(가) ` +
            `실행 시 시뮬레이션 모드로 동작합니다.`,
        );
      }
    }

    // 4. Build RunWorkflowInput
    const executionNodes: WorkflowNode[] = sortedNodes.map((draftNode, idx) => {
      const resolved = resolvedByKey.get(draftNode.nodeKey)!;

      return {
        id: draftNode.nodeKey,
        type: resolved.executionType,
        capability: resolved.capability,
        config: {
          ...draftNode.config,
          _uiType: draftNode.uiType,
          _nodeName: draftNode.name,
          _intentCategory: resolved.intentCategory,
        },
        inputMapping:
          Object.keys(resolved.inputMapping).length > 0 ? resolved.inputMapping : undefined,
        dependsOn:
          draftNode.dependsOn && draftNode.dependsOn.length > 0 ? draftNode.dependsOn : undefined,
      };
    });

    // Determine if we need a mission (agent or human nodes present)
    const needsMission = executionNodes.some((n) => n.type === 'human' || n.type === 'agent');

    const runInput: RunWorkflowInput = {
      workflowKey: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: input.title || '빌더 드래프트 실행',
      nodes: executionNodes,
      initialInput: {},
      createMission: needsMission,
    };

    this.logger.log(
      `Bridge: ${sortedNodes.length} nodes resolved → ${executionNodes.length} execution nodes. ` +
        `Connectors: ${connectorValidation.valid ? 'all available' : `${connectorValidation.missingConnectors.length} missing`}`,
    );

    return {
      runInput,
      resolvedNodes,
      connectorValidation,
      warnings,
    };
  }

  /**
   * Quick resolution without execution — used for preview/validation.
   */
  resolveNodes(nodes: DraftNodeInput[]): ResolvedNode[] {
    const sorted = [...nodes].sort((a, b) => a.executionOrder - b.executionOrder);
    const resolved: ResolvedNode[] = [];

    for (const node of sorted) {
      const resolution = this.registry.resolve(node.uiType, node.config);
      const upstreamForMapping = resolved.map((r, i) => ({
        nodeKey: sorted[i].nodeKey,
        outputKeys: r.outputKeys,
      }));

      const inputMapping = this.registry.inferInputMapping(
        node.uiType,
        node.config,
        upstreamForMapping,
        node.inputMapping,
      );

      resolved.push({
        uiType: node.uiType,
        executionType: resolution.executionType,
        capability: resolution.capability,
        intentCategory: resolution.intentCategory,
        riskLevel: resolution.riskLevel,
        inputMapping,
        outputKeys: resolution.defaultOutputKeys,
      });
    }

    return resolved;
  }

  // ── Private ──

  private async validateConnectors(
    ctx: TenantContext,
    draftNodes: DraftNodeInput[],
    resolvedNodes: ResolvedNode[],
  ): Promise<ConnectorValidationResult> {
    // Collect required connector keys
    const required = new Map<string, { nodeKey: string; nodeName: string }>();

    for (let i = 0; i < resolvedNodes.length; i++) {
      const resolved = resolvedNodes[i];
      const draft = draftNodes[i];

      if (resolved.executionType === 'connector') {
        const entry = this.registry.getEntry(draft.uiType);
        if (entry?.requiredConnectorKey) {
          required.set(entry.requiredConnectorKey, {
            nodeKey: draft.nodeKey,
            nodeName: draft.name,
          });
        }
      }
    }

    if (required.size === 0) {
      return { valid: true, missingConnectors: [], availableConnectors: [] };
    }

    // Query tenant's installed connectors
    const connectorKeys = Array.from(required.keys());
    const installed = await this.prisma.connector
      .findMany({
        where: {
          tenantId: ctx.tenantId,
          key: { in: connectorKeys },
          status: 'ACTIVE',
        },
        select: { key: true },
      })
      .catch(() => []);

    const installedKeys = new Set(installed.map((c) => c.key));
    const missing = connectorKeys
      .filter((k) => !installedKeys.has(k))
      .map((k) => ({
        connectorKey: k,
        requiredByNode: required.get(k)!.nodeKey,
        nodeName: required.get(k)!.nodeName,
      }));

    return {
      valid: missing.length === 0,
      missingConnectors: missing,
      availableConnectors: Array.from(installedKeys),
    };
  }
}
