import { Module } from '@nestjs/common';
import { FinOpsController } from './finops.controller';
import { FinOpsPredictionController } from './finops-prediction.controller';
import { FinOpsService } from './finops.service';
import { FinOpsPredictionService } from './finops-prediction.service';
import { TokenOptimizerService } from './token-optimizer.service';
import { ModelPriceService } from './model-price.service';
import { FinOpsInsightService } from './finops-insight.service';
import { EmbeddingService } from './embedding.service';
import { GovernanceAwareCacheKeyService } from './governance-aware-cache-key.service';
import { CachePolicyDecisionEngine } from './cache-policy-decision.engine';
import { PolicyAwareModelRouterService } from './policy-aware-model-router.service';
import { GovernanceModule } from '../governance/governance.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [GovernanceModule, EmailModule],
  controllers: [FinOpsController, FinOpsPredictionController],
  providers: [
    FinOpsService,
    FinOpsPredictionService,
    TokenOptimizerService,
    ModelPriceService,
    FinOpsInsightService,
    EmbeddingService,
    GovernanceAwareCacheKeyService,
    CachePolicyDecisionEngine,
    PolicyAwareModelRouterService,
  ],
  exports: [
    FinOpsService,
    FinOpsPredictionService,
    TokenOptimizerService,
    ModelPriceService,
    FinOpsInsightService,
    EmbeddingService,
    GovernanceAwareCacheKeyService,
    CachePolicyDecisionEngine,
    PolicyAwareModelRouterService,
  ],
})
export class FinOpsModule {}
