/**
 * Workflow Service — orchestrates draft execution and node resolution.
 *
 * This is the core Step 1 service that bridges:
 *   Frontend builder nodes → NodeResolutionRegistry → WorkflowExecutionBridge → WorkflowRunnerService
 *
 * Future phases will add:
 *   - Workflow CRUD (save, update, delete)
 *   - Version management
 *   - OCC / draft locking
 */
import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  WorkflowExecutionBridge,
  ExecuteDraftInput,
  DraftNodeInput,
} from './workflow-execution-bridge.service';
import { WorkflowRunnerService, WorkflowRunResult } from '../execution/workflow-runner.service';
import { PipelineEngine, PipelineNode } from '../workflow-nodes/pipeline-engine';
import { IngestService } from '../ingest/ingest.service';
import type { ResolvedNode } from './node-resolution.registry';

// ── Helpers ──

/**
 * 외부 agent가 보고한 timings(dict, *_s 초 단위)를 실행 상세의 「단계」로 쓸
 * 구간 배열로 변환한다. 벽시계 기준으로 합이 total 에 수렴하도록 LLM 병렬
 * 구간(llm_wall_s)을 하나로 묶고, 개별 콜은 합산하지 않는다. test-agent 의
 * 키 구조를 알지만, 모르는 키도 best-effort 로 라벨링한다.
 */
export function buildSegmentsFromTimings(
  timings: any,
): Array<{ key: string; type?: string; ms: number }> {
  if (!timings || typeof timings !== 'object') return [];
  const s = (v: any) => Math.max(0, Math.round((Number(v) || 0) * 1000));
  const out: Array<{ key: string; type?: string; ms: number }> = [];
  const push = (key: string, type: string, sec: any) => {
    const ms = s(sec);
    if (ms > 0) out.push({ key, type, ms });
  };
  // 알려진 구조(test-agent) 우선 — 벽시계 합이 total 에 수렴.
  push('정적·동적 분석', 'analysis', timings.analysis_s);
  if (timings.llm_wall_s != null) {
    push('LLM 리뷰(병렬 3콜)', 'llm', timings.llm_wall_s);
  } else {
    push('LLM 요약', 'llm', timings.llm1_summary_s);
    push('LLM 리스크', 'llm', timings.llm2_risk_s);
    push('LLM 권고', 'llm', timings.llm3_recommend_s);
  }
  const post =
    (Number(timings.ledger_telemetry_s) || 0) + (Number(timings.report_write_s) || 0);
  if (post > 0) out.push({ key: '집계·기록', type: 'io', ms: s(post) });
  return out;
}

// ── Response Types ──

export interface ExecuteDraftResponse {
  /** Execution results from the runner */
  execution: WorkflowRunResult;
  /** How each node was resolved */
  nodeResolutions: Array<{
    nodeKey: string;
    nodeName: string;
    uiType: string;
    executionType: string;
    capability: string;
    intentCategory: string;
    inputMapping: Record<string, string>;
  }>;
  /** Connector availability check */
  connectorStatus: {
    allAvailable: boolean;
    missing: string[];
  };
  /** Any warnings generated during resolution */
  warnings: string[];
}

