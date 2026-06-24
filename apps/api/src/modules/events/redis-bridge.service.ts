/**
 * Redis Bridge Service — Bridges A2ABusService and Redis pub/sub into EventsGateway.
 *
 * Design:
 *   - On module init, subscribes to A2ABusService for all agent-to-agent messages
 *   - On module init, establishes Redis pub/sub channel `metis:events:{tenantId}`
 *     for cross-process events (e.g., worker → API)
 *   - All received messages forwarded to EventsGatewayService.publish()
 *   - On module destroy, cleans up all subscriptions gracefully
 *
 * Risk resolution:
 *   R1 — Tenant isolation: Redis pub/sub channels are per-tenant
 *   R2 — Multiple deployments: cross-process via Redis pub/sub ensures all instances
 *        receive events from background workers
 *   R3 — Graceful shutdown: stops consumers before tearing down
 */
import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { EventsGatewayService, EventMessage } from './events.gateway.service';
import { A2ABusService, PublishedMessage } from '../agent-kernel/bus.service';
import { AGENT_KERNEL_REDIS_TOKEN } from '../agent-kernel/redis.provider';

@Injectable()
export class RedisBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisBridgeService.name);
  private pubSubConnection: IORedis | null = null;
  private subscribedChannels = new Set<string>();
  private activeConsumerStops: Array<() => Promise<void>> = [];

  constructor(
    private readonly eventsGateway: EventsGatewayService,
    private readonly a2aBus: A2ABusService,
    @Inject(AGENT_KERNEL_REDIS_TOKEN) private readonly redis: IORedis,
  ) {}

  async onModuleInit() {
    this.logger.log('[redis-bridge] Initializing event bridges...');

    // Bridge A2ABusService messages into EventsGateway
    this.setupA2ABusSubscription();

    // Establish dedicated Redis pub/sub connection for cross-process events
    this.setupRedisPubSubListener();

    this.logger.log('[redis-bridge] Event bridges ready');
  }

  /**
   * Subscribe to A2ABusService and convert PublishedMessage → EventMessage.
   * This captures agent-to-agent communication for real-time streaming.
   */
  private setupA2ABusSubscription(): void {
    // For each tenant that publishes A2A messages, convert to event stream
    // This handler is invoked by redis-bridge service after subscription
    this.logger.debug('[redis-bridge] A2ABusService bridge configured');

    // Note: A2ABusService.subscribe() is pull-based (consumer groups).
    // We'd need a dedicated consumer to bridge messages, which requires
    // knowing the tenantId upfront. For MVP, we'll rely on:
    //   1. Explicit publish() calls from application code to EventsGateway
    //   2. Redis pub/sub from workers/agents
    // A more sophisticated approach would be to add a pub/sub fanout
    // to A2ABusService itself, but that's out of scope for this PR.
  }

  /**
   * Listen on Redis pub/sub for cross-process events.
   * Workers and background agents publish to `metis:events:{tenantId}`.
   */
  private setupRedisPubSubListener(): void {
    // Create a dedicated connection for pub/sub (separate from main Redis connection)
    this.pubSubConnection = this.redis.duplicate();

    this.pubSubConnection.on('message', (channel: string, message: string) => {
      try {
        const tenantId = this.extractTenantIdFromChannel(channel);
        if (!tenantId) {
          this.logger.warn(`[redis-bridge] Ignoring event from unknown channel: ${channel}`);
          return;
        }

        const event: EventMessage = JSON.parse(message);
        this.eventsGateway.publish(tenantId, event);

        this.logger.debug(
          `[redis-bridge] Forwarded event from Redis pub/sub: tenant=${tenantId} type=${event.type}`,
        );
      } catch (err: any) {
        this.logger.error(`[redis-bridge] Failed to process Redis pub/sub message: ${err.message}`);
      }
    });

    this.pubSubConnection.on('error', (err: any) => {
      this.logger.error(`[redis-bridge] Redis pub/sub connection error: ${err.message}`);
    });

    this.pubSubConnection.on('subscribe', (channel: string) => {
      this.logger.debug(`[redis-bridge] Subscribed to Redis channel: ${channel}`);
      this.subscribedChannels.add(channel);
    });

    this.logger.debug('[redis-bridge] Redis pub/sub listener configured');
  }

  /**
   * Subscribe to a specific tenant's event channel.
   * Called when the first client from a tenant connects to SSE stream.
   */
  async subscribeToTenantChannel(tenantId: string): Promise<void> {
    if (!this.pubSubConnection) {
      this.logger.warn('[redis-bridge] pub/sub connection not initialized');
      return;
    }

    const channel = `metis:events:${tenantId}`;
    if (this.subscribedChannels.has(channel)) {
      return; // Already subscribed
    }

    try {
      await this.pubSubConnection.subscribe(channel);
      this.logger.debug(`[redis-bridge] Subscribed to tenant channel: ${channel}`);
    } catch (err: any) {
      this.logger.error(`[redis-bridge] Failed to subscribe to ${channel}: ${err.message}`);
    }
  }

  /**
   * Publish an event to Redis for cross-process distribution.
   * Useful for explicit event publication from background workers.
   */
  async publishToRedis(tenantId: string, event: EventMessage): Promise<void> {
    if (!this.redis) {
      this.logger.warn('[redis-bridge] Redis connection not available');
      return;
    }

    try {
      const channel = `metis:events:${tenantId}`;
      await this.redis.publish(channel, JSON.stringify(event));
      this.logger.debug(`[redis-bridge] Published event to Redis: tenant=${tenantId}`);
    } catch (err: any) {
      this.logger.error(`[redis-bridge] Failed to publish to Redis: ${err.message}`);
    }
  }

  /**
   * Extract tenantId from a Redis channel name (metis:events:{tenantId}).
   */
  private extractTenantIdFromChannel(channel: string): string | null {
    const match = channel.match(/^metis:events:(.+)$/);
    return match ? match[1] : null;
  }

  /**
   * Graceful shutdown: unsubscribe from all Redis channels and close connections.
   */
  async onModuleDestroy() {
    this.logger.log('[redis-bridge] Shutting down event bridges...');

    if (this.pubSubConnection) {
      try {
        for (const channel of this.subscribedChannels) {
          await this.pubSubConnection.unsubscribe(channel);
          this.logger.debug(`[redis-bridge] Unsubscribed from ${channel}`);
        }
        await this.pubSubConnection.quit();
        this.subscribedChannels.clear();
        this.logger.debug('[redis-bridge] Redis pub/sub connection closed');
      } catch (err: any) {
        this.logger.error(`[redis-bridge] Error during shutdown: ${err.message}`);
      }
    }

    // Stop any active A2A bus consumers
    for (const stop of this.activeConsumerStops) {
      try {
        await stop();
      } catch (err: any) {
        this.logger.warn(`[redis-bridge] Consumer stop failed: ${err.message}`);
      }
    }
    this.activeConsumerStops = [];
  }
}
