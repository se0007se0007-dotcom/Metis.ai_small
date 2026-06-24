/**
 * Slack Executor
 *
 * Sends messages to Slack channels via Webhook or Bot API.
 * Supports rich formatting, attachments, thread replies.
 *
 * Registers as connector: metis-slack
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
export class SlackExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'slack';
  readonly displayName = 'Slack 메시지 전송';
  readonly handledNodeTypes = ['slack-message'];
  readonly handledCategories = ['delivery'];

  private readonly logger = new Logger(SlackExecutor.name);

  constructor(private readonly registry: NodeExecutorRegistry) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;
    const connectType = settings.slackConnectType || 'webhook';

    // 설정(노드) → 환경변수 순으로 자격증명 확보.
    const webhook = settings.slackWebhook || process.env.SLACK_WEBHOOK_URL || '';
    const token = settings.slackToken || process.env.SLACK_BOT_TOKEN || '';

    // 미설정 시 throw 대신 graceful skip(성공+skipped) — 노드 개별 테스트가 하드 실패하지 않도록.
    const unconfigured =
      (connectType === 'webhook' && !webhook) || (connectType !== 'webhook' && !token);
    if (unconfigured) {
      return {
        success: true,
        data: { skipped: true, reason: 'slack_unconfigured', connectType },
        outputText:
          `[Slack 미설정 — 건너뜀] ${connectType === 'webhook' ? 'Webhook URL' : 'Bot Token'}이 없어 전송을 건너뛰었습니다.\n` +
          '노드 설정의 slackWebhook/slackToken 또는 환경변수 SLACK_WEBHOOK_URL/SLACK_BOT_TOKEN 을 설정하면 실제 전송됩니다.',
        durationMs: Date.now() - start,
      };
    }

    try {
      let result: { ok: boolean; error?: string; ts?: string };

      // Build message text from template
      const messageText = this.buildMessage(settings, input.previousOutput);

      if (connectType === 'webhook') {
        result = await this.sendViaWebhook(webhook, messageText, settings);
      } else {
        result = await this.sendViaBotApi(token, settings.channel, messageText, settings);
      }

      if (!result.ok) {
        throw new Error(result.error || 'Slack 메시지 전송 실패');
      }

      return {
        success: true,
        data: { channel: settings.channel, messageTs: result.ts, connectType },
        outputText: `Slack 메시지 전송 완료 (${settings.channel || 'webhook'})`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  private buildMessage(settings: Record<string, any>, previousOutput: string): string {
    let template = settings.messageTemplate || '🔔 워크플로우 실행 결과\n\n{{summary}}';

    template = template
      .replace(/\{\{summary\}\}/g, previousOutput?.slice(0, 3000) || '(결과 없음)')
      .replace(/\{\{details\}\}/g, previousOutput || '')
      .replace(/\{\{timestamp\}\}/g, new Date().toLocaleString('ko-KR'))
      .replace(/\{\{link\}\}/g, '(링크)');

    if (settings.mentionUsers) {
      template = '<!here> ' + template;
    }

    return template;
  }

  private async sendViaWebhook(
    webhookUrl: string,
    text: string,
    settings: Record<string, any>,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!webhookUrl) {
      throw new Error('Slack Webhook URL이 설정되지 않았습니다.');
    }

    const payload: any = { text };

    // Add rich attachment if includeAttachment is enabled
    if (settings.includeAttachment) {
      payload.attachments = [
        {
          color: '#3182ce',
          title: 'Metis.AI 워크플로우 결과',
          text: text.slice(0, 7500),
          footer: 'Metis.AI',
          ts: Math.floor(Date.now() / 1000).toString(),
        },
      ];
      payload.text = '🔔 워크플로우 실행 완료';
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `Webhook 오류 (${response.status}): ${body}` };
    }

    return { ok: true };
  }

  private async sendViaBotApi(
    token: string,
    channel: string,
    text: string,
    settings: Record<string, any>,
  ): Promise<{ ok: boolean; error?: string; ts?: string }> {
    if (!token) throw new Error('Slack Bot Token이 설정되지 않았습니다.');
    if (!channel) throw new Error('Slack 채널이 설정되지 않았습니다.');

    const payload: any = {
      channel: channel.startsWith('#') ? channel : `#${channel}`,
      text,
      ...(settings.threadReply && settings.threadTs ? { thread_ts: settings.threadTs } : {}),
    };

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as any;
    return { ok: data.ok, error: data.error, ts: data.ts };
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-slack',
      name: 'Slack 메시지 전송',
      type: 'BUILT_IN',
      description: 'Slack 채널에 워크플로우 결과를 전송합니다. Webhook 또는 Bot API를 지원합니다.',
      category: 'delivery',
      inputSchema: {
        slackWebhook: { type: 'string', description: 'Webhook URL' },
        slackToken: { type: 'string', description: 'Bot Token' },
        channel: { type: 'string' },
        messageTemplate: { type: 'string' },
      },
      outputSchema: {
        messageTs: { type: 'string' },
        channel: { type: 'string' },
      },
      capabilities: ['slack-webhook', 'slack-bot-api', 'rich-messages', 'thread-reply'],
    };
  }
}
