/**
 * Events Module — Real-time event streaming for all tenants.
 *
 * Exports:
 *   - EventsGatewayService: Core event gateway (publish, stream, getRecent)
 *   - RedisBridgeService: Bridges A2ABusService and Redis into EventsGateway
 *
 * To use in other modules:
 *   import { EventsModule } from '../events/events.module';
 *
 *   @Module({
 *     imports: [EventsModule],
 *   })
 *   export class MyModule {
 *     constructor(private events: EventsGatewayService) {}
 *
 *     publishEvent(tenantId: string, event: EventMessage) {
 *       this.events.publish(tenantId, event);
 *     }
 *   }
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventsGatewayService } from './events.gateway.service';
import { RedisBridgeService } from './redis-bridge.service';
import { EventsController } from './events.controller';
import { AgentKernelModule } from '../agent-kernel/agent-kernel.module';

@Module({
  imports: [ConfigModule, AgentKernelModule],
  controllers: [EventsController],
  providers: [EventsGatewayService, RedisBridgeService],
  exports: [EventsGatewayService, RedisBridgeService],
})
export class EventsModule {}
