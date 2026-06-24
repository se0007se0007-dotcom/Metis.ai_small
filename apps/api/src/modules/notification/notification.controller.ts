/**
 * Notification Controller — REST API for notification dispatch and recipient preview
 */
import { Controller, Post, Get, Body, Query, Req, HttpCode, Logger } from '@nestjs/common';
import { NotificationService, NotifyRequest, NotifyResult } from './notification.service';

@Controller('api/notifications')
export class NotificationController {
  private readonly logger = new Logger(NotificationController.name);

  constructor(private readonly notificationService: NotificationService) {}

  /**
   * POST /api/notifications/send — Send a notification
   */
  @Post('send')
  @HttpCode(200)
  async send(@Body() body: NotifyRequest, @Req() req: any): Promise<NotifyResult> {
    // Extract tenant context from JWT (or use fallback for development)
    const ctx = req.user || { tenantId: 'default', userId: 'system', role: 'PLATFORM_ADMIN' };
    return this.notificationService.send(ctx, body);
  }

  /**
   * GET /api/notifications/recipients/preview — Preview resolved recipients
   * Query params: recipientType, customEmails (comma-separated)
   */
  @Get('recipients/preview')
  async previewRecipients(
    @Query('recipientType') recipientType: string,
    @Query('customEmails') customEmails: string,
    @Req() req: any,
  ): Promise<{ emails: string[]; names: string[]; count: number }> {
    const ctx = req.user || { tenantId: 'default', userId: 'system', role: 'PLATFORM_ADMIN' };
    const emails = customEmails ? customEmails.split(',').map((e) => e.trim()) : undefined;
    return this.notificationService.previewRecipients(ctx, recipientType || 'me', emails);
  }
}
