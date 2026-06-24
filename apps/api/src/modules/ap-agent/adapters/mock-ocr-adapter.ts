/**
 * Mock OCR Adapter
 *
 * Default implementation returning realistic-looking deterministic mock data.
 * Useful for:
 * - Local development and testing
 * - Integration testing without external dependencies
 * - Fallback when other adapters fail
 */

import { Injectable, Logger } from '@nestjs/common';
import { OCRAdapter, OCRInput, OCRExtractedInvoice, OCRLineItem } from './ocr-adapter.interface';

@Injectable()
export class MockOCRAdapter implements OCRAdapter {
  private readonly logger = new Logger(MockOCRAdapter.name);

  readonly name = 'mock';
  readonly version = '1.0';

  /**
   * Extract invoice by returning deterministic mock data.
   *
   * Always returns the same data for same invoice number, enabling reproducible tests.
   */
  async extract(input: OCRInput): Promise<OCRExtractedInvoice> {
    // Simulate OCR latency (200-500ms)
    const latencyMs = 200 + Math.random() * 300;
    await this.sleep(latencyMs);

    try {
      // Extract invoice number from URI for deterministic results
      const invoiceNumber = this.extractInvoiceNumber(input.sourceUri);

      // Generate mock data
      const mockData = this.generateMockInvoice(invoiceNumber, input.hints);

      this.logger.debug(
        `Mock OCR extracted invoice ${mockData.invoiceNumber} from ${input.sourceUri}`,
      );
      return mockData;
    } catch (error) {
      this.logger.error(`Mock OCR extraction failed: ${error}`);
      // Fallback to partial extraction
      return {
        invoiceNumber: 'UNKNOWN',
        confidence: 0.3,
        rawText: `[Failed to extract from ${input.sourceUri}]`,
      };
    }
  }

  async isHealthy(): Promise<boolean> {
    // Mock adapter has no external dependencies
    return true;
  }

  /**
   * Generate realistic-looking mock invoice data.
   */
  private generateMockInvoice(
    invoiceNumber: string,
    hints?: OCRInput['hints'],
  ): OCRExtractedInvoice {
    // Deterministic pricing based on invoice number hash
    const hashValue = invoiceNumber.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);

    const baseAmount = 5000 + (hashValue % 95000); // 5,000 - 100,000
    const tax = Math.round(baseAmount * 0.1 * 100) / 100; // 10% tax
    const totalAmount = baseAmount + tax;

    // Vendor names
    const vendorNames = [
      'AcmeCorp Ltd',
      'TechSupply Inc',
      'GlobalServices',
      'Premier Vendors',
      'International Trade Co',
    ];
    const vendorName = hints?.expectedVendor || vendorNames[hashValue % vendorNames.length];

    // Generate line items
    const itemCount = 1 + (hashValue % 3); // 1-3 items
    const lineItems: OCRLineItem[] = [];

    for (let i = 0; i < itemCount; i++) {
      const itemHash = (hashValue + i * 31) % 10000;
      const qty = 1 + (itemHash % 10);
      const unitPrice = Math.round((baseAmount / itemCount / qty) * 100) / 100;

      lineItems.push({
        description: `Item ${i + 1} - ${this.generateItemDescription(itemHash)}`,
        qty,
        unitPrice,
        total: Math.round(qty * unitPrice * 100) / 100,
      });
    }

    // Dates
    const invoiceDate = new Date();
    invoiceDate.setDate(invoiceDate.getDate() - (hashValue % 30)); // Past 30 days
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + 30); // 30 days net

    return {
      invoiceNumber,
      vendorName,
      vendorId: `V-${hashValue % 100000}`,
      amount: baseAmount,
      currency: hints?.language === 'ko' ? 'KRW' : 'USD',
      invoiceDate: invoiceDate.toISOString().split('T')[0],
      dueDate: dueDate.toISOString().split('T')[0],
      lineItems,
      tax,
      confidence: 0.92, // High confidence for mock
      rawText: `[Simulated OCR] Invoice: ${invoiceNumber}\nVendor: ${vendorName}\nAmount: ${totalAmount}`,
    };
  }

  /**
   * Extract invoice number from URI (filename or parameter).
   */
  private extractInvoiceNumber(sourceUri: string): string {
    // Try to extract from filename
    const match = sourceUri.match(/[/\\]([^/\\]+)\.(pdf|png|jpg|jpeg|txt)$/i);
    if (match) {
      const filename = match[1];
      // Clean up filename to use as invoice number
      return filename.replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 50);
    }

    // Fallback: use hash of URI
    const hash = sourceUri.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return `INV-${Math.abs(hash) % 1000000}`;
  }

  /**
   * Generate realistic item descriptions.
   */
  private generateItemDescription(seed: number): string {
    const categories = [
      'Office Supplies',
      'Software License',
      'Consulting Services',
      'Equipment Rental',
      'Maintenance Services',
      'Training & Development',
      'Cloud Services',
      'Hardware Components',
    ];
    const category = categories[seed % categories.length];
    const itemNum = (seed / categories.length) % 100;
    return `${category} (Ref: ${itemNum})`;
  }

  /**
   * Helper to sleep for simulated latency.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
