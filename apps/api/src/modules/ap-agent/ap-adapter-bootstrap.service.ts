/**
 * AP Adapter Bootstrap — registers OCR adapter invokers for workflow use.
 *
 * All 3 registered keys share the same active OCRAdapter selected by the
 * AP module's DI binding. Swap via `{ provide: 'OCR_ADAPTER', useClass: ... }`.
 */
import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { TenantContext } from '@metis/database';
import { AdapterInvocationService } from '../capability-registry/adapter-invocation.service';
import type { OCRAdapter } from './adapters/ocr-adapter.interface';

@Injectable()
export class ApAdapterBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(ApAdapterBootstrapService.name);

  constructor(
    private readonly registry: AdapterInvocationService,
    @Inject('OCR_ADAPTER') private readonly ocr: OCRAdapter,
  ) {}

  onModuleInit() {
    const keys = ['ocr-mock', 'ocr-tesseract', 'ocr-textract'];
    for (const key of keys) {
      this.registry.register(key, async (input: Record<string, any>, ctx: TenantContext) => {
        const result = await this.ocr
          .extract({
            sourceUri: input.sourceUri ?? input.uri ?? 'mock://invoice.pdf',
            mimeType: input.mimeType,
            hints: input.hints ?? { documentType: 'invoice', language: 'ko' },
          })
          .catch((e) => ({ confidence: 0, _error: e.message }) as any);

        return {
          success: !('_error' in result),
          output: {
            invoiceNumber: (result as any).invoiceNumber,
            vendorName: (result as any).vendorName,
            amount: (result as any).amount,
            currency: (result as any).currency,
            invoiceDate: (result as any).invoiceDate,
            lineItems: (result as any).lineItems,
            tax: (result as any).tax,
            confidence: (result as any).confidence,
          },
          adapter: key,
          implementation: this.ocr.name,
          confidence: (result as any).confidence,
          error: (result as any)._error,
        };
      });
    }
    this.logger.log(`[ap-bootstrap] Registered ${keys.length} OCR adapter invokers`);
  }
}
