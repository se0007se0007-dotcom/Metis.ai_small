import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { SHARED_REDIS_TOKEN, SharedRedis } from '../redis/shared-redis.module';

/**
 * Rate limiter for the platform.
 *
 * Default: 60 requests per minute per IP.
 *
 * G6a (ops hardening): when a shared Redis client is configured (REDIS_URL),
 * counters live in Redis (`throttle:<ip>:<window>` via INCR + EXPIRE) so the
 * limit is enforced consistently across replicas. When Redis is null or a
 * Redis op fails, we transparently fall back to the in-process Map below
 * (single-node behavior). Limit/window and req.ip keying are identical in both
 * paths — we deliberately do NOT read the spoofable x-forwarded-for header.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly logger = new Logger(ThrottleGuard.name);
  private readonly store = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(
    @Optional()
    @Inject(SHARED_REDIS_TOKEN)
    private readonly redis?: SharedRedis,
  ) {
    this.limit = parseInt(process.env.RATE_LIMIT ?? '60', 10);
    this.windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    // M-2: key strictly on the resolved client IP (req.ip). With `trust proxy`
    // set in main.ts, Express derives req.ip from X-Forwarded-For safely. We do
    // NOT read the raw x-forwarded-for header ourselves, since it is spoofable
    // and would let an attacker bypass/poison the limiter.
    const key = request.ip || 'unknown';
    const now = Date.now();
    const response = context.switchToHttp().getResponse();

    // ── Redis-backed path (multi-node correctness) ──
    if (this.redis) {
      try {
        const windowMs = this.windowMs;
        const windowId = Math.floor(now / windowMs);
        const redisKey = `throttle:${key}:${windowId}`;
        const count = await this.redis.incr(redisKey);
        if (count === 1) {
          // First hit in this window — set the window TTL.
          await this.redis.pexpire(redisKey, windowMs);
        }
        const resetAt = (windowId + 1) * windowMs;

        if (count > this.limit) {
          const retryAfter = Math.ceil((resetAt - now) / 1000);
          response.setHeader('Retry-After', retryAfter.toString());
          response.setHeader('X-RateLimit-Limit', this.limit.toString());
          response.setHeader('X-RateLimit-Remaining', '0');
          throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
        }

        response.setHeader('X-RateLimit-Limit', this.limit.toString());
        response.setHeader('X-RateLimit-Remaining', Math.max(0, this.limit - count).toString());
        return true;
      } catch (err) {
        // 429s must propagate; any other (Redis) error falls back to in-memory.
        if (err instanceof HttpException) throw err;
        this.logger.warn(`Redis throttle failed, using in-memory: ${(err as Error).message}`);
      }
    }

    // ── In-memory fallback (single-node / Redis unavailable) ──
    let entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.store.set(key, entry);
    }

    entry.count++;

    if (entry.count > this.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      response.setHeader('Retry-After', retryAfter.toString());
      response.setHeader('X-RateLimit-Limit', this.limit.toString());
      response.setHeader('X-RateLimit-Remaining', '0');
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Set rate limit headers
    response.setHeader('X-RateLimit-Limit', this.limit.toString());
    response.setHeader('X-RateLimit-Remaining', (this.limit - entry.count).toString());

    return true;
  }
}
