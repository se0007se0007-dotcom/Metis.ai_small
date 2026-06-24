import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Injects a correlation ID into every request/response.
 * Used for distributed tracing and audit log linkage.
 */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const correlationId = request.headers[CORRELATION_HEADER] || uuidv4();

    // Attach to request for downstream usage (audit, logging)
    request.correlationId = correlationId;

    // Set correlation header BEFORE handler runs, so it's safe even when
    // the controller uses @Res() to send the response manually.
    if (!response.headersSent) {
      response.setHeader(CORRELATION_HEADER, correlationId);
    }

    return next.handle().pipe(
      tap(() => {
        // Guard: if controller already sent response (e.g. @Res() + res.json()),
        // headers are already committed — do not attempt to set again.
        if (!response.headersSent) {
          response.setHeader(CORRELATION_HEADER, correlationId);
        }
      }),
    );
  }
}
