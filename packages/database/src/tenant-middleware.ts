import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Tenant context injected into every request.
 * Populated by NestJS TenantGuard from JWT claims.
 */
export interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
}

/**
 * Models that require tenant isolation.
 * Every query on these models auto-injects tenantId filter.
 */
const TENANT_MODELS = new Set([
  'Policy',
  'PolicyEvaluation',
  'PackInstallation',
  'Connector',
  'ExecutionSession',
  'AuditLog',
  'KnowledgeArtifact',
  'Membership',
  // Phase 2: Foundational Data Safety (FDS)
  'FDSRule',
  'FDSAlert',
  // Phase 3: Controlled Release Engineering
  'ReplayDataset',
  'ReplayRun',
  'ShadowConfig',
  'ShadowPair',
  'CanaryDeployment',
  'CanaryMetricSnapshot',
  'VersionPromotion',
  // Phase 5: Builder Harness
  'BuilderRequest',
]);

/**
 * Prisma client extension for automatic tenant isolation.
 *
 * Usage:
 *   const tenantPrisma = withTenantIsolation(prisma, { tenantId, userId, role });
 *   const logs = await tenantPrisma.auditLog.findMany(); // auto-filtered
 */
export function withTenantIsolation(client: PrismaClient, ctx: TenantContext) {
  return client.$extends({
    query: {
      $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model?: string;
        operation: string;
        args: any;
        query: (args: any) => any;
      }) {
        if (!model || !TENANT_MODELS.has(model)) {
          return query(args);
        }

        // Inject tenantId into reads
        if (
          operation === 'findMany' ||
          operation === 'findFirst' ||
          operation === 'findUnique' ||
          operation === 'count' ||
          operation === 'aggregate' ||
          operation === 'groupBy'
        ) {
          args.where = { ...args.where, tenantId: ctx.tenantId };
          return query(args);
        }

        // Inject tenantId into creates
        if (operation === 'create') {
          args.data = { ...args.data, tenantId: ctx.tenantId };
          return query(args);
        }

        if (operation === 'createMany') {
          if (Array.isArray(args.data)) {
            args.data = args.data.map((d: any) => ({
              ...d,
              tenantId: ctx.tenantId,
            }));
          }
          return query(args);
        }

        // Inject tenantId into updates / deletes
        if (
          operation === 'update' ||
          operation === 'updateMany' ||
          operation === 'delete' ||
          operation === 'deleteMany'
        ) {
          args.where = { ...args.where, tenantId: ctx.tenantId };
          return query(args);
        }

        return query(args);
      },
    },
  });
}
