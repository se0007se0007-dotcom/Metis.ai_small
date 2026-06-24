# Events Module — Real-Time Event Streaming

This module provides Server-Sent Events (SSE) infrastructure for the Metis.AI API, replacing 30-second polling on the `/home` page with live, tenant-isolated event streams.

## Overview

The Events module consists of three core services:

1. **EventsGatewayService** — Core event gateway with per-tenant RxJS Subject
2. **RedisBridgeService** — Bridges A2ABusService and Redis pub/sub into the gateway
3. **EventsController** — REST/SSE endpoints

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Frontend (/home page)                                   │
│ - EventSource("/events/stream")                         │
│ - GET /events/recent (bootstrap)                        │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ↓ SSE Connection
┌─────────────────────────────────────────────────────────┐
│ EventsController                                        │
│ - @Sse('stream') GET /events/stream                     │
│ - @Get('recent') GET /events/recent                     │
│ - @Post('publish') POST /events/publish (admin)         │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ↓ Observables
┌─────────────────────────────────────────────────────────┐
│ EventsGatewayService                                    │
│ - Per-tenant RxJS Subject<EventMessage>                 │
│ - Ring buffer (100 events)                              │
│ - publish(tenantId, event)                              │
│ - stream(tenantId) → Observable<EventMessage>           │
│ - getRecent(tenantId, limit) → EventMessage[]           │
└──────────┬───────────────────────────────┬──────────────┘
           │                               │
           ↓ A2A Messages                  ↓ Redis Pub/Sub
┌─────────────────────────────┐  ┌──────────────────────────┐
│ RedisBridgeService          │  │ Redis Channel            │
│ - A2ABusService bridge      │  │ metis:events:{tenantId}  │
│ - Redis pub/sub listener    │  │                          │
│ - Cross-process event flow  │  │ (worker → API)           │
└─────────────────────────────┘  └──────────────────────────┘
```

## File Structure

```
src/modules/events/
├── events.gateway.service.ts      (119 LOC) — Event gateway
├── redis-bridge.service.ts        (197 LOC) — A2ABus + Redis bridge
├── events.controller.ts           (169 LOC) — REST/SSE endpoints
├── events.module.ts               (35 LOC)  — Module definition
├── index.ts                       (12 LOC)  — Barrel export
└── README.md                      (this file)
```

## Events Model

```typescript
interface EventMessage {
  id: string; // Unique event ID
  type: 'mission' | 'auto-action' | 'fds-alert' | 'audit' | 'system';
  timestamp: string; // ISO 8601
  actor: string; // User ID or system agent
  summary: string; // Human-readable summary
  severity?: 'info' | 'warning' | 'error' | 'success';
  payload?: Record<string, any>; // Event-specific data
  correlationId?: string; // Trace correlation ID
}
```

## REST Endpoints

### 1. SSE Stream: `GET /events/stream`

Subscribe to real-time events for the authenticated tenant.

**Content-Type:** `text/event-stream`

**Client Example:**

```typescript
const eventSource = new EventSource('/events/stream', {
  headers: { Authorization: 'Bearer <JWT>' },
});

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message.type, message.summary);
};

eventSource.onerror = () => {
  eventSource.close();
};
```

### 2. Recent Events: `GET /events/recent?limit=50`

Retrieve recent events from the ring buffer for bootstrapping client state.

**Query Parameters:**

- `limit` (optional, default: 50, max: 500) — Number of events to return

**Response:**

```json
{
  "events": [
    {
      "id": "evt-001",
      "type": "mission",
      "timestamp": "2026-04-15T18:00:00Z",
      "actor": "user-123",
      "summary": "Mission 'Deploy API v2' completed successfully",
      "severity": "success"
    }
  ],
  "count": 1
}
```

### 3. Publish Event: `POST /events/publish` (Admin Only)

Manually publish a test event (requires `PLATFORM_ADMIN` role).

**Request Body:**

```json
{
  "type": "mission",
  "summary": "Test event from admin",
  "severity": "info",
  "actor": "admin-user",
  "payload": { "testKey": "testValue" }
}
```

**Response:**

```json
{
  "id": "evt-123",
  "timestamp": "2026-04-15T18:00:00Z"
}
```

## Usage in Other Modules

To publish events from your service:

```typescript
import { EventsModule } from '../events/events.module';
import { EventsGatewayService, EventMessage } from '../events';

@Module({
  imports: [EventsModule],
})
export class MyModule {
  constructor(private readonly events: EventsGatewayService) {}

