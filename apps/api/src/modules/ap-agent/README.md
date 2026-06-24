# AP Agent Module

Accounts Payable invoice processing with 3-way matching (Invoice vs PO vs GR).

## Quick Start

### Module Registration

Add to `apps/api/src/app.module.ts`:

```typescript
import { APAgentModule } from './modules/ap-agent';

@Module({
  imports: [APAgentModule /* ... */],
})
export class AppModule {}
```

### API Endpoints

```bash
# List invoices (with optional filters)
GET /ap/invoices?status=PENDING_APPROVAL&vendorId=v123&limit=20

# Get summary stats
GET /ap/invoices/summary
# Response: { byStatus, total, todayProcessed, timestamp }

# Create invoice
POST /ap/invoices
Content-Type: application/json
Authorization: Bearer {token}

{
  "invoiceNumber": "INV-2026-001",
  "vendorName": "Acme Corp",
  "vendorId": "v123",
  "amount": 50000,
  "currency": "KRW",
  "invoiceDate": "2026-04-15",
  "dueDate": "2026-05-15",
  "sourceUri": "s3://bucket/invoice.pdf",
  "poReference": "PO-12345",
  "grReference": "GR-98765"
}

# Parse invoice (simulate OCR)
POST /ap/invoices/{id}/parse
{ "sourceUri": "s3://bucket/invoice.pdf" }

# Run 3-way matching
POST /ap/invoices/{id}/match

# Approve invoice
POST /ap/invoices/{id}/approve

# Reject invoice
POST /ap/invoices/{id}/reject
Content-Type: application/json

{ "reason": "Vendor mismatch" }
```

## Architecture

### State Machine

```
RECEIVED
  ↓
PARSING (simulated OCR)
  ↓
MATCHING (3-way comparison)
  ├→ EXCEPTION (discrepancies found)
  └→ PENDING_APPROVAL (ready for review)
       ├→ APPROVED (approved by operator)
       └→ REJECTED (rejected by operator)
            ↓
           PAID (handled externally)
```

### 3-Way Matching

Compares:

- **Invoice** (amount, vendor, items)
- **PO** (purchase order) - optional
- **GR** (goods receipt) - optional

Returns:

- `FULL_MATCH`: All documents match
- `PARTIAL_MATCH`: Some warnings (1% amount variance, etc.)
- `NO_MATCH`: Critical discrepancies (vendor mismatch, >5% amount diff)
- `NOT_APPLICABLE`: Missing PO/GR

Recommendation: `approve | review | reject`

## Tenant Isolation (R2)

All endpoints require valid JWT with tenantId. Data is automatically filtered by tenant.

```typescript
// Service receives TenantContext
async listInvoices(ctx: TenantContext, opts) {
  const db = withTenantIsolation(this.prisma, ctx);
  // Queries automatically scoped to ctx.tenantId
}
```

## Audit Trails (R3)

Every state transition records:

- Unique `correlationId` (generated at invoice creation)
- Event type (CREATED, PARSED, MATCHING_COMPLETED, etc.)
- Metadata (amounts, recommendations, user IDs)
- Timestamp

Stored in `ExecutionTrace` model for compliance.

## Testing

### Unit Test Example

```typescript
import { match3way } from './ap-matching';

describe('match3way', () => {
  it('should return FULL_MATCH when all documents match', () => {
    const result = match3way(invoice, po, gr);
    expect(result.result).toBe('FULL_MATCH');
    expect(result.recommendation).toBe('approve');
  });

  it('should handle missing PO/GR as NOT_APPLICABLE', () => {
    const result = match3way(invoice, null, null);
    expect(result.result).toBe('NOT_APPLICABLE');
    expect(result.recommendation).toBe('review');
  });
});
```

### Integration Test Flow

```typescript
// 1. Create
const invoice = await service.createInvoice(ctx, dto);

// 2. Parse
await service.parseInvoice(ctx, invoice.id);

// 3. Match
const matched = await service.runMatching(ctx, invoice.id);

// 4. Check status
if (matched.status === 'PENDING_APPROVAL') {
  await service.approve(ctx, invoice.id, userId);
} else if (matched.status === 'EXCEPTION') {
  await service.reject(ctx, invoice.id, 'Discrepancy found');
}

// 5. Verify traces
const traces = await prisma.executionTrace.findMany({
  where: { correlationId: invoice.correlationId },
});
expect(traces.length).toBe(5); // CREATE, PARSED, MATCHING, APPROVED, CREATED, PARSED, MATCHING_COMPLETED, APPROVED
```

## Database Schema

```prisma
enum APInvoiceStatus {
  RECEIVED, PARSING, MATCHING, EXCEPTION,
  PENDING_APPROVAL, APPROVED, REJECTED, PAID
}

enum APMatchingResult {
  FULL_MATCH, PARTIAL_MATCH, NO_MATCH, NOT_APPLICABLE
}

model APInvoice {
  id: String
  tenantId: String
  invoiceNumber: String
  vendorName: String
  vendorId?: String
  amount: Decimal
  currency: String
  invoiceDate: DateTime
  dueDate?: DateTime
  status: APInvoiceStatus

  // OCR
  sourceUri?: String
  parsedJson?: Json
  ocrConfidence?: Float

  // Matching
  matchingResult?: APMatchingResult
  poReference?: String
  grReference?: String
  matchingDetailsJson?: Json
  aiSuggestionJson?: Json

  // Approval
  approvedByUserId?: String
  approvedAt?: DateTime
  rejectedReason?: String

  correlationId: String
  createdAt: DateTime
  updatedAt: DateTime
}
```

## Known Limitations

1. **PO/GR Data**: Currently not fetched (returns null in matching)

   - Need to integrate with PO and GR systems
   - Implement via poReference and grReference lookups

2. **OCR**: Simulated with mock data

   - Replace with real OCR service (AWS Textract, etc.)
   - Handle PDF, images, scanned documents

3. **Matching**: Basic algorithm

   - No fuzzy vendor name matching
   - No line-by-line item comparison
   - No tax/discount handling

4. **Async Processing**: Not implemented
   - Consider async OCR jobs for large documents
   - Add queue (Bull, etc.) for batch operations

## Performance Considerations

- Indexes on (tenantId, status, createdAt) for fast filtering
- Pagination support (limit/offset) for large result sets
- Correlations indexed for audit queries
- Summary endpoint counts cached (optional)

## Security

- Role-based access: OPERATOR required for mutations
- Tenant isolation enforced at database level
- Audit decorators on all state transitions
- No sensitive data in logs (only IDs, counts)
- Decimal type for financial amounts (no float rounding)

---

Last updated: 2026-04-15
