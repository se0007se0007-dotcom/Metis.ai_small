import { Module } from '@nestjs/common';
import { ConnectorController } from './connector.controller';
import { ConnectorService } from './connector.service';
import {
  SecretsManager,
  LifecycleManager,
  RateLimiter,
  CircuitBreaker,
  CallLogger,
  RuntimeDispatcher,
  SchemaDiscovery,
  TestPipeline,
} from './connector-runtime';

@Module({
  controllers: [ConnectorController],
  providers: [
    // Runtime core
    SecretsManager,
    LifecycleManager,
    RateLimiter,
    CircuitBreaker,
    CallLogger,
    RuntimeDispatcher,
    SchemaDiscovery,
    TestPipeline,
    // Service (depends on all runtime providers)
    ConnectorService,
  ],
  exports: [
    ConnectorService,
    SecretsManager,
    LifecycleManager,
    RateLimiter,
    CircuitBreaker,
    CallLogger,
    RuntimeDispatcher,
  ],
})
export class ConnectorModule {}
