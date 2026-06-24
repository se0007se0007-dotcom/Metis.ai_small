import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentKernelRedisProvider } from './redis.provider';
import { A2ABusService } from './bus.service';
import { MissionService } from './mission.service';
import { HandoffService } from './handoff.service';
import { AgentDispatcherService } from './dispatcher.service';
import { LocalAgentsService } from './local-agents.service';
import { CapabilityRegistryModule } from '../capability-registry/capability-registry.module';
// P3-4: ConnectorModule gives the MCP kernel a real, governed MCP client
// (rate-limit → circuit-breaker → MCP stdio/SSE → call log).
import { ConnectorModule } from '../connector/connector.module';

// NOTE: the user-facing "Missions" feature (menu + HTTP API) was removed.
// MissionService / HandoffService remain as INTERNAL agent-kernel primitives
// (A2A bus uses missionId; workflow execution + handoffs depend on them).
@Module({
  imports: [ConfigModule, CapabilityRegistryModule, ConnectorModule],
  controllers: [],
  providers: [
    AgentKernelRedisProvider,
    A2ABusService,
    MissionService,
    HandoffService,
    AgentDispatcherService,
    LocalAgentsService,
  ],
  exports: [
    AgentKernelRedisProvider,
    A2ABusService,
    MissionService,
    HandoffService,
    AgentDispatcherService,
  ],
})
export class AgentKernelModule {}
