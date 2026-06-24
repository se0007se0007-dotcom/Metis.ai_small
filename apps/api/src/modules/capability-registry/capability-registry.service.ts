/**
 * Capability Registry Service — Unified catalog of all executable resources.
 *
 * This is the single source of truth for the Builder Harness when generating
 * workflows. It aggregates:
 *   - Connectors (from Connector module)
 *   - Agents (from AgentDefinition model)
 *   - Adapters (from AdapterRegistration model)
 *   - Pack capabilities (from existing PackCapability)
 *
 * The binding table (`CapabilityBinding`) keeps a denormalized view so
 * Builder can issue a single query instead of joining across modules.
 */
import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

export interface CapabilityQuery {
  kind?: 'CONNECTOR' | 'AGENT' | 'ADAPTER' | 'TEMPLATE' | 'SKILL';
  category?: string;
  tag?: string;
  search?: string;
}

export interface CapabilityEntry {
  id: string;
  key: string;
  kind: string;
  label: string;
  category: string;
  tags: string[];
  inputSchema?: any;
  outputSchema?: any;
  sourceType: string;
  sourceId: string;
  docsUrl?: string;
}

@Injectable()
export class CapabilityRegistryService {
  private readonly logger = new Logger(CapabilityRegistryService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ═══════════════════════════════════════════════════════════
  //  Discovery — used by Builder Harness
  // ═══════════════════════════════════════════════════════════

  async list(ctx: TenantContext, query: CapabilityQuery = {}): Promise<CapabilityEntry[]> {
    const db = withTenantIsolation(this.prisma, ctx);
    const where: any = { active: true };
    if (query.kind) where.kind = query.kind;
    if (query.category) where.category = query.category;
    if (query.tag) where.tags = { has: query.tag };
    if (query.search) {
      where.OR = [
        { label: { contains: query.search, mode: 'insensitive' } },
        { key: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const items = await db.capabilityBinding.findMany({
      where,
      orderBy: [{ category: 'asc' }, { label: 'asc' }],
      take: 500,
    });

    return items.map((i) => ({
      id: i.id,
      key: i.key,
      kind: i.kind,
      label: i.label,
      category: i.category,
      tags: i.tags,
      inputSchema: i.inputSchemaJson,
      outputSchema: i.outputSchemaJson,
      sourceType: i.sourceType,
      sourceId: i.sourceId,
      docsUrl: i.docsUrl ?? undefined,
    }));
  }

  async getByKey(ctx: TenantContext, key: string): Promise<CapabilityEntry> {
    const db = withTenantIsolation(this.prisma, ctx);
    const item = await db.capabilityBinding.findFirst({ where: { key } });
    if (!item) throw new NotFoundException(`Capability "${key}" not found`);
    return {
      id: item.id,
      key: item.key,
      kind: item.kind,
      label: item.label,
      category: item.category,
      tags: item.tags,
      inputSchema: item.inputSchemaJson,
      outputSchema: item.outputSchemaJson,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      docsUrl: item.docsUrl ?? undefined,
    };
  }

  /** Facet counts for the Builder sidebar. */
  async facets(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);
    const items = await db.capabilityBinding.findMany({
      where: { active: true },
      select: { kind: true, category: true, tags: true },
    });
    const byKind: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byTag: Record<string, number> = {};
    for (const i of items) {
      byKind[i.kind] = (byKind[i.kind] || 0) + 1;
      byCategory[i.category] = (byCategory[i.category] || 0) + 1;
      for (const t of i.tags) byTag[t] = (byTag[t] || 0) + 1;
    }
    return { total: items.length, byKind, byCategory, byTag };
  }

  // ═══════════════════════════════════════════════════════════
  //  Registration — used by modules on startup or via API
  // ═══════════════════════════════════════════════════════════

  async upsertBinding(
    ctx: TenantContext,
    binding: {
      kind: 'CONNECTOR' | 'AGENT' | 'ADAPTER' | 'TEMPLATE' | 'SKILL';
      sourceType: string;
      sourceId: string;
      key: string;
      label: string;
      category: string;
      tags?: string[];
      inputSchema?: any;
      outputSchema?: any;
      docsUrl?: string;
    },
  ) {
    return this.prisma.capabilityBinding.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: binding.key } },
      update: {
        label: binding.label,
        category: binding.category,
        tags: binding.tags ?? [],
        inputSchemaJson: binding.inputSchema ?? {},
        outputSchemaJson: binding.outputSchema ?? {},
        docsUrl: binding.docsUrl,
        sourceType: binding.sourceType,
        sourceId: binding.sourceId,
        active: true,
      },
      create: {
        tenantId: ctx.tenantId,
        kind: binding.kind,
        sourceType: binding.sourceType,
        sourceId: binding.sourceId,
        key: binding.key,
        label: binding.label,
        category: binding.category,
        tags: binding.tags ?? [],
        inputSchemaJson: binding.inputSchema ?? {},
        outputSchemaJson: binding.outputSchema ?? {},
        docsUrl: binding.docsUrl,
      },
    });
  }

  async deactivate(ctx: TenantContext, key: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const item = await db.capabilityBinding.findFirst({ where: { key } });
    if (!item) throw new NotFoundException(`Capability "${key}" not found`);
    return this.prisma.capabilityBinding.update({
      where: { id: item.id },
      data: { active: false },
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Auto-reconcile — sync CapabilityBinding from source tables
  // ═══════════════════════════════════════════════════════════

  /**
   * Scans Connector, AgentDefinition, AdapterRegistration, PackCapability
   * and ensures CapabilityBinding has corresponding entries.
   *
   * Called on module init and on-demand (POST /capabilities/reconcile).
   */
  async reconcile(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);
    const report = { connectors: 0, agents: 0, adapters: 0, packCapabilities: 0 };

    // Connectors
    const connectors = await db.connector.findMany();
    for (const c of connectors) {
      await this.upsertBinding(ctx, {
        kind: 'CONNECTOR',
        sourceType: 'Connector',
        sourceId: c.id,
        key: `connector:${c.key}`,
        label: c.name,
        category: c.type.toLowerCase().replace('_', '-'),
        tags: [c.type, c.status],
        inputSchema: {
          type: 'object',
          properties: { method: { type: 'string' }, payload: { type: 'object' } },
        },
        outputSchema: { type: 'object', properties: { data: {}, statusCode: { type: 'number' } } },
      });
      report.connectors++;
    }

    // Agents
    const agents = await db.agentDefinition.findMany();
    for (const a of agents) {
      await this.upsertBinding(ctx, {
        kind: 'AGENT',
        sourceType: 'AgentDefinition',
        sourceId: a.id,
        key: `agent:${a.key}`,
        label: a.name,
        category: a.category,
        tags: [
          a.category,
          a.kernelType,
          ...(Array.isArray(a.capabilitiesJson) ? (a.capabilitiesJson as string[]) : []),
        ],
        inputSchema: a.inputSchemaJson,
        outputSchema: a.outputSchemaJson,
      });
      report.agents++;
    }

    // Adapters
    const adapters = await db.adapterRegistration.findMany({ where: { active: true } });
    for (const ad of adapters) {
      await this.upsertBinding(ctx, {
        kind: 'ADAPTER',
        sourceType: 'AdapterRegistration',
        sourceId: ad.id,
        key: `adapter:${ad.key}`,
        label: ad.name,
        category: ad.adapterType,
        tags: [ad.adapterType, ad.implementation],
        inputSchema: ad.inputSchemaJson,
        outputSchema: ad.outputSchemaJson,
      });
      report.adapters++;
    }

    // Pack capabilities (existing table)
    // NOTE: packCapability table does not exist in schema, commented out
    // const packCaps = await this.prisma.packCapability.findMany({
    //   where: { packVersion: { pack: { installations: { some: { tenantId: ctx.tenantId } } } } },
    //   take: 200,
    //   include: { packVersion: { include: { pack: true } } },
    // }).catch(() => []);
    // for (const pc of packCaps) {
    //   await this.upsertBinding(ctx, {
    //     kind: 'SKILL',
    //     sourceType: 'PackCapability',
    //     sourceId: pc.id,
    //     key: `skill:${pc.packVersion.pack.key}:${pc.key}`,
    //     label: pc.name,
    //     category: pc.category || 'skill',
    //     tags: [pc.category || 'skill'],
    //     inputSchema: pc.inputSchemaJson ?? {},
    //     outputSchema: pc.outputSchemaJson ?? {},
    //   });
    //   report.packCapabilities++;
    // }

    this.logger.log(
      `[registry] Reconciled for tenant ${ctx.tenantId}: ` +
        `connectors=${report.connectors}, agents=${report.agents}, ` +
        `adapters=${report.adapters}, packs=${report.packCapabilities}`,
    );
    return report;
  }
}
