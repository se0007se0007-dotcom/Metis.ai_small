/**
 * Metis.AI Worker — BullMQ Job Processors
 *
 * Queues:
 *   - pack-import: 9-stage import pipeline (fetch→parse→normalize→validate→scan→certify→sign→publish→install)
 *   - execution: Agent execution runtime
 *
 * Observability:
 *   - Job progress updates at each pipeline stage
 *   - Structured logging with correlation IDs
 *   - Graceful shutdown on SIGINT/SIGTERM
 */

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@metis/database';
import { runPackImportPipeline, PackImportJobData } from './processors/pack-import-pipeline';
import { runExecution, ExecutionJobData } from './processors/execution-processor';
import { runReplayProcessor, ReplayRunJobData } from './processors/replay-processor';
import { runShadowProcessor, ShadowExecuteJobData } from './processors/shadow-processor';
import { runCanaryEvaluator, CanaryEvaluateJobData } from './processors/canary-evaluator';
import {
  runAutonomousOpsProcessor,
  AutoActionJobData,
} from './processors/autonomous-ops-processor';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '5', 10);

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// ── Queue definitions (exported for API server to dispatch jobs) ──
export const packImportQueue = new Queue('pack-import', { connection });
export const executionQueue = new Queue('execution', { connection });
export const replayQueue = new Queue('replay', { connection });
export const shadowQueue = new Queue('shadow', { connection });
export const canaryQueue = new Queue('canary', { connection });
export const autoActionsQueue = new Queue('auto-actions', { connection });

// ── Pack Import Worker — delegates to 9-stage pipeline ──
const packImportWorker = new Worker<PackImportJobData>(
  'pack-import',
  async (job) => {
    const correlationId = job.id ?? `job-${Date.now()}`;
    console.log(
      `[pack-import:${correlationId}] Starting pipeline for ${job.data.sourceType}:${job.data.sourceUrl}`,
    );

    try {
      const result = await runPackImportPipeline(job, prisma as any);

      console.log(`[pack-import:${correlationId}] Pipeline completed successfully`);
      console.log(`  Pack: ${result.packId}`);
      console.log(`  Version: ${result.packVersionId}`);
      if (result.warnings.length > 0) {
        console.log(`  Warnings: ${result.warnings.join('; ')}`);
      }

      // Record completion in audit log
      await prisma.auditLog.create({
        data: {
          actorUserId: job.data.userId ?? 'system',
          tenantId: job.data.tenantId ?? 'system',
          action: 'IMPORT',
          targetType: 'PackVersion',
          targetId: result.packVersionId,
          correlationId: correlationId,
          metadataJson: {
            packId: result.packId,
            certificationId: result.certificationId,
            signatureHash: result.signatureHash,
            warnings: result.warnings,
            completedAt: new Date().toISOString(),
          },
        },
      });

      return result;
    } catch (error: any) {
      console.error(`[pack-import:${correlationId}] Pipeline failed:`, error.message);

      // Record failure in audit log
      await prisma.auditLog
        .create({
          data: {
            actorUserId: job.data.userId ?? 'system',
            tenantId: job.data.tenantId ?? 'system',
            action: 'IMPORT',
            targetType: 'Pack',
            targetId: job.data.sourceUrl,
            correlationId: correlationId,
            metadataJson: {
              sourceType: job.data.sourceType,
              sourceUrl: job.data.sourceUrl,
              error: error.message,
              failedAt: new Date().toISOString(),
            },
          },
        })
        .catch((e: any) => {
          console.error(`[pack-import:${correlationId}] Audit log write failed:`, e.message);
        });

      throw error;
    }
  },
  { connection, concurrency: CONCURRENCY },
);

