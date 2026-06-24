import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? (exception as HttpException).getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? (exception as HttpException).message
        : 'Internal server error';

    const correlationId = (request as any).correlationId ?? 'unknown';

    if (status >= 500) {
      this.logger.error(
        `[${correlationId}] ${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // Guard: if response was already sent (e.g. @Res() + res.json()),
    // do not attempt to send again — this would crash the process.
    if (response.headersSent) {
      return;
    }

    response.status(status).json({
      statusCode: status,
      message,
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }
}
