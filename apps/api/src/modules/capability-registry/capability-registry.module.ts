import { Module } from '@nestjs/common';
import { CapabilityRegistryService } from './capability-registry.service';
import { AgentRegistryService } from './agent-registry.service';
import { AgentSimulatorService } from './agent-simulator.service';
import { CapabilityRegistryController } from './capability-registry.controller';
import { AdapterInvocationService } from './adapter-invocation.service';
import { EvaluatorModule } from '../evaluator/evaluator.module';

@Module({
  imports: [EvaluatorModule],
  controllers: [CapabilityRegistryController],
  providers: [
    CapabilityRegistryService,
    AgentRegistryService,
    AgentSimulatorService,
    AdapterInvocationService,
  ],
  exports: [
    CapabilityRegistryService,
    AgentRegistryService,
    AgentSimulatorService,
    AdapterInvocationService,
  ],
})
export class CapabilityRegistryModule {}
