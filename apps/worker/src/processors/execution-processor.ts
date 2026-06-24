/**
 * Execution Processor — Phase 2 Capability Runtime
 *
 * Handles execution jobs dispatched by ExecutionService:
 *   1. Load execution session context
 *   2. Resolve pack manifest capabilities/workflows
 *   3. Execute steps sequentially (with cancellation checks)
 *   4. Record ExecutionStep and ExecutionTrace
 *   5. Enforce timeout from manifest runtime config
 *   6. Update final status (SUCCEEDED / FAILED / CANCELLED)
 */

import { Job } from 'bullmq';
import { PrismaClient } from '@metis/database';
import { resolveSteps, ResolvedStepResult } from '../runtime/step-resolver';

export interface ExecutionJobData {
  executionSessionId: string;
  tenantId: string;
  userId: string;
  packInstallationId?: string;
  capabilityKey?: string;
  workflowKey?: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Run a single execution job.
 */
export async function runExecution(
  job: Job<ExecutionJobData>,
  prisma: PrismaClient,
): Promise<{
  sessionId: string;
  status: string;
  stepsCompleted: number;
  latencyMs: number;
}> {
  const { executionSessionId, timeoutMs = 300_000 } = job.data;
  const startTime = Date.now();

  // Update status to RUNNING
  await prisma.executionSession.update({
    where: { id: executionSessionId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  await job.updateProgress(5);

  // Load execution context
  const session = await prisma.executionSession.findUnique({
    where: { id: executionSessionId },
  });

  if (!session) {
    throw new Error(`Execution session ${executionSessionId} not found`);
  }

  // Resolve REAL steps to execute (loads AgentDefinition / pack manifest).
  const steps = await resolveSteps(prisma, {
    tenantId: job.data.tenantId,
    capabilityKey: job.data.capabilityKey,
    workflowKey: job.data.workflowKey,
    packInstallationId: job.data.packInstallationId,
    executionSessionId,
    input: job.data.input,
  });
  const totalSteps = steps.length;
  let completedSteps = 0;
  let totalCostUsd = 0;

  // Create initial trace
  await createTrace(prisma, executionSessionId, 'EXECUTION_START', {
    steps: steps.map((s) => s.key),
    input: job.data.input,
    timeoutMs,
  });

  try {
    for (let i = 0; i < totalSteps; i++) {
      const step = steps[i];
      const stepStartTime = Date.now();

      // Check cancellation before each step
      const cancelled = await isCancelled(prisma, executionSessionId);
      if (cancelled) {
        await createTrace(prisma, executionSessionId, 'CANCELLATION_DETECTED', {
          atStep: step.key,
          completedSteps,
        });
        return {
          sessionId: executionSessionId,
          status: 'CANCELLED',
          stepsCompleted: completedSteps,
          latencyMs: Date.now() - startTime,
        };
      }

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        await markSessionFailed(
          prisma,
          executionSessionId,
          startTime,
          `Timeout after ${timeoutMs}ms`,
        );
        await createTrace(prisma, executionSessionId, 'TIMEOUT', {
          atStep: step.key,
          elapsedMs: Date.now() - startTime,
        });
        throw new Error(`Execution timed out after ${timeoutMs}ms at step "${step.key}"`);
      }

      // Create step record (IN_PROGRESS)
      const stepRecord = await prisma.executionStep.create({
        data: {
          executionSessionId,
          stepKey: step.key,
          stepType: step.type,
          status: 'RUNNING',
          startedAt: new Date(),
          inputJson: job.data.input ? JSON.parse(JSON.stringify(job.data.input)) : {},
        },
      });

      try {
        // Execute step handler (real agent / LLM / REST / deterministic no-op)
        const result: ResolvedStepResult = await step.run(job.data.input ?? {});
        const output = result.output;

        const stepLatency = Date.now() - stepStartTime;

        // Record real LLM cost to FinOps when this step made an LLM call.
        if (result.llm) {
          totalCostUsd += result.llm.costUsd;
          await recordFinOps(prisma, {
            tenantId: job.data.tenantId,
            agentName: step.capabilityKey ?? step.key,
            executionSessionId,
            nodeId: step.key,
            llm: result.llm,
            responseTimeMs: stepLatency,
          });
        }

        // Update step as SUCCEEDED (real latency persisted)
        await prisma.executionStep.update({
          where: { id: stepRecord.id },
          data: {
            status: 'SUCCEEDED',
            endedAt: new Date(),
            latencyMs: stepLatency,
            outputJson: JSON.parse(JSON.stringify(output)) as any,
          },
        });

        completedSteps++;
        await job.updateProgress(5 + Math.round((completedSteps / totalSteps) * 90));

        // Create trace for step completion
        await createTrace(prisma, executionSessionId, 'STEP_COMPLETED', {
          stepKey: step.key,
          stepType: step.type,
          latencyMs: stepLatency,
          costUsd: result.llm?.costUsd ?? 0,
          model: result.llm?.model,
          outputSummary: Object.keys(output),
        });
      } catch (stepError: any) {
        // Step failed
        await prisma.executionStep.update({
          where: { id: stepRecord.id },
          data: {
            status: 'FAILED',
            endedAt: new Date(),
            errorMessage: stepError.message,
          },
        });

        await createTrace(prisma, executionSessionId, 'STEP_FAILED', {
          stepKey: step.key,
          error: stepError.message,
        });

        throw stepError; // Propagate to mark session as failed
      }
    }

    // All steps completed — mark as SUCCEEDED
    const latencyMs = Date.now() - startTime;
    await prisma.executionSession.update({
      where: { id: executionSessionId },
      data: {
        status: 'SUCCEEDED',
        endedAt: new Date(),
        latencyMs,
        costUsd: totalCostUsd,
        outputJson: JSON.parse(
          JSON.stringify({ stepsCompleted: completedSteps, totalSteps, costUsd: totalCostUsd }),
        ) as any,
      },
    });

    await job.updateProgress(100);
    await createTrace(prisma, executionSessionId, 'EXECUTION_COMPLETED', {
      stepsCompleted: completedSteps,
      latencyMs,
      costUsd: totalCostUsd,
    });

    return {
      sessionId: executionSessionId,
      status: 'SUCCEEDED',
      stepsCompleted: completedSteps,
      latencyMs,
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;

    // Check if already cancelled
    const currentSession = await prisma.executionSession.findUnique({
      where: { id: executionSessionId },
      select: { status: true },
    });

    if (currentSession?.status !== 'CANCELLED') {
      await markSessionFailed(prisma, executionSessionId, startTime, error.message);
    }

    await createTrace(prisma, executionSessionId, 'EXECUTION_FAILED', {
      error: error.message,
      stepsCompleted: completedSteps,
      latencyMs,
    });

    throw error;
  }
}

// ── Helpers ──

/**
 * Persist a real LLM call's token usage and cost to FinOpsTokenLog so the
 * FinOps dashboard reflects actual spend per execution (no more estimate-only
 * rows). originalCostUsd == optimizedCostUsd here because the worker path does
 * not yet route through the API cache/router gates.
 */
async function recordFinOps(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    agentName: string;
    executionSessionId: string;
    nodeId: string;
    responseTimeMs: number;
    llm: {
      model: string;
      provider: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      costUsd: number;
    };
  },
): Promise<void> {
  await prisma.finOpsTokenLog
    .create({
      data: {
        tenantId: args.tenantId,
        agentName: args.agentName,
        executionSessionId: args.executionSessionId,
        nodeId: args.nodeId,
        promptTokens: args.llm.promptTokens,
        completionTokens: args.llm.completionTokens,
        totalTokens: args.llm.totalTokens,
        routedModel: args.llm.model,
        originalCostUsd: args.llm.costUsd,
        optimizedCostUsd: args.llm.costUsd,
        savedUsd: 0,
        responseTimeMs: args.responseTimeMs,
      },
    })
    .catch((err: any) => {
      console.error(
        `[finops] Failed to record token log for session ${args.executionSessionId}: ${err.message}`,
      );
    });
}

async function isCancelled(prisma: PrismaClient, sessionId: string): Promise<boolean> {
  const session = await prisma.executionSession.findUnique({
    where: { id: sessionId },
    select: { status: true, outputJson: true },
  });

  if (!session) return true;
  if (session.status === 'CANCELLED') return true;

  // Check cancellation flag set by kill switch
  const output = session.outputJson as Record<string, unknown> | null;
  if (output?._cancellationRequested) return true;

  return false;
}

async function markSessionFailed(
  prisma: PrismaClient,
  sessionId: string,
  startTime: number,
  errorMessage: string,
): Promise<void> {
  await prisma.executionSession.update({
    where: { id: sessionId },
    data: {
      status: 'FAILED',
      endedAt: new Date(),
      latencyMs: Date.now() - startTime,
      outputJson: JSON.parse(JSON.stringify({ error: errorMessage })) as any,
    },
  });
}

async function createTrace(
  prisma: PrismaClient,
  sessionId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  await prisma.executionTrace
    .create({
      data: {
        executionSessionId: sessionId,
        correlationId: `trace-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        traceJson: {
          event,
          ...data,
          timestamp: new Date().toISOString(),
        },
      },
    })
    .catch((err: any) => {
      console.error(
        `[execution-trace] Failed to write trace for session ${sessionId}, event=${event}: ${err.message}`,
      );
    });
}
