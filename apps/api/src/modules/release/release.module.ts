/**
 * Release Module — Phase 3: Controlled Release Engineering
 *
 * Consolidates all release engineering features:
 *   - Replay (dataset, golden tasks, replay runs)
 *   - Shadow (config, pairs, comparison)
 *   - Canary (deployment, gates, metrics)
 *   - Promotion / Rollback
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database.module';
import { EvaluatorModule } from '../evaluator/evaluator.module';

// Services
import { ReplayService } from './replay.service';
import { ShadowService } from './shadow.service';
import { CanaryService } from './canary.service';
import { PromotionService } from './promotion.service';

// Controllers
import { ReplayController } from './replay.controller';
import { ShadowController } from './shadow.controller';
import { CanaryController } from './canary.controller';
import { PromotionController } from './promotion.controller';

// Queue Providers
import { ReplayQueueProvider, ShadowQueueProvider, CanaryQueueProvider } from './queue.providers';

@Module({
  imports: [DatabaseModule, ConfigModule, EvaluatorModule],
  controllers: [ReplayController, ShadowController, CanaryController, PromotionController],
  providers: [
    ReplayService,
    ShadowService,
    CanaryService,
    PromotionService,
    ReplayQueueProvider,
    ShadowQueueProvider,
    CanaryQueueProvider,
  ],
  exports: [ReplayService, ShadowService, CanaryService, PromotionService],
})
export class ReleaseModule {}