// ── Execution Worker — Phase 2 Capability Runtime ──
const executionWorker = new Worker<ExecutionJobData>(
  'execution',
  async (job) => {
    const correlationId = job.id ?? `exec-${Date.now()}`;
    console.log(
      `[execution:${correlationId}] Starting runtime for session ${job.data.executionSessionId}`,
    );

    try {
      const result = await runExecution(job, prisma as any);

      console.log(
        `[execution:${correlationId}] Completed: ${result.status} (${result.stepsCompleted} steps, ${result.latencyMs}ms)`,
      );

      // Audit log
      await prisma.auditLog.create({
        data: {
          actorUserId: job.data.userId ?? 'system',
          tenantId: job.data.tenantId,
          action: 'EXECUTE',
          targetType: 'ExecutionSession',
          targetId: job.data.executionSessionId,
          correlationId: correlationId,
          metadataJson: {
            status: result.status,
            stepsCompleted: result.stepsCompleted,
            latencyMs: result.latencyMs,
            capabilityKey: job.data.capabilityKey,
            workflowKey: job.data.workflowKey,
            completedAt: new Date().toISOString(),
          },
        },
      });

      return result;
    } catch (error: any) {
      console.error(`[execution:${correlationId}] Failed:`, error.message);

      await prisma.auditLog
        .create({
          data: {
            actorUserId: job.data.userId ?? 'system',
            tenantId: job.data.tenantId,
            action: 'EXECUTE',
            targetType: 'ExecutionSession',
            targetId: job.data.executionSessionId,
            correlationId: correlationId,
            metadataJson: {
              status: 'FAILED',
              error: error.message,
              capabilityKey: job.data.capabilityKey,
              failedAt: new Date().toISOString(),
            },
          },
        })
        .catch((e: any) => {
          console.error(`[execution:${correlationId}] Audit log write failed:`, e.message);
        });

      throw error;
    }
  },
  { connection, concurrency: CONCURRENCY },
);

// ── Phase 3: Replay Worker ──
const replayWorker = new Worker<ReplayRunJobData>(
  'replay',
  async (job) => {
    const correlationId = job.id ?? `replay-${Date.now()}`;
    console.log(`[replay:${correlationId}] Starting replay run ${job.data.runId}`);
    try {
      const result = await runReplayProcessor(job, prisma as any);
      console.log(
        `[replay:${correlationId}] Completed: ${result.passedCases}/${result.totalCases} passed`,
      );

      await prisma.auditLog
        .create({
          data: {
            actorUserId: job.data.userId ?? null,
            tenantId: job.data.tenantId,
            action: 'REPLAY_RUN_START' as any,
            targetType: 'ReplayRun',
            targetId: job.data.runId,
            correlationId,
            metadataJson: {
              status: result.status,
              totalCases: result.totalCases,
              passedCases: result.passedCases,
              failedCases: result.failedCases,
              completedAt: new Date().toISOString(),
            },
          },
        })
        .catch((e: any) => console.error(`[replay:${correlationId}] Audit failed: ${e.message}`));

      return result;
    } catch (error: any) {
      console.error(`[replay:${correlationId}] Failed:`, error.message);
      await prisma.replayRun
        .update({
          where: { id: job.data.runId },
          data: { status: 'FAILED', completedAt: new Date() },
        })
        .catch(() => {});
      throw error;
    }
  },
  { connection, concurrency: Math.max(1, Math.floor(CONCURRENCY / 2)) },
);

// ── Phase 3: Shadow Worker ──
const shadowWorker = new Worker<ShadowExecuteJobData>(
  'shadow',
  async (job) => {
    const correlationId = job.id ?? `shadow-${Date.now()}`;
    console.log(`[shadow:${correlationId}] Starting shadow pair ${job.data.pairId}`);
    try {
      const result = await runShadowProcessor(job, prisma as any);
      console.log(`[shadow:${correlationId}] Completed: verdict=${result.verdict}`);
      return result;
    } catch (error: any) {
      console.error(`[shadow:${correlationId}] Failed:`, error.message);
      await prisma.shadowPair
        .update({
          where: { id: job.data.pairId },
          data: { status: 'FAILED', verdict: 'ERROR', verdictReason: error.message },
        })
        .catch(() => {});
      throw error;
    }
  },
  { connection, concurrency: CONCURRENCY },
);