  async doSomething(tenantId: string) {
    const event: EventMessage = {
      id: 'evt-' + Date.now(),
      type: 'mission',
      timestamp: new Date().toISOString(),
      actor: 'system',
      summary: 'Something happened',
      severity: 'info',
    };
    this.events.publish(tenantId, event);
  }
}
```

## Cross-Process Events (Workers)

Background workers and agents can publish events via Redis pub/sub:

```typescript
// In a worker process:
const redis = new Redis(process.env.REDIS_URL);
const event = {
  id: 'evt-' + Date.now(),
  type: 'fds-alert',
  timestamp: new Date().toISOString(),
  actor: 'fds-checker',
  summary: 'Anomaly detected',
  severity: 'warning',
};
await redis.publish(`metis:events:${tenantId}`, JSON.stringify(event));
```

## Design Decisions

### 1. RxJS Subject per Tenant

- **Why:** Tenant isolation + lazy initialization (subjects created on demand)
- **Benefit:** Memory efficient, natural Observable API
- **Backpressure:** Events dropped if no subscribers (no unbounded queue)

### 2. Ring Buffer (100 events)

- **Why:** Provide recent history without querying the database
- **Use case:** `/events/recent` endpoint for bootstrapping client state
- **Size trade-off:** 100 events covers ~30 minutes at typical event rate

### 3. Redis Bridge for Cross-Process Events

- **Why:** Support multiple API instances + background workers
- **Channel name:** `metis:events:{tenantId}` (per-tenant isolation)
- **Delivery:** At-most-once (Redis pub/sub, not durable)

### 4. No Persistence in Gateway

- **Why:** Keep gateway stateless and lightweight
- **For audit trail:** Use the existing ExecutionTrace/AuditLog tables
- **For replay:** Use A2ABusService.replay() for mission-specific history

## Security & Governance

### Tenant Isolation

- Each tenant receives only their own events
- `@CurrentUser()` decorator extracts `tenantId` from JWT
- No cross-tenant event leakage possible

### Authentication

- All endpoints protected by global `JwtAuthGuard`
- SSE stream requires valid JWT in `Authorization` header

### Authorization

- `POST /events/publish` restricted to `PLATFORM_ADMIN` role
- GET endpoints accessible to all authenticated users

## Performance & Scalability

### Memory

- Per-tenant Subject: ~1 KB per idle tenant
- Ring buffer: 100 events × ~500 bytes = 50 KB per tenant
- For 1000 tenants: ~50 MB total (acceptable)

### CPU

- RxJS Subject emission: O(1) per subscriber
- Ring buffer append: O(1) shift + push

### Network

- SSE reduces polling overhead: 30-second → event-driven
- Typical event: ~500 bytes, gzip reduces to ~150 bytes
- No heartbeat overhead (events only on activity)

## Graceful Shutdown

On `onModuleDestroy`:

1. `EventsGatewayService`: Complete all RxJS Subjects
2. `RedisBridgeService`: Unsubscribe from Redis, close connections

This ensures:

- In-flight SSE responses finish cleanly
- No orphaned Redis subscriptions
- No lost events during deployment

## Testing

### Unit Test Example

```typescript
import { Test } from '@nestjs/testing';
import { EventsGatewayService, EventMessage } from './events.gateway.service';

describe('EventsGatewayService', () => {
  let service: EventsGatewayService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [EventsGatewayService],
    }).compile();
    service = module.get(EventsGatewayService);
  });

  it('publishes events to tenant stream', (done) => {
    const tenantId = 'tenant-123';
    const event: EventMessage = {
      id: 'evt-1',
      type: 'mission',
      timestamp: new Date().toISOString(),
      actor: 'user-1',
      summary: 'Test event',
    };

    service.stream(tenantId).subscribe((received) => {
      expect(received.id).toBe('evt-1');
      done();
    });

    service.publish(tenantId, event);
  });

  it('maintains ring buffer', () => {
    const tenantId = 'tenant-456';
    for (let i = 0; i < 150; i++) {
      service.publish(tenantId, {
        id: `evt-${i}`,
        type: 'audit',
        timestamp: new Date().toISOString(),
        actor: 'user-1',
        summary: `Event ${i}`,
      });
    }
    const recent = service.getRecent(tenantId, 100);
    expect(recent.length).toBe(100);
    expect(recent[0].id).toBe('evt-50'); // First 50 dropped
  });
});
```

## Known Limitations & Future Enhancements

1. **No Persistence** — Events not stored beyond ring buffer

   - Future: Add optional event log table for long-term audit trail

2. **At-Most-Once Delivery** — Redis pub/sub has no guarantees

   - Future: Add optional message queue (RabbitMQ/NATS) for guaranteed delivery

3. **No Event Filtering** — All events sent to all subscribers

   - Future: Add `?types=mission,audit` query parameter to filter events

4. **No Backpressure Handling** — Slow clients may miss events

   - Future: Add client-side buffer or slow-client detection

5. **Single EventMessage Schema** — All event types share same interface
   - Future: Add event-specific payload schemas (TypeScript discriminated unions)

## Integration Checklist

- [x] Module created and exported
- [x] Added to `app.module.ts` imports
- [x] EventsController with `@Sse()` decorator
- [x] EventsGatewayService with per-tenant isolation
- [x] RedisBridgeService for cross-process events
- [x] Ring buffer for `/events/recent` endpoint
- [ ] Frontend integration (Next.js /home page)
- [ ] E2E tests for SSE stream
- [ ] Load test ring buffer behavior
- [ ] Documentation on event types from each module

## Related Files

- **Backend:** `/apps/api/src/modules/events/`
- **Frontend:** `/apps/web/app/(authenticated)/home/page.tsx` (to integrate SSE)
- **Types:** Consider adding `EventMessage` to `/packages/types/` for shared usage
- **API Docs:** Swagger automatically documents all endpoints

## Support

For questions or issues:

1. Check the design decisions section above
2. Review EventsGatewayService for ring buffer behavior
3. Check RedisBridgeService for cross-process Redis pub/sub setup
4. Ensure JwtAuthGuard is properly injecting `user.tenantId`
