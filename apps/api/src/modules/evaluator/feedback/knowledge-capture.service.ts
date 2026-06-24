/**
 * Knowledge Capture Service — Scenario 1, Part A
 *
 * Closes the FIRST half of the "execution → knowledge" loop: turns evaluation
 * problems (quality F / security high·critical / anomaly) and hard step
 * failures into durable KNOWLEDGE.
 *
 * Two writes per capture (both best-effort, never throw):
 *   1. UPSERT ErrorPattern by (tenantId, signature)
 *        - on conflict: occurrences++, lastSeenAt=now, keep earliest firstSeenAt,
 *          refresh sampleMessage/recommendation/severity if newly available.
 *        - on create: seed all fields.
 *   2. UPSERT a KnowledgeArtifact (category 'ERROR_PATTERN',
 *      key `errpat:${signatureHash}`) so the pattern surfaces in the knowledge
 *      registry UI alongside curated knowledge.
 *
 * All Prisma access uses `(this.prisma as any)` because ErrorPattern is a newly
 * added model whose generated client types may lag.
 *
 * @module evaluator/feedback
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../../database.module';
import {
  buildSignature,
  classify,
  signatureHash,
  ErrorCategory,
  ErrorSeverity,
} from './error-signature';
import { detectPromptInjection } from '../prompt-guard';

/** Params for {@link KnowledgeCaptureService.captureFromEvaluation}. */
export interface CaptureFromEvaluationParams {
  tenantId: string;
  workflowKey?: string | null;
  stepKey?: string | null;
  agentName?: string | null;
  qualityGrade?: string | null;
  securityRiskLevel?: string | null;
  anomalyDetected?: boolean;
  /** Human-readable problem summary used as the dedup message + sample. */
  message?: string | null;
}

/** Params for {@link KnowledgeCaptureService.captureFromStepError}. */
export interface CaptureFromStepErrorParams {
  tenantId: string;
  workflowKey?: string | null;
  stepKey?: string | null;
  agentName?: string | null;
  errorMessage?: string | null;
}

@Injectable()
export class KnowledgeCaptureService {
  private readonly logger = new Logger(KnowledgeCaptureService.name);

  // F7 (security, recommendation): all writes below are explicitly scoped by
  // tenantId. For defense-in-depth consider routing through withTenantIsolation
  // (see agent-kernel/*.service.ts) so RLS-style scoping is enforced centrally.
  // Left as a no-behavior-change note here to avoid altering best-effort upsert paths.
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * Capture a knowledge entry from an evaluation that indicates a problem.
   * Caller is responsible for only invoking this when a problem exists, but we
   * re-derive classification here so the persisted category/severity is correct.
   */
  async captureFromEvaluation(params: CaptureFromEvaluationParams): Promise<void> {
    const cls = classify({
      qualityGrade: params.qualityGrade,
      securityRiskLevel: params.securityRiskLevel,
      anomalyDetected: params.anomalyDetected,
    });

    const message = params.message?.trim() || this.deriveEvalMessage(cls.category, params);

    await this.capture({
      tenantId: params.tenantId,
      workflowKey: params.workflowKey ?? null,
      stepKey: params.stepKey ?? null,
      category: cls.category,
      severity: cls.severity,
      recommendation: cls.recommendation,
      message,
    });
  }

