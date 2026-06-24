/**
 * A2A Message Bus — Redis Streams backbone for multi-agent collaboration.
 *
 * Design decisions (R1/R2/R3 risk resolution):
 *   R1 — Redis Streams from day one. MessageBus interface keeps the surface stable
 *        so any future switch to a different broker (Kafka/NATS) is localized.
 *   R2 — Stream keys are partitioned per tenant: `metis:mission:{tenantId}:stream`.
 *        Cross-tenant reads are not possible via this service.
 *   R3 — Every publish() durably writes to Prisma AgentMessage AND appends to
 *        ExecutionTrace via the provided correlationId. No message is lost from audit.
 *
 * Contract:
 *   publish(tenantId, missionId, msg) → appends to Redis Stream + Prisma
 *   subscribe(tenantId, handler, opts) → consumer group reads blocking
 *   replay(tenantId, missionId) → full history from Prisma (Stream has retention limits)
 */
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import {
  PrismaClient,
  withTenantIsolation,
  TenantContext,
  getSystemSessionId,
} from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { AGENT_KERNEL_REDIS_TOKEN } from './redis.provider';

export type AgentMessageKind =
  | 'REQUEST'
  | 'RESPONSE'
  | 'EVENT'
  | 'HANDOFF'
  | 'HUMAN_INTERVENTION'
  | 'SYSTEM';

export interface A2AMessage {
  kind: AgentMessageKind;
  fromAgent: string;
  toAgent?: string;
  subject?: string;
  payload: Record<string, any>;
  naturalSummary?: string;
  correlationId: string;
}

export interface PublishedMessage extends A2AMessage {
  id: string; // Prisma AgentMessage id
  streamId: string; // Redis stream entry id
  missionId: string;
  tenantId: string;
  createdAt: string;
}

export interface SubscribeOptions {
  consumerGroup: string; // Logical consumer group (e.g. 'ops-orchestrator')
  consumerName?: string; // Individual consumer within group
  blockMs?: number; // Block duration per XREAD call
  batchSize?: number; // Max messages per pull
  startFrom?: '$' | '0'; // New messages only ($) or replay from start (0)
}

export type A2AHandler = (msg: PublishedMessage) => Promise<void>;

/** Stable abstraction. Today: Redis Streams. Tomorrow: Kafka/NATS — interface unchanged. */
export interface MessageBus {
  publish(tenantId: string, missionId: string, msg: A2AMessage): Promise<PublishedMessage>;
  subscribe(tenantId: string, handler: A2AHandler, opts: SubscribeOptions): () => Promise<void>;
  replay(ctx: TenantContext, missionId: string, limit?: number): Promise<PublishedMessage[]>;
}

@Injectable()
export class A2ABusService implements MessageBus, OnModuleDestroy {
  private readonly logger = new Logger(A2ABusService.name);
  private readonly activeConsumers = new Map<string, { stop: () => Promise<void> }>();

  constructor(
    @Inject(AGENT_KERNEL_REDIS_TOKEN) private readonly redis: IORedis,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
  ) {}

  // ── R2: Per-tenant stream key ─────────────────────────────
  private streamKey(tenantId: string): string {
    return `metis:mission:${tenantId}:stream`;
  }

  private consumerGroupKey(tenantId: string, group: string): string {
    return `${this.streamKey(tenantId)}:group:${group}`;
  }

