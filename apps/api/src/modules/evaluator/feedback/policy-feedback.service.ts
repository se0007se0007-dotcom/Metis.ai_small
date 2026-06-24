/**
 * Policy Feedback Service — Phase 2.1 + 2.2
 *
 * Ties the pure pattern analyzer to persistence:
 *   - analyzeAndSuggest(): read recent AgentEvaluation rows → detect patterns →
 *     persist PolicySuggestion rows (deduping against open suggestions)
 *   - listSuggestions(): list suggestions for review
 *   - approveSuggestion(): apply proposed changes to the EvaluationPolicy, mark APPLIED
 *   - rejectSuggestion(): mark REJECTED
 *
 * All Prisma access uses `(this.prisma as any)` to tolerate generated-type lag
 * (same pattern as the rest of this codebase).
 *
 * @module evaluator/feedback
 */
import { Injectable, Inject, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../../database.module';
import { EvaluationPolicyService } from '../evaluation-policy.service';
import {
  analyzeEvaluations,
  DEFAULT_ANALYSIS_PARAMS,
  EvalRow,
  PolicySuggestionDraft,
  ProposedChange,
} from './pattern-analysis';

@Injectable()
export class PolicyFeedbackService {
  private readonly logger = new Logger(PolicyFeedbackService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly policyService: EvaluationPolicyService,
  ) {}

  // ════════════════════════════════════════════════════════════════
  // 2.1 + 2.2: analyze recent history and persist suggestions
  // ════════════════════════════════════════════════════════════════

  /**
   * Analyze the last `days` of evaluations and create new PolicySuggestion
   * rows for any detected patterns. Returns the created suggestions.
   *
   * Dedup: a pattern is skipped if an open (PENDING) suggestion of the same
   * patternType + agentName already exists.
   */
  async analyzeAndSuggest(
    tenantId: string,
    options: { days?: number; policyName?: string; agentGroup?: string | null } = {},
  ): Promise<any[]> {
    const days = options.days ?? 30;
    const policyName = options.policyName ?? 'default';
    const resolvedTenantId = await this.resolveTenantId(tenantId);

    const since = new Date();
    since.setDate(since.getDate() - days);

    let rows: EvalRow[] = [];
    try {
      rows = await (this.prisma as any).agentEvaluation.findMany({
        where: { tenantId: resolvedTenantId, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: {
          agentName: true,
          overallScore: true,
          securityScore: true,
          securityRiskLevel: true,
          qualityGrade: true,
          costEfficiency: true,
          anomalyDetected: true,
          createdAt: true,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to load evaluations: ${(err as Error).message}`);
      return [];
    }

    const policy = await this.policyService.getActivePolicy(resolvedTenantId, options.agentGroup);

    const drafts = analyzeEvaluations(
      rows,
      {
        securityCriticalCap: policy.securityCriticalCap,
        securityHighCap: policy.securityHighCap,
        qualityHardGateMin: policy.qualityHardGateMin,
        securityWeight: policy.securityWeight,
        qualityWeight: policy.qualityWeight,
        llmJudgeEnabled: policy.llmJudgeEnabled,
      },
      DEFAULT_ANALYSIS_PARAMS,
    );

    // Load existing open suggestions for dedup.
    let openExisting: any[] = [];
    try {
      openExisting = await (this.prisma as any).policySuggestion.findMany({
        where: { tenantId: resolvedTenantId, status: 'PENDING' },
        select: { patternType: true, agentName: true },
      });
    } catch {
      /* table may be empty */
    }
    const seen = new Set(openExisting.map((s) => `${s.patternType}::${s.agentName ?? ''}`));

    const created: any[] = [];
    for (const draft of drafts) {
      const key = `${draft.patternType}::${draft.agentName ?? ''}`;
      if (seen.has(key)) continue;
      try {
        const row = await (this.prisma as any).policySuggestion.create({
          data: {
            tenantId: resolvedTenantId,
            policyName,
            agentGroup: options.agentGroup ?? null,
            patternType: draft.patternType,
            agentName: draft.agentName,
            severity: draft.severity,
            title: draft.title,
            rationale: draft.rationale,
            proposedChanges: draft.proposedChanges,
            evidenceJson: draft.evidence,
            status: 'PENDING',
          },
        });
        created.push(row);
        seen.add(key);
      } catch (err) {
        this.logger.warn(`Failed to persist suggestion (${key}): ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `Pattern analysis for tenant ${resolvedTenantId}: ${rows.length} rows, ` +
        `${drafts.length} patterns, ${created.length} new suggestions`,
    );
    return created;
  }

  // ════════════════════════════════════════════════════════════════
  // List / decide
  // ════════════════════════════════════════════════════════════════

  async listSuggestions(tenantId: string, filters: { status?: string } = {}): Promise<any[]> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const where: any = { tenantId: resolvedTenantId };
    if (filters.status) where.status = filters.status;
    try {
      return await (this.prisma as any).policySuggestion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
    } catch (err) {
      this.logger.error(`Failed to list suggestions: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Approve a suggestion: apply its proposed changes to the target policy and
   * mark it APPLIED. Returns { suggestion, policy }.
   */
  async approveSuggestion(tenantId: string, id: string, userId?: string): Promise<any> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const suggestion = await (this.prisma as any).policySuggestion.findFirst({
      where: { id, tenantId: resolvedTenantId },
    });
    if (!suggestion) throw new NotFoundException(`PolicySuggestion not found: ${id}`);

    // Build a patch from proposedChanges.
    const changes: ProposedChange[] = Array.isArray(suggestion.proposedChanges)
      ? suggestion.proposedChanges
      : [];
    const patch: Record<string, number | boolean> = {};
    for (const c of changes) {
      if (c && typeof c.field === 'string') patch[c.field] = c.to;
    }

    let updatedPolicy: Awaited<ReturnType<EvaluationPolicyService['updatePolicy']>> | null = null;
    if (Object.keys(patch).length > 0) {
      updatedPolicy = await this.policyService.updatePolicy(
        resolvedTenantId,
        suggestion.policyName ?? 'default',
        patch as any,
      );
    }

    const now = new Date();
    const updated = await (this.prisma as any).policySuggestion.update({
      where: { id },
      data: {
        status: Object.keys(patch).length > 0 ? 'APPLIED' : 'APPROVED',
        decidedByUserId: userId ?? null,
        decidedAt: now,
        appliedAt: Object.keys(patch).length > 0 ? now : null,
      },
    });

    this.logger.log(
      `Suggestion ${id} approved by ${userId ?? 'unknown'} — ` +
        `applied ${Object.keys(patch).length} change(s) to policy "${suggestion.policyName}"`,
    );
    return { suggestion: updated, policy: updatedPolicy };
  }

  async rejectSuggestion(tenantId: string, id: string, userId?: string): Promise<any> {
    const resolvedTenantId = await this.resolveTenantId(tenantId);
    const suggestion = await (this.prisma as any).policySuggestion.findFirst({
      where: { id, tenantId: resolvedTenantId },
    });
    if (!suggestion) throw new NotFoundException(`PolicySuggestion not found: ${id}`);

    return (this.prisma as any).policySuggestion.update({
      where: { id },
      data: { status: 'REJECTED', decidedByUserId: userId ?? null, decidedAt: new Date() },
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Private
  // ════════════════════════════════════════════════════════════════

  private async resolveTenantId(tenantId: string): Promise<string> {
    // C-3 fix: validate the JWT tenantId exists. NEVER fall back to another
    // tenant (that would be a cross-tenant data breach). Throw instead.
    const tenant = await (this.prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (tenant) return tenant.id;
    throw new ForbiddenException('Invalid tenant');
  }
}
