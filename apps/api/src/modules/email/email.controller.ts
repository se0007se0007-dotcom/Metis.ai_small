/**
 * Email Controller — SMTP email endpoints for workflow nodes
 *
 * Endpoints:
 * - POST /email/send — Send email via SMTP
 * - POST /email/verify — Verify SMTP connection
 */
import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmailService, SmtpConfig } from './email.service';

// ── DTOs ──

export class SmtpConfigDto {
  @ApiProperty({ description: 'SMTP server host', example: 'smtp.gmail.com' })
  @IsString()
  host!: string;

  @ApiPropertyOptional({ description: 'SMTP port', example: 587 })
  @IsOptional()
  @IsNumber()
  port?: number;

  @ApiPropertyOptional({ description: 'Use TLS/SSL', example: false })
  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @ApiProperty({ description: 'SMTP username/email' })
  @IsString()
  user!: string;

  @ApiProperty({ description: 'SMTP password or app password' })
  @IsString()
  pass!: string;

  @ApiPropertyOptional({ description: 'Sender display name' })
  @IsOptional()
  @IsString()
  fromName?: string;

  @ApiPropertyOptional({ description: 'Sender email address' })
  @IsOptional()
  @IsString()
  fromEmail?: string;
}

export class SendEmailDto {
  @ApiProperty({ description: 'Recipient email address' })
  @IsString()
  to!: string;

  @ApiProperty({ description: 'Email subject' })
  @IsString()
  subject!: string;

  @ApiProperty({ description: 'Email body content' })
  @IsString()
  body!: string;

  @ApiPropertyOptional({ description: 'CC recipients' })
  @IsOptional()
  @IsString()
  cc?: string;

  @ApiPropertyOptional({ description: 'BCC recipients' })
  @IsOptional()
  @IsString()
  bcc?: string;

  @ApiPropertyOptional({ description: 'Send as HTML', default: false })
  @IsOptional()
  @IsBoolean()
  html?: boolean;

  @ApiPropertyOptional({ description: 'Custom SMTP config (overrides env defaults)' })
  @IsOptional()
  smtpConfig?: SmtpConfigDto;
}

export class VerifySmtpDto {
  @ApiPropertyOptional({ description: 'Custom SMTP config to verify' })
  @IsOptional()
  smtpConfig?: SmtpConfigDto;
}

// ── Controller ──

@ApiTags('Email')
@ApiBearerAuth()
@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Post('send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send email via SMTP' })
  @ApiResponse({ status: 200, description: 'Email send result' })
  async sendEmail(@Body() dto: SendEmailDto) {
    const smtpConfig: SmtpConfig | undefined = dto.smtpConfig
      ? {
          host: dto.smtpConfig.host,
          port: dto.smtpConfig.port || 587,
          secure: dto.smtpConfig.secure || false,
          user: dto.smtpConfig.user,
          pass: dto.smtpConfig.pass,
          fromName: dto.smtpConfig.fromName,
          fromEmail: dto.smtpConfig.fromEmail,
        }
      : undefined;

    return this.emailService.sendEmail({
      to: dto.to,
      subject: dto.subject,
      body: dto.body,
      cc: dto.cc,
      bcc: dto.bcc,
      html: dto.html,
      smtpConfig,
    });
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify SMTP connection' })
  @ApiResponse({ status: 200, description: 'SMTP verification result' })
  async verifySmtp(@Body() dto: VerifySmtpDto) {
    const smtpConfig: SmtpConfig | undefined = dto.smtpConfig
      ? {
          host: dto.smtpConfig.host,
          port: dto.smtpConfig.port || 587,
          secure: dto.smtpConfig.secure || false,
          user: dto.smtpConfig.user,
          pass: dto.smtpConfig.pass,
          fromName: dto.smtpConfig.fromName,
          fromEmail: dto.smtpConfig.fromEmail,
        }
      : undefined;

    return this.emailService.verifyConnection(smtpConfig);
  }
}
