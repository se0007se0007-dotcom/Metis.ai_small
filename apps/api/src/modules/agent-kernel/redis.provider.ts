/**
 * Shared Redis connection for Agent Kernel (Streams + Pub/Sub).
 *
 * Resolves R1 (Redis-first from day one) by providing a stable connection
 * that the MessageBus, Orchestrator, and Handoff services all share.
 */
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

export const AGENT_KERNEL_REDIS_TOKEN = 'AGENT_KERNEL_REDIS';

export const AgentKernelRedisProvider = {
  provide: AGENT_KERNEL_REDIS_TOKEN,
  useFactory: (configService: ConfigService) => {
    const redisUrl = configService.get<string>('REDIS_URL', 'redis://localhost:6379');
    // Streams require maxRetriesPerRequest: null for blocking reads.
    return new IORedis(redisUrl, { maxRetriesPerRequest: null });
  },
  inject: [ConfigService],
};
