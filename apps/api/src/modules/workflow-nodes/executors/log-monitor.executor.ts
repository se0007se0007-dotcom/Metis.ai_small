/**
 * Log Monitor Executor
 *
 * Collects and analyzes logs from various sources.
 * Supports pattern matching, error detection, and statistics.
 *
 * Registers as connector: metis-log-monitor
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as child_process from 'child_process';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
} from '../node-executor-registry';

@Injectable()
export class LogMonitorExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'log-monitor';
  readonly displayName = '로그 모니터링 / 수집';
  readonly handledNodeTypes = ['log-monitor'];
  readonly handledCategories = ['monitor'];

  private readonly logger = new Logger(LogMonitorExecutor.name);

  constructor(private readonly registry: NodeExecutorRegistry) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;
    const logSource = settings.logSource || 'server';

    try {
      let logData: LogEntry[];

      switch (logSource) {
        case 'server':
          logData = await this.collectServerLogs(settings);
          break;
        case 'application':
          logData = await this.collectAppLogs(settings);
          break;
        case 'cloud':
          logData = await this.collectCloudLogs(settings);
          break;
        default:
          logData = await this.collectCustomLogs(settings);
      }

      // Filter by log levels
      const levels: string[] = settings.logLevels || ['ERROR', 'WARN'];
      const filtered = logData.filter((l) => levels.includes(l.level));

      // Pattern matching
      const alertPattern = settings.alertPattern ? new RegExp(settings.alertPattern, 'gi') : null;
      const alerts = alertPattern ? filtered.filter((l) => alertPattern.test(l.message)) : [];

      // Generate statistics
      const stats = {
        totalEntries: logData.length,
        filteredEntries: filtered.length,
        alertCount: alerts.length,
        byLevel: {} as Record<string, number>,
        errorRate: 0,
      };

      for (const entry of logData) {
        stats.byLevel[entry.level] = (stats.byLevel[entry.level] || 0) + 1;
      }
      stats.errorRate =
        logData.length > 0 ? ((stats.byLevel['ERROR'] || 0) / logData.length) * 100 : 0;

      // 실제 수집 실패/미설정으로 데모 샘플이 사용됐는지 판정 → 결과에 명시.
      const isDemo = logData.length > 0 && logData.every((l) => l.source === 'metis-demo');

      const outputText = this.formatOutput(filtered, alerts, stats, isDemo);

      return {
        success: true,
        data: { stats, alertCount: alerts.length, logSource, entryCount: filtered.length, demo: isDemo },
        outputText,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: `로그 수집 실패: ${(err as Error).message}`,
      };
    }
  }

  private async collectServerLogs(settings: Record<string, any>): Promise<LogEntry[]> {
    const endpoint = settings.logEndpoint || '';

    // If endpoint is an SSH connection, use ssh to collect.
    // SECURITY: never build a shell string from user config. Validate the SSH
    // target against a strict [user@]host[:port] allowlist and invoke ssh via
    // execFileSync with an argument array (shell: false) so metacharacters in
    // settings.logEndpoint cannot inject commands.
    if (endpoint.startsWith('ssh://')) {
      const sshTarget = endpoint.replace('ssh://', '').trim();
      const SSH_TARGET_RE = /^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9._-]+(?::[0-9]{1,5})?$/;
      if (!SSH_TARGET_RE.test(sshTarget)) {
        this.logger.warn(`Rejected unsafe SSH target in logEndpoint: "${sshTarget}"`);
      } else {
        try {
          // Optional explicit port → -p flag; host kept separate from the command.
          const [hostPart, portPart] = sshTarget.split(':');
          const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];
          if (portPart) args.push('-p', portPart);
          args.push(hostPart, 'journalctl --no-pager -n 200 --output=json');
          const output = child_process.execFileSync('ssh', args, {
            timeout: 30000,
            encoding: 'utf-8',
          });
          return this.parseJournalctl(output);
        } catch {
          this.logger.warn('SSH log collection failed, using local fallback');
        }
      }
    }

    // Local server logs
    try {
      const output = child_process.execSync(
        'journalctl --no-pager -n 100 --output=json 2>/dev/null || dmesg --json 2>/dev/null || echo "[]"',
        { timeout: 10000, encoding: 'utf-8' },
      );
      return this.parseJournalctl(output);
    } catch {
      // Generate sample data for demo
      return this.generateSampleLogs(50);
    }
  }

  private async collectAppLogs(settings: Record<string, any>): Promise<LogEntry[]> {
    const logPath = settings.logEndpoint || settings.logPath || '';

    if (logPath && require('fs').existsSync(logPath)) {
      const content = require('fs').readFileSync(logPath, 'utf-8');
      return this.parseTextLogs(content);
    }

    return this.generateSampleLogs(30);
  }

  private async collectCloudLogs(settings: Record<string, any>): Promise<LogEntry[]> {
    throw new Error(
      '클라우드 로그 수집은 클라우드 커넥터(CloudWatch, Stackdriver) 설정이 필요합니다.',
    );
  }

  private async collectCustomLogs(settings: Record<string, any>): Promise<LogEntry[]> {
    const endpoint = settings.logEndpoint || '';
    if (!endpoint) throw new Error('로그 소스 엔드포인트가 설정되지 않았습니다.');

    if (endpoint.startsWith('http')) {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`API 오류: ${response.status}`);
      const data = (await response.json()) as any;
      return Array.isArray(data) ? data : [data];
    }

    return this.generateSampleLogs(20);
  }

  private parseJournalctl(output: string): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const line of output.split('\n')) {
      try {
        const j = JSON.parse(line);
        entries.push({
          timestamp: j.__REALTIME_TIMESTAMP
            ? new Date(parseInt(j.__REALTIME_TIMESTAMP) / 1000).toISOString()
            : new Date().toISOString(),
          level: this.mapPriority(j.PRIORITY),
          message: j.MESSAGE || '',
          source: j.SYSLOG_IDENTIFIER || j._COMM || 'unknown',
        });
      } catch {
        /* skip non-JSON lines */
      }
    }
    return entries;
  }

  private parseTextLogs(content: string): LogEntry[] {
    return content
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const level = /ERROR|FATAL/i.test(line)
          ? 'ERROR'
          : /WARN/i.test(line)
            ? 'WARN'
            : /DEBUG/i.test(line)
              ? 'DEBUG'
              : 'INFO';
        return { timestamp: new Date().toISOString(), level, message: line, source: 'file' };
      });
  }

  private generateSampleLogs(count: number): LogEntry[] {
    const levels = ['ERROR', 'WARN', 'INFO', 'INFO', 'INFO', 'DEBUG'];
    const messages = [
      'Connection refused to database server',
      'OutOfMemoryError: Java heap space',
      'Request timeout after 30000ms',
      'HTTP 503 Service Unavailable',
      'Disk usage exceeded 90% threshold',
      'Successfully processed batch of 1000 records',
      'Authentication token expired for user',
      'Cache miss ratio above 40%',
      'Scheduled backup completed',
      'SSL certificate renewal pending (7 days)',
    ];
    return Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(Date.now() - i * 60000).toISOString(),
      level: levels[Math.floor(Math.random() * levels.length)],
      message: messages[Math.floor(Math.random() * messages.length)],
      // 실제 로그가 아니라 데모 샘플임을 명확히 표시 — 실데이터로 오인 방지.
      source: 'metis-demo',
    }));
  }

  private mapPriority(p: string | number): string {
    const n = typeof p === 'string' ? parseInt(p) : p;
    if (n <= 3) return 'ERROR';
    if (n === 4) return 'WARN';
    if (n <= 6) return 'INFO';
    return 'DEBUG';
  }

  private formatOutput(entries: LogEntry[], alerts: LogEntry[], stats: any, isDemo = false): string {
    const lines = [
      ...(isDemo
        ? ['⚠️ [데모 데이터] 실제 로그 소스에 연결하지 못해 샘플 로그를 표시합니다. (실데이터 아님)', '']
        : []),
      '=== 로그 모니터링 결과 ===',
      `총 수집: ${stats.totalEntries}건 | 필터 결과: ${stats.filteredEntries}건 | 알림: ${stats.alertCount}건`,
      `에러율: ${stats.errorRate.toFixed(1)}%`,
      '',
      '--- 레벨별 분포 ---',
      ...Object.entries(stats.byLevel as Record<string, number>).map(([k, v]) => `  ${k}: ${v}건`),
    ];

    if (alerts.length > 0) {
      lines.push('', '--- 🚨 패턴 매칭 알림 ---');
      for (const a of alerts.slice(0, 20)) {
        lines.push(`  [${a.level}] ${a.timestamp} ${a.message}`);
      }
    }

    lines.push('', '--- 최근 로그 (상위 30건) ---');
    for (const e of entries.slice(0, 30)) {
      lines.push(`  [${e.level}] ${e.timestamp} [${e.source}] ${e.message}`);
    }

    return lines.join('\n');
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-log-monitor',
      name: '로그 모니터링 / 수집',
      type: 'BUILT_IN',
      description: '서버, 애플리케이션, 클라우드 로그를 수집하고 에러 패턴을 분석합니다.',
      category: 'monitor',
      inputSchema: {
        logSource: { type: 'string', enum: ['server', 'application', 'cloud', 'custom'] },
        logLevels: { type: 'array' },
        alertPattern: { type: 'string' },
        errorThreshold: { type: 'number' },
      },
      outputSchema: {
        stats: { type: 'object' },
        entries: { type: 'array' },
        alerts: { type: 'array' },
      },
      capabilities: ['server-logs', 'app-logs', 'pattern-match', 'error-detection', 'statistics'],
    };
  }
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  source: string;
}