// ── Phase 3: Canary Evaluator Worker ──
const canaryWorker = new Worker<CanaryEvaluateJobData>(
  'canary',
  async (job) => {
    const correlationId = job.id ?? `canary-${Date.now()}`;
    console.log(
      `[canary:${correlationId}] Evaluating gate for deployment ${job.data.deploymentId} window ${job.data.windowNumber}`,
    );
    try {
      const result = await runCanaryEvaluator(job, prisma as any);
      console.log(
        `[canary:${correlationId}] Gate result: ${result.gateResult}, action: ${result.action}`,
      );
      return result;
    } catch (error: any) {
      console.error(`[canary:${correlationId}] Evaluation failed:`, error.message);
      throw error;
    }
  },
  { connection, concurrency: 2 },
);

// ── Phase 5: Autonomous Ops Worker ──
const autoActionsWorker = new Worker<AutoActionJobData>(
  'auto-actions',
  async (job) => {
    const correlationId = job.id ?? `auto-${Date.now()}`;
    console.log(
      `[auto-ops:${correlationId}] Executing ${job.data.kind} on ${job.data.targetType}:${job.data.targetId}`,
    );
    try {
      const result = await runAutonomousOpsProcessor(job, prisma as any);
      console.log(
        `[auto-ops:${correlationId}] ${result.verified ? 'Verified' : 'Failed'} in ${result.durationMs}ms`,
      );
      return result;
    } catch (error: any) {
      console.error(`[auto-ops:${correlationId}] Failed:`, error.message);
      throw error;
    }
  },
  { connection, concurrency: Math.max(1, Math.floor(CONCURRENCY / 2)) },
);

// ── Worker Event Handlers ──
packImportWorker.on('failed', (job, error) => {
  console.error(`[pack-import] Job ${job?.id} failed:`, error.message);
});

packImportWorker.on('completed', (job) => {
  console.log(`[pack-import] Job ${job.id} completed`);
});

executionWorker.on('failed', (job, error) => {
  console.error(`[execution] Job ${job?.id} failed:`, error.message);
});

executionWorker.on('completed', (job) => {
  console.log(`[execution] Job ${job.id} completed`);
});

replayWorker.on('failed', (job, error) => {
  console.error(`[replay] Job ${job?.id} failed:`, error.message);
});

shadowWorker.on('failed', (job, error) => {
  console.error(`[shadow] Job ${job?.id} failed:`, error.message);
});

canaryWorker.on('failed', (job, error) => {
  console.error(`[canary] Job ${job?.id} failed:`, error.message);
});

autoActionsWorker.on('failed', (job, error) => {
  console.error(`[auto-ops] Job ${job?.id} failed:`, error.message);
});

// ── Graceful shutdown ──
async function shutdown() {
  console.log('[worker] Shutting down gracefully...');
  await Promise.all([
    packImportWorker.close(),
    executionWorker.close(),
    replayWorker.close(),
    shadowWorker.close(),
    canaryWorker.close(),
    autoActionsWorker.close(),
  ]);
  await connection.quit();
  await prisma.$disconnect();
  console.log('[worker] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Unhandled error handlers (H-5) ──
process.on('unhandledRejection', (reason: any, promise) => {
  console.error('[worker] Unhandled rejection at:', promise, 'reason:', reason?.message ?? reason);
  // Log but don't crash — let BullMQ handle individual job failures
});

process.on('uncaughtException', (error: Error) => {
  console.error('[worker] Uncaught exception:', error.message, error.stack);
  // Attempt graceful shutdown on uncaught exceptions
  shutdown().catch(() => process.exit(1));
});

console.log('🔧 Metis.AI Worker started');
console.log(`  Queues: pack-import, execution, replay, shadow, canary, auto-actions`);
console.log(`  Concurrency: ${CONCURRENCY}`);
console.log(`  Redis: ${REDIS_URL}`);
