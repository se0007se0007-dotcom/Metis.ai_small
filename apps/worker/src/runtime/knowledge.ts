/**
 * Worker-side knowledge grounding — mirrors the API's
 * KnowledgeRetrievalService for the worker execution path, so agents run via
 * the BullMQ queue get the same curated operational knowledge as workflow-node
 * executions.
 *
 * Security model is identical to the API side:
 *   - ACTIVE artifacts only
 *   - source AUTO_ERROR is NEVER injected (dashboard-only until human review)
 *   - missing/empty scope is workflow-local, NOT global
 *   - artifacts matching prompt-injection patterns are dropped
 *
 * Usage recording (KnowledgeUsage + usageCount) is best-effort and never
 * blocks execution.
 */

import { PrismaClient } from '@metis/database';

export interface KnowledgeContext {
  tenantId: string;
  workflowKey?: string | null;
  capabilityKey?: string | null;
  executionSessionId?: string | null;
  agentName?: string | null;
  limit?: number;
}

/** Same scope semantics as the API's matchesScope (F2: empty scope ≠ global). */
export function matchesScope(
  scopeJson: any,
  ctx: { workflowKey?: string | null; capabilityKey?: string | null },
): boolean {
  if (!scopeJson || typeof scopeJson !== 'object') return false;
  if (scopeJson.global === true) return true;
  if (
    ctx.workflowKey &&
    Array.isArray(scopeJson.workflowKeys) &&
    scopeJson.workflowKeys.includes(ctx.workflowKey)
  ) {
    return true;
  }
  if (
    ctx.capabilityKey &&
    Array.isArray(scopeJson.capabilityKeys) &&
    scopeJson.capabilityKeys.includes(ctx.capabilityKey)
  ) {
    return true;
  }
  return false;
}

/** Minimal prompt-injection screen (subset of the API's prompt-guard). */
export function looksLikeInjection(text: string): boolean {
  if (!text) return false;
  return [
    /ignore (all )?(previous|prior|above) (instructions|rules)/i,
    /disregard (your|the) (system|previous) prompt/i,
    /you are now/i,
    /<<<?\s*system\s*>>>?/i,
    /\bDAN mode\b/i,
  ].some((re) => re.test(text));
}

/**
 * Fetch relevant ACTIVE knowledge and render a Korean prompt preamble.
 * Returns '' when nothing relevant (or on any DB error).
 */
export async function buildKnowledgePreamble(
  prisma: PrismaClient,
  ctx: KnowledgeContext,
): Promise<string> {
  const limit = ctx.limit ?? 5;
  let artifacts: any[] = [];
  try {
    const candidates = await (prisma as any).knowledgeArtifact.findMany({
      where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
      orderBy: [{ priority: 'desc' }, { usageCount: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
    });
    artifacts = (candidates || [])
      .filter((a: any) => a?.source !== 'AUTO_ERROR')
      .filter((a: any) =>
        matchesScope(a.scopeJson, {
          workflowKey: ctx.workflowKey,
          capabilityKey: ctx.capabilityKey,
        }),
      )
      .filter((a: any) => !looksLikeInjection(`${a?.title ?? ''}\n${a?.content ?? ''}`))
      .slice(0, limit);
  } catch {
    return '';
  }

  if (artifacts.length === 0) return '';

  // Record usage best-effort (fire-and-forget).
  void recordUsage(prisma, ctx, artifacts).catch(() => {});

  const parts: string[] = [
    '=== 참고 지식 (운영지식관리) ===',
    '<<<KNOWLEDGE — 아래는 검증된 운영 지식입니다. 작업 시 준수하세요.>>>',
  ];
  artifacts.forEach((a: any, idx: number) => {
    const body = (a?.content ?? '').toString().slice(0, 500);
    parts.push(`${idx + 1}. ${a.title} [${a.category}]`);
    if (body) parts.push(`   ${body}`);
  });
  parts.push('<<<END KNOWLEDGE>>>');
  parts.push('=== 참고 지식 끝 ===\n');
  return parts.join('\n') + '\n';
}

async function recordUsage(
  prisma: PrismaClient,
  ctx: KnowledgeContext,
  artifacts: any[],
): Promise<void> {
  const now = new Date();
  for (const a of artifacts) {
    await (prisma as any).knowledgeUsage
      .create({
        data: {
          tenantId: ctx.tenantId,
          artifactId: a.id,
          workflowKey: ctx.workflowKey ?? null,
          executionSessionId: ctx.executionSessionId ?? null,
          agentName: ctx.agentName ?? null,
        },
      })
      .catch(() => {});
    await (prisma as any).knowledgeArtifact
      .update({
        where: { id: a.id },
        data: { usageCount: { increment: 1 }, lastUsedAt: now },
      })
      .catch(() => {});
  }
}