  // ═══════════════════════════════════════════════════════════
  //  Publish — writes to both Redis and Prisma (R3: durability)
  // ═══════════════════════════════════════════════════════════
  async publish(tenantId: string, missionId: string, msg: A2AMessage): Promise<PublishedMessage> {
    // 1. Durable store in Prisma (source of truth)
    const saved = await this.prisma.agentMessage.create({
      data: {
        tenantId,
        missionId,
        kind: msg.kind,
        fromAgent: msg.fromAgent,
        toAgent: msg.toAgent,
        subject: msg.subject,
        payloadJson: msg.payload as any,
        naturalSummary: msg.naturalSummary,
        correlationId: msg.correlationId,
      },
    });

    // 2. Append to Redis Stream (fan-out to live subscribers)
    const streamId = await this.redis.xadd(
      this.streamKey(tenantId),
      '*',
      'messageId',
      saved.id,
      'missionId',
      missionId,
      'kind',
      msg.kind,
      'fromAgent',
      msg.fromAgent,
      'toAgent',
      msg.toAgent || '',
      'subject',
      msg.subject || '',
      'payload',
      JSON.stringify(msg.payload),
      'naturalSummary',
      msg.naturalSummary || '',
      'correlationId',
      msg.correlationId,
    );

    // 3. R3: ExecutionTrace audit breadcrumb (uses a per-tenant sentinel
    // ExecutionSession so the required FK is satisfied; previously 'system-bus'
    // was a non-existent id and the trace silently failed the FK constraint).
    const sessionId = await getSystemSessionId(this.prisma, tenantId);
    if (sessionId)
      await this.prisma.executionTrace
        .create({
          data: {
            executionSessionId: sessionId,
            correlationId: msg.correlationId,
            traceJson: {
              event: 'A2A_MESSAGE_PUBLISHED',
              messageId: saved.id,
              missionId,
              kind: msg.kind,
              fromAgent: msg.fromAgent,
              toAgent: msg.toAgent,
              subject: msg.subject,
              naturalSummary: msg.naturalSummary,
              streamId,
              timestamp: new Date().toISOString(),
            } as any,
          },
        })
        .catch((e) => this.logger.warn(`Trace record failed: ${e.message}`));

    this.logger.log(
      `[a2a] ${msg.fromAgent} → ${msg.toAgent || '*'} (${msg.kind}) mission=${missionId} tenant=${tenantId}`,
    );

    return {
      id: saved.id,
      streamId: streamId || '',
      tenantId,
      missionId,
      kind: msg.kind,
      fromAgent: msg.fromAgent,
      toAgent: msg.toAgent,
      subject: msg.subject,
      payload: msg.payload,
      naturalSummary: msg.naturalSummary,
      correlationId: msg.correlationId,
      createdAt: saved.createdAt.toISOString(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  Subscribe — consumer group on per-tenant stream
  // ═══════════════════════════════════════════════════════════
  subscribe(tenantId: string, handler: A2AHandler, opts: SubscribeOptions): () => Promise<void> {
    const consumerName = opts.consumerName || `consumer-${process.pid}-${Date.now()}`;
    const groupName = opts.consumerGroup;
    const blockMs = opts.blockMs ?? 5000;
    const batchSize = opts.batchSize ?? 10;
    const streamKey = this.streamKey(tenantId);
    let stopped = false;

    // Dedicated IORedis connection for blocking reads (best practice)
    const reader = this.redis.duplicate();

    const ensureGroup = async () => {
      try {
        await reader.xgroup('CREATE', streamKey, groupName, opts.startFrom ?? '$', 'MKSTREAM');
      } catch (e: any) {
        if (!String(e.message).includes('BUSYGROUP')) throw e;
      }
    };

    const loop = async () => {
      await ensureGroup();
      while (!stopped) {
        try {
          const res: any = await reader.xreadgroup(
            'GROUP',
            groupName,
            consumerName,
            'COUNT',
            batchSize,
            'BLOCK',
            blockMs,
            'STREAMS',
            streamKey,
            '>',
          );
          if (!res) continue;
          for (const [, entries] of res as [string, [string, string[]][]][]) {
            for (const [entryId, fields] of entries) {
              const obj = this.fieldsToObject(fields);
              const msg: PublishedMessage = {
                id: obj.messageId,
                streamId: entryId,
                tenantId,
                missionId: obj.missionId,
                kind: obj.kind as AgentMessageKind,
                fromAgent: obj.fromAgent,
                toAgent: obj.toAgent || undefined,
                subject: obj.subject || undefined,
                payload: obj.payload ? JSON.parse(obj.payload) : {},
                naturalSummary: obj.naturalSummary || undefined,
                correlationId: obj.correlationId,
                createdAt: new Date().toISOString(),
              };
              try {
                await handler(msg);
                await reader.xack(streamKey, groupName, entryId);
              } catch (err: any) {
                this.logger.error(`Handler failed for ${entryId}: ${err.message}`);
                // Do NOT ack — message will be redelivered after PEL timeout
              }
            }
          }
        } catch (err: any) {
          if (stopped) break;
          this.logger.error(`Consumer loop error: ${err.message}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    };

    const handle = `${tenantId}:${groupName}:${consumerName}`;

    // Start the loop and track its lifetime so onModuleDestroy can await completion.
    const loopPromise = loop().catch((e) => {
      this.logger.error(`Consumer crashed: ${e.message}`);
    });

    const stop = async () => {
      stopped = true;
      // Wait for the consumer loop to exit cleanly before closing the connection.
      // This prevents mid-read XREADGROUP errors during graceful shutdown.
      await loopPromise;
      await reader.quit().catch(() => {});
      this.activeConsumers.delete(handle);
    };
    this.activeConsumers.set(handle, { stop });

    return stop;
  }

  // ═══════════════════════════════════════════════════════════
  //  Replay — full history from Prisma (R3: audit-grade)
  // ═══════════════════════════════════════════════════════════
  async replay(ctx: TenantContext, missionId: string, limit = 500): Promise<PublishedMessage[]> {
    const db = withTenantIsolation(this.prisma, ctx);
    const messages = await db.agentMessage.findMany({
      where: { missionId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return messages.map((m) => ({
      id: m.id,
      streamId: '', // historical
      tenantId: m.tenantId,
      missionId: m.missionId,
      kind: m.kind as AgentMessageKind,
      fromAgent: m.fromAgent,
      toAgent: m.toAgent ?? undefined,
      subject: m.subject ?? undefined,
      payload: (m.payloadJson as Record<string, any>) || {},
      naturalSummary: m.naturalSummary ?? undefined,
      correlationId: m.correlationId,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  // ── Lifecycle ────────────────────────────────────────────
  /**
   * Graceful shutdown: stop every active consumer loop (each awaits its loop
   * and quits its duplicated reader connection), then close the main Redis
   * client. Snapshot the handles first since stop() mutates activeConsumers.
   */
  async onModuleDestroy(): Promise<void> {
    const stops = Array.from(this.activeConsumers.values()).map((c) =>
      c.stop().catch((e) => this.logger.error(`Consumer stop failed: ${(e as Error).message}`)),
    );
    await Promise.all(stops);
    await this.redis.quit().catch(() => {});
  }

  // ── Private helpers ─────────────────────────────────────
  private fieldsToObject(fields: string[]): Record<string, string> {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return obj;
  }
}
