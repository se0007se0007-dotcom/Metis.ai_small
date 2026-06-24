/**
 * Workflow Persistence Service — Full CRUD + Version Management
 *
 * Manages the lifecycle of saved workflows:
 *   - Create / Read / Update / Delete (soft)
 *   - Publish (creates a versioned snapshot)
 *   - Version history and restore
 *   - OCC via `version` field (optimistic concurrency control)
 *
 * All operations are tenant-scoped.
 */
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaClient, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

// ── DTOs ──

export interface CreateWorkflowDto {
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  nodes: WorkflowNodeDto[];
  edges?: WorkflowEdgeDto[];
}

export interface UpdateWorkflowDto {
  name?: string;
  description?: string;
  tags?: string[];
  nodes?: WorkflowNodeDto[];
  edges?: WorkflowEdgeDto[];
  /** OCC: client must send the current version number */
  expectedVersion: number;
}

/**
 * SCENARIO 2 / OPS: editable per-agent effectiveness baseline + system assignment.
 * All fields OPTIONAL — only provided keys are merged into Workflow.effectivenessJson.
 * `system` is additionally promoted onto the Workflow.system column (and mirrored
 * into effectivenessJson.system for back-compat).
 */
export interface UpdateEffectivenessDto {
  system?: string;
  manualMinutesPerRun?: number;
  valueLabel?: string;
  domain?: string;
  mttdTargetPct?: number;
  coverageTargetX?: number;
  hourlyRateUsd?: number;
  allowedTools?: string[];
  allowedDomains?: string[];
}

export interface UpdateEffectivenessResult {
  workflowKey: string;
  system: string | null;
  effectivenessJson: Record<string, any> | null;
}

export interface WorkflowNodeDto {
  nodeKey: string;
  uiType: string;
  name: string;
  executionOrder: number;
  config: Record<string, any>;
  inputMapping?: Record<string, string>;
  dependsOn?: string[];
  positionX?: number;
  positionY?: number;
}

export interface WorkflowEdgeDto {
  fromNodeKey: string;
  toNodeKey: string;
  edgeType?: string;
  condition?: string;
  label?: string;
}

export interface WorkflowListQuery {
  status?: string;
  search?: string;
  tags?: string[];
  page?: number;
  limit?: number;
  sortBy?: 'updatedAt' | 'createdAt' | 'name';
  sortOrder?: 'asc' | 'desc';
}

export interface WorkflowListResult {
  items: WorkflowSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface WorkflowSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  tags: string[];
  nodeCount: number;
  createdById: string;
  createdByName?: string;
  updatedAt: Date;
  createdAt: Date;
}

export interface WorkflowDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  activeVersionId: string | null;
  tags: string[];
  createdById: string;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
}

export interface WorkflowVersionSummary {
  id: string;
  versionNumber: number;
  label: string | null;
  createdById: string;
  createdByName?: string;
  createdAt: Date;
  nodeCount: number;
}

// ── Service ──

