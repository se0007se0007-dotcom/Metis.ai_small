/**
 * Fraud Detection System — NestJS Module
 *
 * Registers all FDS services and the main controller.
 * Exports services for use by other modules.
 *
 * Adapter Configuration:
 * - Default: HeuristicMLAdapter (pattern-based, no dependencies)
 * - To swap: Change the useClass value in the 'FDS_ML_ADAPTER' provider
 *   e.g., { provide: 'FDS_ML_ADAPTER', useClass: OpenAIMLAdapter }
 */

import { Module } from '@nestjs/common';
import { RuleEngineService } from './rule-engine.service';
import { AnomalyService } from './anomaly.service';
import { AlertService } from './alert.service';
import { RiskService } from './risk.service';
import { FdsController } from './fds.controller';
import { HeuristicMLAdapter } from './adapters/heuristic-adapter';
import { FdsAdapterBootstrapService } from './fds-adapter-bootstrap.service';
import { CapabilityRegistryModule } from '../capability-registry/capability-registry.module';
import { DatabaseModule } from '../database.module';

@Module({
  imports: [CapabilityRegistryModule, DatabaseModule],
  controllers: [FdsController],
  providers: [
    RuleEngineService,
    AnomalyService,
    AlertService,
    RiskService,
    {
      provide: 'FDS_ML_ADAPTER',
      useClass: HeuristicMLAdapter,
    },
    FdsAdapterBootstrapService,
  ],
  exports: [RuleEngineService, AnomalyService, AlertService, RiskService],
})
export class FdsModule {}
