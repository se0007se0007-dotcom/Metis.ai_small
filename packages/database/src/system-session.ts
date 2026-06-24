/**
 * System sentinel ExecutionSession helper.
 *
 * Several services write ExecutionTrace audit breadcrumbs for events that are
 * NOT tied to a real workflow execution (A2A bus messages, mission lifecycle,
 * auto-ops actions, AP invoice transitions, etc.). ExecutionTrace.executionSessionId
 * is a required FK to ExecutionSession, so those writes previously used a fake
 * id like 'system-bus' and silently failed the FK constraint (swallowed by
 * .catch). That meant the audit trail was being dropped.
 *
 * This helper lazily ensures a single per-tenant sentinel ExecutionSession
 * (a SUCCEEDED bookkeeping session) exists and returns its id, so those traces
 * persist correctly. Results are memoized per tenant to avoid repeat lookups.
 *
 * @module @metis/database
 */
import type { PrismaClient } from '@prisma/client';

/** Stable key per tenant for the audit sentinel session. */
const SENTINEL_WORKFLOW_KEY = '__system_audit__';

/** In-process cache: tenantId → sentinel ExecutionSession id. */
const sentinelCache = new Map<string, string>();

/**
 * Ensure a per-tenant sentinel ExecutionSession exists and return its id.
 * Safe to call frequently — memoized, and tolerant of races (re-reads on
 * unique-constraint conflict).
 *
 * @param prisma   Prisma client (untyped accepted to tolerate generated-type lag)
 * @param tenantId Tenant the audit event belongs to
 * @returns the sentinel ExecutionSession id, or null if it cannot be ensured
 */
export async function getSystemSessionId(
  prisma: PrismaClient,
  tenantId: string,
): Promise<string | null> {
  if (!tenantId) return null;
  const cached = sentinelCache.get(tenantId);
  if (cached) return cached;

  const db = prisma as any;
  try {
    const existing = await db.executionSession.findFirst({
      where: { tenantId, workflowKey: SENTINEL_WORKFLOW_KEY },
      select: { id: true },
    });
    if (existing?.id) {
      sentinelCache.set(tenantId, existing.id);
      return existing.id;
    }

    const created = await db.executionSession.create({
      data: {
        tenantId,
        workflowKey: SENTINEL_WORKFLOW_KEY,
        capabilityKey: 'system-audit',
        status: 'SUCCEEDED',
        startedAt: new Date(),
        endedAt: new Date(),
        completedAt: new Date(),
        inputJson: { system: true, purpose: 'audit-trace sentinel' },
      },
      select: { id: true },
    });
    sentinelCache.set(tenantId, created.id);
    return created.id;
  } catch {
    // Race or transient error — try one more read before giving up.
    try {
      const again = await db.executionSession.findFirst({
        where: { tenantId, workflowKey: SENTINEL_WORKFLOW_KEY },
        select: { id: true },
      });
      if (again?.id) {
        sentinelCache.set(tenantId, again.id);
        return again.id;
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Reset the memoized cache (test helper). */
export function __resetSystemSessionCache(): void {
  sentinelCache.clear();
}
