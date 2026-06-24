import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import * as bcrypt from 'bcryptjs';
import { mergeOpsRef, sanitizeOpsRefPatch, OpsReference } from '../../common/ops-reference.defaults';

/** 관리자 역할(사용자 삭제 가드용) */
const ADMIN_ROLES = ['TENANT_ADMIN', 'PLATFORM_ADMIN'];

export interface CreateUserDto {
  email: string;
  name?: string;
  role: string;
  password: string;
}
export interface UpdateUserDto {
  name?: string;
  role?: string;
  isActive?: boolean;
  password?: string;
}

@Injectable()
export class TenantService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async findById(id: string) {
    return this.prisma.tenant.findUniqueOrThrow({ where: { id } });
  }

  async findBySlug(slug: string) {
    return this.prisma.tenant.findUniqueOrThrow({ where: { slug } });
  }

  async getMemberships(tenantId: string) {
    return this.prisma.membership.findMany({
      where: { tenantId },
      include: { user: true },
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 사용자 기준정보 (User + Membership + 자격증명) CRUD — 관리자 전용
  //   비밀번호 해시는 기존 패턴대로 KnowledgeArtifact(category:AUTH,
  //   key: user-credential-<userId>)의 contentJson.passwordHash 에 저장한다.
  // ════════════════════════════════════════════════════════════════

  /** 현재 테넌트 구성원 목록 (역할/활성/가입일 포함). */
  async listUsers(tenantId: string) {
    const ms = await this.prisma.membership.findMany({
      where: { tenantId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: ms.map((m: any) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        isActive: m.user.isActive,
        createdAt: m.createdAt,
      })),
    };
  }

  /** 자격증명(비밀번호 해시) upsert — 생성/재설정 공용. */
  private async setCredential(tenantId: string, userId: string, email: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 12);
    await (this.prisma as any).knowledgeArtifact.upsert({
      where: { tenantId_key: { tenantId, key: `user-credential-${userId}` } },
      update: { contentJson: { passwordHash } },
      create: {
        tenantId,
        key: `user-credential-${userId}`,
        title: `Credential: ${email}`,
        category: 'AUTH',
        status: 'ACTIVE',
        version: '1',
        contentJson: { passwordHash },
      },
    });
  }

  /** 사용자 등록: 이메일로 User 확보(없으면 생성) + Membership + 초기 비밀번호. */
  async createUser(tenantId: string, dto: CreateUserDto) {
    const email = (dto.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw new BadRequestException('유효한 이메일이 필요합니다.');
    if (!dto.password || dto.password.length < 4)
      throw new BadRequestException('비밀번호는 4자 이상이어야 합니다.');
    if (!dto.role) throw new BadRequestException('역할(role)이 필요합니다.');

    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { email, name: (dto.name || '').trim() || email, isActive: true },
      });
    }
    const existing = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: user.id } },
    });
    if (existing) throw new BadRequestException('이미 이 조직의 구성원으로 등록된 계정입니다.');

    await this.prisma.membership.create({
      data: { tenantId, userId: user.id, role: dto.role as any },
    });
    await this.setCredential(tenantId, user.id, email, dto.password);

    return { userId: user.id, email, name: user.name, role: dto.role, isActive: user.isActive };
  }

  /** 사용자 수정: 이름/활성/역할 + (선택)비밀번호 재설정. */
  async updateUser(tenantId: string, userId: string, dto: UpdateUserDto) {
    const membership = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('해당 구성원을 찾을 수 없습니다.');

    if (dto.name !== undefined || dto.isActive !== undefined) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() || membership.user.email } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    }
    if (dto.role) {
      // 마지막 관리자 강등 방지
      if (ADMIN_ROLES.includes(membership.role) && !ADMIN_ROLES.includes(dto.role)) {
        await this.assertNotLastAdmin(tenantId, userId);
      }
      await this.prisma.membership.update({
        where: { tenantId_userId: { tenantId, userId } },
        data: { role: dto.role as any },
      });
    }
    if (dto.password) {
      if (dto.password.length < 4) throw new BadRequestException('비밀번호는 4자 이상이어야 합니다.');
      await this.setCredential(tenantId, userId, membership.user.email, dto.password);
    }
    return { ok: true };
  }

  /** 사용자 삭제: 본인/마지막 관리자 보호. 테넌트 멤버십 제거 후 잔여 멤버십 없으면 계정·자격증명 정리. */
  async deleteUser(tenantId: string, actingUserId: string, userId: string) {
    if (actingUserId === userId) throw new BadRequestException('본인 계정은 삭제할 수 없습니다.');
    const membership = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (!membership) throw new NotFoundException('해당 구성원을 찾을 수 없습니다.');
    if (ADMIN_ROLES.includes(membership.role)) await this.assertNotLastAdmin(tenantId, userId);

    await this.prisma.membership.delete({
      where: { tenantId_userId: { tenantId, userId } },
    });
    const remaining = await this.prisma.membership.count({ where: { userId } });
    if (remaining === 0) {
      await (this.prisma as any).knowledgeArtifact
        .deleteMany({ where: { key: `user-credential-${userId}` } })
        .catch(() => undefined);
      await this.prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    return { ok: true };
  }

  private async assertNotLastAdmin(tenantId: string, excludingUserId?: string) {
    const adminCount = await this.prisma.membership.count({
      where: {
        tenantId,
        role: { in: ADMIN_ROLES as any },
        ...(excludingUserId ? { NOT: { userId: excludingUserId } } : {}),
      },
    });
    if (adminCount < 1)
      throw new BadRequestException('마지막 관리자 계정은 삭제/강등할 수 없습니다.');
  }

  // ════════════════════════════════════════════════════════════════
  // 테넌트(조직 그룹) · 팀 기준정보 — 관리자 전용
  //   조직 그룹 = Tenant, 그 아래 하위 팀 = Team(@@unique[tenantId,name]).
  //   기본 단위는 팀이며 조직(테넌트)에 연결된 형태.
  // ════════════════════════════════════════════════════════════════

  /** 현재 조직(테넌트) + 소속 팀 목록(팀별 Ingest 키 수 포함). */
  async getOrgWithTeams(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, createdAt: true },
    });
    const teams = await (this.prisma as any).team.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true, _count: { select: { ingestKeys: true } } },
    });
    const memberCount = await this.prisma.membership.count({ where: { tenantId } });
    return {
      tenant: { ...tenant, memberCount },
      teams: teams.map((t: any) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        keyCount: t._count?.ingestKeys ?? 0,
      })),
    };
  }

  /** 팀 생성 (이름 중복 방지). */
  async createTeam(tenantId: string, name: string) {
    const nm = (name || '').trim();
    if (!nm) throw new BadRequestException('팀 이름이 필요합니다.');
    const dup = await (this.prisma as any).team.findUnique({
      where: { tenantId_name: { tenantId, name: nm } },
    });
    if (dup) throw new BadRequestException('같은 이름의 팀이 이미 있습니다.');
    return (this.prisma as any).team.create({
      data: { tenantId, name: nm },
      select: { id: true, name: true, createdAt: true },
    });
  }

  /** 팀 이름 변경. */
  async updateTeam(tenantId: string, teamId: string, name: string) {
    const nm = (name || '').trim();
    if (!nm) throw new BadRequestException('팀 이름이 필요합니다.');
    const team = await (this.prisma as any).team.findFirst({ where: { id: teamId, tenantId } });
    if (!team) throw new NotFoundException('팀을 찾을 수 없습니다.');
    const dup = await (this.prisma as any).team.findUnique({
      where: { tenantId_name: { tenantId, name: nm } },
    });
    if (dup && dup.id !== teamId) throw new BadRequestException('같은 이름의 팀이 이미 있습니다.');
    return (this.prisma as any).team.update({
      where: { id: teamId },
      data: { name: nm },
      select: { id: true, name: true, createdAt: true },
    });
  }

  /** 팀 삭제 (연결된 Ingest 키는 onDelete:SetNull 로 팀 해제만 됨). */
  async deleteTeam(tenantId: string, teamId: string) {
    const team = await (this.prisma as any).team.findFirst({ where: { id: teamId, tenantId } });
    if (!team) throw new NotFoundException('팀을 찾을 수 없습니다.');
    await (this.prisma as any).team.delete({ where: { id: teamId } });
    return { ok: true };
  }

  // ════════════════════════════════════════════════════════════════
  // 운영 기준값(OpsReferenceConfig) 기준정보 — 시급·근무시간·health 임계값·등급
  // ════════════════════════════════════════════════════════════════

  /** 현재 조직의 운영 기준값 (행/테이블/클라이언트 없으면 기본값). */
  async getOpsReference(tenantId: string): Promise<OpsReference> {
    const model = (this.prisma as any).opsReferenceConfig;
    if (!model || typeof model.findUnique !== 'function') return mergeOpsRef(null);
    const row = await model.findUnique({ where: { tenantId } }).catch(() => null);
    return mergeOpsRef(row);
  }

  /** 운영 기준값 저장(upsert) — 알려진 숫자 필드만, 범위 클램프. */
  async updateOpsReference(tenantId: string, patch: Record<string, any>): Promise<OpsReference> {
    const model = (this.prisma as any).opsReferenceConfig;
    if (!model || typeof model.upsert !== 'function') {
      throw new BadRequestException(
        '운영 기준값 테이블이 아직 준비되지 않았습니다. start-metis.bat(db:generate + push)를 한 번 실행해 마이그레이션을 적용하세요.',
      );
    }
    const data = sanitizeOpsRefPatch(patch || {});
    const saved = await model.upsert({
      where: { tenantId },
      update: data,
      create: { tenantId, ...data },
    });
    return mergeOpsRef(saved);
  }

  /** 전체 조직(테넌트) 목록 — 조직별 구성원/팀 수 포함. */
  async listAllTenants() {
    const tenants = await (this.prisma as any).tenant.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
        _count: { select: { users: true, teams: true } },
      },
    });
    return {
      items: tenants.map((t: any) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        createdAt: t.createdAt,
        memberCount: t._count?.users ?? 0,
        teamCount: t._count?.teams ?? 0,
      })),
    };
  }

  /** 조직(테넌트) 생성 — slug 미지정 시 이름에서 생성, 중복 방지. */
  async createTenant(name: string, slug?: string) {
    const nm = (name || '').trim();
    if (!nm) throw new BadRequestException('조직(테넌트) 이름이 필요합니다.');
    let base =
      (slug || nm)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'org';
    // slug 유일성 확보
    let finalSlug = base;
    for (let i = 1; i < 50; i++) {
      const dup = await (this.prisma as any).tenant.findUnique({ where: { slug: finalSlug } });
      if (!dup) break;
      finalSlug = `${base}-${i}`;
    }
    const created = await (this.prisma as any).tenant.create({
      data: { name: nm, slug: finalSlug },
      select: { id: true, slug: true, name: true, createdAt: true },
    });
    return { ...created, memberCount: 0, teamCount: 0 };
  }

  /**
   * 조직(테넌트) 삭제. 안전장치:
   *  - 현재 로그인한 조직은 삭제 불가(자기 발등 찍기 방지)
   *  - 에이전트(워크플로우)나 실행 이력이 남아있으면 차단 — 데이터 보호.
   *  즉 비어있는(테스트/미사용) 조직만 정리 가능. 나머지는 먼저 비워야 한다.
   */
  async deleteTenant(currentTenantId: string, tenantId: string) {
    if (!tenantId) throw new BadRequestException('조직 ID가 필요합니다.');
    if (tenantId === currentTenantId)
      throw new BadRequestException('현재 로그인한 조직은 삭제할 수 없습니다.');

    const tenant = await (this.prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, _count: { select: { workflows: true, users: true } } },
    });
    if (!tenant) throw new NotFoundException('조직(테넌트)을 찾을 수 없습니다.');

    const wfCount = tenant._count?.workflows ?? 0;
    let runCount = 0;
    try {
      runCount = await (this.prisma as any).executionSession.count({ where: { tenantId } });
    } catch {
      /* 테이블 부재 등은 무시 */
    }
    if (wfCount > 0 || runCount > 0) {
      throw new BadRequestException(
        `데이터가 있는 조직은 삭제할 수 없습니다 (에이전트 ${wfCount}개 · 실행 이력 ${runCount}건). ` +
          `먼저 에이전트/이력을 정리한 뒤 삭제하세요.`,
      );
    }

    try {
      await (this.prisma as any).tenant.delete({ where: { id: tenantId } });
    } catch (e) {
      throw new BadRequestException(
        `조직 삭제 실패 — 연결된 데이터(사용자/팀/키 등)가 남아 있습니다. 먼저 정리 후 다시 시도하세요. (${(e as Error).message})`,
      );
    }
    return { ok: true, deleted: tenant.name };
  }

  /**
   * G6a (governance): update tenant settings. Currently exposes the
   * `externalLlmDisabled` flag — when true, the AI-analysis executor and the
   * LLM judge stop egressing to external LLM providers and use local fallbacks.
   */
  async updateSettings(tenantId: string, settings: { externalLlmDisabled?: boolean }) {
    const data: Record<string, unknown> = {};
    if (typeof settings.externalLlmDisabled === 'boolean') {
      data.externalLlmDisabled = settings.externalLlmDisabled;
    }
    return (this.prisma as any).tenant.update({
      where: { id: tenantId },
      data,
      select: { id: true, slug: true, name: true, externalLlmDisabled: true },
    });
  }
}
