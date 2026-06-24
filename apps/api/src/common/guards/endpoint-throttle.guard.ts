import { CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

/**
 * Per-endpoint rate limiter — a tighter, route-scoped complement to the global
 * ThrottleGuard. Use it inline on expensive/abuse-prone endpoints, e.g.:
 *
 *   @UseGuards(new EndpointThrottleGuard({ limit: 20, windowMs: 60_000 }))
 *
 * It is instantiated per route (no DI), keeps an in-process sliding window, and
 * keys on tenantId+userId when the request is authenticated (falling back to
 * req.ip). This means one tenant/user cannot exhaust the global IP budget for
 * everyone, and a single user is bounded on the specific endpoint.
 *
 * In-memory only by design (single-node). For multi-replica enforcement on a
 * hot endpoint, promote to the Redis-backed ThrottleGuard pattern.
 */
export interface EndpointThrottleOptions {
  limit: number;
  windowMs: number;
  /** Optional label used in the key namespace (defaults to the route path). */
  bucket?: string;
}

export class EndpointThrottleGuard implements CanActivate {
  private readonly store = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly opts: EndpointThrottleOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const now = Date.now();

    const user = request.user as { tenantId?: string; userId?: string } | undefined;
    const identity = user?.tenantId
      ? `${user.tenantId}:${user.userId ?? 'anon'}`
      : request.ip || 'unknown';
    const bucket = this.opts.bucket ?? request.route?.path ?? request.url ?? 'endpoint';
    const key = `${bucket}|${identity}`;

    let entry = this.store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.opts.windowMs };
      this.store.set(key, entry);
    }
    entry.count++;

    response.setHeader('X-RateLimit-Limit', this.opts.limit.toString());
    if (entry.count > this.opts.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      response.setHeader('Retry-After', retryAfter.toString());
      response.setHeader('X-RateLimit-Remaining', '0');
      throw new HttpException(
        `Rate limit exceeded for this endpoint (${this.opts.limit}/${Math.round(
          this.opts.windowMs / 1000,
        )}s). Retry in ${retryAfter}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    response.setHeader('X-RateLimit-Remaining', (this.opts.limit - entry.count).toString());
    return true;
  }
}
