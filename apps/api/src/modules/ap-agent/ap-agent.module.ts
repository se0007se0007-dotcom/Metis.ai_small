/**
 * AP Agent Module — Accounts Payable invoice processing.
 * Registers controller and service with pluggable OCR adapter.
 *
 * Adapter Configuration:
 * - Default: MockOCRAdapter (deterministic mock data, no dependencies)
 * - To swap: Change the useClass value in the 'OCR_ADAPTER' provider
 *   e.g., { provide: 'OCR_ADAPTER', useClass: TesseractOCRAdapter }
 *        { provide: 'OCR_ADAPTER', useClass: TextractOCRAdapter }
 */
import { Module } from '@nestjs/common';
import { APAgentController } from './ap-agent.controller';
import { APAgentService } from './ap-agent.service';
import { MockOCRAdapter } from './adapters/mock-ocr-adapter';
import { ApAdapterBootstrapService } from './ap-adapter-bootstrap.service';
import { CapabilityRegistryModule } from '../capability-registry/capability-registry.module';

@Module({
  imports: [CapabilityRegistryModule],
  controllers: [APAgentController],
  providers: [
    APAgentService,
    {
      provide: 'OCR_ADAPTER',
      useClass: MockOCRAdapter,
    },
    ApAdapterBootstrapService,
  ],
  exports: [APAgentService],
})
export class APAgentModule {}
