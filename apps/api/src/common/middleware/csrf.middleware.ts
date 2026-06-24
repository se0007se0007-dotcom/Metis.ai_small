/**
 * CSRF Protection Middleware
 *
 * Uses Double Submit Cookie pattern:
 * - Server sets a random CSRF token in a non-HttpOnly cookie
 * - Client reads it and sends it back in X-CSRF-Token header
 * - Server validates they match
 *
 * Safe methods (GET, HEAD, OPTIONS) are exempt.
 * Requests with valid Bearer JWT token are also exempt (API-first clients).
 */
import { Injectable, NestMiddleware, ForbiddenException, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

const CSRF_COOKIE = 'metis_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Paths exempt from CSRF validation (internal API-to-API, health checks, auth)
const EXEMPT_PREFIXES = ['/v1/health', '/v1/auth/login', '/v1/auth/refresh', '/docs'];

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    // Ensure CSRF cookie exists for browser clients
    if (!req.cookies?.[CSRF_COOKIE]) {
      const token = crypto.randomBytes(32).toString('hex');
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false, // Client needs to read this
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000, // 24h
      });
    }

    // Skip validation for safe methods
    if (SAFE_METHODS.has(req.method)) {
      return next();
    }

    // Skip validation for exempt paths
    if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
      return next();
    }

    // Skip CSRF for requests with a valid Bearer token (API clients).
    // These are stateless API calls authenticated via JWT, not browser form submissions.
    // The CSRF attack vector (cookie auto-attachment by browser) doesn't apply when
    // the auth credential is an explicit Authorization header.
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return next();
    }

    // Validate CSRF token for state-changing requests from browser sessions
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER] as string;

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      this.logger.warn(`CSRF validation failed for ${req.method} ${req.path} from ${req.ip}`);
      throw new ForbiddenException('CSRF token validation failed');
    }

    next();
  }
}
