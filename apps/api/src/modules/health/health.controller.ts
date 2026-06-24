import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@metis/database';
import { Public } from '../../common/decorators';
import { PRISMA_TOKEN } from '../database.module';
import IORedis from 'ioredis';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private redis: IORedis | null = null;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly config: ConfigService,
  ) {
    try {
      const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
      this.redis = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
      });
    } catch {
      // Redis unavailable — health check will report degraded
    }
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check (DB + Redis)' })
  async check() {
    const checks: Record<string, string> = {};

    // Database
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    // Redis
    try {
      if (this.redis) {
        await this.redis.connect().catch(() => {});
        const pong = await this.redis.ping();
        checks.redis = pong === 'PONG' ? 'ok' : 'error';
      } else {
        checks.redis = 'not_configured';
      }
    } catch {
      checks.redis = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    const anyError = Object.values(checks).some((v) => v === 'error');

    return {
      status: anyError ? 'degraded' : allOk ? 'healthy' : 'partial',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      services: checks,
    };
  }
}
