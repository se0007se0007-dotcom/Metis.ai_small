/**
 * Pipeline Engine
 *
 * Orchestrates real sequential execution of workflow nodes.
 * Each node receives the accumulated output from all previous nodes.
 * Results are stored in ExecutionSession/ExecutionStep for audit.
 *
 * This is the bridge between the frontend workflow builder and
 * the actual node executors.
 */
import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import {
  NodeExecutorRegistry,
  NodeExecutionInput,
  NodeExecutionOutput,
  UploadedFileInfo,
} from './node-executor-registry';
import { EvaluatorService } from '../evaluator/evaluator.service';
import { RuntimeGovernanceService } from '../governance/runtime-governance.service';
import { KnowledgeCaptureService } from '../evaluator/feedback/knowledge-capture.service';
import {
  EffectivenessSignalService,
  parseSignalFromOutput,
} from '../metrics/effectiveness-signal.service';

export interface PipelineNode {
  id: string;
  type: string;
  name: string;
  order: number;
  settings: Record<string, any>;
}

export interface PipelineExecutionRequest {
  workflowId?: string;
  title: string;
  nodes: PipelineNode[];
  tenantId: string;
  userId: string;
  /** Pre-uploaded files to feed to input nodes */
  uploadedFiles?: UploadedFileInfo[];
  /** 사용자가 실행 화면에서 입력한 초기 입력(첫 노드의 previousOutput/컨텍스트로 주입). */
  initialInput?: string;
}

export interface PipelineNodeResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  success: boolean;
  output: NodeExecutionOutput;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: string;
}

export interface PipelineResult {
  executionSessionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL';
  nodeResults: PipelineNodeResult[];
  finalOutput: string;
  generatedFiles: Array<{ name: string; path: string; format: string; downloadUrl?: string }>;
  totalDurationMs: number;
}

export type PipelineProgressCallback = (event: {
  type: 'node_start' | 'node_complete' | 'node_error' | 'pipeline_complete';
  nodeId?: string;
  nodeName?: string;
  progress: number;
  data?: any;
}) => void;

@Injectable()
export class PipelineEngine {
  private readonly logger = new Logger(PipelineEngine.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly registry: NodeExecutorRegistry,
    @Optional() private readonly evaluatorService?: EvaluatorService,
    @Optional() private readonly knowledgeCapture?: KnowledgeCaptureService,
    @Optional() private readonly effectivenessSignalService?: EffectivenessSignalService,
    @Optional() private readonly runtimeGovernance?: RuntimeGovernanceService,
  ) {}

