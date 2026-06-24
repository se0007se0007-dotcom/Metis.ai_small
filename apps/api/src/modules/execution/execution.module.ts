import { Module } from '@nestjs/common';
import { ExecutionController } from './execution.controller';
import { ExecutionService } from './execution.service';
import { ExecutionQueueProvider } from './queue.provider';
import { GovernanceModule } from '../governance/governance.module';
import { WorkflowNodeRouter } from './node-router.service';
import { WorkflowRunnerService } from './workflow-runner.service';
import { WorkflowRunnerController } from './workflow-runner.controller';
import { SchemaValidatorService } from './schema-validator.service';
import { ConnectorModule } from '../connector/connector.module';
import { AgentKernelModule } from '../agent-kernel/agent-kernel.module';
import { CapabilityRegistryModule } from '../capability-registry/capability-registry.module';

@Module({
  imports: [GovernanceModule, ConnectorModule, AgentKernelModule, CapabilityRegistryModule],
  controllers: [ExecutionController, WorkflowRunnerController],
  providers: [
    ExecutionService,
    ExecutionQueueProvider,
    WorkflowNodeRouter,
    WorkflowRunnerService,
    SchemaValidatorService,
  ],
  exports: [ExecutionService, WorkflowRunnerService, WorkflowNodeRouter, SchemaValidatorService],
})
export class ExecutionModule {}
