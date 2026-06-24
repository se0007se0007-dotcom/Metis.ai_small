import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { QUEUE_TOKEN } from './queue.provider';
import { canTransition, PackStatus } from './domain';

/** Pack statuses visible to non-admin users */
const PUBLIC_PACK_STATUSES = ['PUBLISHED', 'CERTIFIED'];

interface QueueLike {
  add(name: string, data: any, opts?: any): Promise<{ id?: string | null }>;
  getJob(id: string): Promise<any>;
}

@Injectable()
export class PackService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(QUEUE_TOKEN) private readonly packImportQueue: QueueLike,
  ) {}

  // ═══════════════════════════════════════════
  //  Pack Listing & Retrieval
  // ═══════════════════════════════════════════

  async listPacks(filters?: {
    sourceType?: string;
    status?: string;
    role?: string;
    search?: string;
  }) {
    const where: any = {};

    if (filters?.sourceType) {
      where.sourceType = filters.sourceType;
    }

    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { key: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters?.status) {
      where.versions = { some: { status: filters.status } };
    } else if (
      filters?.role &&
      !['PLATFORM_ADMIN', 'TENANT_ADMIN', 'OPERATOR'].includes(filters.role)
    ) {
      where.versions = { some: { status: { in: PUBLIC_PACK_STATUSES } } };
    }

    return this.prisma.pack.findMany({
      where,
      include: {
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            version: true,
            status: true,
            publishedAt: true,
          },
        },
        _count: { select: { installs: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getPackById(packId: string) {
    const pack = await this.prisma.pack.findUnique({
      where: { id: packId },
      include: {
        versions: { orderBy: { createdAt: 'desc' } },
        installs: {
          take: 10,
          orderBy: { installedAt: 'desc' },
          select: { id: true, tenantId: true, installedAt: true },
        },
        _count: { select: { installs: true, versions: true } },
      },
    });

    if (!pack) throw new NotFoundException(`Pack ${packId} not found`);
    return pack;
  }

  async getPackVersions(packId: string) {
    return this.prisma.packVersion.findMany({
      where: { packId },
      include: {
        certifications: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { id: true, level: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPackVersionById(versionId: string) {
    const version = await this.prisma.packVersion.findUnique({
      where: { id: versionId },
      include: {
        pack: true,
        certifications: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!version) throw new NotFoundException(`PackVersion ${versionId} not found`);
    return version;
  }

  // ═══════════════════════════════════════════
  //  Installation (tenant-scoped)
  // ═══════════════════════════════════════════

  async getInstallations(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);
    return db.packInstallation.findMany({
      include: {
        pack: true,
        packVersion: {
          select: { id: true, version: true, status: true },
        },
      },
      orderBy: { installedAt: 'desc' },
    });
  }

  async install(
    ctx: TenantContext,
    packId: string,
    packVersionId: string,
    config?: Record<string, unknown>,
  ) {
    // Validate version is PUBLISHED or CERTIFIED
    const version = await this.prisma.packVersion.findUnique({
      where: { id: packVersionId },
    });

    if (!version) throw new NotFoundException('Pack version not found');
    if (!['PUBLISHED', 'CERTIFIED'].includes(version.status)) {
      throw new BadRequestException(
        `Cannot install pack in status "${version.status}". Only PUBLISHED or CERTIFIED packs can be installed.`,
      );
    }

    // Check for existing installation
    const existing = await this.prisma.packInstallation.findFirst({
      where: {
        packId,
        packVersionId,
        tenantId: ctx.tenantId,
      },
    });

    if (existing) {
      throw new BadRequestException('This pack version is already installed for your tenant');
    }

    const db = withTenantIsolation(this.prisma, ctx);
    return db.packInstallation.create({
      data: {
        packId,
        packVersionId,
        installedById: ctx.userId,
        configJson: config ?? {},
        tenantId: ctx.tenantId,
      },
    });
  }

  async uninstall(ctx: TenantContext, installationId: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const installation = await db.packInstallation.findUnique({
      where: { id: installationId },
    });
    if (!installation) throw new NotFoundException('Installation not found');

    await db.packInstallation.delete({ where: { id: installationId } });
    return { success: true };
  }

  // ═══════════════════════════════════════════
  //  Import (BullMQ dispatch)
  // ═══════════════════════════════════════════

  async importPack(
    data: {
      sourceType: string;
      sourceUrl: string;
      displayName?: string;
    },
    user?: { userId: string; tenantId: string },
  ): Promise<{ jobId: string; status: 'QUEUED' }> {
    const job = await this.packImportQueue.add(
      'import',
      {
        sourceType: data.sourceType,
        sourceUrl: data.sourceUrl,
        displayName: data.displayName,
        tenantId: user?.tenantId,
        userId: user?.userId,
        autoInstall: false,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    );

    return {
      jobId: job.id ?? `import-${Date.now()}`,
      status: 'QUEUED',
    };
  }

  // ═══════════════════════════════════════════
  //  Admin: Status transitions
  // ═══════════════════════════════════════════

  async transitionVersionStatus(versionId: string, targetStatus: PackStatus, role: string) {
    const version = await this.prisma.packVersion.findUnique({
      where: { id: versionId },
    });

    if (!version) throw new NotFoundException('Pack version not found');

    const currentStatus = version.status as PackStatus;
    const result = canTransition(currentStatus, targetStatus, role);

    if (!result.allowed) {
      throw new BadRequestException(result.reason);
    }

    const updateData: any = { status: targetStatus };
    if (targetStatus === 'PUBLISHED') {
      updateData.publishedAt = new Date();
    }

    return this.prisma.packVersion.update({
      where: { id: versionId },
      data: updateData,
    });
  }

  // ═══════════════════════════════════════════
  //  Job Status Query
  // ═══════════════════════════════════════════

  async getJobStatus(jobId: string) {
    const job = await this.packImportQueue.getJob(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);

    return {
      jobId: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      state: (await job.getState?.()) ?? 'unknown',
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
    };
  }
}
