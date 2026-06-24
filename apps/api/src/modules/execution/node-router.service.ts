/**
 * Workflow Node Router — dispatches each node in a workflow to the correct runtime.
 *
 * Node types:
 *   - connector   → ConnectorService.invoke
 *   - agent       → AgentDispatcherService.dispatch
 *   - adapter     → AdapterRegistry (future: direct invocation of registered adapter)
 *   - decision    → PolicyService.evaluate
 *   - human       → MissionService.pauseForHuman
 *   - skill       → Pack capability invocation (delegated to ConnectorService for now)
 *
 * Design:
 *   - Each node produces a NodeResult consumed by the next node
 *   - Mission-aware: if the execution belongs to a mission, each node emits
 *     an A2A bus message for live timeline visibility
 *   - Fully audit-traced via correlationId
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenantContext } from '@metis/database';
import { ConnectorService } from '../connector/connector.service';
import { AgentDispatcherService } from '../agent-kernel/dispatcher.service';
import { A2ABusService } from '../agent-kernel/bus.service';
import { MissionService } from '../agent-kernel/mission.service';
import { AdapterInvocationService } from '../capability-registry/adapter-invocation.service';
import { SchemaValidatorService } from './schema-validator.service';
import { CapabilityRegistryService } from '../capability-registry/capability-registry.service';

export type WorkflowNodeType =
  | 'connector'
  | 'agent'
  | 'adapter'
  | 'decision'
  | 'human'
  | 'skill'
  | 'start'
  | 'end';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  capability?: string; // e.g. 'connector:slack-webhook', 'agent:qa-agent', 'adapter:ocr-mock'
  config?: Record<string, any>;
  inputMapping?: Record<string, string>; // { "fieldName": "$.previousNode.output.field" }
  dependsOn?: string[]; // Node IDs that must complete before this node runs (enables DAG parallelism)
  parallelGroup?: string; // Optional explicit group name for fan-out patterns
}

export interface NodeExecutionContext {
  ctx: TenantContext;
  workflowId: string;
  executionSessionId: string;
  missionId?: string;
  correlationId: string;
  /** Accumulated outputs per node id (for inputMapping resolution) */
  state: Record<string, any>;
}

export interface NodeResult {
  success: boolean;
  output: Record<string, any>;
  durationMs: number;
  error?: string;
}

@Injectable()
export class WorkflowNodeRouter {
  private readonly logger = new Logger(WorkflowNodeRouter.name);

  constructor(
    private readonly connectors: ConnectorService,
    private readonly agentDispatcher: AgentDispatcherService,
    private readonly bus: A2ABusService,
    private readonly missions: MissionService,
    private readonly adapterInvocation: AdapterInvocationService,
    private readonly schemaValidator: SchemaValidatorService,
    private readonly capabilityRegistry: CapabilityRegistryService,
  ) {}

