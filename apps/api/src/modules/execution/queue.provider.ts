/**
 * BullMQ Execution Queue Provider
 */
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

export const EXECUTION_QUEUE_TOKEN = 'EXECUTION_QUEUE';

export const ExecutionQueueProvider = {
  provide: EXECUTION_QUEUE_TOKEN,
  useFactory: (configService: ConfigService) => {
    const redisUrl = configService.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    return new Queue('execution', { connection });
  },
  inject: [ConfigService],
};
