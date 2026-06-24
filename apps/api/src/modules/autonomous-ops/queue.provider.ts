/**
 * BullMQ Queue provider for dispatching auto-actions to the worker process.
 */
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

export const AUTO_ACTIONS_QUEUE_TOKEN = 'AUTO_ACTIONS_QUEUE';

export const AutoActionsQueueProvider = {
  provide: AUTO_ACTIONS_QUEUE_TOKEN,
  useFactory: (configService: ConfigService) => {
    const redisUrl = configService.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    return new Queue('auto-actions', { connection });
  },
  inject: [ConfigService],
};
