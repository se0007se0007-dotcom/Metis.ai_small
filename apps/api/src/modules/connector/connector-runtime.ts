/**
 * Connector Runtime — Phase 3~4
 * ================================================================
 * Real protocol dispatch, MCP client, secrets, lifecycle management,
 * rate limiting, circuit breaking, call logging — all in one module.
 *
 * Designed for NestJS injection into ConnectorService.
 */
import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { EventEmitter } from 'events';
import {
  assertExternalUrl,
  resolveValidatedExternalIps,
  pinnedLookup,
} from '../../common/utils/url-validator';

// ── Stdio connector hardening ───────────────────────────────
// NOTE: stdio connectors spawn local processes and should ideally require
// PLATFORM_ADMIN privileges. We never use a shell; commands are restricted
// to a known allow-list and arguments are screened for shell metacharacters.
const ALLOWED_STDIO_COMMANDS = new Set([
  'npx',
  'node',
  'python',
  'python3',
  'uvx',
  'uv',
  'docker',
  'bun',
  'deno',
]);

// Reject shell metacharacters that could enable injection if a shell is ever
// (re)introduced, or that indicate a malicious payload.
const SHELL_METACHAR = /[;|&`$><\n\r\u0000]/;

// Environment variable keys that must never be overridden by tenant config.
const BLOCKED_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PATH',
  'IFS',
  'BASH_ENV',
  'ENV',
]);

function sanitizeStdioEnv(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue; // only string values
    if (BLOCKED_ENV_KEYS.has(k.toUpperCase())) continue; // block critical vars
    safe[k] = v;
  }
  return safe;
}

function assertSafeStdioSpawn(command: string, args: string[]): void {
  const cmd = (command || '').trim();
  if (!cmd) throw new Error('stdio 커넥터: command가 비어 있습니다.');
  // Allow-list check on the base command name (strip any path component).
  const base = cmd.split(/[\\/]/).pop() || cmd;
  if (!ALLOWED_STDIO_COMMANDS.has(base)) {
    throw new Error(
      `stdio 커넥터: 허용되지 않은 명령어 "${base}". 허용 목록: ${[...ALLOWED_STDIO_COMMANDS].join(', ')}`,
    );
  }
  if (SHELL_METACHAR.test(cmd)) {
    throw new Error('stdio 커넥터: command에 허용되지 않는 셸 메타문자가 포함되어 있습니다.');
  }
  for (const a of args) {
    if (typeof a !== 'string') {
      throw new Error('stdio 커넥터: 모든 인자는 문자열이어야 합니다.');
    }
    if (SHELL_METACHAR.test(a)) {
      throw new Error('stdio 커넥터: 인자에 허용되지 않는 셸 메타문자가 포함되어 있습니다.');
    }
  }
}

// ── Secrets Manager ─────────────────────────────────────────
const ENCRYPTION_KEY = process.env.METIS_SECRET_KEY || crypto.randomBytes(32).toString('hex');

@Injectable()
export class SecretsManager {
  private key: Buffer;

  constructor() {
    const raw = ENCRYPTION_KEY.padEnd(64, '0').substring(0, 64);
    this.key = Buffer.from(raw, 'hex');
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `enc:${iv.toString('hex')}:${tag}:${encrypted}`;
  }

  decrypt(ciphertext: string): string | null {
    if (!ciphertext?.startsWith('enc:')) return ciphertext;
    try {
      const [, ivHex, tagHex, encrypted] = ciphertext.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      let dec = decipher.update(encrypted, 'hex', 'utf8');
      dec += decipher.final('utf8');
      return dec;
    } catch {
      return null;
    }
  }

  encryptConfig(config: Record<string, any>): Record<string, any> {
    if (!config) return config;
    const sensitive = [
      'api_key',
      'apiKey',
      'secret',
      'password',
      'token',
      'auth_token',
      'access_token',
      'private_key',
    ];
    const result = { ...config };
    for (const key of Object.keys(result)) {
      if (
        sensitive.some((s) => key.toLowerCase().includes(s.toLowerCase())) &&
        typeof result[key] === 'string' &&
        !result[key].startsWith('enc:')
      ) {
        result[key] = this.encrypt(result[key]);
      }
    }
    return result;
  }

  decryptConfig(config: Record<string, any>): Record<string, any> {
    if (!config) return config;
    const result = { ...config };
    for (const key of Object.keys(result)) {
      if (typeof result[key] === 'string' && result[key].startsWith('enc:')) {
        result[key] = this.decrypt(result[key]);
      }
    }
    return result;
  }

  maskConfig(config: Record<string, any>): Record<string, any> {
    if (!config) return config;
    const sensitive = [
      'api_key',
      'apiKey',
      'secret',
      'password',
      'token',
      'auth_token',
      'access_token',
      'private_key',
    ];
    const result = { ...config };
    for (const key of Object.keys(result)) {
      if (sensitive.some((s) => key.toLowerCase().includes(s.toLowerCase()))) {
        result[key] = '••••••••';
      }
    }
    return result;
  }
}

// ── MCP Client ──────────────────────────────────────────────
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export class MCPClient extends EventEmitter {
  process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: Function; reject: Function; timeout: any }
  >();
  private buffer = '';
  tools: MCPTool[] = [];
  serverInfo: any = null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private sseConnection: any = null;

  async connectStdio(
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ): Promise<{ serverInfo: any; tools: MCPTool[] }> {
    return new Promise((resolve, reject) => {
      this.status = 'connecting';
      try {
        // SECURITY (C-1): enforce command allow-list + reject shell metacharacters.
        assertSafeStdioSpawn(command, args);
        // Merge tenant env AFTER process.env, with critical keys blocked.
        // PATH is always inherited from process.env and cannot be overridden.
        const childEnv = { ...process.env, ...sanitizeStdioEnv(env) };
        // Windows 에서 npx/uvx 등은 .cmd 셸 스크립트라 shell:false 로는 spawn ENOENT 가 난다.
        // assertSafeStdioSpawn 이 command 화이트리스트 + 셸 메타문자 차단을 이미 수행하므로,
        // win32 에 한해 shell:true 를 허용해 MCP 서버 프로세스가 실제로 기동되도록 한다.
        const useShell = process.platform === 'win32';
        this.process = spawn(command, args, {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: useShell,
        });
        // 'error' 리스너를 즉시 부착(아래에서도 부착하지만, spawn 직후 동기 안전망).
        this.process.on('error', (err) => {
          this.status = 'error';
          reject(err);
        });

        this.process.stdout!.on('data', (data: Buffer) => {
          this.buffer += data.toString();
          this._processBuffer();
        });
        this.process.stderr!.on('data', (data: Buffer) => this.emit('log', data.toString().trim()));
        this.process.on('error', (err) => {
          this.status = 'error';
          reject(err);
        });
        this.process.on('close', (code) => {
          this.status = 'disconnected';
          this.emit('close', code);
        });

        setTimeout(async () => {
          try {
            this.serverInfo = await this._sendRequest('initialize', {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              clientInfo: { name: 'metis-ai', version: '1.3.0' },
            });
            this._sendNotification('notifications/initialized', {});
            const toolsResult = await this._sendRequest('tools/list', {});
            this.tools = toolsResult.tools || [];
            this.status = 'connected';
            resolve({ serverInfo: this.serverInfo, tools: this.tools });
          } catch (err) {
            this.status = 'error';
            reject(err);
          }
        }, 500);
      } catch (err) {
        this.status = 'error';
        reject(err);
      }
    });
  }

  async connectSSE(endpoint: string): Promise<{ serverInfo: any; tools: MCPTool[] }> {
    // SSRF guard (H-1) + DNS-rebinding pin.
    const sseIps = (await resolveValidatedExternalIps(endpoint)).ips;
    return new Promise((resolve, reject) => {
      this.status = 'connecting';
      const url = new URL(endpoint);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          lookup: pinnedLookup(sseIps),
          servername: url.hostname,
        },
        (res) => {
          if (res.statusCode !== 200) {
            this.status = 'error';
            reject(new Error(`SSE ${res.statusCode}`));
            return;
          }
          this.sseConnection = res;
          let sseBuf = '';
          res.on('data', (chunk: Buffer) => {
            sseBuf += chunk.toString();
            const events = sseBuf.split('\n\n');
            sseBuf = events.pop() || '';
            for (const ev of events) {
              const m = ev.match(/^data:\s*(.+)$/m);
              if (m) {
                try {
                  this._handleMessage(JSON.parse(m[1]));
                } catch {}
              }
            }
          });
          res.on('end', () => {
            this.status = 'disconnected';
          });
          setTimeout(async () => {
            try {
              const msgUrl = endpoint.replace(/\/sse$/, '/message');
              this.serverInfo = await this._sendSSERequest(msgUrl, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                clientInfo: { name: 'metis-ai', version: '1.3.0' },
              });
              await this._sendSSERequest(msgUrl, 'notifications/initialized', {});
              const toolsResult = await this._sendSSERequest(msgUrl, 'tools/list', {});
              this.tools = toolsResult?.tools || [];
              this.status = 'connected';
              resolve({ serverInfo: this.serverInfo, tools: this.tools });
            } catch (err) {
              this.status = 'error';
              reject(err);
            }
          }, 300);
        },
      );
      req.on('error', (err) => {
        this.status = 'error';
        reject(err);
      });
      req.end();
    });
  }

  async callTool(toolName: string, args: Record<string, any> = {}): Promise<any> {
    if (this.status !== 'connected') throw new Error(`MCP not connected (${this.status})`);
    if (this.process) return this._sendRequest('tools/call', { name: toolName, arguments: args });
    if (this.sseConnection) {
      const endpoint = (this as any)._sseEndpoint || '';
      return this._sendSSERequest(endpoint.replace(/\/sse$/, '/message'), 'tools/call', {
        name: toolName,
        arguments: args,
      });
    }
    throw new Error('No active connection');
  }

  disconnect() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    if (this.sseConnection) {
      this.sseConnection.destroy();
      this.sseConnection = null;
    }
    this.status = 'disconnected';
    this.tools = [];
    this.pendingRequests.clear();
  }

  private _sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 30000);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.process!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private _sendNotification(method: string, params: any) {
    if (this.process)
      this.process.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private async _sendSSERequest(
    messageEndpoint: string,
    method: string,
    params: any,
  ): Promise<any> {
    // SSRF guard (H-1) + DNS-rebinding pin.
    const msgIps = (await resolveValidatedExternalIps(messageEndpoint)).ips;
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params });
      const url = new URL(messageEndpoint);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          lookup: pinnedLookup(msgIps),
          servername: url.hostname,
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => {
            data += c;
          });
          res.on('end', () => {
            try {
              const r = JSON.parse(data);
              r.error ? reject(new Error(r.error.message)) : resolve(r.result);
            } catch {
              resolve(data);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private _processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this._handleMessage(JSON.parse(line));
      } catch {}
    }
  }

  private _handleMessage(msg: any) {
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timeout } = this.pendingRequests.get(msg.id)!;
      clearTimeout(timeout);
      this.pendingRequests.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      this.emit('notification', msg);
    }
  }
}

// ── Lifecycle Manager ───────────────────────────────────────
@Injectable()
export class LifecycleManager {
  private readonly logger = new Logger(LifecycleManager.name);
  private clients = new Map<string, MCPClient>();
  private restartCounts = new Map<string, number>();

  async start(
    connectorId: string,
    config: Record<string, any>,
  ): Promise<{ status: string; tools: MCPTool[]; serverInfo: any }> {
    const existing = this.clients.get(connectorId);
    if (existing?.status === 'connected')
      return {
        status: 'already_connected',
        tools: existing.tools,
        serverInfo: existing.serverInfo,
      };

    const client = new MCPClient();
    this.clients.set(connectorId, client);

    client.on('close', (code: number) => {
      if (code !== 0) {
        const count = (this.restartCounts.get(connectorId) || 0) + 1;
        this.restartCounts.set(connectorId, count);
        if (count <= 5) setTimeout(() => this.start(connectorId, config), 2000 * count);
      }
    });

    const transport = config.transport || 'stdio';
    if (transport === 'sse') {
      const result = await client.connectSSE(config.endpoint);
      this.restartCounts.set(connectorId, 0);
      return { status: 'connected', ...result };
    } else {
      const result = await client.connectStdio(
        config.command || 'npx',
        config.args || [],
        config.env || {},
      );
      this.restartCounts.set(connectorId, 0);
      return { status: 'connected', ...result };
    }
  }

  stop(connectorId: string) {
    const client = this.clients.get(connectorId);
    if (client) {
      client.disconnect();
      this.clients.delete(connectorId);
      this.restartCounts.delete(connectorId);
    }
    return { status: 'disconnected' };
  }

  async restart(connectorId: string, config: Record<string, any>) {
    this.stop(connectorId);
    await new Promise((r) => setTimeout(r, 500));
    return this.start(connectorId, config);
  }

  getClient(connectorId: string): MCPClient | null {
    return this.clients.get(connectorId) || null;
  }

  getStatuses(): Record<string, { status: string; tools: number; serverInfo: any }> {
    const s: Record<string, any> = {};
    for (const [id, client] of this.clients)
      s[id] = { status: client.status, tools: client.tools.length, serverInfo: client.serverInfo };
    return s;
  }

  shutdownAll() {
    for (const [id] of this.clients) this.stop(id);
  }
}

// ── Rate Limiter ────────────────────────────────────────────
interface Bucket {
  tokens: number;
  maxTokens: number;
  refillRate: number;
  maxPerMinute: number;
  maxPerHour: number;
  lastRefill: number;
  minuteCount: number;
  hourCount: number;
  minuteStart: number;
  hourStart: number;
}

@Injectable()
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  configure(
    connectorId: string,
    opts: { maxPerMinute?: number; maxPerHour?: number; burstSize?: number } = {},
  ) {
    const { maxPerMinute = 60, maxPerHour = 600, burstSize = 10 } = opts;
    this.buckets.set(connectorId, {
      tokens: burstSize,
      maxTokens: burstSize,
      refillRate: maxPerMinute / 60,
      maxPerMinute,
      maxPerHour,
      lastRefill: Date.now(),
      minuteCount: 0,
      hourCount: 0,
      minuteStart: Date.now(),
      hourStart: Date.now(),
    });
  }

  check(connectorId: string): {
    allowed: boolean;
    remaining: number;
    waitMs: number;
    reason?: string;
  } {
    const b = this.buckets.get(connectorId);
    if (!b) return { allowed: true, remaining: Infinity, waitMs: 0 };
    this._refill(b);
    const now = Date.now();
    if (now - b.minuteStart > 60000) {
      b.minuteCount = 0;
      b.minuteStart = now;
    }
    if (now - b.hourStart > 3600000) {
      b.hourCount = 0;
      b.hourStart = now;
    }
    if (b.minuteCount >= b.maxPerMinute)
      return {
        allowed: false,
        remaining: 0,
        waitMs: 60000 - (now - b.minuteStart),
        reason: `${b.maxPerMinute}/min exceeded`,
      };
    if (b.hourCount >= b.maxPerHour)
      return {
        allowed: false,
        remaining: 0,
        waitMs: 3600000 - (now - b.hourStart),
        reason: `${b.maxPerHour}/hr exceeded`,
      };
    if (b.tokens < 1)
      return {
        allowed: false,
        remaining: 0,
        waitMs: Math.ceil(((1 - b.tokens) / b.refillRate) * 1000),
        reason: 'Burst limit',
      };
    return { allowed: true, remaining: Math.floor(b.tokens), waitMs: 0 };
  }

  consume(connectorId: string) {
    const b = this.buckets.get(connectorId);
    if (b) {
      b.tokens = Math.max(0, b.tokens - 1);
      b.minuteCount++;
      b.hourCount++;
    }
  }

  getStats(connectorId: string) {
    const b = this.buckets.get(connectorId);
    if (!b) return null;
    this._refill(b);
    return {
      tokensRemaining: Math.floor(b.tokens),
      maxPerMinute: b.maxPerMinute,
      maxPerHour: b.maxPerHour,
      minuteUsed: b.minuteCount,
      hourUsed: b.hourCount,
    };
  }

  getAllStats() {
    const s: Record<string, any> = {};
    for (const [id] of this.buckets) s[id] = this.getStats(id);
    return s;
  }

  private _refill(b: Bucket) {
    const elapsed = (Date.now() - b.lastRefill) / 1000;
    b.tokens = Math.min(b.maxTokens, b.tokens + elapsed * b.refillRate);
    b.lastRefill = Date.now();
  }
}

// ── Circuit Breaker ─────────────────────────────────────────
interface Circuit {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  failureThreshold: number;
  resetTimeout: number;
  lastFailure: number | null;
  openedAt: number | null;
  totalFailures: number;
  totalSuccesses: number;
  halfOpenAttempts: number;
  halfOpenMax: number;
}

@Injectable()
export class CircuitBreaker {
  private circuits = new Map<string, Circuit>();

  init(connectorId: string, opts: { failureThreshold?: number; resetTimeout?: number } = {}) {
    this.circuits.set(connectorId, {
      state: 'closed',
      failureCount: 0,
      successCount: 0,
      failureThreshold: opts.failureThreshold ?? 5,
      resetTimeout: opts.resetTimeout ?? 30000,
      lastFailure: null,
      openedAt: null,
      totalFailures: 0,
      totalSuccesses: 0,
      halfOpenAttempts: 0,
      halfOpenMax: 2,
    });
  }

  canExecute(connectorId: string): {
    allowed: boolean;
    state: string;
    reason?: string;
    retryAfterMs?: number;
  } {
    const c = this.circuits.get(connectorId);
    if (!c) return { allowed: true, state: 'closed' };
    if (c.state === 'closed') return { allowed: true, state: 'closed' };
    if (c.state === 'open') {
      const elapsed = Date.now() - (c.openedAt || 0);
      if (elapsed >= c.resetTimeout) {
        c.state = 'half-open';
        c.halfOpenAttempts = 0;
        return { allowed: true, state: 'half-open' };
      }
      return {
        allowed: false,
        state: 'open',
        retryAfterMs: c.resetTimeout - elapsed,
        reason: `Circuit open: ${c.failureCount} failures`,
      };
    }
    if (c.state === 'half-open' && c.halfOpenAttempts < c.halfOpenMax)
      return { allowed: true, state: 'half-open' };
    return { allowed: false, state: c.state, reason: 'Half-open attempts exhausted' };
  }

  recordSuccess(connectorId: string) {
    const c = this.circuits.get(connectorId);
    if (!c) return;
    c.totalSuccesses++;
    if (c.state === 'half-open') {
      c.successCount++;
      if (c.successCount >= 2) {
        c.state = 'closed';
        c.failureCount = 0;
        c.successCount = 0;
      }
    } else c.failureCount = 0;
  }

  recordFailure(connectorId: string) {
    const c = this.circuits.get(connectorId);
    if (!c) return;
    c.totalFailures++;
    c.failureCount++;
    c.lastFailure = Date.now();
    if (c.state === 'half-open') {
      c.state = 'open';
      c.openedAt = Date.now();
    } else if (c.failureCount >= c.failureThreshold) {
      c.state = 'open';
      c.openedAt = Date.now();
    }
  }

  getState(connectorId: string) {
    const c = this.circuits.get(connectorId);
    if (!c) return null;
    return {
      state: c.state,
      failureCount: c.failureCount,
      failureThreshold: c.failureThreshold,
      totalFailures: c.totalFailures,
      totalSuccesses: c.totalSuccesses,
      lastFailure: c.lastFailure,
    };
  }

  getAllStates() {
    const s: Record<string, any> = {};
    for (const [id] of this.circuits) s[id] = this.getState(id);
    return s;
  }
}

// ── Call Logger ──────────────────────────────────────────────
export interface CallLogEntry {
  id: string;
  timestamp: string;
  connector_id: string;
  connector_name: string;
  protocol: string;
  action: string;
  success: boolean;
  duration_ms: number;
  error?: string;
  tenant_id: string;
  cost_estimate: number;
}

@Injectable()
export class CallLogger {
  private logs: CallLogEntry[] = [];
  private maxEntries = 10000;

  log(entry: Omit<CallLogEntry, 'id' | 'timestamp'>) {
    this.logs.push({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...entry });
    if (this.logs.length > this.maxEntries) this.logs = this.logs.slice(-this.maxEntries);
  }

  query(
    opts: {
      connector_id?: string;
      tenant_id?: string;
      success?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    let results = [...this.logs];
    if (opts.connector_id) results = results.filter((l) => l.connector_id === opts.connector_id);
    if (opts.tenant_id) results = results.filter((l) => l.tenant_id === opts.tenant_id);
    if (opts.success !== undefined) results = results.filter((l) => l.success === opts.success);
    const total = results.length;
    return {
      total,
      logs: results.reverse().slice(opts.offset || 0, (opts.offset || 0) + (opts.limit || 100)),
    };
  }

  getStats(connectorId: string, periodMinutes = 60) {
    const since = new Date(Date.now() - periodMinutes * 60000).toISOString();
    const r = this.logs.filter((l) => l.connector_id === connectorId && l.timestamp >= since);
    if (!r.length)
      return {
        totalCalls: 0,
        successRate: 0,
        avgDuration: 0,
        errorCount: 0,
        totalCost: 0,
        period: `${periodMinutes}min`,
      };
    const ok = r.filter((l) => l.success);
    const dur = r.reduce((s, l) => s + l.duration_ms, 0);
    const cost = r.reduce((s, l) => s + l.cost_estimate, 0);
    return {
      totalCalls: r.length,
      successRate: Math.round((ok.length / r.length) * 100),
      avgDuration: Math.round(dur / r.length),
      errorCount: r.length - ok.length,
      totalCost: Math.round(cost * 1000) / 1000,
      period: `${periodMinutes}min`,
    };
  }

  getAllStats(periodMinutes = 60) {
    const since = new Date(Date.now() - periodMinutes * 60000).toISOString();
    const r = this.logs.filter((l) => l.timestamp >= since);
    const byConn: Record<string, any> = {};
    r.forEach((l) => {
      if (!byConn[l.connector_id])
        byConn[l.connector_id] = {
          name: l.connector_name,
          calls: 0,
          successes: 0,
          errors: 0,
          totalDuration: 0,
          totalCost: 0,
        };
      const b = byConn[l.connector_id];
      b.calls++;
      if (l.success) b.successes++;
      else b.errors++;
      b.totalDuration += l.duration_ms;
      b.totalCost += l.cost_estimate;
    });
    const bucketSize = periodMinutes <= 60 ? 5 : 60;
    const timeSeries: any[] = [];
    for (let m = periodMinutes; m > 0; m -= bucketSize) {
      const s = new Date(Date.now() - m * 60000).toISOString();
      const e = new Date(Date.now() - (m - bucketSize) * 60000).toISOString();
      const bl = r.filter((l) => l.timestamp >= s && l.timestamp < e);
      timeSeries.push({
        time: s.substring(11, 16),
        calls: bl.length,
        errors: bl.filter((l) => !l.success).length,
      });
    }
    return {
      summary: {
        totalCalls: r.length,
        successRate: r.length
          ? Math.round((r.filter((l) => l.success).length / r.length) * 100)
          : 0,
        avgDuration: r.length ? Math.round(r.reduce((s, l) => s + l.duration_ms, 0) / r.length) : 0,
        totalCost: Math.round(r.reduce((s, l) => s + l.cost_estimate, 0) * 1000) / 1000,
        totalErrors: r.filter((l) => !l.success).length,
      },
      byConnector: Object.entries(byConn).map(([id, b]: [string, any]) => ({
        connector_id: id,
        connector_name: b.name,
        calls: b.calls,
        successRate: Math.round((b.successes / b.calls) * 100),
        avgDuration: Math.round(b.totalDuration / b.calls),
        errors: b.errors,
        cost: Math.round(b.totalCost * 1000) / 1000,
      })),
      timeSeries,
      period: `${periodMinutes}min`,
    };
  }
}

// ── Runtime Dispatcher ──────────────────────────────────────
@Injectable()
export class RuntimeDispatcher {
  private readonly logger = new Logger(RuntimeDispatcher.name);

  constructor(
    private readonly secrets: SecretsManager,
    private readonly lifecycle: LifecycleManager,
  ) {}

  async dispatch(
    connector: { id: string; key: string; name: string; type: string; configJson: any },
    action: string,
    params: Record<string, any> = {},
  ): Promise<{ success: boolean; data: any; duration_ms: number; error?: string }> {
    const config = this.secrets.decryptConfig((connector.configJson as Record<string, any>) || {});
    const protocol = connector.type.toUpperCase();
    const start = Date.now();

    try {
      let result: any;
      switch (protocol) {
        case 'MCP_SERVER':
          result = await this._dispatchMCP(connector.id, config, action, params);
          break;
        case 'REST_API':
        case 'AGENT':
          result = await this._dispatchREST(config, action, params);
          break;
        case 'WEBHOOK':
          result = await this._dispatchWebhook(config, action, params);
          break;
        default:
          result = await this._dispatchREST(config, action, params);
      }
      return { success: true, data: result, duration_ms: Date.now() - start };
    } catch (err: any) {
      return { success: false, data: {}, duration_ms: Date.now() - start, error: err.message };
    }
  }

  private async _dispatchMCP(
    connectorId: string,
    config: Record<string, any>,
    action: string,
    params: Record<string, any>,
  ) {
    let client = this.lifecycle.getClient(connectorId);
    if (!client || client.status !== 'connected') {
      await this.lifecycle.start(connectorId, config);
      client = this.lifecycle.getClient(connectorId);
    }
    if (!client || client.status !== 'connected')
      throw new Error('Failed to connect to MCP server');
    return client.callTool(action, params);
  }

  private async _dispatchREST(
    config: Record<string, any>,
    action: string,
    params: Record<string, any>,
  ): Promise<any> {
    const baseUrl = config.endpoint || config.base_url || config.url;
    if (!baseUrl) throw new Error('No endpoint configured');
    const url = new URL(action.startsWith('/') ? action : `/${action}`, baseUrl);
    // SSRF guard (H-1) + DNS-rebinding pin.
    const restIps = (await resolveValidatedExternalIps(url.toString())).ips;
    const method = (config.method || 'POST').toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    };
    if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`;
    else if (config.auth_token) headers['Authorization'] = `Bearer ${config.auth_token}`;

    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const body = method !== 'GET' ? JSON.stringify(params) : null;
      if (method === 'GET')
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const req = mod.request(
        url,
        {
          method,
          headers: body
            ? { ...headers, 'Content-Length': String(Buffer.byteLength(body!)) }
            : headers,
          timeout: 30000,
          lookup: pinnedLookup(restIps),
          servername: url.hostname,
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => {
            data += c;
          });
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
            } catch {
              resolve({ statusCode: res.statusCode, data });
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      if (body) req.write(body);
      req.end();
    });
  }

  private async _dispatchWebhook(
    config: Record<string, any>,
    action: string,
    params: Record<string, any>,
  ): Promise<any> {
    const webhookUrl = config.webhook_url || config.endpoint;
    if (!webhookUrl) throw new Error('No webhook URL configured');
    // SSRF guard (H-1) + DNS-rebinding pin.
    const webhookIps = (await resolveValidatedExternalIps(webhookUrl)).ips;
    const url = new URL(webhookUrl);
    const body = JSON.stringify({
      action,
      params,
      source: 'metis-ai',
      timestamp: new Date().toISOString(),
    });
    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            ...(config.secret ? { 'X-Webhook-Secret': config.secret } : {}),
          },
          timeout: 10000,
          lookup: pinnedLookup(webhookIps),
          servername: url.hostname,
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => {
            data += c;
          });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              accepted: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            });
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Webhook timeout'));
      });
      req.write(body);
      req.end();
    });
  }
}

