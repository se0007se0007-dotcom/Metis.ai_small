/**
 * PolicyContextService — resolves the tenant's current policy surface
 * into a deterministic policyVersionHash. Any policy create/update/
 * (de)activation changes the hash, which in turn invalidates
 * governance fingerprints (Patent 2) and cache reuse (Patent 3).
 */
import { Injectable, Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

@Injectable()
export class PolicyContextService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async getPolicyVersionHash(tenantId: string): Promise<string> {
    const policies = await this.prisma.policy.findMany({
      where: { tenantId, isActive: true },
      select: { key: true, version: true, updatedAt: true },
      orderBy: { key: 'asc' },
    });
    const canonical = policies.map((p) => ({
      key: p.key,
      version: p.version,
      updatedAt: p.updatedAt.toISOString(),
    }));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}
