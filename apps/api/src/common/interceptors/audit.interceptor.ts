import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { PrismaClient } from '@metis/database';
import { AUDIT_KEY, AuditMeta } from '../decorators/audit.decorator';
import { PRISMA_TOKEN } from '../../modules/database.module';

/**
 * Automatically writes audit log entries for endpoints decorated with @Audit().
 * Captures: actor, action, targetType, targetId, policyResult, correlationId.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const auditMeta = this.reflector.get<AuditMeta>(AUDIT_KEY, context.getHandler());

    // No @Audit() decorator → pass through
    if (!auditMeta) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const startTime = Date.now();

    return next.handle().pipe(
      tap(async (responseBody) => {
        try {
          const user = request.user;
          const tenantId = user?.tenantId;
          if (!tenantId) return;

          await this.prisma.auditLog.create({
            data: {
              tenantId,
              actorUserId: user?.userId,
              action: auditMeta.action as any,
              targetType: auditMeta.targetType,
              targetId: responseBody?.id ?? request.params?.id ?? null,
              correlationId: request.correlationId ?? 'unknown',
              metadataJson: {
                method: request.method,
                path: request.url,
                durationMs: Date.now() - startTime,
                statusCode: context.switchToHttp().getResponse().statusCode,
              },
            },
          });
        } catch (error) {
          // Audit failure must not break the request
          this.logger.error('Audit log write failed', error);
        }
      }),
    );
  }
}