export interface ResolveNodesResponse {
  nodes: Array<{
    nodeKey: string;
    uiType: string;
    executionType: string;
    capability: string;
    intentCategory: string;
    riskLevel: string;
    outputKeys: string[];
    inputMapping: Record<string, string>;
  }>;
  /** Which connector keys are needed */
  requiredConnectors: string[];
}

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly bridge: WorkflowExecutionBridge,
    private readonly runner: WorkflowRunnerService,
    private readonly pipeline: PipelineEngine,
    private readonly ingest: IngestService,
  ) {}

  /**
   * 외부 전용 화면 Agent 실행 (metis가 서버에서 그 agent의 분석 기능을 호출하고 결과를 기록).
   *
   * agent의 effectivenessJson.launchUrl 을 베이스로 `{base}/api/test` 를 호출한다(FinOps
   * 테스트에이전트 계약: { filename, code } → { markdown, cost_usd, mode }). 결과를 metis
   * Ingest(/ingest/runs)로 기록 → ExecutionSession + 4Gate(품질·보안·비용·이상)가 대시보드/이력에 남는다.
   * 사용자는 별도 포트를 직접 다루지 않고 metis 안에서 실행/조회한다.
   */
  /**
   * 임베드된 외부 화면(iframe)이 실행을 끝낸 뒤 postMessage로 넘긴 결과를 metis에 기록한다.
   * 화면은 사용자가 metis 안에서 그대로 보고, 실행 결과(비용·품질·보안·이상 4Gate + 이력)는
   * metis 대시보드에 남는다. (서버가 외부를 호출하지 않음 — 화면이 이미 실행한 결과를 기록만)
   */
  /**
   * AI 활동 로그(AuditLog)에 Agent 실행 1건을 명시적으로 남긴다.
   * 글로벌 AuditInterceptor(@Audit)와 별개로, 에이전트 이름·모델·비용 등
   * 의미있는 메타데이터를 가진 EXECUTE/Agent 항목을 보장한다. best-effort.
   */
  private async writeRunAudit(
    ctx: TenantContext,
    meta: {
      workflowKey: string;
      agentName: string;
      model?: string;
      costUsd?: number;
      latencyMs?: number;
      status?: string;
      executionSessionId?: string | null;
      source?: string;
    },
  ): Promise<void> {
    try {
      await (this.prisma as any).auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId ?? null,
          action: 'EXECUTE' as any,
          targetType: 'Agent',
          targetId: meta.workflowKey,
          correlationId: meta.executionSessionId ?? `run-${Date.now()}`,
          metadataJson: {
            agentName: meta.agentName,
            workflowKey: meta.workflowKey,
            model: meta.model ?? null,
            costUsd: meta.costUsd ?? 0,
            latencyMs: meta.latencyMs ?? 0,
            status: meta.status ?? 'COMPLETED',
            executionSessionId: meta.executionSessionId ?? null,
            source: meta.source ?? 'external-screen',
          },
        },
      });
    } catch (e) {
      this.logger.warn(`AI 활동 로그 기록 실패: ${(e as Error).message}`);
    }
  }

  /**
   * 외부 실행이 보고한 구간별 소요(steps)를 ExecutionStep 행으로 저장한다.
   * 저장되면 실행 상세(/dashboard/executions/:id)의 「단계」에 구간별로 표시된다.
   * startedAt/endedAt 은 세션 시작 시각부터 순차로 누적해 타임라인을 만든다.
   * best-effort: 실패해도 실행 기록 자체를 깨뜨리지 않는다.
   */
  private async writeExternalSteps(
    sessionId: string,
    sessionStart: Date,
    steps: Array<{ key: string; type?: string; ms?: number; status?: string }>,
  ): Promise<void> {
    if (!sessionId || !Array.isArray(steps) || steps.length === 0) return;
    try {
      let cursor = sessionStart.getTime();
      const rows = steps
        .filter((s) => s && s.key)
        .map((s, i) => {
          const ms = Math.max(0, Math.round(Number(s.ms) || 0));
          const startedAt = new Date(cursor);
          cursor += ms;
          const endedAt = new Date(cursor);
          return {
            executionSessionId: sessionId,
            stepKey: String(s.key).slice(0, 120),
            stepType: (s.type || 'segment').toString().slice(0, 40),
            status: (s.status || 'SUCCEEDED') as any,
            latencyMs: ms,
            startedAt,
            endedAt,
            inputJson: { order: i + 1 } as any,
          };
        });
      if (rows.length > 0) {
        await (this.prisma as any).executionStep.createMany({ data: rows });
      }
    } catch (e) {
      this.logger.warn(`구간(step) 기록 실패: ${(e as Error).message}`);
    }
  }

  async recordExternalRun(
    ctx: TenantContext,
    body: {
      workflowKey: string;
      input?: string;
      output?: string;
      model?: string;
      costUsd?: number;
      latencyMs?: number;
      steps?: Array<{ key: string; type?: string; ms?: number; status?: string }>;
      /** 외부 agent가 보고한 구간 타이밍(dict, *_s). steps 미제공 시 이걸로 구간 생성. */
      timings?: any;
    },
  ): Promise<any> {
    const wf = await (this.prisma as any).workflow.findFirst({
      where: { tenantId: ctx.tenantId, key: body.workflowKey, deletedAt: null },
      select: { key: true, name: true },
    });
    const name = wf?.name ?? body.workflowKey;
    let executionSessionId: string | null = null;
    try {
      const ing = await this.ingest.ingestRuns(
        ctx.tenantId,
        [
          {
            agentName: name,
            workflowKey: body.workflowKey,
            input: (body.input || '').toString().slice(0, 8000),
            output: (body.output || '').toString().slice(0, 20000),
            model: body.model || 'external',
            costUsd: Number(body.costUsd) || 0,
            latencyMs: Number(body.latencyMs) || 0,
            status: 'COMPLETED',
          } as any,
        ],
        { wait: true } as any,
      );
      const r0: any = ing?.results?.[0];
      executionSessionId = r0?.executionSessionId ?? r0?.sessionId ?? null;
    } catch (e) {
      this.logger.warn(`external-record 기록 실패: ${(e as Error).message}`);
    }
    const segs =
      Array.isArray(body.steps) && body.steps.length > 0
        ? body.steps
        : buildSegmentsFromTimings(body.timings);
    if (executionSessionId && segs.length > 0) {
      const lat = Number(body.latencyMs) || 0;
      const start = new Date(Date.now() - lat);
      await this.writeExternalSteps(executionSessionId, start, segs);
    }
    await this.writeRunAudit(ctx, {
      workflowKey: body.workflowKey,
      agentName: name,
      model: body.model,
      costUsd: Number(body.costUsd) || 0,
      latencyMs: Number(body.latencyMs) || 0,
      status: 'COMPLETED',
      executionSessionId,
      source: 'external-screen',
    });
    return { execution: { executionSessionId, status: 'COMPLETED' } };
  }

  async runExternalAgent(
    ctx: TenantContext,
    workflowKey: string,
    body: { filename?: string; code?: string; input?: string },
  ): Promise<any> {
    const wf = await (this.prisma as any).workflow.findFirst({
      where: { tenantId: ctx.tenantId, key: workflowKey, deletedAt: null },
      select: { key: true, name: true, effectivenessJson: true },
    });
    if (!wf) throw new BadRequestException(`Agent를 찾을 수 없습니다: ${workflowKey}`);
    const base =
      wf.effectivenessJson && typeof wf.effectivenessJson === 'object'
        ? (wf.effectivenessJson as any).launchUrl
        : null;
    if (!base) {
      throw new BadRequestException(
        '이 Agent에는 실행 화면(launchUrl)이 설정되지 않았습니다. 기준정보에서 「전용 실행 화면 URL」을 입력하세요.',
      );
    }
    const code = (body.code ?? body.input ?? '').toString();
    const filename = (body.filename || 'input.py').toString();
    const trimmed = String(base).replace(/\/+$/, '');
    // 베이스만 넣어도, /api/test 까지 넣어도 동작하도록 보정.
    const apiUrl = /\/api\/test$/.test(trimmed) ? trimmed : `${trimmed}/api/test`;

    const t0 = Date.now();
    let result: any;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename, code }),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      result = await r.json();
    } catch (e: any) {
      throw new BadRequestException(`외부 실행 화면 호출 실패 (${apiUrl}): ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - t0;
    const output = (result?.markdown as string) || JSON.stringify(result ?? {});
    const costUsd = Number(result?.cost_usd) || 0;
    const mode = (result?.mode as string) || 'external';

    // metis 기록(4Gate 평가 포함). wait=true 로 동기 처리해 세션 ID를 받는다.
    let executionSessionId: string | null = null;
    try {
      const ing = await this.ingest.ingestRuns(
        ctx.tenantId,
        [
          {
            agentName: wf.name ?? workflowKey,
            workflowKey,
            input: code.slice(0, 8000),
            output: output.slice(0, 20000),
            model: mode,
            costUsd,
            latencyMs,
            status: 'COMPLETED',
          } as any,
        ],
        { wait: true } as any,
      );
      const res0: any = ing?.results?.[0];
      executionSessionId = res0?.executionSessionId ?? res0?.sessionId ?? null;
    } catch (e) {
      this.logger.warn(`run-external 기록 실패: ${(e as Error).message}`);
    }
    if (executionSessionId) {
      const steps = buildSegmentsFromTimings(result?.timings);
      if (steps.length > 0) {
        await this.writeExternalSteps(executionSessionId, new Date(t0), steps);
      }
    }
    await this.writeRunAudit(ctx, {
      workflowKey,
      agentName: wf.name ?? workflowKey,
      model: mode,
      costUsd,
      latencyMs,
      status: 'COMPLETED',
      executionSessionId,
      source: 'external-screen',
    });

    return {
      execution: { executionSessionId, status: 'COMPLETED' },
      finalOutput: output,
      costUsd,
      mode,
    };
  }

  /**
   * Execute a draft workflow from builder canvas.
   *
   * Full pipeline:
   *   1. Validate input nodes
   *   2. Resolve nodes via NodeResolutionRegistry
   *   3. Infer data flow (inputMapping)
   *   4. Check connector availability
   *   5. Build RunWorkflowInput
   *   6. Execute via WorkflowRunnerService
   *   7. Return results with resolution metadata
   */
  async executeDraft(ctx: TenantContext, input: ExecuteDraftInput): Promise<ExecuteDraftResponse> {
    // 1. Validate
    if (!input.nodes || input.nodes.length === 0) {
      throw new BadRequestException('워크플로우에 노드가 없습니다.');
    }

    // Sanitize node names
    for (const node of input.nodes) {
      if (!node.nodeKey || !node.uiType) {
        throw new BadRequestException(`노드에 nodeKey 또는 uiType이 누락되었습니다.`);
      }
      if (!node.name) {
        node.name = `${node.uiType}-${node.executionOrder}`;
      }
    }

    this.logger.log(
      `[execute-draft] tenant=${ctx.tenantId} user=${ctx.userId} ` +
        `nodes=${input.nodes.length} title="${input.title || 'untitled'}"`,
    );

    // 2-5. Resolve and build via bridge
    const bridgeResult = await this.bridge.buildRunInput(ctx, input);

    // Log resolution summary
    const typeSummary = bridgeResult.resolvedNodes
      .map((r, i) => `${input.nodes[i].name}(${r.uiType}→${r.executionType}:${r.capability})`)
      .join(', ');
    this.logger.log(`[execute-draft] Resolved: ${typeSummary}`);

    // 6. Execute
    let execution: WorkflowRunResult;
    try {
      execution = await this.runner.run(ctx, bridgeResult.runInput);
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`[execute-draft] Runner failed: ${msg}`);
      throw new BadRequestException(`워크플로우 실행 실패: ${msg}`);
    }

    // 7. Build response with resolution metadata
    const nodeResolutions = input.nodes.map((node, idx) => {
      const resolved = bridgeResult.resolvedNodes[idx];
      return {
        nodeKey: node.nodeKey,
        nodeName: node.name,
        uiType: node.uiType,
        executionType: resolved.executionType,
        capability: resolved.capability,
        intentCategory: resolved.intentCategory,
        inputMapping: resolved.inputMapping,
      };
    });

    this.logger.log(
      `[execute-draft] Completed: status=${execution.status} ` +
        `duration=${execution.totalDurationMs}ms ` +
        `succeeded=${execution.nodeResults.filter((r) => r.success).length}/${execution.nodeResults.length}`,
    );

    return {
      execution,
      nodeResolutions,
      connectorStatus: {
        allAvailable: bridgeResult.connectorValidation.valid,
        missing: bridgeResult.connectorValidation.missingConnectors.map((m) => m.connectorKey),
      },
      warnings: bridgeResult.warnings,
    };
  }

  /**
   * 저장된 Agent(워크플로우)를 key로 로드해 **빌더 이동 없이 즉시 실행**한다.
   * 실제 노드 실행기 + 4Gate 평가기를 가진 PipelineEngine 경로를 타므로 노드별
   * 4Gate(품질·보안·비용·이상)가 평가·기록(AgentEvaluation)되고 대시보드/실행 상세에 반영된다.
   */
  async runSavedWorkflow(ctx: TenantContext, workflowKey: string, input?: string): Promise<any> {
    const wf = await (this.prisma as any).workflow.findFirst({
      where: { tenantId: ctx.tenantId, key: workflowKey, deletedAt: null },
      select: {
        key: true,
        name: true,
        nodes: {
          select: {
            nodeKey: true,
            uiType: true,
            name: true,
            executionOrder: true,
            configJson: true,
          },
          orderBy: { executionOrder: 'asc' },
        },
      },
    });
    if (!wf) throw new BadRequestException(`Agent(워크플로우)를 찾을 수 없습니다: ${workflowKey}`);
    if (!wf.nodes?.length) throw new BadRequestException('이 Agent에 실행할 Sub-Agent(노드)가 없습니다.');

    // 실제 노드 실행기(NodeExecutorRegistry) + 4Gate 평가기(EvaluatorService)를 가진
    // PipelineEngine으로 실행한다. AgentDispatcher 경로(executeDraft)가 아니라 이 경로라야
    // 노드별 AgentEvaluation(품질·보안·비용·이상)이 기록되고 대시보드/실행 상세에 반영된다.
    const nodes: PipelineNode[] = wf.nodes.map((n: any, i: number) => {
      const settings = (n.configJson as Record<string, any>) ?? {};
      return {
        id: n.nodeKey,
        type: n.uiType,
        name: n.name ?? n.nodeKey,
        order: n.executionOrder ?? i,
        settings,
      };
    });

    const result = await this.pipeline.execute({
      workflowId: wf.key,
      title: wf.name ?? workflowKey,
      nodes,
      tenantId: ctx.tenantId,
      userId: ctx.userId ?? 'system',
      initialInput: input,
    });

    // 프런트(AgentCategoryView)는 execution.executionSessionId / status 만 사용한다.
    return {
      execution: {
        executionSessionId: result.executionSessionId,
        status: result.status,
        totalDurationMs: result.totalDurationMs,
      },
      nodeResults: result.nodeResults.map((r) => ({
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        nodeType: r.nodeType,
        success: r.success,
        durationMs: r.durationMs,
        error: r.error,
      })),
      finalOutput: result.finalOutput,
    };
  }

  /**
   * Preview node resolution without executing.
   * Used by the frontend to display capability badges and data flow arrows.
   */
  async resolveNodes(ctx: TenantContext, nodes: DraftNodeInput[]): Promise<ResolveNodesResponse> {
    if (!nodes || nodes.length === 0) {
      return { nodes: [], requiredConnectors: [] };
    }

    const resolved = this.bridge.resolveNodes(nodes);

    const requiredConnectors = new Set<string>();
    const response = nodes.map((node, idx) => {
      const r = resolved[idx];
      const entry = this.bridge['registry'].getEntry(node.uiType);
      if (entry?.requiredConnectorKey) {
        requiredConnectors.add(entry.requiredConnectorKey);
      }
      return {
        nodeKey: node.nodeKey,
        uiType: node.uiType,
        executionType: r.executionType,
        capability: r.capability,
        intentCategory: r.intentCategory,
        riskLevel: r.riskLevel,
        outputKeys: r.outputKeys,
        inputMapping: r.inputMapping,
      };
    });

    return {
      nodes: response,
      requiredConnectors: Array.from(requiredConnectors),
    };
  }
}