// ── Schema Discovery ────────────────────────────────────────
@Injectable()
export class SchemaDiscovery {
  constructor(
    private readonly lifecycle: LifecycleManager,
    private readonly dispatcher: RuntimeDispatcher,
  ) {}

  async discover(connector: {
    id: string;
    type: string;
    configJson: any;
  }): Promise<{ capabilities: any[]; source: string }> {
    const protocol = connector.type.toUpperCase();
    if (protocol === 'MCP_SERVER') {
      const client = this.lifecycle.getClient(connector.id);
      if (client?.status === 'connected') {
        return {
          capabilities: client.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            type: 'mcp_tool',
          })),
          source: 'mcp_tools_list',
        };
      }
      return { capabilities: [], source: 'mcp_not_connected' };
    }
    if (protocol === 'WEBHOOK') {
      return {
        capabilities: [
          { name: 'webhook_trigger', description: 'Send webhook event', type: 'webhook' },
        ],
        source: 'static',
      };
    }
    return { capabilities: [], source: 'manual' };
  }
}

// ── Test Pipeline ───────────────────────────────────────────
@Injectable()
export class TestPipeline {
  constructor(
    private readonly secrets: SecretsManager,
    private readonly lifecycle: LifecycleManager,
  ) {}

  async run(connector: {
    id: string;
    key: string;
    name: string;
    type: string;
    configJson: any;
  }): Promise<any> {
    const config = this.secrets.decryptConfig((connector.configJson as Record<string, any>) || {});
    const protocol = connector.type.toUpperCase();
    const steps: any[] = [];
    const startTime = Date.now();

    // Step 1: Config validation
    const issues: string[] = [];
    if (['MCP_SERVER'].includes(protocol) && !config.command && !config.endpoint)
      issues.push('No command or endpoint');
    if (['REST_API', 'AGENT'].includes(protocol) && !config.endpoint && !config.base_url)
      issues.push('No endpoint');
    if (protocol === 'WEBHOOK' && !config.webhook_url && !config.endpoint)
      issues.push('No webhook URL');
    steps.push({
      step: 'config_validation',
      label: '설정 검증',
      status: issues.length ? 'warn' : 'pass',
      details: issues.length ? issues.join('; ') : 'Valid',
      duration_ms: Date.now() - startTime,
    });

    // Step 2: Connectivity
    const s2 = Date.now();
    if (protocol === 'MCP_SERVER' && config.transport !== 'sse') {
      steps.push({
        step: 'connectivity',
        label: '네트워크 연결',
        status: 'pass',
        details: `Command "${config.command || 'npx'}" will be spawned`,
        duration_ms: Date.now() - s2,
      });
    } else {
      const endpoint = config.endpoint || config.base_url || config.webhook_url;
      if (endpoint) {
        try {
          await assertExternalUrl(endpoint); // SSRF guard (H-1)
          const url = new URL(endpoint);
          const mod = url.protocol === 'https:' ? https : http;
          await new Promise((resolve, reject) => {
            const r = mod.request(url, { method: 'HEAD', timeout: 5000 }, resolve);
            r.on('error', reject);
            r.on('timeout', () => {
              r.destroy();
              reject(new Error('Timeout'));
            });
            r.end();
          });
          steps.push({
            step: 'connectivity',
            label: '네트워크 연결',
            status: 'pass',
            details: `Reachable: ${endpoint}`,
            duration_ms: Date.now() - s2,
          });
        } catch (e: any) {
          steps.push({
            step: 'connectivity',
            label: '네트워크 연결',
            status: 'fail',
            details: e.message,
            duration_ms: Date.now() - s2,
          });
        }
      } else {
        steps.push({
          step: 'connectivity',
          label: '네트워크 연결',
          status: 'warn',
          details: 'No endpoint to test',
          duration_ms: Date.now() - s2,
        });
      }
    }

    // Step 3: Authentication
    const hasAuth = config.api_key || config.auth_token || config.token || config.secret;
    steps.push({
      step: 'authentication',
      label: '인증 확인',
      status: hasAuth ? 'pass' : 'warn',
      details: hasAuth ? 'Credentials present' : 'No credentials (may be OK)',
      duration_ms: 1,
    });

    // Step 4: Discovery
    const s4 = Date.now();
    const client = this.lifecycle.getClient(connector.id);
    if (client?.status === 'connected') {
      steps.push({
        step: 'discovery',
        label: '스키마 탐색',
        status: 'pass',
        details: `${client.tools.length} tools discovered`,
        duration_ms: Date.now() - s4,
      });
    } else {
      steps.push({
        step: 'discovery',
        label: '스키마 탐색',
        status: 'warn',
        details: 'Server not running',
        duration_ms: Date.now() - s4,
      });
    }

    // Step 5: Invoke test
    steps.push({
      step: 'invoke_test',
      label: '호출 테스트',
      status: client?.status === 'connected' ? 'pass' : 'warn',
      details:
        client?.status === 'connected' ? `Ready (${client.tools.length} tools)` : 'Not connected',
      duration_ms: 1,
    });

    const passed = steps.filter((s) => s.status === 'pass').length;
    const failed = steps.filter((s) => s.status === 'fail').length;
    return {
      connector_id: connector.id,
      connector_name: connector.name,
      protocol,
      steps,
      overall:
        failed > 0
          ? 'fail'
          : steps.some((s) => s.status === 'warn')
            ? 'pass_with_warnings'
            : 'pass',
      passed,
      failed,
      total_duration_ms: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
