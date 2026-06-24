/**
 * SharedRedisProvider — a single ioredis client shared by security-state
 * consumers (auth jti store, throttle limiter, llm-judge budget).
 *
 * GRACEFUL DEGRADATION (operational hardening G6a):
 *   The platform must still run on a single node with NO Redis configured
 *   (dev). Therefore this provider returns `Redis | null`:
 *     - REDIS_URL set        → an ioredis client (lazy-connecting, fault-tolerant)
 *     - REDIS_URL unset/empty → null, and every consumer falls back to its
 *       existing in-memory behavior.
 *
 *   We deliberately do NOT default to redis://localhost:6379 here (unlike the
 *   Agent Kernel bus, which requires Redis). Security-state must never crash or
 *   block requests because Redis is down — connection errors are swallowed and
 *   logged, and consumers treat any failed op as "fall back to in-memory".
 */
import { Global, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

export const SHARED_REDIS_TOKEN = 'SHARED_REDIS';

/** Injected type for consumers: a live client or null when unconfigured. */
export type SharedRedis = IORedis | null;

export const SharedRedisProvider = {
  provide: SHARED_REDIS_TOKEN,
  useFactory: (configService: ConfigService): SharedRedis => {
    const logger = new Logger('SharedRedis');
    // Only the explicit REDIS_URL enables Redis-backed security state. No
    // implicit localhost default → dev with no Redis stays fully in-memory.
    const redisUrl = configService.get<string>('REDIS_URL', '').trim();
    if (!redisUrl) {
      logger.warn(
        'REDIS_URL not set — security state (auth jti, throttle, llm budget) ' +
          'uses in-memory fallback (single-node only). Set REDIS_URL for multi-node.',
      );
      return null;
    }

    try {
      const client = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      // Never let a Redis connection error take down the process; consumers
      // already guard each op and fall back to in-memory on failure.
      client.on('error', (err) => {
        logger.warn(`Shared Redis error (falling back to in-memory): ${err.message}`);
      });
      client.on('connect', () => logger.log('Shared Redis connected (security state)'));
      return client;
    } catch (err) {
      logger.warn(`Shared Redis init failed, using in-memory fallback: ${(err as Error).message}`);
      return null;
    }
  },
  inject: [ConfigService],
};

@Global()
@Module({
  providers: [SharedRedisProvider],
  exports: [SHARED_REDIS_TOKEN],
})
export class SharedRedisModule {}
