/**
 * BullMQ Queue Provider
 * Provides pack-import queue instance for NestJS DI.
 * Uses ConfigService for environment variables (no direct process.env).
 */
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

export const QUEUE_TOKEN = 'PACK_IMPORT_QUEUE';

export const PackImportQueueProvider = {
  provide: QUEUE_TOKEN,
  useFactory: (configService: ConfigService) => {
    const redisUrl = configService.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    return new Queue('pack-import', { connection });
  },
  inject: [ConfigService],
};
