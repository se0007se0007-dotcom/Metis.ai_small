/**
 * Workflow Runner — orchestrates execution of a node graph end-to-end.
 *
 * Responsibilities:
 *   - Create an ExecutionSession
 *   - Optionally create a Mission for multi-agent coordination
 *   - Execute each node sequentially (topological order for now)
 *   - Propagate state between nodes via inputMapping
 *   - Emit granular traces for audit
 *
 * Scope: single-path DAG (linear). Fan-out/parallel execution is a future extension.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { WorkflowNodeRouter, WorkflowNode, NodeExecutionContext } from './node-router.service';
// WorkflowNode type re-exported from router; used by planExecutionLevels below.
import { MissionService } from '../agent-kernel/mission.service';

export interface RunWorkflowInput {
  workflowKey: string;
  title: string;
  nodes: WorkflowNode[];
  initialInput?: Record<string, any>;
  createMission?: boolean;
  missionKind?: string;
  participants?: Array<{ agent: string; role: string }>;
}

export interface WorkflowRunResult {
  executionSessionId: string;
  missionId?: string;
  correlationId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  nodeResults: Array<{ nodeId: string; success: boolean; durationMs: number; error?: string }>;
  finalState: Record<string, any>;
  totalDurationMs: number;
}

@Injectable()
export class WorkflowRunnerService {
  private readonly logger = new Logger(WorkflowRunnerService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly router: WorkflowNodeRouter,
    private readonly missions: MissionService,
  ) {}

  async run(ctx: TenantContext, input: RunWorkflowInput): Promise<WorkflowRunResult> {
    const start = Date.now();
    const correlationId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 1. Execution session
    const session = await this.prisma.executionSession.create({
      data: {
        tenantId: ctx.tenantId,
        workflowKey: input.workflowKey,
        triggeredById: ctx.userId,
        status: 'RUNNING',
        correlationId,
        inputJson: (input.initialInput ?? {}) as any,
      },
    });

    // 2. Optional mission
    let missionId: string | undefined;
    if (input.createMission) {
      const mission = await this.missions
        .create(ctx, {
          key: `wf-${session.id.slice(-8)}-${Date.now()}`,
          title: input.title,
          kind: input.missionKind ?? 'WORKFLOW',
          participants: input.participants ?? [{ agent: 'workflow-executor', role: 'executor' }],
          context: { executionSessionId: session.id, workflowKey: input.workflowKey },
        })
        .catch((e) => {
          this.logger.warn(`Mission create failed: ${e.message}`);
          return null;
        });
      if (mission) {
        missionId = mission.id;
        await this.missions.start(ctx, mission.id).catch(() => {});
      }
    }

    // 3. Execute nodes
    const execCtx: NodeExecutionContext = {
      ctx,
      workflowId: input.workflowKey,
      executionSessionId: session.id,
      missionId,
      correlationId,
      state: { __initial__: input.initialInput ?? {} },
    };

    const nodeResults: WorkflowRunResult['nodeResults'] = [];
    let status: WorkflowRunResult['status'] = 'SUCCEEDED';

    // Topologically sort nodes into parallel levels (DAG execution).
    // Nodes without `dependsOn` are linear (level 0 only has start, then each subsequent node).
    // Nodes with `dependsOn` group together when their deps are all satisfied.
    const levels = this.planExecutionLevels(input.nodes);
    let stepIndex = 0;

    outer: for (const level of levels) {
      // Execute all nodes in this level in parallel
      const promises = level.map(async (node) => {
        const result = await this.router.execute(node, execCtx);
        return { node, result };
      });
      const levelResults = await Promise.all(promises);

      for (const { node, result } of levelResults) {
        stepIndex++;
        nodeResults.push({
          nodeId: node.id,
          success: result.success,
          durationMs: result.durationMs,
          error: result.error,
        });

        await this.prisma.executionStep
          .create({
            data: {
              executionSessionId: session.id,
              stepKey: node.id,
              stepType: node.type as any,
              capabilityKey: node.capability,
              status: result.success ? 'SUCCEEDED' : 'FAILED',
              inputJson: (result.output ?? {}) as any,
              outputJson: (result.output ?? {}) as any,
              errorMessage: result.error,
              latencyMs: result.durationMs,
            },
          })
          .catch((e) => this.logger.warn(`Step record failed: ${e.message}`));
      }

      // Fail-fast: if any node in this level failed, stop.
      const failed = levelResults.find((r) => !r.result.success);
      if (failed) {
        status = 'FAILED';
        break outer;
      }

      // Human intervention pauses the workflow at this point.
      const paused = levelResults.find((r) => r.node.type === 'human' && r.result.output.waiting);
      if (paused) {
        status = 'BLOCKED';
        break outer;
      }
    }

    // 4. Finalize
    const totalDurationMs = Date.now() - start;
    await this.prisma.executionSession.update({
      where: { id: session.id },
      data: {
        status,
        completedAt: status !== 'BLOCKED' ? new Date() : null,
        latencyMs: totalDurationMs,
        outputJson: execCtx.state as any,
      },
    });

    if (missionId && status === 'SUCCEEDED') {
      await this.missions
        .complete(ctx, missionId, 'SUCCEEDED', '워크플로우 정상 완료')
        .catch(() => {});
    } else if (missionId && status === 'FAILED') {
      await this.missions.complete(ctx, missionId, 'FAILED', '워크플로우 실패').catch(() => {});
    }

    return {
      executionSessionId: session.id,
      missionId,
      correlationId,
      status,
      nodeResults,
      finalState: execCtx.state,
      totalDurationMs,
    };
  }

  /**
   * Topologically sort nodes into execution levels.
   *
   * Rules:
   *   - A node without `dependsOn` and not referenced by any dependsOn runs at the earliest
   *     level where all its prerequisites have completed.
   *   - Nodes at the same level execute in parallel.
   *   - If no `dependsOn` is specified anywhere, the input order is preserved (linear backward-compat).
   *
   * Throws if a cycle is detected.
   */
  private planExecutionLevels(nodes: WorkflowNode[]): WorkflowNode[][] {
    const hasAnyDependency = nodes.some((n) => n.dependsOn && n.dependsOn.length > 0);
    if (!hasAnyDependency) {
      // Linear fallback: each node its own level in declaration order
      return nodes.map((n) => [n]);
    }

    const remaining = new Set(nodes.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const levels: WorkflowNode[][] = [];
    const completed = new Set<string>();

    while (remaining.size > 0) {
      const level: WorkflowNode[] = [];
      for (const nid of remaining) {
        const n = byId.get(nid)!;
        const deps = n.dependsOn ?? [];
        if (deps.every((d) => completed.has(d))) {
          level.push(n);
        }
      }
      if (level.length === 0) {
        // Cycle detected
        throw new Error(
          `Workflow DAG cycle or unsatisfiable dependency detected. Remaining: ${Array.from(remaining).join(', ')}`,
        );
      }
      for (const n of level) {
        completed.add(n.id);
        remaining.delete(n.id);
      }
      levels.push(level);
    }
    return levels;
  }
}
