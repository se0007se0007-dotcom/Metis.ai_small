/**
 * Agent Dispatcher — routes a task to a named agent.
 *
 * Resolution order:
 *   1. Look up AgentDefinition by key → pick kernelType
 *   2. Dispatch according to kernel:
 *        LOCAL   → invoke in-process handler registry
 *        MCP     → use ConnectorService to call MCP tool
 *        REST    → HTTP POST to kernelConfig.endpoint
 *        EXTERNAL→ webhook + wait for callback (not implemented here)
 *   3. Record invocation stats + publish EVENT to A2A bus
 *
 * This service makes agents "first-class executable nodes".
 */
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import {
  PrismaClient,
  withTenantIsolation,
  TenantContext,
  getSystemSessionId,
} from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { AgentRegistryService } from '../capability-registry/agent-registry.service';
import { ConnectorService } from '../connector/connector.service';
import { A2ABusService } from './bus.service';
import * as http from 'http';
import * as https from 'https';
import {
  assertExternalUrl,
  resolveValidatedExternalIps,
  pinnedLookup,
} from '../../common/utils/url-validator';

export interface AgentDispatchRequest {
  agentKey: string;
  missionId?: string;
  input: Record<string, any>;
  correlationId?: string;
  timeoutSec?: number;
}

export interface AgentDispatchResult {
  success: boolean;
  output: Record<string, any>;
  durationMs: number;
  agent: string;
  kernel: string;
  error?: string;
}

type LocalAgentHandler = (
  input: Record<string, any>,
  ctx: TenantContext,
) => Promise<Record<string, any>>;

