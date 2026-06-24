/**
 * Connector Service — Phase 3~4 (Upgraded)
 *
 * Full runtime integration with:
 *   - RuntimeDispatcher (MCP/REST/Webhook protocol dispatch)
 *   - GovernedDispatcher chain: RateLimit → CircuitBreaker → PolicyGate → Dispatch → CallLog
 *   - SecretsManager for config encryption
 *   - LifecycleManager for MCP server start/stop/restart
 *   - SchemaDiscovery for MCP tools/list
 *   - TestPipeline for connector health verification
 */
import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import type { ActionType } from '@metis/types';
import {
  SecretsManager,
  RuntimeDispatcher,
  LifecycleManager,
  RateLimiter,
  CircuitBreaker,
  CallLogger,
  SchemaDiscovery,
  TestPipeline,
} from './connector-runtime';

// ── Connector Types (matching HTML prototype) ──
export const CONNECTOR_TYPES = ['MCP_SERVER', 'AGENT', 'REST_API', 'WEBHOOK'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const CONNECTOR_STATUSES = ['ACTIVE', 'INACTIVE', 'ERROR', 'PENDING'] as const;

export interface CreateConnectorDto {
  key: string;
  name: string;
  type: string;
  endpoint?: string;
  authType?: string;
  rateLimit?: string;
  timeoutSec?: number;
  config?: Record<string, unknown>;
}

export interface ConnectorInvocationRequest {
  connectorKey: string;
  actionType: ActionType;
  method: string;
  payload: Record<string, unknown>;
  executionContext: {
    tenantId: string;
    userId: string;
    executionSessionId: string;
    correlationId: string;
  };
}

export interface ConnectorInvocationResult {
  success: boolean;
  statusCode: number;
  data: Record<string, unknown>;
  latencyMs: number;
  error?: string;
}

@Injectable()
export class ConnectorService {
  private readonly logger = new Logger(ConnectorService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly secrets: SecretsManager,
    private readonly dispatcher: RuntimeDispatcher,
    private readonly lifecycle: LifecycleManager,
    private readonly rateLimiter: RateLimiter,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly callLogger: CallLogger,
    private readonly schemaDiscovery: SchemaDiscovery,
    private readonly testPipeline: TestPipeline,
  ) {}

  // ═══════════════════════════════════════════
  //  CRUD Operations
  // ═══════════════════════════════════════════

  async list(ctx: TenantContext) {
    const db = withTenantIsolation(this.prisma, ctx);
    return db.connector.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async getByKey(ctx: TenantContext, key: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const connector = await db.connector.findFirst({ where: { key } });
    if (!connector) throw new NotFoundException(`Connector "${key}" not found`);
    return connector;
  }

  async getById(ctx: TenantContext, id: string) {
    const db = withTenantIsolation(this.prisma, ctx);
    const connector = await db.connector.findFirst({ where: { id } });
    if (!connector) throw new NotFoundException(`Connector ${id} not found`);
    return connector;
  }

  /**
   * A connector "uses stdio transport" when it spawns a local process: an
   * MCP_SERVER whose transport is stdio (the default when unspecified), or any
   * config carrying a `command`. Such connectors can launch arbitrary local
   * payloads via launchers (npx/docker), so they are restricted to PLATFORM_ADMIN.
   */
  private isStdioTransport(type: string | undefined, config?: Record<string, any>): boolean {
    const cfg = config || {};
    if (cfg.transport === 'stdio') return true;
    if (cfg.command) return true;
    // MCP_SERVER defaults to stdio transport when no transport is set and no
    // remote endpoint is configured.
    if (String(type) === 'MCP_SERVER' && !cfg.transport && !cfg.endpoint) return true;
    return false;
  }

  /**
   * Enforce that stdio (local-process-spawning) connectors are only created or
   * started by a PLATFORM_ADMIN. Non-stdio connectors keep their @Roles guard.
   */
  private assertStdioPrivilege(
    ctx: TenantContext,
    type: string | undefined,
    config?: Record<string, any>,
  ) {
    if (this.isStdioTransport(type, config) && ctx.role !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException(
        'stdio(로컬 프로세스 실행) 커넥터의 생성/시작은 PLATFORM_ADMIN 권한이 필요합니다. ' +
          '런처(npx/docker)는 임의 페이로드를 실행할 수 있어 플랫폼 관리자만 허용됩니다.',
      );
    }
  }

  async create(ctx: TenantContext, dto: CreateConnectorDto) {
    const db = withTenantIsolation(this.prisma, ctx);

    // stdio (local-process) connectors require PLATFORM_ADMIN (RCE surface).
    this.assertStdioPrivilege(ctx, dto.type, dto.config);

    // Check for duplicate key
    const existing = await db.connector.findFirst({ where: { key: dto.key } });
    if (existing) {
      throw new BadRequestException(`Connector with key "${dto.key}" already exists`);
    }

    // Encrypt sensitive fields in config
    const rawConfig = {
      endpoint: dto.endpoint,
      authType: dto.authType,
      rateLimit: dto.rateLimit,
      timeoutSec: dto.timeoutSec ?? 30,
      ...dto.config,
    };
    const encryptedConfig = this.secrets.encryptConfig(rawConfig);

    const connector = await db.connector.create({
      data: {
        tenantId: ctx.tenantId,
        key: dto.key,
        name: dto.name,
        type: dto.type,
        status: 'PENDING',
        configJson: encryptedConfig,
      },
    });

    // Auto-configure rate limiter and circuit breaker
    const rlConfig = dto.rateLimit ? this._parseRateLimit(dto.rateLimit) : {};
    this.rateLimiter.configure(connector.id, rlConfig);
    this.circuitBreaker.init(connector.id);

    return connector;
  }

  async update(ctx: TenantContext, id: string, dto: Partial<CreateConnectorDto>) {
    const db = withTenantIsolation(this.prisma, ctx);
    const connector = await this.getById(ctx, id);
    const existingConfig = (connector.configJson as Record<string, unknown>) ?? {};

    const mergedConfig = {
      ...existingConfig,
      ...(dto.endpoint !== undefined ? { endpoint: dto.endpoint } : {}),
      ...(dto.authType !== undefined ? { authType: dto.authType } : {}),
      ...(dto.rateLimit !== undefined ? { rateLimit: dto.rateLimit } : {}),
      ...(dto.timeoutSec !== undefined ? { timeoutSec: dto.timeoutSec } : {}),
      ...dto.config,
    };

    return db.connector.update({
      where: { id },
      data: {
        name: dto.name ?? connector.name,
        type: dto.type ?? connector.type,
        configJson: this.secrets.encryptConfig(mergedConfig),
      },
    });
  }

  async delete(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    // Stop lifecycle if running
    this.lifecycle.stop(id);
    await this.prisma.connector.delete({ where: { id } });
    return { success: true };
  }

  // ═══════════════════════════════════════════
  //  Health Check
  // ═══════════════════════════════════════════

  async healthCheck(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    const config = connector.configJson as Record<string, unknown>;
    const startTime = Date.now();

    // Simulated health check — in production, actually ping the endpoint
    const healthy = !!config?.endpoint;
    const latencyMs = Date.now() - startTime + Math.random() * 100;

    const newStatus = healthy ? 'ACTIVE' : 'ERROR';
    await this.prisma.connector.update({
      where: { id },
      data: {
        status: newStatus,
        configJson: {
          ...(config ?? {}),
          lastHealthCheck: new Date().toISOString(),
          lastHealthLatencyMs: Math.round(latencyMs),
          lastHealthStatus: healthy ? 'OK' : 'UNREACHABLE',
        },
      },
    });

    return {
      connectorId: id,
      connectorKey: connector.key,
      healthy,
      status: newStatus,
      latencyMs: Math.round(latencyMs),
      checkedAt: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════
  //  Lifecycle Management (MCP Start/Stop/Restart)
  // ═══════════════════════════════════════════

  async startConnector(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    const config = this.secrets.decryptConfig((connector.configJson as Record<string, any>) || {});

    // stdio (local-process) connectors require PLATFORM_ADMIN to start (RCE surface).
    this.assertStdioPrivilege(ctx, connector.type, config);

    try {
      const result = await this.lifecycle.start(id, config);

      // Update status to ACTIVE
      await this.prisma.connector.update({
        where: { id },
        data: { status: 'ACTIVE' },
      });

      // Configure rate limiter and circuit breaker
      this.rateLimiter.configure(id, this._parseRateLimit(config.rateLimit));
      this.circuitBreaker.init(id);

      return {
        connectorId: id,
        connectorKey: connector.key,
        ...result,
      };
    } catch (err: any) {
      await this.prisma.connector.update({
        where: { id },
        data: { status: 'ERROR' },
      });
      throw new BadRequestException(`Failed to start connector: ${err.message}`);
    }
  }

  async stopConnector(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    const result = this.lifecycle.stop(id);

    await this.prisma.connector.update({
      where: { id },
      data: { status: 'INACTIVE' },
    });

    return {
      connectorId: id,
      connectorKey: connector.key,
      ...result,
    };
  }

  async restartConnector(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    const config = this.secrets.decryptConfig((connector.configJson as Record<string, any>) || {});

    try {
      const result = await this.lifecycle.restart(id, config);
      await this.prisma.connector.update({
        where: { id },
        data: { status: 'ACTIVE' },
      });
      return {
        connectorId: id,
        connectorKey: connector.key,
        ...result,
      };
    } catch (err: any) {
      await this.prisma.connector.update({
        where: { id },
        data: { status: 'ERROR' },
      });
      throw new BadRequestException(`Failed to restart connector: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════
  //  Schema Discovery & Tools
  // ═══════════════════════════════════════════

  async discoverSchema(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    return this.schemaDiscovery.discover(connector as any);
  }

  async getTools(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    const client = this.lifecycle.getClient(id);
    if (client?.status === 'connected') {
      return { tools: client.tools, source: 'live', connectorId: id };
    }
    return { tools: [], source: 'not_connected', connectorId: id };
  }

  // ═══════════════════════════════════════════
  //  Test Pipeline
  // ═══════════════════════════════════════════

  async testConnector(ctx: TenantContext, id: string) {
    const connector = await this.getById(ctx, id);
    return this.testPipeline.run(connector as any);
  }

  // ═══════════════════════════════════════════
  //  Governed Runtime Invocation
  //  Chain: RateLimit → CircuitBreaker → Dispatch → CallLog
  // ═══════════════════════════════════════════

  async invoke(request: ConnectorInvocationRequest): Promise<ConnectorInvocationResult> {
    const { connectorKey, actionType, method, payload, executionContext } = request;
    const startTime = Date.now();

    this.logger.log(
      `[governed] Invoking connector "${connectorKey}" ` +
        `action=${actionType} method=${method} ` +
        `session=${executionContext.executionSessionId}`,
    );

    // 1. Load connector
    const connector = await this.prisma.connector.findFirst({
      where: {
        key: connectorKey,
        tenantId: executionContext.tenantId,
      },
    });

    if (!connector) {
      return {
        success: false,
        statusCode: 404,
        data: {},
        latencyMs: Date.now() - startTime,
        error: `Connector "${connectorKey}" not found for tenant`,
      };
    }

    // 2. Verify connector is active
    if (connector.status !== 'ACTIVE') {
      return {
        success: false,
        statusCode: 503,
        data: {},
        latencyMs: Date.now() - startTime,
        error: `Connector "${connectorKey}" is not active (status: ${connector.status})`,
      };
    }

    // 3. Rate Limit Gate
    const rlCheck = this.rateLimiter.check(connector.id);
    if (!rlCheck.allowed) {
      this.callLogger.log({
        connector_id: connector.id,
        connector_name: connector.name,
        protocol: connector.type,
        action: method,
        success: false,
        duration_ms: Date.now() - startTime,
        error: `Rate limited: ${rlCheck.reason}`,
        tenant_id: executionContext.tenantId,
        cost_estimate: 0,
      });
      return {
        success: false,
        statusCode: 429,
        data: { waitMs: rlCheck.waitMs },
        latencyMs: Date.now() - startTime,
        error: `Rate limited: ${rlCheck.reason}`,
      };
    }

    // 4. Circuit Breaker Gate
    const cbCheck = this.circuitBreaker.canExecute(connector.id);
    if (!cbCheck.allowed) {
      this.callLogger.log({
        connector_id: connector.id,
        connector_name: connector.name,
        protocol: connector.type,
        action: method,
        success: false,
        duration_ms: Date.now() - startTime,
        error: `Circuit open: ${cbCheck.reason}`,
        tenant_id: executionContext.tenantId,
        cost_estimate: 0,
      });
      return {
        success: false,
        statusCode: 503,
        data: { retryAfterMs: cbCheck.retryAfterMs, circuitState: cbCheck.state },
        latencyMs: Date.now() - startTime,
        error: `Circuit breaker: ${cbCheck.reason}`,
      };
    }

    // 5. Execute via RuntimeDispatcher
    try {
      this.rateLimiter.consume(connector.id);

      const result = await this.dispatcher.dispatch(
        connector as any,
        method,
        payload as Record<string, any>,
      );

      const latencyMs = Date.now() - startTime;

      if (result.success) {
        this.circuitBreaker.recordSuccess(connector.id);
      } else {
        this.circuitBreaker.recordFailure(connector.id);
      }

      // 6. Log the call
      const costEstimate = this._estimateCost(connector.type, latencyMs);
      this.callLogger.log({
        connector_id: connector.id,
        connector_name: connector.name,
        protocol: connector.type,
        action: method,
        success: result.success,
        duration_ms: latencyMs,
        error: result.error,
        tenant_id: executionContext.tenantId,
        cost_estimate: costEstimate,
      });

      // 7. Record execution trace
      await this.prisma.executionTrace.create({
        data: {
          executionSessionId: executionContext.executionSessionId,
          correlationId: executionContext.correlationId,
          traceJson: JSON.parse(
            JSON.stringify({
              event: result.success ? 'CONNECTOR_INVOCATION' : 'CONNECTOR_INVOCATION_FAILED',
              connectorKey,
              connectorType: connector.type,
              actionType,
              method,
              input: this.sanitizeForTrace(payload),
              output: this.sanitizeForTrace(result.data || {}),
              latencyMs,
              success: result.success,
              governed: true,
              rateLimit: this.rateLimiter.getStats(connector.id),
              circuitBreaker: this.circuitBreaker.getState(connector.id),
              costEstimate,
              timestamp: new Date().toISOString(),
            }),
          ),
        },
      });

      return {
        success: result.success,
        statusCode: result.success ? 200 : 500,
        data: result.data,
        latencyMs,
        error: result.error,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      this.circuitBreaker.recordFailure(connector.id);

      this.callLogger.log({
        connector_id: connector.id,
        connector_name: connector.name,
        protocol: connector.type,
        action: method,
        success: false,
        duration_ms: latencyMs,
        error: error.message,
        tenant_id: executionContext.tenantId,
        cost_estimate: 0,
      });

      // Record failure trace
      await this.prisma.executionTrace
        .create({
          data: {
            executionSessionId: executionContext.executionSessionId,
            correlationId: executionContext.correlationId,
            traceJson: {
              event: 'CONNECTOR_INVOCATION_FAILED',
              connectorKey,
              actionType,
              method,
              error: error.message,
              latencyMs,
              governed: true,
              timestamp: new Date().toISOString(),
            },
          },
        })
        .catch(() => {});

      return {
        success: false,
        statusCode: 500,
        data: {},
        latencyMs,
        error: error.message,
      };
    }
  }

  // ═══════════════════════════════════════════
  //  Governance Data Accessors
  // ═══════════════════════════════════════════

  getRateLimitStats(connectorId?: string) {
    if (connectorId) return this.rateLimiter.getStats(connectorId);
    return this.rateLimiter.getAllStats();
  }

  getCircuitBreakerStates(connectorId?: string) {
    if (connectorId) return this.circuitBreaker.getState(connectorId);
    return this.circuitBreaker.getAllStates();
  }

  getCallLogs(
    opts: {
      connector_id?: string;
      tenant_id?: string;
      success?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    return this.callLogger.query(opts);
  }

  getCallStats(connectorId?: string, periodMinutes = 60) {
    if (connectorId) return this.callLogger.getStats(connectorId, periodMinutes);
    return this.callLogger.getAllStats(periodMinutes);
  }

  getLifecycleStatuses() {
    return this.lifecycle.getStatuses();
  }

  getGovernanceOverview() {
    const stats = this.callLogger.getAllStats(60);
    const circuits = this.circuitBreaker.getAllStates();
    const rateLimits = this.rateLimiter.getAllStats();
    const lifecycles = this.lifecycle.getStatuses();

    return {
      summary: stats.summary,
      connectors: stats.byConnector,
      circuits,
      rateLimits,
      lifecycles,
      timeSeries: stats.timeSeries,
    };
  }

  // ── Private Helpers ──

  private _parseRateLimit(rateLimit?: string): {
    maxPerMinute?: number;
    maxPerHour?: number;
    burstSize?: number;
  } {
    if (!rateLimit) return {};
    const match = rateLimit.match(/(\d+)\s*\/\s*(min|hr|hour|minute)/i);
    if (!match) return {};
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'min' || unit === 'minute') return { maxPerMinute: num, maxPerHour: num * 60 };
    return { maxPerHour: num, maxPerMinute: Math.ceil(num / 60) };
  }

  private _estimateCost(connectorType: string, durationMs: number): number {
    const rates: Record<string, number> = {
      MCP_SERVER: 0.001,
      AGENT: 0.005,
      REST_API: 0.0005,
      WEBHOOK: 0.0001,
    };
    const baseRate = rates[connectorType] || 0.001;
    return Math.round(baseRate * (1 + durationMs / 10000) * 10000) / 10000;
  }

  private sanitizeForTrace(data: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...data };
    const sensitiveKeys = ['password', 'secret', 'token', 'apiKey', 'authorization'];
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
        sanitized[key] = '[REDACTED]';
      }
    }
    return sanitized;
  }
}