  async execute(node: WorkflowNode, ctx: NodeExecutionContext): Promise<NodeResult> {
    const start = Date.now();
    const input = this.resolveInput(node, ctx);

    this.logger.log(
      `[workflow-node] Executing ${node.type} "${node.capability ?? node.id}" ` +
        `session=${ctx.executionSessionId} mission=${ctx.missionId ?? '-'}`,
    );

    try {
      // Pre-execution: validate input against registered capability schema
      if (node.capability && ['connector', 'agent', 'adapter', 'skill'].includes(node.type)) {
        const cap = await this.capabilityRegistry
          .getByKey(ctx.ctx, node.capability)
          .catch(() => null);
        if (cap?.inputSchema) {
          const v = this.schemaValidator.validate(input, cap.inputSchema);
          if (!v.valid) {
            throw new Error(
              `Input schema validation failed for "${node.capability}": ${v.errors.join('; ')}`,
            );
          }
        }
      }
      let output: Record<string, any> = {};
      switch (node.type) {
        case 'start':
        case 'end':
          output = { marker: node.type };
          break;

        case 'connector': {
          const key = this.parseCapabilityKey(node.capability, 'connector');
          const result = await this.connectors.invoke({
            connectorKey: key,
            actionType: 'ACTION_INVOKE' as any,
            method: input.method || node.config?.method || 'default',
            payload: input,
            executionContext: {
              tenantId: ctx.ctx.tenantId,
              userId: ctx.ctx.userId || 'system',
              executionSessionId: ctx.executionSessionId,
              correlationId: ctx.correlationId,
            },
          });
          output = { success: result.success, data: result.data, statusCode: result.statusCode };
          if (!result.success) throw new Error(result.error || 'Connector invocation failed');
          break;
        }

        case 'agent': {
          const key = this.parseCapabilityKey(node.capability, 'agent');
          const result = await this.agentDispatcher.dispatch(ctx.ctx, {
            agentKey: key,
            missionId: ctx.missionId,
            input,
            correlationId: ctx.correlationId,
            timeoutSec: node.config?.timeoutSec,
          });
          output = result.output;
          if (!result.success) throw new Error(result.error || 'Agent failed');
          break;
        }

        case 'adapter': {
          const key = this.parseCapabilityKey(node.capability, 'adapter');
          const result = await this.adapterInvocation.invoke(ctx.ctx, key, input);
          output = {
            ...result.output,
            _adapterMeta: {
              implementation: result.implementation,
              confidence: result.confidence,
              latencyMs: result.latencyMs,
            },
          };
          if (!result.success) throw new Error(result.error || `Adapter ${key} failed`);
          break;
        }

        case 'decision': {
          // Evaluate a condition expression against state.
          const cond = node.config?.condition;
          const result = this.evaluateCondition(cond, { input, state: ctx.state });
          output = { result, branch: result ? 'true' : 'false' };
          break;
        }

        case 'human': {
          if (!ctx.missionId) {
            throw new Error('Human intervention node requires a mission context');
          }
          await this.missions.pauseForHuman(
            ctx.ctx,
            ctx.missionId,
            node.config?.prompt || '사용자 승인 필요',
          );
          output = { waiting: true, prompt: node.config?.prompt };
          break;
        }

        case 'skill': {
          output = {
            note: 'Skill execution placeholder',
            capability: node.capability,
            input,
          };
          break;
        }

        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }

      // Update shared state for downstream nodes
      ctx.state[node.id] = output;

      // Push a tiny bus event if this is mission-bound
      if (ctx.missionId && node.type !== 'start' && node.type !== 'end') {
        await this.bus
          .publish(ctx.ctx.tenantId, ctx.missionId, {
            kind: 'EVENT',
            fromAgent: 'workflow-executor',
            subject: `Node ${node.id} (${node.type})`,
            payload: { nodeId: node.id, capability: node.capability, success: true },
            naturalSummary: `워크플로우 노드 실행: ${node.capability ?? node.type}`,
            correlationId: ctx.correlationId,
          })
          .catch(() => {});
      }

      return { success: true, output, durationMs: Date.now() - start };
    } catch (e: any) {
      this.logger.error(`[workflow-node] ${node.id} failed: ${e.message}`);
      if (ctx.missionId) {
        await this.bus
          .publish(ctx.ctx.tenantId, ctx.missionId, {
            kind: 'EVENT',
            fromAgent: 'workflow-executor',
            subject: `Node ${node.id} FAILED`,
            payload: { nodeId: node.id, error: e.message },
            naturalSummary: `워크플로우 노드 실패: ${e.message}`,
            correlationId: ctx.correlationId,
          })
          .catch(() => {});
      }
      return { success: false, output: {}, durationMs: Date.now() - start, error: e.message };
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private parseCapabilityKey(capability: string | undefined, expectedKind: string): string {
    if (!capability) throw new Error(`Missing capability for ${expectedKind} node`);
    const [kind, ...rest] = capability.split(':');
    if (kind !== expectedKind)
      throw new Error(`Expected capability kind "${expectedKind}", got "${kind}"`);
    return rest.join(':');
  }

  private resolveInput(node: WorkflowNode, ctx: NodeExecutionContext): Record<string, any> {
    const input: Record<string, any> = { ...(node.config?.defaultInput || {}) };
    for (const [field, ref] of Object.entries(node.inputMapping || {})) {
      input[field] = this.resolveJsonPath(ref, ctx.state);
    }
    return input;
  }

  private resolveJsonPath(ref: string, state: Record<string, any>): any {
    if (!ref.startsWith('$.')) return ref;
    const parts = ref.substring(2).split('.');
    let v: any = state;
    for (const p of parts) {
      if (v == null) return undefined;
      v = v[p];
    }
    return v;
  }

  private evaluateCondition(cond: any, scope: { input: any; state: any }): boolean {
    if (!cond) return true;
    if (typeof cond === 'boolean') return cond;
    // Simple { field, operator, value } evaluation
    const fieldVal = this.resolveJsonPath(cond.field, scope.state) ?? scope.input[cond.field];
    switch (cond.operator) {
      case 'eq':
        return fieldVal === cond.value;
      case 'neq':
        return fieldVal !== cond.value;
      case 'gt':
        return Number(fieldVal) > Number(cond.value);
      case 'lt':
        return Number(fieldVal) < Number(cond.value);
      case 'exists':
        return fieldVal !== undefined && fieldVal !== null;
      default:
        return !!fieldVal;
    }
  }
}