  /**
   * Execute a complete workflow pipeline sequentially.
   */
  async execute(
    request: PipelineExecutionRequest,
    onProgress?: PipelineProgressCallback,
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const sortedNodes = [...request.nodes].sort((a, b) => a.order - b.order);

    // Create execution session
    const session = await this.prisma.executionSession.create({
      data: {
        tenantId: request.tenantId,
        workflowKey: request.workflowId || `adhoc-${Date.now()}`,
        triggeredById: request.userId,
        status: 'RUNNING',
        correlationId: `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        inputJson: { title: request.title, nodeCount: sortedNodes.length } as any,
      },
    });

    const nodeResults: PipelineNodeResult[] = [];
    const pipelineData: Record<string, NodeExecutionOutput> = {};
    // 사용자 실행 입력을 첫 노드의 컨텍스트(previousOutput)로 주입.
    let accumulatedText = (request.initialInput || '').toString();
    let allGeneratedFiles: PipelineResult['generatedFiles'] = [];
    let hasFailed = false;
    let governanceHaltReason: string | null = null;

    for (let i = 0; i < sortedNodes.length; i++) {
      const node = sortedNodes[i];
      const category = node.settings?.stepCategory || '';

      // Emit progress
      onProgress?.({
        type: 'node_start',
        nodeId: node.id,
        nodeName: node.name,
        progress: (i / sortedNodes.length) * 100,
      });

      // Find executor
      const executor = this.registry.resolve(node.type, category);
      if (!executor) {
        this.logger.warn(
          `No executor found for type="${node.type}" category="${category}", skipping node "${node.name}"`,
        );
        const skipResult: PipelineNodeResult = {
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          success: true,
          output: {
            success: true,
            data: { skipped: true, reason: 'No executor registered' },
            outputText: accumulatedText,
            durationMs: 0,
          },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        };
        nodeResults.push(skipResult);
        pipelineData[node.id] = skipResult.output;
        continue;
      }

      this.logger.log(
        `Node "${node.name}" (${node.type}:${category}) → executor: ${executor.executorKey}`,
      );

      // Build execution input
      const execInput: NodeExecutionInput = {
        nodeId: node.id,
        nodeType: node.type,
        nodeName: node.name,
        settings: node.settings,
        pipelineData,
        previousOutput: accumulatedText,
        uploadedFiles: request.uploadedFiles,
        tenantId: request.tenantId,
        userId: request.userId,
        executionSessionId: session.id,
      };

      const nodeStart = Date.now();
      let output: NodeExecutionOutput;

      try {
        output = await executor.execute(execInput);
      } catch (err) {
        const errorMsg = (err as Error).message || 'Unknown execution error';
        this.logger.error(`Node ${node.name} failed: ${errorMsg}`);
        output = {
          success: false,
          data: {},
          outputText: '',
          durationMs: Date.now() - nodeStart,
          error: errorMsg,
        };
      }

      const nodeEnd = Date.now();
      const durationMs = nodeEnd - nodeStart;

      // Store result
      const nodeResult: PipelineNodeResult = {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        success: output.success,
        output,
        startedAt: new Date(nodeStart).toISOString(),
        completedAt: new Date(nodeEnd).toISOString(),
        durationMs,
        error: output.error,
      };
      nodeResults.push(nodeResult);
      pipelineData[node.id] = output;

      // Accumulate text for downstream nodes
      if (output.outputText) {
        accumulatedText = output.outputText;
      }

      // Collect generated files
      if (output.generatedFiles?.length) {
        allGeneratedFiles.push(
          ...output.generatedFiles.map((f) => ({
            name: f.name,
            path: f.path,
            format: f.format,
            downloadUrl: f.downloadUrl,
          })),
        );
      }

      // Record execution step
      const persistedStep = await this.prisma.executionStep.create({
        data: {
          executionSessionId: session.id,
          stepKey: node.id,
          stepType: node.type,
          capabilityKey: executor?.executorKey || null,
          status: output.success ? 'SUCCEEDED' : 'FAILED',
          startedAt: new Date(Date.now() - durationMs),
          endedAt: new Date(),
          inputJson: {
            settings: node.settings,
            previousNodeCount: Object.keys(pipelineData).length,
          } as any,
          outputJson: { text: output.outputText?.slice(0, 2000), data: output.data } as any,
          errorMessage: output.error || null,
          latencyMs: durationMs,
        },
      });

      // ── Scenario 1 (Part A): KNOWLEDGE-IFY step failures ──
      // When a node FAILS, capture the error as durable knowledge so it can be
      // fed back to future runs. Best-effort: never blocks the pipeline.
      if (!output.success && this.knowledgeCapture) {
        try {
          await this.knowledgeCapture.captureFromStepError({
            tenantId: request.tenantId,
            workflowKey: session.workflowKey ?? request.workflowId ?? null,
            stepKey: node.id || `node-${i}`,
            agentName: executor?.displayName ?? null,
            errorMessage: output.error || 'step execution failed',
          });
        } catch (capErr) {
          this.logger.warn(
            `Knowledge capture (step error) failed for node ${node.id}: ${(capErr as Error).message}`,
          );
        }
      }

      // ── Evaluator Hook — evaluate node output after persistence ──
      if (this.evaluatorService) {
        try {
          const evalResult = await this.evaluatorService.evaluate({
            tenantId: request.tenantId,
            executionSessionId: session.id,
            stepKey: node.id || `node-${i}`,
            nodeType: node.type,
            // Sub-Agent(노드) 고유 이름 우선 — 대시보드에서 노드별로 구분되도록.
            agentName: node.name || executor.displayName,
            workflowKey: session.workflowKey ?? request.workflowId,
            input: execInput.previousOutput,
            output: output.outputText,
            executionTimeMs: output.durationMs,
            tokensUsed: output.data?.tokensUsed,
            model: output.data?.model,
            cacheHit: output.data?.cacheHit,
            estimatedCostUsd: output.data?.costUsd,
          });
          // Attach evaluation to node output data
          output.data = { ...output.data, evaluation: evalResult };

          // ── Runtime Governance Hook (Patent 1) ──────────────────
          // Profile → 5-gate decision → FDS alert → auto action →
          // evidence pack. BLOCK / QUARANTINE / REQUIRE_APPROVAL
          // halts the remaining nodes (실행 중 자동 차단).
          if (this.runtimeGovernance) {
            const governed = await this.runtimeGovernance.evaluateStep({
              ctx: {
                tenantId: request.tenantId,
                executionSessionId: session.id,
                executionStepId: persistedStep.id,
                workflowKey: session.workflowKey ?? request.workflowId,
                nodeKey: node.id || `node-${i}`,
                executionType: node.type,
                modelId: output.data?.model,
                userId: request.userId,
                output: output.outputText,
                tokensUsed: output.data?.tokensUsed,
                estimatedCostUsd: output.data?.costUsd,
                executionTimeMs: output.durationMs,
              },
              evaluation: evalResult,
            });
            if (governed) {
              output.data = { ...output.data, governance: governed };
              if (governed.haltPipeline) {
                this.logger.warn(
                  `[governance] ${governed.decision.decision} on node ${node.id} — pipeline halted`,
                );
                onProgress?.({
                  type: 'node_error',
                  nodeId: node.id,
                  nodeName: node.name,
                  progress: Math.round(((i + 1) / sortedNodes.length) * 100),
                  data: {
                    governanceDecision: governed.decision.decision,
                    reasons: governed.decision.reasons,
                  },
                });
                hasFailed = true;
                governanceHaltReason = `governance ${governed.decision.decision}: ${governed.decision.reasons.join('; ')}`.slice(
                  0,
                  500,
                );
                break;
              }
            }
          }
        } catch (evalErr) {
          // Never block pipeline on evaluation failure
          this.logger.warn(`Evaluation failed for node ${node.id}: ${(evalErr as Error).message}`);
        }
      }

      // ── Effectiveness Signal Hook — MEASURED MTTD / coverage source data ──
      //
      // Source #1 (agent-emit): an executor may attach a signal to its output:
      //   output.data.effectivenessSignal = { kind:'COVERAGE', testsTotal, testsPassed, coveragePct }
      //   output.data.effectivenessSignal = { kind:'DETECTION', occurredAt, detectedAt }
      // (shorthands output.data.coverage / output.data.detection are also read).
      // Persisted best-effort; pipeline never blocks on a signal failure.
      if (this.effectivenessSignalService) {
        try {
          const parsed = parseSignalFromOutput(output.data);
          if (parsed) {
            await this.effectivenessSignalService.record(request.tenantId, {
              ...parsed,
              workflowKey: session.workflowKey ?? request.workflowId ?? 'unknown',
              stepKey: node.id || `node-${i}`,
              executionSessionId: session.id,
              source: 'agent',
            });
          }
        } catch (sigErr) {
          this.logger.warn(
            `Effectiveness signal capture failed for node ${node.id}: ${(sigErr as Error).message}`,
          );
        }
      }

      // Emit progress
      onProgress?.({
        type: output.success ? 'node_complete' : 'node_error',
        nodeId: node.id,
        nodeName: node.name,
        progress: ((i + 1) / sortedNodes.length) * 100,
        data: { durationMs, success: output.success },
      });

      // Handle failure with retry logic
      if (!output.success) {
        const failAction = node.settings?.failureAction || 'continue';
        if (failAction === 'stop') {
          hasFailed = true;
          break;
        }
        if (failAction === 'retry') {
          const retryCount = node.settings?.retryCount || 2;
          let retried = false;
          for (let r = 0; r < retryCount; r++) {
            this.logger.log(`Retrying node ${node.name} (attempt ${r + 2})`);
            try {
              output = await executor.execute(execInput);
              if (output.success) {
                // Update the stored result
                nodeResults[nodeResults.length - 1] = {
                  ...nodeResult,
                  success: true,
                  output,
                  durationMs: Date.now() - nodeStart,
                };
                pipelineData[node.id] = output;
                if (output.outputText) accumulatedText = output.outputText;
                retried = true;
                break;
              }
            } catch {
              /* continue retrying */
            }
          }
          if (!retried) {
            hasFailed = true;
            if (failAction === 'stop') break;
          }
        }
      }
    }

    // Update session status + STANDARD metrics rollup (latency/cost).
    const totalDuration = Date.now() - startTime;
    const finalStatus = hasFailed
      ? 'FAILED'
      : nodeResults.every((r) => r.success)
        ? 'SUCCEEDED'
        : 'FAILED';

    // Sum per-node cost from accumulated outputs (each executor may report data.costUsd).
    const totalCostUsd = Object.values(pipelineData).reduce((s: number, o: any) => {
      const c = Number(o?.data?.costUsd);
      return s + (Number.isFinite(c) ? c : 0);
    }, 0);

    await this.prisma.executionSession.update({
      where: { id: session.id },
      data: {
        status: finalStatus,
        completedAt: new Date(),
        endedAt: new Date(),
        latencyMs: totalDuration,
        costUsd: totalCostUsd,
        outputJson: {
          nodeCount: nodeResults.length,
          successCount: nodeResults.filter((r) => r.success).length,
          failedCount: nodeResults.filter((r) => !r.success).length,
          ...(governanceHaltReason ? { governanceHalt: governanceHaltReason } : {}),
        } as any,
      },
    });

    // Emit final progress
    onProgress?.({
      type: 'pipeline_complete',
      progress: 100,
      data: { status: finalStatus, totalDurationMs: totalDuration, costUsd: totalCostUsd },
    });

    return {
      executionSessionId: session.id,
      status: finalStatus as PipelineResult['status'],
      nodeResults,
      finalOutput: accumulatedText,
      generatedFiles: allGeneratedFiles,
      totalDurationMs: totalDuration,
    };
  }

  /**
   * 단일 노드(sub-agent) 개별 실행 — 빌더의 "노드 테스트" 패널용.
   *
   * 워크플로 전체를 돌리지 않고 노드 하나만 실제 실행기로 수행한다. 실 실행기를
   * 그대로 호출하므로(목 아님) LLM/HTTP/파일/DB 작업이 실제로 일어난다. 호출자가
   * settings 와 previousOutput(이전 노드 산출물 샘플)을 직접 넣어 입력을 통제한다.
   * 감사를 위해 ExecutionSession/Step 을 남기고, 가능하면 품질 평가도 첨부한다.
   */
  async executeSingleNode(params: {
    nodeType: string;
    category?: string;
    nodeName?: string;
    settings?: Record<string, any>;
    previousOutput?: string;
    tenantId?: string;
    userId?: string;
    uploadedFiles?: UploadedFileInfo[];
    runEvaluation?: boolean;
  }): Promise<{
    resolved: boolean;
    executorKey?: string;
    displayName?: string;
    output?: NodeExecutionOutput;
    evaluation?: Record<string, any> | null;
    executionSessionId?: string;
    error?: string;
  }> {
    const settings = { ...(params.settings || {}) };
    const category = params.category || settings.stepCategory || '';
    if (category && !settings.stepCategory) settings.stepCategory = category;

    const executor = this.registry.resolve(params.nodeType, category);
    if (!executor) {
      return { resolved: false, error: `executor를 찾지 못했습니다: type="${params.nodeType}" category="${category}"` };
    }

    // 유효한 tenant FK 확보 (없으면 첫 테넌트로 폴백 — 테스트 편의).
    const tenantId = await this.resolveTenantId(params.tenantId);
    const userId = params.userId || 'node-test';

    const session = await this.prisma.executionSession.create({
      data: {
        tenantId,
        workflowKey: `nodetest-${Date.now()}`,
        triggeredById: userId,
        status: 'RUNNING',
        correlationId: `nodetest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        inputJson: { nodeType: params.nodeType, category, single: true } as any,
      },
    });

    const nodeId = `nodetest-${Math.random().toString(36).slice(2, 8)}`;
    const execInput: NodeExecutionInput = {
      nodeId,
      nodeType: params.nodeType,
      nodeName: params.nodeName || executor.displayName,
      settings,
      pipelineData: {},
      previousOutput: params.previousOutput || '',
      uploadedFiles: params.uploadedFiles,
      tenantId,
      userId,
      executionSessionId: session.id,
      isTest: true,
    };

    const start = Date.now();
    let output: NodeExecutionOutput;
    try {
      output = await executor.execute(execInput);
    } catch (err) {
      output = {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: (err as Error).message || '노드 실행 오류',
      };
    }
    const durationMs = Date.now() - start;

    // 감사 로그 (best-effort)
    try {
      await this.prisma.executionStep.create({
        data: {
          executionSessionId: session.id,
          stepKey: nodeId,
          stepType: params.nodeType,
          capabilityKey: executor.executorKey,
          status: output.success ? 'SUCCEEDED' : 'FAILED',
          startedAt: new Date(start),
          endedAt: new Date(),
          inputJson: { settings, previousOutputChars: execInput.previousOutput.length } as any,
          outputJson: { text: output.outputText?.slice(0, 2000), data: output.data } as any,
          errorMessage: output.error || null,
          latencyMs: durationMs,
        },
      });
    } catch (e) {
      this.logger.warn(`node-test step persist 실패: ${(e as Error).message}`);
    }

    // 품질 평가 (선택, best-effort) — 노드 테스트에서도 품질·FinOps 폐루프를 보여준다.
    let evaluation: Record<string, any> | null = null;
    if (params.runEvaluation !== false && this.evaluatorService && output.success && output.outputText) {
      try {
        const ev = await this.evaluatorService.evaluate({
          tenantId,
          executionSessionId: session.id,
          stepKey: nodeId,
          nodeType: params.nodeType,
          agentName: executor.displayName,
          workflowKey: session.workflowKey ?? undefined,
          input: execInput.previousOutput,
          output: output.outputText,
          executionTimeMs: output.durationMs,
          tokensUsed: output.data?.tokensUsed,
          model: output.data?.model,
          cacheHit: output.data?.cacheHit,
          estimatedCostUsd: output.data?.costUsd,
          // 노드 테스트: 4게이트는 계산하고 기록(isTest 태그)도 남기되, 운영 지표
          // (이상동작 베이스라인·FinOps 원장·알람·지식)에서는 제외.
          excludeFromMetrics: true,
        });
        // 4게이트(비용·품질·보안·이상동작) 전체 분해 결과를 반환 → 테스트 화면에 표시.
        evaluation = {
          overallScore: ev.overallScore,
          qualityGrade: ev.quality.qualityGrade,
          gatesApplied: ev.gatesApplied,
          gates: {
            quality: {
              grade: ev.quality.qualityGrade,
              score: ev.overallScore,
              accuracy: ev.quality.accuracyScore,
              hallucinationRate: ev.quality.hallucinationRate,
            },
            security: {
              score: ev.security.securityScore,
              riskLevel: ev.security.securityRiskLevel,
              threats: ev.security.inputThreatCount,
              leaks: ev.security.outputLeakageCount,
            },
            cost: {
              costUsd: ev.cost.costUsd,
              efficiency: ev.cost.costEfficiency,
              latencyGrade: ev.cost.latencyGrade,
            },
            anomaly: {
              detected: ev.anomaly.anomalyDetected,
              count: ev.anomaly.events.length,
            },
          },
        };
      } catch (e) {
        this.logger.warn(`node-test 평가 실패: ${(e as Error).message}`);
      }
    }

    await this.prisma.executionSession.update({
      where: { id: session.id },
      data: {
        status: output.success ? 'SUCCEEDED' : 'FAILED',
        completedAt: new Date(),
        endedAt: new Date(),
        latencyMs: durationMs,
        costUsd: Number(output.data?.costUsd) || 0,
      },
    }).catch(() => undefined);

    return {
      resolved: true,
      executorKey: executor.executorKey,
      displayName: executor.displayName,
      output,
      evaluation,
      executionSessionId: session.id,
    };
  }

  /** 주어진 tenantId 가 존재하면 그대로, 없으면 가장 오래된 테넌트로 폴백(테스트 편의). */
  private async resolveTenantId(tenantId?: string): Promise<string> {
    if (tenantId) {
      const t = await (this.prisma as any).tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (t) return t.id;
    }
    const first = await (this.prisma as any).tenant.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!first) throw new Error('테넌트가 없습니다. 먼저 시드/온보딩이 필요합니다.');
    return first.id;
  }
}
