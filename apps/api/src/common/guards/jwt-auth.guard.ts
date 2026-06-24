import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check @Public() decorator
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing authentication token');
    }

    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('AUTH_SECRET'),
        algorithms: ['HS256'],
      });
      // Attach user context to request
      request.user = {
        userId: payload.sub,
        email: payload.email,
        tenantId: payload.tenantId,
        role: payload.role,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return true;
  }

  private extractToken(request: any): string | undefined {
    // (a) Standard Authorization: Bearer header takes priority.
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type === 'Bearer' && token) return token;

    // (b) HttpOnly cookie `metis_access` (preferred for web apps + SSE).
    // H-6 fix: tokens are NEVER accepted from the URL query string, because
    // they leak into logs, referrers, and browser history. SSE/EventSource
    // clients send the httpOnly cookie automatically, so no query token is needed.
    const cookieToken = this.readAccessCookie(request);
    if (cookieToken) return cookieToken;

    return undefined;
  }

  /**
   * Reads the `metis_access` httpOnly cookie. Uses cookie-parser's
   * request.cookies when available, otherwise parses the raw Cookie header
   * manually (no extra dependency required).
   */
  private readAccessCookie(request: any): string | undefined {
    if (request.cookies?.metis_access) {
      return request.cookies.metis_access;
    }
    const header: string | undefined = request.headers?.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name === 'metis_access') {
        return decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
    return undefined;
  }
}
