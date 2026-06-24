/**
 * Schedule Executor
 *
 * Handles schedule/trigger nodes in the workflow pipeline.
 * In dev mode, these nodes simply pass through (the schedule itself
 * is handled at the workflow-level trigger, not per-execution).
 *
 * Registers as connector: metis-schedule
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
} from '../node-executor-registry';

@Injectable()
export class ScheduleExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'schedule';
  readonly displayName = '스케줄 트리거';
  readonly handledNodeTypes = ['schedule'];
  readonly handledCategories = ['schedule', 'trigger'];

  private readonly logger = new Logger(ScheduleExecutor.name);

  constructor(private readonly registry: NodeExecutorRegistry) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;

    // Extract schedule configuration
    const cronExpr = settings.cronExpression || settings.cron || '0 9 * * *';
    const scheduleLabel = settings.scheduleLabel || settings.label || '매일 09:00';
    const timezone = settings.timezone || 'Asia/Seoul';

    this.logger.log(
      `Schedule node triggered: ${scheduleLabel} (cron: ${cronExpr}, tz: ${timezone})`,
    );

    // Schedule nodes act as trigger/pass-through in execution context.
    // The actual scheduling (cron job creation) is managed at the workflow level.
    // During manual execution, this node simply passes through with metadata.
    const now = new Date();
    const nextRun = this.calculateNextRun(cronExpr);

    return {
      success: true,
      data: {
        scheduleType: settings.scheduleType || 'cron',
        cronExpression: cronExpr,
        timezone,
        label: scheduleLabel,
        triggeredAt: now.toISOString(),
        nextRunAt: nextRun,
        manualTrigger: true,
      },
      outputText:
        `⏱️ 스케줄 트리거 실행됨\n` +
        `스케줄: ${scheduleLabel}\n` +
        `Cron: ${cronExpr}\n` +
        `시간대: ${timezone}\n` +
        `실행 시각: ${now.toLocaleString('ko-KR', { timeZone: timezone })}\n` +
        `다음 예정: ${nextRun}\n` +
        `\n다음 노드로 파이프라인을 진행합니다.`,
      durationMs: Date.now() - start,
    };
  }

  private calculateNextRun(cron: string): string {
    // Simple next-run estimation for common patterns
    try {
      const parts = cron.split(/\s+/);
      if (parts.length >= 5) {
        const [min, hour] = parts;
        const now = new Date();
        const next = new Date(now);
        next.setHours(parseInt(hour) || 9, parseInt(min) || 0, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        return next.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      }
    } catch {
      /* fallback */
    }
    return '(계산 불가)';
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-schedule',
      name: '스케줄 트리거',
      type: 'BUILT_IN',
      description: 'Cron 또는 인터벌 기반 워크플로우 트리거. 수동 실행 시에는 즉시 통과합니다.',
      category: 'trigger',
      inputSchema: {
        cronExpression: { type: 'string', description: 'Cron 표현식 (예: 0 9 * * *)' },
        timezone: { type: 'string', description: '시간대 (기본: Asia/Seoul)' },
        scheduleLabel: { type: 'string', description: '스케줄 라벨' },
      },
      outputSchema: {
        triggeredAt: { type: 'string' },
        nextRunAt: { type: 'string' },
        manualTrigger: { type: 'boolean' },
      },
      capabilities: ['cron-trigger', 'interval-trigger', 'manual-trigger'],
    };
  }
}
