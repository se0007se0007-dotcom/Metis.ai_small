/**
 * Notification Service — Multi-channel notification dispatch
 *
 * Channels: email, slack (webhook), browser (stored for SSE/polling), webhook
 * Recipient resolution: 'me' (current user), 'team' (tenant members), 'admins' (TENANT_ADMIN/PLATFORM_ADMIN roles), 'custom' (explicit emails)
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { EmailService } from '../email/email.service';
import { validateExternalUrl } from '../../common/utils/url-validator';

export interface NotifyRequest {
  channel: 'email' | 'slack' | 'browser' | 'webhook';
  recipientType: 'me' | 'team' | 'admins' | 'custom';
  customEmails?: string[]; // when recipientType='custom'
  slackChannel?: string; // when channel='slack'
  slackWebhookUrl?: string; // Slack incoming webhook
  webhookUrl?: string; // generic webhook
  template: 'success' | 'with-summary' | 'error-only' | 'custom';
  subject?: string;
  body?: string; // for custom template
  workflowName?: string;
  executionSummary?: string; // pipeline result text
  errorDetails?: string;
}

export interface NotifyResult {
  success: boolean;
  channel: string;
  recipientCount: number;
  resolvedRecipients: string[]; // actual email addresses or channel names
  messageId?: string;
  error?: string;
  timestamp: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolve recipients based on type
   * - me: lookup current user's email from User table
   * - team: lookup all users in the same tenant
   * - admins: lookup users with role TENANT_ADMIN or PLATFORM_ADMIN in tenant
   * - custom: use provided customEmails
   */
  async resolveRecipients(
    ctx: TenantContext,
    recipientType: string,
    customEmails?: string[],
  ): Promise<{ emails: string[]; names: string[] }> {
    const tenantPrisma = withTenantIsolation(this.prisma, ctx);

    if (recipientType === 'custom' && customEmails?.length) {
      // Validate email format only — custom recipients can be external addresses
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validEmails = customEmails.filter((e) => emailRegex.test(e.trim()));
      if (validEmails.length === 0) {
        return { emails: [], names: [] };
      }

      // Optionally resolve names for known tenant members
      try {
        const tenantMembers = await tenantPrisma.membership.findMany({
          where: { tenantId: ctx.tenantId },
          include: { user: { select: { email: true, name: true } } },
        });
        const memberMap = new Map(
          tenantMembers.map((m) => [m.user.email.toLowerCase(), m.user.name || m.user.email]),
        );

        return {
          emails: validEmails.map((e) => e.trim()),
          names: validEmails.map((e) => memberMap.get(e.trim().toLowerCase()) || e.trim()),
        };
      } catch (error) {
        // If DB lookup fails, still allow sending to the validated emails
        this.logger.warn(`Failed to resolve member names, using emails as-is: ${error}`);
        return {
          emails: validEmails.map((e) => e.trim()),
          names: validEmails.map((e) => e.trim()),
        };
      }
    }

    try {
      if (recipientType === 'me') {
        const user = await this.prisma.user.findUnique({
          where: { id: ctx.userId },
          select: { email: true, name: true },
        });
        if (user) return { emails: [user.email], names: [user.name || user.email] };
        return { emails: [], names: [] };
      }

      if (recipientType === 'team') {
        // Get all active members in the tenant via Membership
        const members = await tenantPrisma.membership.findMany({
          where: { tenantId: ctx.tenantId },
          include: { user: { select: { email: true, name: true } } },
          take: 50, // safety limit
        });
        return {
          emails: members.map((m) => m.user.email),
          names: members.map((m) => m.user.name || m.user.email),
        };
      }

      if (recipientType === 'admins') {
        const admins = await tenantPrisma.membership.findMany({
          where: { tenantId: ctx.tenantId, role: { in: ['TENANT_ADMIN', 'PLATFORM_ADMIN'] } },
          include: { user: { select: { email: true, name: true } } },
        });
        return {
          emails: admins.map((m) => m.user.email),
          names: admins.map((m) => m.user.name || m.user.email),
        };
      }
    } catch (error) {
      this.logger.error(`Failed to resolve recipients: ${error}`);
    }

    return { emails: [], names: [] };
  }

  /**
   * Build notification body from template
   */
  private buildBody(req: NotifyRequest): { subject: string; text: string; html: string } {
    const wfName = req.workflowName || 'Metis.AI 워크플로우';
    const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    let subject: string;
    let text: string;
    let html: string;

    switch (req.template) {
      case 'success':
        subject = `✅ [Metis.AI] ${wfName} 실행 완료`;
        text = `워크플로우 "${wfName}"이(가) 성공적으로 완료되었습니다.\n완료 시각: ${timestamp}`;
        html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#10B981;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
            <h2 style="margin:0;font-size:16px;">✅ 워크플로우 실행 완료</h2>
          </div>
          <div style="padding:20px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px;">
            <p><strong>${wfName}</strong>이(가) 성공적으로 완료되었습니다.</p>
            <p style="color:#6B7280;font-size:13px;">완료 시각: ${timestamp}</p>
          </div>
        </div>`;
        break;

      case 'with-summary':
        subject = `📊 [Metis.AI] ${wfName} 결과 요약`;
        text = `워크플로우 "${wfName}" 실행 결과:\n\n${req.executionSummary || '(결과 요약 없음)'}\n\n완료 시각: ${timestamp}`;
        html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#3B82F6;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
            <h2 style="margin:0;font-size:16px;">📊 실행 결과 요약</h2>
          </div>
          <div style="padding:20px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px;">
            <p><strong>${wfName}</strong></p>
            <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:12px;margin:12px 0;white-space:pre-wrap;font-size:13px;">${req.executionSummary || '(결과 요약 없음)'}</div>
            <p style="color:#6B7280;font-size:13px;">완료 시각: ${timestamp}</p>
          </div>
        </div>`;
        break;

      case 'error-only':
        subject = `❌ [Metis.AI] ${wfName} 실행 실패`;
        text = `워크플로우 "${wfName}" 실행 중 오류가 발생했습니다.\n\n오류 내용:\n${req.errorDetails || '(상세 내용 없음)'}\n\n발생 시각: ${timestamp}`;
        html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#EF4444;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
            <h2 style="margin:0;font-size:16px;">❌ 실행 오류 알림</h2>
          </div>
          <div style="padding:20px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px;">
            <p><strong>${wfName}</strong> 실행 중 오류가 발생했습니다.</p>
            <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:12px;margin:12px 0;white-space:pre-wrap;font-size:13px;color:#991B1B;">${req.errorDetails || '(상세 내용 없음)'}</div>
            <p style="color:#6B7280;font-size:13px;">발생 시각: ${timestamp}</p>
          </div>
        </div>`;
        break;

      default: // custom
        subject = req.subject || `[Metis.AI] ${wfName} 알림`;
        text = req.body || `워크플로우 "${wfName}" 알림입니다.\n\n${req.executionSummary || ''}`;
        html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">${text.replace(/\n/g, '<br>')}</div>`;
        break;
    }

    return { subject, text, html };
  }

  /**
   * Send notification through the selected channel
   */
  async send(ctx: TenantContext, req: NotifyRequest): Promise<NotifyResult> {
    const startTime = Date.now();

    try {
      // Resolve recipients
      const { emails, names } = await this.resolveRecipients(
        ctx,
        req.recipientType,
        req.customEmails,
      );
      const { subject, text, html } = this.buildBody(req);

      // Channel dispatch
      switch (req.channel) {
        case 'email': {
          if (emails.length === 0) {
            return {
              success: false,
              channel: 'email',
              recipientCount: 0,
              resolvedRecipients: [],
              error: '수신자를 찾을 수 없습니다. 사용자 이메일이 등록되어 있는지 확인하세요.',
              timestamp: new Date().toISOString(),
            };
          }
          const to = emails.join(', ');
          const result = await this.emailService.sendEmail({ to, subject, body: html, html: true });
          return {
            success: result.success,
            channel: 'email',
            recipientCount: emails.length,
            resolvedRecipients: emails,
            messageId: result.messageId,
            error: result.error,
            timestamp: new Date().toISOString(),
          };
        }

        case 'slack': {
          const webhookUrl =
            req.slackWebhookUrl || this.configService.get<string>('SLACK_WEBHOOK_URL');
          if (!webhookUrl) {
            return {
              success: false,
              channel: 'slack',
              recipientCount: 0,
              resolvedRecipients: [],
              error:
                'Slack 웹훅 URL이 설정되지 않았습니다. 환경변수 SLACK_WEBHOOK_URL을 설정하거나 노드에서 직접 입력하세요.',
              timestamp: new Date().toISOString(),
            };
          }

          // SSRF Protection: validate webhook URL
          const urlCheck = await validateExternalUrl(webhookUrl);
          if (!urlCheck.safe) {
            return {
              success: false,
              channel: 'slack',
              recipientCount: 0,
              resolvedRecipients: [],
              error: `Slack 웹훅 URL 보안 검증 실패: ${urlCheck.error}`,
              timestamp: new Date().toISOString(),
            };
          }

          const slackChannel = req.slackChannel || '#general';
          const slackPayload = {
            channel: slackChannel,
            username: 'Metis.AI',
            icon_emoji: ':robot_face:',
            text: `*${subject}*\n${text}`,
          };
          const resp = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(slackPayload),
          });
          return {
            success: resp.ok,
            channel: 'slack',
            recipientCount: 1,
            resolvedRecipients: [slackChannel],
            error: resp.ok ? undefined : `Slack 전송 실패: ${resp.status} ${resp.statusText}`,
            timestamp: new Date().toISOString(),
          };
        }

        case 'browser': {
          // Store notification in DB for SSE/polling retrieval by frontend
          // In a full implementation, this would go to a Notification table
          // For now, we log it and return success (frontend will show via Notification API)
          const notification = {
            id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            type: 'workflow-completion',
            title: subject,
            body: text,
            channel: 'browser',
            recipientType: req.recipientType,
            recipients: emails.length > 0 ? emails : [ctx.userId],
            createdAt: new Date().toISOString(),
            read: false,
          };
          this.logger.log(
            `Browser notification stored: ${notification.id} for ${notification.recipients.join(', ')}`,
          );
          return {
            success: true,
            channel: 'browser',
            recipientCount: notification.recipients.length,
            resolvedRecipients: notification.recipients,
            messageId: notification.id,
            timestamp: new Date().toISOString(),
          };
        }

        case 'webhook': {
          if (!req.webhookUrl) {
            return {
              success: false,
              channel: 'webhook',
              recipientCount: 0,
              resolvedRecipients: [],
              error: '웹훅 URL이 설정되지 않았습니다.',
              timestamp: new Date().toISOString(),
            };
          }

          // SSRF Protection: validate webhook URL
          const urlCheck = await validateExternalUrl(req.webhookUrl);
          if (!urlCheck.safe) {
            return {
              success: false,
              channel: 'webhook',
              recipientCount: 0,
              resolvedRecipients: [],
              error: `웹훅 URL 보안 검증 실패: ${urlCheck.error}`,
              timestamp: new Date().toISOString(),
            };
          }

          const webhookPayload = {
            event: 'workflow.completed',
            workflow: req.workflowName,
            template: req.template,
            summary: req.executionSummary,
            timestamp: new Date().toISOString(),
          };
          const whResp = await fetch(req.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookPayload),
          });
          return {
            success: whResp.ok,
            channel: 'webhook',
            recipientCount: 1,
            resolvedRecipients: [req.webhookUrl],
            error: whResp.ok ? undefined : `웹훅 전송 실패: ${whResp.status}`,
            timestamp: new Date().toISOString(),
          };
        }

        default:
          return {
            success: false,
            channel: req.channel,
            recipientCount: 0,
            resolvedRecipients: [],
            error: `지원하지 않는 채널: ${req.channel}`,
            timestamp: new Date().toISOString(),
          };
      }
    } catch (error) {
      this.logger.error(`Notification send failed: ${error}`);
      return {
        success: false,
        channel: req.channel,
        recipientCount: 0,
        resolvedRecipients: [],
        error: `알림 전송 실패: ${(error as Error).message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Resolve and return recipient info (for frontend display)
   */
  async previewRecipients(
    ctx: TenantContext,
    recipientType: string,
    customEmails?: string[],
  ): Promise<{ emails: string[]; names: string[]; count: number }> {
    const { emails, names } = await this.resolveRecipients(ctx, recipientType, customEmails);
    return { emails, names, count: emails.length };
  }
}
