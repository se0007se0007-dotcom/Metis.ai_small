/**
 * BullMQ Queue Providers for Release Engineering
 */
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { REPLAY_QUEUE_TOKEN } from './replay.service';
import { SHADOW_QUEUE_TOKEN } from './shadow.service';
import { CANARY_QUEUE_TOKEN } from './canary.service';

export const ReplayQueueProvider = {
  provide: REPLAY_QUEUE_TOKEN,
  useFactory: (config: ConfigService) => {
    const redisUrl = config.get('REDIS_URL', 'redis://localhost:6379');
    return new Queue('replay', { connection: { url: redisUrl } as any });
  },
  inject: [ConfigService],
};

export const ShadowQueueProvider = {
  provide: SHADOW_QUEUE_TOKEN,
  useFactory: (config: ConfigService) => {
    const redisUrl = config.get('REDIS_URL', 'redis://localhost:6379');
    return new Queue('shadow', { connection: { url: redisUrl } as any });
  },
  inject: [ConfigService],
};

export const CanaryQueueProvider = {
  provide: CANARY_QUEUE_TOKEN,
  useFactory: (config: ConfigService) => {
    const redisUrl = config.get('REDIS_URL', 'redis://localhost:6379');
    return new Queue('canary', { connection: { url: redisUrl } as any });
  },
  inject: [ConfigService],
};
