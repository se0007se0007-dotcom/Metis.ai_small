/**
 * Events Controller — REST/SSE endpoints for real-time event streaming.
 *
 * Endpoints:
 *   - GET /events/stream → SSE endpoint, returns MessageEvent stream for tenant
 *   - GET /events/recent → Returns last N events from ring buffer
 *   - POST /events/publish → Internal admin endpoint to manually publish test event
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Sse,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { EventsGatewayService, EventMessage } from './events.gateway.service';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';

@ApiTags('Events')
@ApiBearerAuth()
@Controller('events')
export class EventsController {
  constructor(private readonly eventsGateway: EventsGatewayService) {}

  /**
   * SSE endpoint: Subscribe to real-time events for the tenant.
   * Returns a Server-Sent Events stream (text/event-stream).
   *
   * Client usage:
   *   const eventSource = new EventSource('/events/stream');
   *   eventSource.onmessage = (e) => {
   *     const event = JSON.parse(e.data);
   *     console.log('Received event:', event);
   *   };
   *   eventSource.addEventListener('error', () => {
   *     eventSource.close();
   *   });
   */
  @Sse('stream')
  @ApiOperation({
    summary: 'Subscribe to real-time events via SSE',
    description:
      'Opens a persistent Server-Sent Events connection. Client can listen to mission updates, ' +
      'auto-action notifications, FDS alerts, and audit logs in real-time.',
  })
  @ApiResponse({
    status: 200,
    description: 'Event stream (Content-Type: text/event-stream). Each event is JSON-encoded.',
  })
  stream(@CurrentUser() user: RequestUser): Observable<MessageEvent> {
    return this.eventsGateway.stream(user.tenantId).pipe(
      map((event: EventMessage) => ({
        data: event,
      })),
    );
  }

  /**
   * Retrieve recent events from the ring buffer.
   * Useful for bootstrapping client state on connection.
   */
  @Get('recent')
  @ApiOperation({
    summary: 'Get recent events',
    description:
      'Fetches the last N events from the in-memory ring buffer. ' +
      'Use this to bootstrap your client state with recent history.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of events to return (default: 50, max: 500)',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of recent events',
    schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: { $ref: '#/components/schemas/EventMessage' },
        },
        count: { type: 'number' },
      },
    },
  })
  async getRecent(
    @CurrentUser() user: RequestUser,
    @Query('limit') limitStr?: string,
  ): Promise<{ events: EventMessage[]; count: number }> {
    let limit = 50;
    if (limitStr) {
      limit = parseInt(limitStr, 10);
      if (isNaN(limit) || limit < 1 || limit > 500) {
        throw new BadRequestException('limit must be between 1 and 500');
      }
    }

    const events = this.eventsGateway.getRecent(user.tenantId, limit);
    return {
      events,
      count: events.length,
    };
  }

  /**
   * Manually publish a test event (internal use, PLATFORM_ADMIN only).
   * Useful for testing the SSE connection and event flow.
   */
  @Post('publish')
  @Roles('PLATFORM_ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Publish a test event (admin only)',
    description:
      'Manually publish an event to the event stream. For testing purposes. ' +
      'Requires PLATFORM_ADMIN role.',
  })
  @ApiResponse({
    status: 201,
    description: 'Event published successfully',
  })
  async publish(
    @CurrentUser() user: RequestUser,
    @Body()
    payload: {
      type: 'mission' | 'auto-action' | 'fds-alert' | 'audit' | 'system';
      summary: string;
      severity?: 'info' | 'warning' | 'error' | 'success';
      actor?: string;
      payload?: Record<string, any>;
      correlationId?: string;
    },
  ): Promise<{ id: string; timestamp: string }> {
    const event: EventMessage = {
      id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: payload.type,
      timestamp: new Date().toISOString(),
      actor: payload.actor || user.userId,
      summary: payload.summary,
      severity: payload.severity,
      payload: payload.payload,
      correlationId: payload.correlationId,
    };

    this.eventsGateway.publish(user.tenantId, event);

    return {
      id: event.id,
      timestamp: event.timestamp,
    };
  }
}
