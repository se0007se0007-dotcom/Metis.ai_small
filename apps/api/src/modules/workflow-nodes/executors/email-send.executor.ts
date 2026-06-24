/**
 * Email Send Executor
 *
 * Sends emails via SMTP as a workflow delivery node.
 * Wraps the EmailService for pipeline integration.
 * Supports HTML/plain text, CC/BCC, and template variables.
 *
 * Registers as connector: metis-email-send
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
} from '../node-executor-registry';
import { EmailService, SmtpConfig } from '../../email/email.service';

@Injectable()
export class EmailSendExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'email-send';
  readonly displayName = '이메일 발송';
  readonly handledNodeTypes = ['email-send'];
  readonly handledCategories = ['delivery'];

  private readonly logger = new Logger(EmailSendExecutor.name);

  constructor(
    private readonly registry: NodeExecutorRegistry,
    private readonly emailService: EmailService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;

    try {
      // Build recipients list
      const toRecipients = settings.to || settings.recipients || settings.emailTo || '';
      if (!toRecipients) {
        // No recipient configured — skip email gracefully (common in demo/template workflows)
        this.logger.warn(
          `Email node "${input.nodeName}" has no recipients configured. Skipping send.`,
        );
        return {
          success: true,
          data: { skipped: true, reason: 'no_recipient_configured' },
          outputText:
            `📧 이메일 발송 스킵: 수신자(to)가 설정되지 않았습니다.\n` +
            `워크플로우 빌더에서 알림 노드의 설정에 수신자 이메일을 입력해주세요.\n` +
            `\n이전 단계 결과는 그대로 전달됩니다.\n` +
            (input.previousOutput ? `\n${input.previousOutput}` : ''),
          durationMs: Date.now() - start,
        };
      }

      // Build subject with template variables
      let subject = settings.subject || settings.emailSubject || 'Metis.AI 워크플로우 결과';
      subject = this.replaceTemplateVars(subject, input);

      // Build body with template variables
      let body = settings.body || settings.emailBody || settings.messageTemplate || '';
      if (!body && input.previousOutput) {
        // Default: use previous node output as body
        body = `워크플로우 실행 결과\n\n${input.previousOutput}`;
      }
      body = this.replaceTemplateVars(body, input);

      const isHtml =
        settings.html !== false &&
        (settings.html === true ||
          settings.format === 'html' ||
          (body.includes('<') && body.includes('>')));

      // Build SMTP config from node settings (if provided)
      let smtpConfig: SmtpConfig | undefined;
      if (settings.smtpHost) {
        smtpConfig = {
          host: settings.smtpHost,
          port: parseInt(settings.smtpPort || '587', 10),
          secure: settings.smtpSecure === true || settings.smtpSecure === 'true',
          user: settings.smtpUser || '',
          pass: settings.smtpPass || '',
          fromName: settings.fromName || 'Metis.AI',
          fromEmail: settings.fromEmail || settings.smtpUser || '',
        };
      }

      // Send the email
      const result = await this.emailService.sendEmail({
        to: toRecipients,
        subject,
        body: isHtml ? this.wrapHtml(body, subject) : body,
        cc: settings.cc || undefined,
        bcc: settings.bcc || undefined,
        html: isHtml,
        smtpConfig,
      });

      if (!result.success) {
        throw new Error(result.error || '이메일 발송 실패');
      }

      return {
        success: true,
        data: {
          messageId: result.messageId,
          recipient: toRecipients,
          subject,
          timestamp: result.timestamp,
          html: isHtml,
        },
        outputText:
          `📧 이메일 발송 완료\n` +
          `수신자: ${toRecipients}\n` +
          `제목: ${subject}\n` +
          `형식: ${isHtml ? 'HTML' : '텍스트'}\n` +
          `Message-ID: ${result.messageId || '(없음)'}\n` +
          `시각: ${result.timestamp}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.logger.error(`Email send failed: ${errorMsg}`);

      return {
        success: false,
        data: { recipient: settings.to || settings.recipients || '' },
        outputText: '',
        durationMs: Date.now() - start,
        error: errorMsg,
      };
    }
  }

  private replaceTemplateVars(template: string, input: NodeExecutionInput): string {
    return template
      .replace(/\{\{summary\}\}/g, input.previousOutput?.slice(0, 3000) || '(결과 없음)')
      .replace(/\{\{details\}\}/g, input.previousOutput || '')
      .replace(/\{\{timestamp\}\}/g, new Date().toLocaleString('ko-KR'))
      .replace(/\{\{nodeName\}\}/g, input.nodeName)
      .replace(/\{\{sessionId\}\}/g, input.executionSessionId)
      .replace(/\{\{output\}\}/g, input.previousOutput || '');
  }

  private wrapHtml(body: string, title: string): string {
    // If body already has HTML structure, return as-is
    if (body.toLowerCase().includes('<html') || body.toLowerCase().includes('<!doctype')) {
      return body;
    }

    // Wrap plain text or simple HTML in a styled email template
    const bodyContent = body.includes('<') ? body : body.replace(/\n/g, '<br>');

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="border-bottom: 3px solid #3182ce; padding-bottom: 12px; margin-bottom: 20px;">
    <h2 style="margin: 0; color: #1a365d;">${title}</h2>
    <p style="margin: 4px 0 0; color: #718096; font-size: 13px;">Metis.AI 워크플로우 자동 발송</p>
  </div>
  <div style="line-height: 1.7; font-size: 14px;">
    ${bodyContent}
  </div>
  <div style="margin-top: 30px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #a0aec0;">
    이 메일은 Metis.AI 워크플로우에 의해 자동 발송되었습니다.
  </div>
</body>
</html>`;
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-email-send',
      name: '이메일 발송',
      type: 'BUILT_IN',
      description: 'SMTP를 통해 워크플로우 결과를 이메일로 발송합니다. HTML 및 텍스트 형식 지원.',
      category: 'delivery',
      inputSchema: {
        to: { type: 'string', description: '수신자 이메일 (콤마 구분)' },
        subject: { type: 'string', description: '메일 제목' },
        body: { type: 'string', description: '메일 본문 (템플릿 변수 사용 가능)' },
        cc: { type: 'string', description: 'CC 수신자' },
        bcc: { type: 'string', description: 'BCC 수신자' },
        html: { type: 'boolean', description: 'HTML 형식 여부' },
        smtpHost: { type: 'string', description: 'SMTP 호스트 (미설정 시 환경변수 사용)' },
      },
      outputSchema: {
        messageId: { type: 'string' },
        recipient: { type: 'string' },
        timestamp: { type: 'string' },
      },
      capabilities: ['smtp-send', 'html-email', 'template-vars', 'cc-bcc'],
    };
  }
}