@Injectable()
export class AgentDispatcherService {
  private readonly logger = new Logger(AgentDispatcherService.name);
  private readonly localHandlers = new Map<string, LocalAgentHandler>();

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly agentRegistry: AgentRegistryService,
    private readonly bus: A2ABusService,
    @Optional() private readonly connectorService?: ConnectorService,
  ) {}

  /** Register an in-process agent handler (called from each agent module). */
  registerLocalHandler(agentKey: string, handler: LocalAgentHandler) {
    this.localHandlers.set(agentKey, handler);
    this.logger.log(`[dispatcher] Registered local handler for "${agentKey}"`);
  }

  async dispatch(ctx: TenantContext, req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const start = Date.now();
    const correlationId =
      req.correlationId || `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Resolve agent definition.
    // Generic/built-in agents (e.g. ai-processing's "workflow-agent") may carry a
    // model suffix in the capability ("workflow-agent:claude-sonnet-4.6") and have a
    // registered in-process handler but NO AgentDefinition row. In that case fall
    // back to the local handler keyed by the base name (segment before the first ":")
    // so workflow execution doesn't fail with "Agent not found".
    let agent: Awaited<ReturnType<AgentRegistryService['getByKey']>>;
    try {
      agent = await this.agentRegistry.getByKey(ctx, req.agentKey);
    } catch (notFound) {
      const baseKey = req.agentKey.split(':')[0];
      const modelHint = req.agentKey.includes(':')
        ? req.agentKey.slice(req.agentKey.indexOf(':') + 1)
        : undefined;
      if (baseKey && baseKey !== req.agentKey && this.localHandlers.has(baseKey)) {
        // Pass the requested model through to the handler input.
        if (modelHint) req.input = { ...req.input, _model: modelHint };
        agent = {
          key: baseKey,
          name: baseKey,
          kernelType: 'LOCAL',
          status: 'AVAILABLE',
          kernelConfigJson: {},
          defaultTimeoutSec: req.timeoutSec ?? 60,
        } as any;
      } else if (this.localHandlers.has(req.agentKey)) {
        agent = {
          key: req.agentKey,
          name: req.agentKey,
          kernelType: 'LOCAL',
          status: 'AVAILABLE',
          kernelConfigJson: {},
          defaultTimeoutSec: req.timeoutSec ?? 60,
        } as any;
      } else {
        throw notFound;
      }
    }
    if (agent.status === 'UNAVAILABLE' || agent.status === 'DRAINING') {
      return {
        success: false,
        output: {},
        durationMs: Date.now() - start,
        agent: agent.key,
        kernel: agent.kernelType,
        error: `Agent "${agent.key}" is ${agent.status}`,
      };
    }

    // Emit request event to mission if bound
    if (req.missionId) {
      await this.bus.publish(ctx.tenantId, req.missionId, {
        kind: 'REQUEST',
        fromAgent: 'dispatcher',
        toAgent: agent.key,
        subject: 'Task dispatch',
        payload: { input: req.input },
        naturalSummary: `${agent.name} 에이전트에게 작업을 요청했습니다.`,
        correlationId,
      });
    }

    let output: Record<string, any> = {};
    let success = false;
    let error: string | undefined;

    try {
      switch (agent.kernelType) {
        case 'LOCAL':
          output = await this.dispatchLocal(agent.key, req.input, ctx);
          success = true;
          break;
        case 'REST':
          output = await this.dispatchREST(
            agent.kernelConfigJson as any,
            req.input,
            req.timeoutSec ?? agent.defaultTimeoutSec,
          );
          success = true;
          break;
        case 'MCP':
          output = await this.dispatchMCP(ctx, agent.key, agent.kernelConfigJson as any, req.input);
          success = true;
          break;
        case 'EXTERNAL':
          output = await this.dispatchExternal(agent.kernelConfigJson as any, req.input);
          success = true;
          break;
      }
    } catch (e: any) {
      success = false;
      error = e.message;
      this.logger.error(`[dispatcher] ${agent.key} failed: ${e.message}`);
    }

    const durationMs = Date.now() - start;

    // Record stats
    await this.agentRegistry.recordInvocation(ctx, agent.key, success).catch(() => {});

    // Emit response event
    if (req.missionId) {
      await this.bus.publish(ctx.tenantId, req.missionId, {
        kind: success ? 'RESPONSE' : 'EVENT',
        fromAgent: agent.key,
        toAgent: 'dispatcher',
        subject: success ? 'Task completed' : 'Task failed',
        payload: success ? { output } : { error },
        naturalSummary: success
          ? `${agent.name}가 작업을 완료했습니다.`
          : `${agent.name} 실행 실패: ${error}`,
        correlationId,
      });
    }

    // Audit trace (per-tenant sentinel session FK)
    const dispatchSessionId = await getSystemSessionId(this.prisma, ctx.tenantId);
    if (dispatchSessionId)
      await this.prisma.executionTrace
        .create({
          data: {
            executionSessionId: dispatchSessionId,
            correlationId,
            traceJson: {
              event: 'AGENT_DISPATCH',
              agent: agent.key,
              kernel: agent.kernelType,
              success,
              durationMs,
              missionId: req.missionId,
              timestamp: new Date().toISOString(),
            } as any,
          },
        })
        .catch(() => {});

    return { success, output, durationMs, agent: agent.key, kernel: agent.kernelType, error };
  }

  // ── Kernel implementations ──────────────────────────────

  private async dispatchLocal(agentKey: string, input: Record<string, any>, ctx: TenantContext) {
    const handler = this.localHandlers.get(agentKey);
    if (!handler) {
      throw new Error(`No local handler registered for "${agentKey}"`);
    }
    return handler(input, ctx);
  }

  private async dispatchREST(
    config: Record<string, any>,
    input: Record<string, any>,
    timeoutSec: number,
  ): Promise<Record<string, any>> {
    const endpoint = config?.endpoint;
    if (!endpoint) throw new Error('No endpoint in agent kernelConfig');
    // SSRF guard (H-1) + DNS-rebinding pin: validate, then pin the socket connect
    // to the already-validated IP so DNS cannot rebind to an internal address
    // between validation and connect. Host header / TLS SNI stay = hostname.
    const { ips } = await resolveValidatedExternalIps(endpoint);
    const url = new URL(endpoint);
    const mod = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(input);
    const timeoutMs = Math.max(1, timeoutSec) * 1000;
    return new Promise((resolve) => {
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          lookup: pinnedLookup(ips),
          servername: url.hostname,
          timeout: timeoutMs,
        },
        (res) => {
          // Actually read the agent's response body (previously discarded).
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: any = raw;
            try {
              parsed = raw ? JSON.parse(raw) : {};
            } catch {
              /* keep raw text */
            }
            resolve({
              dispatched: true,
              status: res.statusCode ?? 0,
              ok: (res.statusCode ?? 500) < 400,
              result: parsed,
            });
          });
        },
      );
      req.on('error', (err) => resolve({ dispatched: false, ok: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ dispatched: false, ok: false, error: `REST agent timed out after ${timeoutMs}ms` });
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * MCP kernel — dispatch the task to an MCP-backed agent through the
   * governed connector runtime (rate-limit → circuit-breaker → real MCP
   * client → call log). P3-4: replaces the former structured stub.
   *
   * kernelConfig contract:
   *   { connectorKey: string, tool?: string, actionType?: ActionType }
   * `tool` defaults to kernelConfig.action/toolName; actionType defaults to
   * 'execute'. The connector must be registered + ACTIVE for the tenant.
   */
  private async dispatchMCP(
    ctx: TenantContext,
    agentKey: string,
    config: Record<string, any>,
    input: Record<string, any>,
  ): Promise<Record<string, any>> {
    const tool = config?.tool || config?.action || config?.toolName;
    const connectorKey = config?.connectorKey || config?.connector;

    if (!this.connectorService) {
      throw new Error('MCP kernel unavailable: ConnectorService not wired');
    }
    if (!connectorKey) {
      throw new Error(
        `MCP agent "${agentKey}" has no kernelConfig.connectorKey — cannot resolve MCP server`,
      );
    }
    if (!tool) {
      throw new Error(`MCP agent "${agentKey}" has no kernelConfig.tool — cannot resolve MCP tool`);
    }

    this.logger.log(
      `[dispatcher] MCP dispatch for "${agentKey}" connector="${connectorKey}" tool="${tool}"`,
    );

    const sessionId =
      (await getSystemSessionId(this.prisma, ctx.tenantId).catch(() => null)) ??
      `dispatch-${Date.now()}`;

    const result = await this.connectorService.invoke({
      connectorKey,
      actionType: (config?.actionType as any) ?? 'execute',
      method: tool,
      payload: input,
      executionContext: {
        tenantId: ctx.tenantId,
        userId: ctx.userId ?? 'system',
        executionSessionId: sessionId,
        correlationId: `mcp-${agentKey}-${Date.now()}`,
      },
    });

    if (!result.success) {
      throw new Error(
        `MCP tool "${tool}" via connector "${connectorKey}" failed (${result.statusCode}): ${result.error ?? 'unknown'}`,
      );
    }

    return {
      dispatched: true,
      via: 'mcp',
      agentKey,
      connectorKey,
      tool,
      latencyMs: result.latencyMs,
      output: result.data,
    };
  }

  /**
   * EXTERNAL kernel — dispatch to an external system (webhook / async callback).
   *
   * Reconstructed (no original source). Mirrors the dispatchREST stub shape;
   * a real implementation would POST to a webhook and await a callback.
   */
  private async dispatchExternal(
    config: Record<string, any>,
    input: Record<string, any>,
  ): Promise<Record<string, any>> {
    const endpoint = config?.endpoint || config?.webhook || config?.callbackUrl;
    if (endpoint) await assertExternalUrl(endpoint); // SSRF guard (H-1)
    this.logger.log(`[dispatcher] EXTERNAL dispatch endpoint="${endpoint ?? 'none'}"`);
    return {
      dispatched: true,
      via: 'external',
      endpoint: endpoint ?? null,
      output: input,
    };
  }
}
