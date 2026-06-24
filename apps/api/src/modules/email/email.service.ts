/**
 * Email Service — SMTP-based email sending for workflow nodes
 *
 * Supports:
 * - SMTP relay (Gmail, Outlook, custom)
 * - Per-tenant SMTP configuration
 * - HTML and plain text emails
 * - CC/BCC recipients
 * - Connection pooling and retries
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName?: string;
  fromEmail?: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
  smtpConfig?: SmtpConfig;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  timestamp: string;
  recipient: string;
  subject: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporterCache: Map<string, nodemailer.Transporter> = new Map();

  constructor(private readonly configService: ConfigService) {}

  /**
   * Create or get cached SMTP transporter
   */
  private getTransporter(config: SmtpConfig): nodemailer.Transporter {
    const cacheKey = `${config.host}:${config.port}:${config.user}`;

    if (this.transporterCache.has(cacheKey)) {
      return this.transporterCache.get(cacheKey)!;
    }

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      tls: {
        rejectUnauthorized: this.configService.get<string>('NODE_ENV') === 'production',
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });

    this.transporterCache.set(cacheKey, transporter);
    return transporter;
  }

  /**
   * Get default SMTP config from environment variables
   */
  private getDefaultSmtpConfig(): SmtpConfig | null {
    const host = this.configService.get<string>('SMTP_HOST');
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');

    if (!host || !user || !pass) {
      return null;
    }

    return {
      host,
      port: parseInt(this.configService.get<string>('SMTP_PORT') || '587', 10),
      secure: this.configService.get<string>('SMTP_SECURE') === 'true',
      user,
      pass,
      fromName: this.configService.get<string>('SMTP_FROM_NAME') || 'Metis.AI',
      fromEmail: this.configService.get<string>('SMTP_FROM_EMAIL') || user,
    };
  }

  /**
   * Verify SMTP connection
   */
  async verifyConnection(config?: SmtpConfig): Promise<{ success: boolean; error?: string }> {
    const smtpConfig = config || this.getDefaultSmtpConfig();
    if (!smtpConfig) {
      return {
        success: false,
        error: 'SMTP 설정이 없습니다. 환경변수 또는 노드 설정을 확인하세요.',
      };
    }

    try {
      const transporter = this.getTransporter(smtpConfig);
      await transporter.verify();
      return { success: true };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`SMTP verify failed: ${msg}`);
      return { success: false, error: `SMTP 연결 실패: ${msg}` };
    }
  }

  /**
   * Send email via SMTP
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const smtpConfig = params.smtpConfig || this.getDefaultSmtpConfig();

    if (!smtpConfig) {
      return {
        success: false,
        error: 'SMTP 설정이 없습니다. SMTP 호스트, 사용자, 비밀번호를 설정하세요.',
        timestamp: new Date().toISOString(),
        recipient: params.to,
        subject: params.subject,
      };
    }

    try {
      const transporter = this.getTransporter(smtpConfig);

      const fromAddress = smtpConfig.fromName
        ? `"${smtpConfig.fromName}" <${smtpConfig.fromEmail || smtpConfig.user}>`
        : smtpConfig.fromEmail || smtpConfig.user;

      const mailOptions: nodemailer.SendMailOptions = {
        from: fromAddress,
        to: params.to,
        subject: params.subject,
        ...(params.html ? { html: params.body } : { text: params.body }),
        ...(params.cc && { cc: params.cc }),
        ...(params.bcc && { bcc: params.bcc }),
      };

      const info = await transporter.sendMail(mailOptions);

      this.logger.log(`Email sent to ${params.to}: ${info.messageId}`);

      return {
        success: true,
        messageId: info.messageId,
        timestamp: new Date().toISOString(),
        recipient: params.to,
        subject: params.subject,
      };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Email send failed: ${msg}`);
      return {
        success: false,
        error: `이메일 발송 실패: ${msg}`,
        timestamp: new Date().toISOString(),
        recipient: params.to,
        subject: params.subject,
      };
    }
  }
}
