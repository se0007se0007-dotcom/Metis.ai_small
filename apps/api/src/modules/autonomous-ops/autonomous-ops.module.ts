import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AutonomousOpsService } from './autonomous-ops.service';
import { AutonomousOpsController } from './autonomous-ops.controller';
import { AgentKernelModule } from '../agent-kernel/agent-kernel.module';
import { EventsModule } from '../events/events.module';
import { AutoActionsQueueProvider } from './queue.provider';

@Module({
  imports: [ConfigModule, AgentKernelModule, EventsModule],
  controllers: [AutonomousOpsController],
  providers: [AutonomousOpsService, AutoActionsQueueProvider],
  exports: [AutonomousOpsService],
})
export class AutonomousOpsModule {}