  /**
   * Capture a SUCCESS insight from a high-quality evaluation (grade A / high
   * overall score) — closes the positive half of the "execution → knowledge"
   * feedback loop. Upserts one KnowledgeArtifact per (workflow, agent) keyed
   * `success:${hash}` with source=EVALUATION, accumulating a success counter.
   *
   * Created as DRAFT and never auto-injected into prompts until a human
   * reviews/activates it (same trust boundary as AUTO_ERROR knowledge).
   * Best-effort: never throws.
   */
  async captureSuccessFromEvaluation(params: {
    tenantId: string;
    workflowKey?: string | null;
    stepKey?: string | null;
    agentName?: string | null;
    overallScore?: number | null;
    summary?: string | null;
  }): Promise<void> {
    try {
      const scope = `${params.workflowKey ?? 'global'}::${params.agentName ?? 'unknown'}`;
      const key = `success:${signatureHash(scope)}`;
      const title = `[SUCCESS] ${params.agentName ?? 'agent'} @ ${params.workflowKey ?? 'global'} 우수 실행 패턴`;
      const summary = (params.summary ?? '').toString().slice(0, 1000);

      // F4: never let injection-looking content become promotable knowledge.
      if (summary && detectPromptInjection(summary).length > 0) {
        this.logger.warn(`Success capture quarantined (injection pattern) for ${scope}`);
        return;
      }

      const existing = await (this.prisma as any).knowledgeArtifact.findUnique({
        where: { tenantId_key: { tenantId: params.tenantId, key } },
      });

      const contentJson = {
        kind: 'SUCCESS_PATTERN',
        workflowKey: params.workflowKey ?? null,
        stepKey: params.stepKey ?? null,
        agentName: params.agentName ?? null,
        lastScore: params.overallScore ?? null,
        successCount: ((existing?.contentJson as any)?.successCount ?? 0) + 1,
        lastSummary: summary || null,
        lastSeenAt: new Date().toISOString(),
      };

      if (existing) {
        await (this.prisma as any).knowledgeArtifact.update({
          where: { id: existing.id },
          data: { contentJson, version: existing.version },
        });
      } else {
        await (this.prisma as any).knowledgeArtifact.create({
          data: {
            tenantId: params.tenantId,
            key,
            title,
            category: 'SUCCESS_PATTERN',
            status: 'DRAFT', // human review required before ACTIVE/injection
            source: 'EVALUATION',
            version: 'v1',
            content: summary || null,
            tags: ['auto', 'success'],
            scopeJson: params.workflowKey ? { workflowKeys: [params.workflowKey] } : null,
            priority: 0,
            usageCount: 0,
            contentJson,
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Success knowledge capture failed: ${(err as Error).message}`);
    }
  }

  /**
   * Capture a knowledge entry from a hard step failure (executor threw / status
   * FAILED with an errorMessage).
   */
  async captureFromStepError(params: CaptureFromStepErrorParams): Promise<void> {
    const cls = classify({ stepFailed: true, errorMessage: params.errorMessage });

    await this.capture({
      tenantId: params.tenantId,
      workflowKey: params.workflowKey ?? null,
      stepKey: params.stepKey ?? null,
      category: cls.category,
      severity: cls.severity,
      recommendation: cls.recommendation,
      message: params.errorMessage?.trim() || 'step execution failed',
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Core upsert (both writes best-effort)
  // ──────────────────────────────────────────────────────────────

  private async capture(input: {
    tenantId: string;
    workflowKey: string | null;
    stepKey: string | null;
    category: ErrorCategory;
    severity: ErrorSeverity;
    recommendation?: string;
    message: string;
  }): Promise<void> {
    const signature = buildSignature({
      category: input.category,
      workflowKey: input.workflowKey,
      stepKey: input.stepKey,
      message: input.message,
    });

    // 1) UPSERT ErrorPattern
    try {
      await (this.prisma as any).errorPattern.upsert({
        where: { tenantId_signature: { tenantId: input.tenantId, signature } },
        update: {
          occurrences: { increment: 1 },
          lastSeenAt: new Date(),
          // keep earliest firstSeenAt automatically (not touched on update)
          severity: input.severity,
          sampleMessage: input.message.slice(0, 1000),
          ...(input.recommendation ? { recommendation: input.recommendation } : {}),
          // refresh denormalized location if it was unknown before
          ...(input.workflowKey ? { workflowKey: input.workflowKey } : {}),
          ...(input.stepKey ? { stepKey: input.stepKey } : {}),
        },
        create: {
          tenantId: input.tenantId,
          workflowKey: input.workflowKey,
          stepKey: input.stepKey,
          signature,
          category: input.category,
          severity: input.severity,
          occurrences: 1,
          sampleMessage: input.message.slice(0, 1000),
          recommendation: input.recommendation ?? null,
          status: 'OPEN',
        },
      });
    } catch (err) {
      this.logger.warn(`ErrorPattern upsert failed (sig=${signature}): ${(err as Error).message}`);
    }

    // 2) UPSERT KnowledgeArtifact so it shows in the knowledge registry.
    // F4 (security): scan captured content for prompt-injection at CAPTURE time.
    // If the auto-captured message looks like an injection payload, we QUARANTINE it
    // — the ErrorPattern row above still records it for the dashboard, but we do NOT
    // create a KnowledgeArtifact that could ever be promoted into the prompt path.
    const injectionHits = detectPromptInjection(
      `${input.recommendation ?? ''}\n${input.message ?? ''}`,
    );
    if (injectionHits.length > 0) {
      this.logger.warn(
        `KnowledgeArtifact capture quarantined (injection pattern: ${injectionHits.join(', ')})`,
      );
      return;
    }

    try {
      const key = `errpat:${signatureHash(signature)}`;
      const title = `[${input.category}/${input.severity}] ${input.message.slice(0, 80)}`;
      const contentJson = {
        signature,
        workflowKey: input.workflowKey,
        stepKey: input.stepKey,
        category: input.category,
        severity: input.severity,
        sampleMessage: input.message.slice(0, 1000),
        recommendation: input.recommendation ?? null,
      };

      // Resolve current occurrences (best-effort) to denormalize into content.
      let occurrences = 1;
      try {
        const ep = await (this.prisma as any).errorPattern.findUnique({
          where: { tenantId_signature: { tenantId: input.tenantId, signature } },
          select: { occurrences: true },
        });
        if (ep?.occurrences) occurrences = ep.occurrences;
      } catch {
        /* ignore — occurrences stays 1 */
      }

      const contentBody = (input.recommendation || input.message || '').toString().slice(0, 1000);
      // F1 (security): auto-captured error knowledge is ALWAYS workflow-LOCAL,
      // never global. If no workflowKey is known we still scope it locally to an
      // empty workflow list so it is NOT injected anywhere until a human promotes it.
      const scope = { workflowKeys: input.workflowKey ? [input.workflowKey] : [] };

      await (this.prisma as any).knowledgeArtifact.upsert({
        where: { tenantId_key: { tenantId: input.tenantId, key } },
        update: {
          title,
          // F1 (security): auto-captured content stays DRAFT (dashboard-only) until a
          // human reviewer promotes it to ACTIVE. Never auto-publish to the prompt path.
          status: 'DRAFT',
          source: 'AUTO_ERROR',
          content: contentBody,
          priority: 5,
          scopeJson: scope as any,
          contentJson: { ...contentJson, occurrences } as any,
        },
        create: {
          tenantId: input.tenantId,
          key,
          title,
          category: 'ERROR_PATTERN',
          // F1 (security): created as DRAFT — not injectable until human-promoted.
          status: 'DRAFT',
          source: 'AUTO_ERROR',
          priority: 5,
          content: contentBody,
          tags: ['auto', 'error-pattern', input.category],
          scopeJson: scope as any,
          version: 'v1',
          contentJson: { ...contentJson, occurrences } as any,
        },
      });
    } catch (err) {
      this.logger.warn(`KnowledgeArtifact upsert failed: ${(err as Error).message}`);
    }
  }

  /** Build a readable problem message when the caller doesn't supply one. */
  private deriveEvalMessage(category: ErrorCategory, params: CaptureFromEvaluationParams): string {
    switch (category) {
      case 'security':
        return `security risk ${params.securityRiskLevel ?? 'high'} detected`;
      case 'quality':
        return `quality grade F (response failed quality gate)`;
      case 'anomaly':
        return `anomaly detected in execution metrics`;
      default:
        return `evaluation problem detected`;
    }
  }
}
