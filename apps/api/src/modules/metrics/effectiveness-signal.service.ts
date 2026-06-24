/**
 * EffectivenessSignalService — collection + persistence of MEASURED MTTD /
 * test-coverage source data (model EffectivenessSignal).
 *
 * Three collection paths feed this service:
 *   1. AGENT  — PipelineEngine auto-hook reads `output.data.effectivenessSignal`
 *               emitted by an executor and calls record() (source 'agent').
 *   2. API    — POST /metrics/effectiveness-signal (source 'api').
 *   3. SEED   — prisma/seed-dashboard.ts bulk-creates rows (source 'seed').
 *
 * All writes are tenant-scoped and best-effort (never throw into the pipeline).
 *
 * @module metrics
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

/** Normalized signal shape accepted by record() / parseSignalFromOutput(). */
export interface RawEffectivenessSignal {
  workflowKey: string;
  stepKey?: string | null;
  executionSessionId?: string | null;
  kind: 'DETECTION' | 'COVERAGE';
  // DETECTION
  occurredAt?: string | Date | null;
  detectedAt?: string | Date | null;
  detectSeconds?: number | null;
  // COVERAGE
  testsTotal?: number | null;
  testsPassed?: number | null;
  coveragePct?: number | null;
  source?: string;
  detailsJson?: Record<string, unknown> | null;
}

const toDate = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
};
const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Read an effectiveness signal off a node output's data field.
 *
 * Recognized shapes (pure — no Prisma, so it is unit-testable):
 *   - outputData.effectivenessSignal = { kind:'COVERAGE', testsTotal, testsPassed, coveragePct }
 *   - outputData.effectivenessSignal = { kind:'DETECTION', occurredAt, detectedAt }
 *   - outputData.coverage   = { testsTotal, testsPassed, coveragePct }   (shorthand → COVERAGE)
 *   - outputData.detection  = { occurredAt, detectedAt }                 (shorthand → DETECTION)
 *
 * Returns a normalized RawEffectivenessSignal (without workflowKey/stepKey,
 * which the caller fills from pipeline context), or null when nothing usable.
 */
export function parseSignalFromOutput(
  outputData: unknown,
): Omit<RawEffectivenessSignal, 'workflowKey'> | null {
  if (!outputData || typeof outputData !== 'object') return null;
  const d = outputData as Record<string, any>;

  const raw = d.effectivenessSignal ?? null;
  if (raw && typeof raw === 'object') {
    const kind = String(raw.kind || '').toUpperCase();
    if (kind === 'DETECTION') {
      return {
        kind: 'DETECTION',
        occurredAt: raw.occurredAt ?? null,
        detectedAt: raw.detectedAt ?? null,
        detectSeconds: toNum(raw.detectSeconds),
        detailsJson: raw.detailsJson ?? null,
      };
    }
    if (kind === 'COVERAGE') {
      return {
        kind: 'COVERAGE',
        testsTotal: toNum(raw.testsTotal),
        testsPassed: toNum(raw.testsPassed),
        coveragePct: toNum(raw.coveragePct),
        detailsJson: raw.detailsJson ?? null,
      };
    }
    return null;
  }

  // shorthands
  if (d.coverage && typeof d.coverage === 'object') {
    return {
      kind: 'COVERAGE',
      testsTotal: toNum(d.coverage.testsTotal),
      testsPassed: toNum(d.coverage.testsPassed),
      coveragePct: toNum(d.coverage.coveragePct),
    };
  }
  if (d.detection && typeof d.detection === 'object') {
    return {
      kind: 'DETECTION',
      occurredAt: d.detection.occurredAt ?? null,
      detectedAt: d.detection.detectedAt ?? null,
      detectSeconds: toNum(d.detection.detectSeconds),
    };
  }
  return null;
}

@Injectable()
export class EffectivenessSignalService {
  private readonly logger = new Logger(EffectivenessSignalService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * Persist one effectiveness signal (tenant-scoped, best-effort).
   *
   * DETECTION: derives detectSeconds = (detectedAt − occurredAt)/1000 when both
   *            are present and not already supplied.
   * COVERAGE:  derives coveragePct = 100·testsPassed/testsTotal when not given.
   *
   * Returns the created row, or null when the write fails (never throws).
   */
  async record(tenantId: string, sig: RawEffectivenessSignal): Promise<any | null> {
    try {
      if (!tenantId || !sig?.workflowKey || !sig?.kind) return null;
      const kind = String(sig.kind).toUpperCase() === 'DETECTION' ? 'DETECTION' : 'COVERAGE';

      let detectSeconds = toNum(sig.detectSeconds);
      let occurredAt = toDate(sig.occurredAt);
      let detectedAt = toDate(sig.detectedAt);
      if (kind === 'DETECTION' && detectSeconds == null && occurredAt && detectedAt) {
        detectSeconds = Math.max(
          0,
          Math.round((detectedAt.getTime() - occurredAt.getTime()) / 1000),
        );
      }

      const testsTotal = toNum(sig.testsTotal);
      const testsPassed = toNum(sig.testsPassed);
      let coveragePct = toNum(sig.coveragePct);
      if (
        kind === 'COVERAGE' &&
        coveragePct == null &&
        testsTotal != null &&
        testsTotal > 0 &&
        testsPassed != null
      ) {
        coveragePct = Math.round((testsPassed / testsTotal) * 10000) / 100;
      }

      const row = await (this.prisma as any).effectivenessSignal.create({
        data: {
          tenantId,
          workflowKey: sig.workflowKey,
          stepKey: sig.stepKey ?? null,
          executionSessionId: sig.executionSessionId ?? null,
          kind,
          occurredAt: kind === 'DETECTION' ? occurredAt : null,
          detectedAt: kind === 'DETECTION' ? detectedAt : null,
          detectSeconds: kind === 'DETECTION' ? detectSeconds : null,
          testsTotal: kind === 'COVERAGE' ? testsTotal : null,
          testsPassed: kind === 'COVERAGE' ? testsPassed : null,
          coveragePct: kind === 'COVERAGE' ? coveragePct : null,
          source: sig.source ?? 'agent',
          detailsJson: (sig.detailsJson ?? null) as any,
        },
      });
      return row;
    } catch (err) {
      this.logger.warn(`EffectivenessSignal.record failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Tenant-scoped signals since `sinceDate`, optionally filtered by kind, for
   * aggregation (MTTD / coverage) and inspection. Best-effort → [] on error.
   */
  async listByTenant(
    tenantId: string,
    sinceDate: Date,
    kind?: 'DETECTION' | 'COVERAGE',
    limit = 5000,
  ): Promise<any[]> {
    try {
      const where: any = { tenantId, createdAt: { gte: sinceDate } };
      if (kind) where.kind = kind;
      return await (this.prisma as any).effectivenessSignal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    } catch (err) {
      this.logger.warn(`EffectivenessSignal.listByTenant failed: ${(err as Error).message}`);
      return [];
    }
  }
}