@Injectable()
export class WorkflowPersistenceService {
  private readonly logger = new Logger(WorkflowPersistenceService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ── Create ──

  async create(ctx: TenantContext, dto: CreateWorkflowDto): Promise<WorkflowDetail> {
    // Validate key format
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(dto.key)) {
      throw new BadRequestException('워크플로우 키는 소문자, 숫자, 하이픈만 허용됩니다 (3-64자).');
    }

    // Check duplicate key
    const existing = await this.prisma.workflow.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: dto.key } },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException(`워크플로우 키 "${dto.key}"가 이미 존재합니다.`);
    }

    if (!dto.nodes || dto.nodes.length === 0) {
      throw new BadRequestException('워크플로우에 최소 1개의 노드가 필요합니다.');
    }

    const workflow = await this.prisma.workflow.create({
      data: {
        tenantId: ctx.tenantId,
        key: dto.key,
        name: dto.name,
        description: dto.description,
        tags: dto.tags || [],
        status: 'DRAFT',
        // SCENARIO 3: user-built workflows start UNLISTED (listed=false) so they
        // must pass ORB review before appearing in the Ops.AI catalog. Seeded/
        // system workflows keep the schema default (listed=true).
        ...({ listed: false } as any),
        version: 1,
        createdById: ctx.userId,
        updatedById: ctx.userId,
        nodes: {
          create: dto.nodes.map((n) => ({
            nodeKey: n.nodeKey,
            uiType: n.uiType,
            name: n.name,
            executionOrder: n.executionOrder,
            configJson: n.config as any,
            inputMappingJson: n.inputMapping ? (n.inputMapping as any) : undefined,
            dependsOn: n.dependsOn || [],
            positionX: n.positionX,
            positionY: n.positionY,
          })),
        },
        edges: dto.edges
          ? {
              create: dto.edges.map((e) => ({
                fromNodeKey: e.fromNodeKey,
                toNodeKey: e.toNodeKey,
                edgeType: e.edgeType || 'SEQUENCE',
                condition: e.condition,
                label: e.label,
              })),
            }
          : undefined,
      },
      include: { nodes: true, edges: true },
    });

    this.logger.log(`[create] tenant=${ctx.tenantId} key=${dto.key} nodes=${dto.nodes.length}`);

    return this.toDetail(workflow);
  }

  // ── List ──

  async findAll(ctx: TenantContext, query: WorkflowListQuery): Promise<WorkflowListResult> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {
      tenantId: ctx.tenantId,
      deletedAt: null,
    };

    if (query.status) {
      where.status = query.status;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { key: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.tags && query.tags.length > 0) {
      where.tags = { hasSome: query.tags };
    }

    const sortBy = query.sortBy || 'updatedAt';
    const sortOrder = query.sortOrder || 'desc';

    const [items, total] = await Promise.all([
      this.prisma.workflow.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          _count: { select: { nodes: true } },
          createdBy: { select: { name: true } },
        },
      }),
      this.prisma.workflow.count({ where }),
    ]);

    return {
      items: items.map((w) => ({
        id: w.id,
        key: w.key,
        name: w.name,
        description: w.description,
        status: w.status,
        version: w.version,
        tags: w.tags,
        nodeCount: (w as any)._count.nodes,
        createdById: w.createdById,
        createdByName: (w as any).createdBy?.name,
        updatedAt: w.updatedAt,
        createdAt: w.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ── Get One ──

  async findOne(ctx: TenantContext, id: string): Promise<WorkflowDetail> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: {
        nodes: { orderBy: { executionOrder: 'asc' } },
        edges: true,
      },
    });

    if (!workflow) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    return this.toDetail(workflow);
  }

  // ── Update (with OCC) ──

  async update(ctx: TenantContext, id: string, dto: UpdateWorkflowDto): Promise<WorkflowDetail> {
    const existing = await this.prisma.workflow.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    // OCC check
    if (existing.version !== dto.expectedVersion) {
      throw new ConflictException(
        `다른 사용자가 이미 수정했습니다. 현재 버전: ${existing.version}, 요청 버전: ${dto.expectedVersion}. 새로고침 후 다시 시도해주세요.`,
      );
    }

    // Build update data
    const updateData: any = {
      version: { increment: 1 },
      updatedById: ctx.userId,
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.tags !== undefined) updateData.tags = dto.tags;

    // Use a transaction for atomic node/edge replacement
    const result = await this.prisma.$transaction(async (tx) => {
      // Replace nodes if provided
      if (dto.nodes) {
        await tx.workflowNodeDef.deleteMany({ where: { workflowId: id } });
        await tx.workflowNodeDef.createMany({
          data: dto.nodes.map((n) => ({
            workflowId: id,
            nodeKey: n.nodeKey,
            uiType: n.uiType,
            name: n.name,
            executionOrder: n.executionOrder,
            configJson: n.config as any,
            inputMappingJson: n.inputMapping ? (n.inputMapping as any) : undefined,
            dependsOn: n.dependsOn || [],
            positionX: n.positionX,
            positionY: n.positionY,
          })),
        });
      }

      // Replace edges if provided
      if (dto.edges) {
        await tx.workflowEdgeDef.deleteMany({ where: { workflowId: id } });
        if (dto.edges.length > 0) {
          await tx.workflowEdgeDef.createMany({
            data: dto.edges.map((e) => ({
              workflowId: id,
              fromNodeKey: e.fromNodeKey,
              toNodeKey: e.toNodeKey,
              edgeType: e.edgeType || 'SEQUENCE',
              condition: e.condition,
              label: e.label,
            })),
          });
        }
      }

      // Update workflow metadata
      const updated = await tx.workflow.update({
        where: { id },
        data: updateData,
        include: {
          nodes: { orderBy: { executionOrder: 'asc' } },
          edges: true,
        },
      });

      return updated;
    });

    this.logger.log(`[update] tenant=${ctx.tenantId} id=${id} version=${result.version}`);

    return this.toDetail(result);
  }

  // ── Delete (soft) ──

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const existing = await this.prisma.workflow.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    await this.prisma.workflow.update({
      where: { id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        updatedById: ctx.userId,
      },
    });

    this.logger.log(`[delete] tenant=${ctx.tenantId} id=${id} key=${existing.key}`);
  }

  // ── Publish (create version snapshot) ──

  async publish(
    ctx: TenantContext,
    id: string,
    label?: string,
    opts?: {
      /** Set by ImmutableVersionPromotionService — governance already enforced. */
      governanceApproved?: boolean;
    },
  ): Promise<{ workflow: WorkflowDetail; version: WorkflowVersionSummary }> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: {
        nodes: { orderBy: { executionOrder: 'asc' } },
        edges: true,
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
      },
    });

    if (!workflow) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    if (workflow.nodes.length === 0) {
      throw new BadRequestException('노드가 없는 워크플로우는 퍼블리시할 수 없습니다.');
    }

    // ── Governance guard (점검 C-1) ──────────────────────────────
    // Direct publish must not bypass ORB governance. When the promotion
    // path calls us (governanceApproved=true) the fingerprint was already
    // validated, so we skip. Otherwise we require an APPROVED governance
    // review for this workflow. GOVERNANCE_PUBLISH_ENFORCE controls whether
    // a missing review hard-blocks (true) or only warns (default, for
    // backward compatibility during rollout).
    if (!opts?.governanceApproved) {
      const approvedReview = await (this.prisma as any).orbGovernanceReview.findFirst({
        where: {
          tenantId: ctx.tenantId,
          workflowId: id,
          status: { in: ['APPROVED', 'PROMOTED', 'ACTIVE'] },
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (!approvedReview) {
        const enforce = process.env.GOVERNANCE_PUBLISH_ENFORCE === 'true';
        const msg =
          '거버넌스 심사를 통과하지 않은 워크플로우입니다. ORB 거버넌스 심사·승격을 먼저 완료하세요.';
        if (enforce) {
          throw new BadRequestException(msg);
        }
        this.logger.warn(
          `[publish] governance review missing for workflow=${id} (enforce=off) — ${msg}`,
        );
      }
    }

    const nextVersionNumber =
      workflow.versions.length > 0 ? workflow.versions[0].versionNumber + 1 : 1;

    // Create snapshot
    const nodesSnapshot = workflow.nodes.map((n) => ({
      nodeKey: n.nodeKey,
      uiType: n.uiType,
      name: n.name,
      executionOrder: n.executionOrder,
      config: n.configJson,
      inputMapping: n.inputMappingJson,
      dependsOn: n.dependsOn,
      positionX: n.positionX,
      positionY: n.positionY,
    }));

    const edgesSnapshot = workflow.edges.map((e) => ({
      fromNodeKey: e.fromNodeKey,
      toNodeKey: e.toNodeKey,
      edgeType: e.edgeType,
      condition: e.condition,
      label: e.label,
    }));

    const result = await this.prisma.$transaction(async (tx) => {
      const version = await tx.workflowVersion.create({
        data: {
          workflowId: id,
          versionNumber: nextVersionNumber,
          label: label || `v${nextVersionNumber}`,
          nodesSnapshot: nodesSnapshot as any,
          edgesSnapshot: edgesSnapshot as any,
          settingsSnapshot: {
            name: workflow.name,
            description: workflow.description,
            tags: workflow.tags,
          } as any,
          createdById: ctx.userId,
        },
      });

      const updated = await tx.workflow.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          activeVersionId: version.id,
          version: { increment: 1 },
          updatedById: ctx.userId,
        },
        include: {
          nodes: { orderBy: { executionOrder: 'asc' } },
          edges: true,
        },
      });

      return { updated, version };
    });

    this.logger.log(`[publish] tenant=${ctx.tenantId} id=${id} version=${nextVersionNumber}`);

    return {
      workflow: this.toDetail(result.updated),
      version: {
        id: result.version.id,
        versionNumber: result.version.versionNumber,
        label: result.version.label,
        createdById: result.version.createdById,
        createdAt: result.version.createdAt,
        nodeCount: nodesSnapshot.length,
      },
    };
  }

  // ── Version History ──

  async listVersions(ctx: TenantContext, workflowId: string): Promise<WorkflowVersionSummary[]> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, tenantId: ctx.tenantId, deletedAt: null },
    });

    if (!workflow) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    const versions = await this.prisma.workflowVersion.findMany({
      where: { workflowId },
      orderBy: { versionNumber: 'desc' },
      include: { createdBy: { select: { name: true } } },
    });

    return versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      label: v.label,
      createdById: v.createdById,
      createdByName: (v as any).createdBy?.name,
      createdAt: v.createdAt,
      nodeCount: Array.isArray(v.nodesSnapshot) ? (v.nodesSnapshot as any[]).length : 0,
    }));
  }

  // ── Restore Version ──

  async restoreVersion(
    ctx: TenantContext,
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowDetail> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, tenantId: ctx.tenantId, deletedAt: null },
    });

    if (!workflow) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    const version = await this.prisma.workflowVersion.findFirst({
      where: { id: versionId, workflowId },
    });

    if (!version) {
      throw new NotFoundException('해당 버전을 찾을 수 없습니다.');
    }

    const nodesData = version.nodesSnapshot as any[];
    const edgesData = version.edgesSnapshot as any[];

    const result = await this.prisma.$transaction(async (tx) => {
      // Clear current nodes and edges
      await tx.workflowNodeDef.deleteMany({ where: { workflowId } });
      await tx.workflowEdgeDef.deleteMany({ where: { workflowId } });

      // Restore from snapshot
      if (nodesData.length > 0) {
        await tx.workflowNodeDef.createMany({
          data: nodesData.map((n: any) => ({
            workflowId,
            nodeKey: n.nodeKey,
            uiType: n.uiType,
            name: n.name,
            executionOrder: n.executionOrder,
            configJson: n.config || {},
            inputMappingJson: n.inputMapping,
            dependsOn: n.dependsOn || [],
            positionX: n.positionX,
            positionY: n.positionY,
          })),
        });
      }

      if (edgesData && edgesData.length > 0) {
        await tx.workflowEdgeDef.createMany({
          data: edgesData.map((e: any) => ({
            workflowId,
            fromNodeKey: e.fromNodeKey,
            toNodeKey: e.toNodeKey,
            edgeType: e.edgeType || 'SEQUENCE',
            condition: e.condition,
            label: e.label,
          })),
        });
      }

      // Restore settings if available
      const settings = version.settingsSnapshot as any;
      const updated = await tx.workflow.update({
        where: { id: workflowId },
        data: {
          name: settings?.name || workflow.name,
          description: settings?.description ?? workflow.description,
          tags: settings?.tags || workflow.tags,
          version: { increment: 1 },
          updatedById: ctx.userId,
        },
        include: {
          nodes: { orderBy: { executionOrder: 'asc' } },
          edges: true,
        },
      });

      return updated;
    });

    this.logger.log(
      `[restore] tenant=${ctx.tenantId} workflow=${workflowId} version=${version.versionNumber}`,
    );

    return this.toDetail(result);
  }

  // ── Archive ──

  async archive(ctx: TenantContext, id: string): Promise<void> {
    const existing = await this.prisma.workflow.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    await this.prisma.workflow.update({
      where: { id },
      data: {
        status: 'ARCHIVED',
        updatedById: ctx.userId,
        version: { increment: 1 },
      },
    });

    this.logger.log(`[archive] tenant=${ctx.tenantId} id=${id}`);
  }

  // ── Duplicate ──

  async duplicate(
    ctx: TenantContext,
    id: string,
    newKey: string,
    newName: string,
  ): Promise<WorkflowDetail> {
    const original = await this.findOne(ctx, id);

    return this.create(ctx, {
      key: newKey,
      name: newName,
      description: original.description || undefined,
      tags: original.tags,
      nodes: original.nodes,
      edges: original.edges,
    });
  }

  // ── Private helpers ──

  // ── Scenario 2 / OPS: edit effectiveness baseline + system assignment ──

  /**
   * PATCH the per-agent effectiveness baseline (and target system) for a workflow,
   * resolved by (tenantId, key). Only provided DTO fields are merged into the
   * existing effectivenessJson (untouched keys are preserved). When `system` is
   * provided it is promoted onto the Workflow.system column AND mirrored into
   * effectivenessJson.system for back-compat. Tenant-scoped.
   */
  async updateEffectiveness(
    ctx: TenantContext,
    workflowKey: string,
    dto: UpdateEffectivenessDto,
  ): Promise<UpdateEffectivenessResult> {
    const existing = await this.prisma.workflow.findFirst({
      where: { tenantId: ctx.tenantId, key: workflowKey, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException('워크플로우를 찾을 수 없습니다.');
    }

    // Merge into the existing effectivenessJson, preserving untouched keys.
    const prev =
      existing.effectivenessJson && typeof existing.effectivenessJson === 'object'
        ? { ...(existing.effectivenessJson as Record<string, any>) }
        : {};
    const merged: Record<string, any> = { ...prev };

    if (dto.system !== undefined) merged.system = dto.system;
    if (dto.manualMinutesPerRun !== undefined) merged.manualMinutesPerRun = dto.manualMinutesPerRun;
    if (dto.valueLabel !== undefined) merged.valueLabel = dto.valueLabel;
    if (dto.domain !== undefined) merged.domain = dto.domain;
    if (dto.mttdTargetPct !== undefined) merged.mttdTargetPct = dto.mttdTargetPct;
    if (dto.coverageTargetX !== undefined) merged.coverageTargetX = dto.coverageTargetX;
    if (dto.hourlyRateUsd !== undefined) merged.hourlyRateUsd = dto.hourlyRateUsd;
    if (dto.allowedTools !== undefined) merged.allowedTools = dto.allowedTools;
    if (dto.allowedDomains !== undefined) merged.allowedDomains = dto.allowedDomains;

    const data: any = {
      effectivenessJson: merged as any,
      updatedById: ctx.userId,
    };
    if (dto.system !== undefined) data.system = dto.system;

    const updated = await (this.prisma as any).workflow.update({
      where: { id: existing.id },
      data,
      select: { key: true, system: true, effectivenessJson: true },
    });

    this.logger.log(
      `Effectiveness baseline updated: workflow=${workflowKey} tenant=${ctx.tenantId}`,
    );

    return {
      workflowKey: updated.key,
      system: updated.system ?? null,
      effectivenessJson: (updated.effectivenessJson as Record<string, any>) ?? null,
    };
  }

  /**
   * Sub-Agent → 메인 Agent 승격 (다중 메인 방지 가드 포함).
   *
   * 같은 Sub-Agent(subKey)는 **하나의 메인 Agent로만** 승격할 수 있다. 승격 시
   * `promoted-from:<subKey>` 마커 태그를 워크플로우에 남기고, 이미 같은 마커를 가진
   * (삭제되지 않은) 워크플로우가 있으면 거부한다. 감시는 Sub-Agent 단위, 대시보드는
   * 메인 기준 그룹핑이라는 모델과 일치한다.
   */
  async promoteSubAgent(
    ctx: TenantContext,
    dto: { subKey: string; name?: string; nodeType: string; category?: string; settings?: Record<string, any> },
  ): Promise<WorkflowDetail> {
    const subKey = (dto.subKey || '').trim();
    if (!subKey) throw new BadRequestException('Sub-Agent 키가 필요합니다.');
    if (!dto.nodeType)
      throw new BadRequestException('Sub-Agent의 노드 타입을 알 수 없어 승격할 수 없습니다.');

    const marker = `promoted-from:${subKey}`;
    const dup = await this.prisma.workflow.findFirst({
      where: { tenantId: ctx.tenantId, deletedAt: null, tags: { has: marker } },
      select: { key: true, name: true },
    });
    if (dup) {
      throw new ConflictException(
        `이미 메인 Agent로 승격된 Sub-Agent입니다: ${dup.name} (${dup.key}). Sub-Agent는 하나의 메인에만 매핑됩니다.`,
      );
    }

    const category = dto.category || 'operations';
    const name = dto.name || subKey;
    const slug =
      subKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
    const key = `subagent-${slug}-${Math.random().toString(36).slice(2, 6)}`;

    return this.create(ctx, {
      key,
      name,
      description: `${name} (Sub-Agent → 메인 Agent 승격)`,
      tags: [category, marker],
      nodes: [
        {
          nodeKey: 'agent',
          uiType: dto.nodeType,
          name,
          executionOrder: 1,
          config: { ...(dto.settings || {}), stepCategory: category },
        },
      ],
      edges: [],
    });
  }

  /**
   * Agent 기준정보 편집 — 메인 Agent(이름/코드/설명) + (선택)Sub-Agent(노드) 이름 변경.
   * 표시 이름 표준([코드] 이름)을 위해 code/name 을 직접 수정한다. 키로 조회, 테넌트 스코프.
   */
  async updateAgentMeta(
    ctx: TenantContext,
    workflowKey: string,
    dto: {
      name?: string;
      code?: string | null;
      description?: string | null;
      nodes?: Array<{ nodeKey: string; name: string }>;
      /** 외부 전용 실행 화면 URL — effectivenessJson.launchUrl 에 저장 */
      launchUrl?: string | null;
    },
  ): Promise<{ key: string; code: string | null; name: string; launchUrl: string | null }> {
    const existing = await this.prisma.workflow.findFirst({
      where: { tenantId: ctx.tenantId, key: workflowKey, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('워크플로우(Agent)를 찾을 수 없습니다.');

    const data: any = { updatedById: ctx.userId };
    if (dto.name !== undefined) {
      const nm = (dto.name || '').trim();
      if (!nm) throw new BadRequestException('Agent 이름은 비울 수 없습니다.');
      data.name = nm;
    }
    if (dto.code !== undefined) data.code = (dto.code || '').trim() || null;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.launchUrl !== undefined) {
      // effectivenessJson 에 launchUrl 병합(다른 키 보존). 빈 문자열이면 제거.
      const prev =
        existing.effectivenessJson && typeof existing.effectivenessJson === 'object'
          ? { ...(existing.effectivenessJson as Record<string, any>) }
          : {};
      const url = (dto.launchUrl || '').trim();
      if (url) prev.launchUrl = url;
      else delete prev.launchUrl;
      data.effectivenessJson = prev;
    }

    const updated = await (this.prisma as any).workflow.update({
      where: { id: existing.id },
      data,
      select: { key: true, code: true, name: true, effectivenessJson: true },
    });

    // (선택) Sub-Agent(노드) 이름 변경 — 같은 워크플로우 내 nodeKey 매칭.
    if (Array.isArray(dto.nodes)) {
      for (const n of dto.nodes) {
        if (!n?.nodeKey || n.name === undefined) continue;
        const nm = (n.name || '').trim();
        if (!nm) continue;
        await (this.prisma as any).workflowNodeDef.updateMany({
          where: { workflowId: existing.id, nodeKey: n.nodeKey },
          data: { name: nm },
        });
      }
    }

    const savedLaunchUrl =
      updated.effectivenessJson && typeof updated.effectivenessJson === 'object'
        ? ((updated.effectivenessJson as any).launchUrl ?? null)
        : null;
    this.logger.log(
      `Agent meta updated: workflow=${workflowKey} tenant=${ctx.tenantId} launchUrl=${savedLaunchUrl ?? '(none)'}`,
    );
    return { key: updated.key, code: updated.code ?? null, name: updated.name, launchUrl: savedLaunchUrl };
  }

  /**
   * 관리자 즉시 게시/미노출 전환 — listed 플래그를 직접 변경한다.
   * 게시(listed=true) 시 status 도 PUBLISHED 로 올려 실행 카탈로그에 바로 노출된다.
   * ORB 심사를 우회하는 관리자 권한 동작이므로 Audit 로그로 남긴다.
   */
  async setAgentListed(
    ctx: TenantContext,
    workflowKey: string,
    listed: boolean,
  ): Promise<{ key: string; listed: boolean; status: string }> {
    const existing = await this.prisma.workflow.findFirst({
      where: { tenantId: ctx.tenantId, key: workflowKey, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('워크플로우(Agent)를 찾을 수 없습니다.');

    const updated = await (this.prisma as any).workflow.update({
      where: { id: existing.id },
      data: {
        listed,
        ...(listed ? { status: 'PUBLISHED' } : {}),
        updatedById: ctx.userId,
      },
      select: { key: true, listed: true, status: true },
    });
    this.logger.log(
      `Agent listing ${listed ? 'PUBLISHED' : 'HIDDEN'}: workflow=${workflowKey} tenant=${ctx.tenantId}`,
    );
    return { key: updated.key, listed: updated.listed, status: updated.status };
  }

  private toDetail(workflow: any): WorkflowDetail {
    return {
      id: workflow.id,
      key: workflow.key,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      version: workflow.version,
      activeVersionId: workflow.activeVersionId,
      tags: workflow.tags,
      createdById: workflow.createdById,
      updatedById: workflow.updatedById,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      nodes: (workflow.nodes || []).map((n: any) => ({
        nodeKey: n.nodeKey,
        uiType: n.uiType,
        name: n.name,
        executionOrder: n.executionOrder,
        config: n.configJson || {},
        inputMapping: n.inputMappingJson || undefined,
        dependsOn: n.dependsOn || [],
        positionX: n.positionX,
        positionY: n.positionY,
      })),
      edges: (workflow.edges || []).map((e: any) => ({
        fromNodeKey: e.fromNodeKey,
        toNodeKey: e.toNodeKey,
        edgeType: e.edgeType,
        condition: e.condition,
        label: e.label,
      })),
    };
  }
}
