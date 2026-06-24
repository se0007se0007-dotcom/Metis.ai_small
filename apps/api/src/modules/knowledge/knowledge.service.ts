import { Injectable, Inject, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { GovernanceService } from '../governance/governance.service';
import { EmbeddingService } from '../finops/embedding.service';

export interface KnowledgeFilters {
  category?: string;
  status?: string;
  source?: string;
  q?: string;
}

export interface CreateArtifactDto {
  title: string;
  category: string;
  content?: string;
  tags?: string[];
  scopeJson?: any;
  source?: string;
  priority?: number;
  status?: string;
  version?: string;
  validUntil?: string | Date | null;
}

export type UpdateArtifactDto = Partial<CreateArtifactDto>;

const VALID_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED', 'DEPRECATED'];

/**
 * Map a knowledge category to a governance Policy type (best-effort heuristic).
 */
export function mapCategoryToPolicyType(category?: string | null): string {
  const c = (category || '').toUpperCase();
  if (c.includes('SECURITY')) return 'SECURITY';
  if (c.includes('COST') || c.includes('FINOPS')) return 'COST';
  if (c.includes('QUALITY')) return 'QUALITY';
  if (c.includes('ERROR')) return 'RELIABILITY';
  return 'COMPLIANCE';
}

/**
 * Derive a minimal rule list from an artifact for promotion to a Policy.
 */
export function deriveRules(artifact: any): unknown[] {
  return [
    {
      kind: 'KNOWLEDGE_GUIDELINE',
      sourceArtifactKey: artifact?.key ?? null,
      category: artifact?.category ?? null,
      statement: (artifact?.content || artifact?.title || '').toString().slice(0, 500),
    },
  ];
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly governanceService: GovernanceService,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {}

  /**
   * Best-effort semantic indexing: compute and persist the title+content
   * embedding for an artifact. Never throws — when no key / external LLM
   * disabled / API error, the artifact simply has no embedding and retrieval
   * falls back to lexical relevance.
   */
  private async indexEmbedding(
    tenantId: string,
    artifactId: string,
    title?: string | null,
    content?: string | null,
  ): Promise<void> {
    if (!this.embeddingService) return;
    const text = `${title ?? ''}\n${content ?? ''}`.trim();
    if (!text) return;
    try {
      const vector = await this.embeddingService.embedForTenant(tenantId, text);
      if (vector && vector.length > 0) {
        await (this.prisma as any).knowledgeArtifact.update({
          where: { id: artifactId },
          data: { embedding: vector },
        });
      }
    } catch (err) {
      this.logger.warn(`embedding index failed for artifact ${artifactId}: ${(err as Error).message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────

  async list(ctx: TenantContext, filters?: KnowledgeFilters) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    const where: any = {};
    if (filters?.category) where.category = filters.category;
    if (filters?.status) where.status = filters.status;
    if (filters?.source) where.source = filters.source;
    if (filters?.q) {
      where.OR = [
        { title: { contains: filters.q, mode: 'insensitive' } },
        { content: { contains: filters.q, mode: 'insensitive' } },
      ];
    }
    return db.knowledgeArtifact.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async getById(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    const item = await db.knowledgeArtifact.findFirst({ where: { id } });
    if (!item) throw new NotFoundException('Knowledge artifact not found');
    return item;
  }

  async create(ctx: TenantContext, dto: CreateArtifactDto) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    const key = this.generateKey(dto.title);
    const created = await db.knowledgeArtifact.create({
      data: {
        tenantId: ctx.tenantId,
        key,
        title: dto.title,
        category: dto.category,
        status: dto.status && VALID_STATUSES.includes(dto.status) ? dto.status : 'DRAFT',
        source: dto.source ?? 'MANUAL',
        version: dto.version ?? 'v1',
        content: dto.content ?? null,
        tags: Array.isArray(dto.tags) ? dto.tags : [],
        scopeJson: dto.scopeJson ?? null,
        priority: typeof dto.priority === 'number' ? dto.priority : 0,
        usageCount: 0,
        createdById: ctx.userId ?? null,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      },
    });
    // Fire-and-forget semantic indexing (does not delay the response).
    void this.indexEmbedding(ctx.tenantId, created.id, created.title, created.content);
    return created;
  }

  async update(ctx: TenantContext, id: string, dto: UpdateArtifactDto) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    await this.getById(ctx, id); // ensure exists + tenant scoped
    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.content !== undefined) data.content = dto.content;
    if (dto.tags !== undefined) data.tags = Array.isArray(dto.tags) ? dto.tags : [];
    if (dto.scopeJson !== undefined) data.scopeJson = dto.scopeJson;
    if (dto.source !== undefined) data.source = dto.source;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.version !== undefined) data.version = dto.version;
    if (dto.status !== undefined && VALID_STATUSES.includes(dto.status)) data.status = dto.status;
    if (dto.validUntil !== undefined)
      data.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    const updated = await db.knowledgeArtifact.update({ where: { id }, data });
    // Re-index embedding when the searchable text changed.
    if (dto.title !== undefined || dto.content !== undefined) {
      void this.indexEmbedding(ctx.tenantId, updated.id, updated.title, updated.content);
    }
    return updated;
  }

  async setStatus(ctx: TenantContext, id: string, status: string) {
    if (!VALID_STATUSES.includes(status)) {
      throw new NotFoundException(`Invalid status: ${status}`);
    }
    const db = withTenantIsolation(this.prisma, ctx) as any;
    await this.getById(ctx, id);
    return db.knowledgeArtifact.update({ where: { id }, data: { status } });
  }

  async remove(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    await this.getById(ctx, id);
    await db.knowledgeArtifact.delete({ where: { id } }); // KnowledgeUsage cascades
    return { id, deleted: true };
  }

  // ──────────────────────────────────────────────────────────────
  // ErrorPatterns (registry view)
  // ──────────────────────────────────────────────────────────────

  async listErrorPatterns(ctx: TenantContext, filters?: { status?: string; workflowKey?: string }) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    const where: any = {};
    if (filters?.status) where.status = filters.status;
    if (filters?.workflowKey) where.workflowKey = filters.workflowKey;
    return db.errorPattern.findMany({
      where,
      orderBy: [{ occurrences: 'desc' }, { lastSeenAt: 'desc' }],
    });
  }

  /** Candidate ErrorPatterns (OPEN, occurrences >= minOccurrences) for promotion. */
  async suggestFromErrorPatterns(ctx: TenantContext, minOccurrences = 3) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    return db.errorPattern.findMany({
      where: { status: 'OPEN', occurrences: { gte: minOccurrences } },
      orderBy: { occurrences: 'desc' },
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Utilization / stats
  // ──────────────────────────────────────────────────────────────

  async getUtilization(ctx: TenantContext, days = 30) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const activeArtifacts: any[] = await db.knowledgeArtifact.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { usageCount: 'desc' },
    });

    const mostUsed = activeArtifacts
      .filter((a) => (a.usageCount ?? 0) > 0)
      .slice(0, 10)
      .map((a) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        usageCount: a.usageCount ?? 0,
        lastUsedAt: a.lastUsedAt ?? null,
      }));

    const unused = activeArtifacts
      .filter(
        (a) =>
          (a.usageCount ?? 0) === 0 ||
          !a.lastUsedAt ||
          new Date(a.lastUsedAt).getTime() < since.getTime(),
      )
      .map((a) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        usageCount: a.usageCount ?? 0,
        lastUsedAt: a.lastUsedAt ?? null,
      }));

    // Window usage from KnowledgeUsage for accuracy.
    let windowUsages: any[] = [];
    try {
      windowUsages = await db.knowledgeUsage.findMany({
        where: { usedAt: { gte: since } },
        select: { artifactId: true, agentName: true },
      });
    } catch {
      windowUsages = [];
    }

    const byAgentMap = new Map<string, number>();
    const usedArtifactIds = new Set<string>();
    for (const u of windowUsages) {
      usedArtifactIds.add(u.artifactId);
      const agent = u.agentName || 'unknown';
      byAgentMap.set(agent, (byAgentMap.get(agent) ?? 0) + 1);
    }
    const byAgent = Array.from(byAgentMap.entries())
      .map(([agentName, count]) => ({ agentName, count }))
      .sort((a, b) => b.count - a.count);

    return {
      mostUsed,
      unused,
      byAgent,
      totals: {
        totalActive: activeArtifacts.length,
        totalUsedInWindow: usedArtifactIds.size,
        windowDays: days,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Knowledge → Policy promotion
  // ──────────────────────────────────────────────────────────────

  async promoteToPolicy(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx) as any;
    const artifact = await this.getById(ctx, id);

    const policy = await this.governanceService.createPolicy(ctx, {
      name: artifact.title,
      type: mapCategoryToPolicyType(artifact.category),
      isActive: true,
      scope: artifact.scopeJson ?? {},
      rules: deriveRules(artifact),
      description: (artifact.content ?? '').toString().slice(0, 300),
    });

    const updated = await db.knowledgeArtifact.update({
      where: { id },
      data: { linkedPolicyKey: (policy as any)?.key ?? null },
    });

    return { policy, artifact: updated };
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  private generateKey(title: string): string {
    const slug =
      (title || '')
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 40) || 'kb';
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${slug}-${suffix}`;
  }
}
