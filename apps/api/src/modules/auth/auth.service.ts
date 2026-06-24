import { Injectable, UnauthorizedException, Inject, Optional, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@metis/database';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PRISMA_TOKEN } from '../database.module';
import { SHARED_REDIS_TOKEN, SharedRedis } from '../../common/redis/shared-redis.module';

/**
 * M-1: refresh-token rotation + revocation.
 *
 * We use a table-less, in-memory approach to avoid a migration:
 *  - every refresh token carries a unique `jti`
 *  - `validJtis` tracks the currently-valid jti per user (single active session)
 *  - `denylist` holds explicitly revoked / rotated-out jtis
 *
 * On refresh we verify the presented jti is still the active one, then ROTATE:
 * a new jti is issued and the old one is moved to the denylist. On logout the
 * active jti is revoked. Refresh expiry is shortened to 1d.
 *
 * G6a (ops hardening): when a shared Redis client is configured (REDIS_URL),
 * this state is stored in Redis instead — active jti per user
 * (`auth:jti:active:<userId>`) and a denylist (`auth:jti:denied:<jti>` with a
 * TTL matching refresh expiry) — so revocation/rotation works across replicas.
 * When Redis is null/unavailable, we transparently fall back to the in-process
 * Maps below (single-node behavior, lost on restart → restart forces re-login).
 */
const REFRESH_EXPIRY = '1d';
// Seconds form, used as the Redis denylist TTL so revoked jtis expire naturally.
const REFRESH_EXPIRY_SECONDS = 24 * 60 * 60;

@Injectable()
export class AuthService {
  // Map<userId, activeJti> — the one refresh jti currently accepted per user.
  private readonly validJtis = new Map<string, string>();
  // Set of revoked/rotated-out jtis (denylist).
  private readonly denylist = new Set<string>();

  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Optional() @Inject(SHARED_REDIS_TOKEN) private readonly redis?: SharedRedis,
  ) {}

  // ── G6a: jti store helpers (Redis when available, else in-memory Maps) ──
  // Every helper is best-effort: any Redis failure logs a warning and the
  // method falls through to the in-memory path so auth never hard-fails.

  private redisActiveKey(userId: string): string {
    return `auth:jti:active:${userId}`;
  }
  private redisDeniedKey(jti: string): string {
    return `auth:jti:denied:${jti}`;
  }

  /** Record `jti` as the single active refresh jti for `userId`. */
  private async setActiveJti(userId: string, jti: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(this.redisActiveKey(userId), jti, 'EX', REFRESH_EXPIRY_SECONDS);
        return;
      } catch (err) {
        this.logger.warn(`Redis setActiveJti failed, using in-memory: ${(err as Error).message}`);
      }
    }
    this.validJtis.set(userId, jti);
  }

  private async getActiveJti(userId: string): Promise<string | undefined> {
    if (this.redis) {
      try {
        return (await this.redis.get(this.redisActiveKey(userId))) ?? undefined;
      } catch (err) {
        this.logger.warn(`Redis getActiveJti failed, using in-memory: ${(err as Error).message}`);
      }
    }
    return this.validJtis.get(userId);
  }

  private async clearActiveJti(userId: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(this.redisActiveKey(userId));
        return;
      } catch (err) {
        this.logger.warn(`Redis clearActiveJti failed, using in-memory: ${(err as Error).message}`);
      }
    }
    this.validJtis.delete(userId);
  }

  private async denyJti(jti: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(this.redisDeniedKey(jti), '1', 'EX', REFRESH_EXPIRY_SECONDS);
        return;
      } catch (err) {
        this.logger.warn(`Redis denyJti failed, using in-memory: ${(err as Error).message}`);
      }
    }
    this.denylist.add(jti);
  }

  private async isDenied(jti: string): Promise<boolean> {
    if (this.redis) {
      try {
        return (await this.redis.exists(this.redisDeniedKey(jti))) === 1;
      } catch (err) {
        this.logger.warn(`Redis isDenied failed, using in-memory: ${(err as Error).message}`);
      }
    }
    return this.denylist.has(jti);
  }

  /**
   * Login with email + password.
   * Password is verified against bcrypt hash stored in User.passwordHash (JSONB metadata).
   * For seed users, password is "metis1234" hashed with bcrypt.
   */
  async login(email: string, password: string, tenantId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          // Only the tenant fields login uses (id/slug/name). Narrow select keeps
          // login resilient to Tenant schema drift (new columns before db push/generate).
          include: { tenant: { select: { id: true, slug: true, name: true } } },
          take: 1,
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Password verification via bcrypt
    // passwordHash is stored in the user record's name field metadata for Phase 0
    // In production: dedicated passwordHash column or Auth.js provider
    const storedHash = await this.getPasswordHash(user.id);
    if (!storedHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, storedHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const membership = user.memberships[0];
    if (!membership) {
      throw new UnauthorizedException('No tenant membership found');
    }

    // Multi-tenancy security: validate user belongs to requested tenant
    if (tenantId && membership.tenantId !== tenantId) {
      throw new UnauthorizedException('User does not belong to this tenant');
    }

    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      tenantId: membership.tenantId,
      tenantSlug: membership.tenant.slug,
      role: membership.role,
    };

    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = await this.issueRefreshToken(user.id);

    // Audit: login event recorded by @Audit decorator or manually
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
      tenant: {
        id: membership.tenant.id,
        slug: membership.tenant.slug,
        name: membership.tenant.name,
      },
    };
  }

  /**
   * Refresh access token using a valid refresh token.
   * JWT algorithm restricted to HS256 to prevent alg:none attacks.
   * M-1: verifies the jti is the active one, then rotates it (old jti denylisted).
   */
  async refresh(refreshToken: string) {
    try {
      const payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('AUTH_SECRET'),
        algorithms: ['HS256'],
      });

      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token type');
      }

      // M-1: jti must be present, not denylisted, and the active one for this user.
      // G6a: validation goes through the Redis-or-in-memory jti store.
      const jti: string | undefined = payload.jti;
      const activeJti = jti ? await this.getActiveJti(payload.sub) : undefined;
      if (!jti || (await this.isDenied(jti)) || activeJti !== jti) {
        throw new UnauthorizedException('Refresh token revoked or rotated');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: {
          memberships: { include: { tenant: true }, take: 1 },
        },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('User not found or inactive');
      }

      const membership = user.memberships[0];
      if (!membership) {
        throw new UnauthorizedException('No tenant membership');
      }

      const newPayload = {
        sub: user.id,
        email: user.email,
        name: user.name,
        tenantId: membership.tenantId,
        tenantSlug: membership.tenant.slug,
        role: membership.role,
      };

      // ROTATE: deny the old jti, issue a fresh refresh token with a new jti.
      await this.denyJti(jti);

      return {
        accessToken: await this.jwt.signAsync(newPayload),
        refreshToken: await this.issueRefreshToken(user.id),
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /**
   * Issues a refresh token with a unique jti and registers it as the active
   * jti for the user (replacing any prior active session token).
   */
  private async issueRefreshToken(userId: string): Promise<string> {
    const jti = randomUUID();
    await this.setActiveJti(userId, jti);
    return this.jwt.signAsync({ sub: userId, type: 'refresh', jti }, { expiresIn: REFRESH_EXPIRY });
  }

  /**
   * M-1: revoke a user's active refresh token (used on logout). Best-effort:
   * also denylists the active jti so an in-flight copy cannot be reused.
   */
  async revokeRefreshForUser(userId: string | undefined): Promise<void> {
    if (!userId) return;
    const active = await this.getActiveJti(userId);
    if (active) await this.denyJti(active);
    await this.clearActiveJti(userId);
  }

  /**
   * M-1: revoke based on a presented refresh token (used on logout when the
   * access token may already be expired). Decodes without verifying signature
   * expiry — we only need sub/jti to denylist; an invalid token is a no-op.
   */
  async revokeRefreshFromToken(refreshToken: string): Promise<void> {
    try {
      const decoded: any = this.jwt.decode(refreshToken);
      if (decoded?.jti) await this.denyJti(decoded.jti);
      if (decoded?.sub) await this.clearActiveJti(decoded.sub);
    } catch {
      // ignore malformed token on logout
    }
  }

  /**
   * Cookie configuration for secure JWT delivery.
   * H-7: short-lived httpOnly access cookie (`metis_access`) and a longer-lived
   * refresh cookie (`metis_refresh`) scoped to the auth routes (set in controller).
   * Prevents XSS token theft by keeping tokens out of JS-readable storage.
   */
  /**
   * Resolve the `secure` cookie flag. Defaults to NODE_ENV==='production',
   * but can be forced via COOKIE_SECURE=true|false. Set COOKIE_SECURE=false
   * for HTTP-only internal deployments where secure cookies would block login.
   */
  private resolveCookieSecure(): boolean {
    const override = this.config.get<string>('COOKIE_SECURE');
    if (override === 'true') return true;
    if (override === 'false') return false;
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  getAccessCookieConfig() {
    return {
      httpOnly: true,
      secure: this.resolveCookieSecure(),
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 15 * 60 * 1000, // 15 minutes (short-lived)
    };
  }

  getRefreshCookieConfig() {
    return {
      httpOnly: true,
      secure: this.resolveCookieSecure(),
      sameSite: 'strict' as const,
      path: '/api/auth',
      maxAge: 24 * 60 * 60 * 1000, // 1 day, matches REFRESH_EXPIRY
    };
  }

  /**
   * Phase 0: password hash stored in a separate lookup table (UserCredential concept).
   * We use a simple KV approach via AuditLog metadata for now,
   * but in practice this would be a dedicated column or Auth.js.
   *
   * For simplicity, we store hashes in a Map seeded at startup.
   * Production: migrate to Auth.js Credentials or dedicated passwordHash field.
   *
   * Security note: Credential lookup by userId is unique per user, not per tenant,
   * so multi-tenant isolation is inherently maintained for password verification.
   */
  private async getPasswordHash(userId: string): Promise<string | null> {
    // Look up from the credential store (seeded via prisma seed)
    const credential = await this.prisma.knowledgeArtifact.findFirst({
      where: {
        key: `user-credential-${userId}`,
        category: 'AUTH',
      },
      // Only select contentJson — keeps login resilient to KnowledgeArtifact
      // schema drift (many columns added) before a db push/generate has synced.
      select: { contentJson: true },
    });

    if (credential && credential.contentJson) {
      const content = credential.contentJson as any;
      return content.passwordHash ?? null;
    }

    return null;
  }
}
