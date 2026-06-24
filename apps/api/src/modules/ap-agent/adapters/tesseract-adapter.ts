/**
 * Tesseract OCR Adapter
 *
 * Implementation structure for open-source Tesseract.js-based OCR.
 * Currently returns mock data for demonstration.
 *
 * To enable real Tesseract OCR:
 * 1. Install: npm install tesseract.js
 * 2. Set OCR_ADAPTER=tesseract environment variable
 * 3. Uncomment the real implementation code below
 *
 * Tesseract.js features:
 * - Runs in Node.js or browser
 * - Supports 100+ languages
 * - No external API required (offline)
 * - Lower accuracy than commercial solutions
 * - Good for simple invoices
 *
 * Useful for:
 * - Self-hosted deployments
 * - Privacy-conscious organizations
 * - Low-latency local processing
 */

import { Injectable, Logger } from '@nestjs/common';
import { OCRAdapter, OCRInput, OCRExtractedInvoice } from './ocr-adapter.interface';

@Injectable()
export class TesseractOCRAdapter implements OCRAdapter {
  private readonly logger = new Logger(TesseractOCRAdapter.name);

  readonly name = 'tesseract';
  readonly version = '1.0';

  constructor() {
    // PRODUCTION CODE (requires: npm install tesseract.js)
    // Uncomment when ready to use real Tesseract
    /*
    try {
      this.tesseract = require('tesseract.js');
    } catch (error) {
      this.logger.error('Tesseract.js not installed. Run: npm install tesseract.js');
      this.tesseract = null;
    }
    */
  }

  /**
   * Extract invoice using Tesseract.js.
   *
   * In production, this would:
   * 1. Load image/PDF from sourceUri
   * 2. Run Tesseract.js OCR with language hint
   * 3. Parse extracted text for invoice structure
   * 4. Return structured data
   */
  async extract(input: OCRInput): Promise<OCRExtractedInvoice> {
    const startTime = Date.now();

    try {
      // MOCK IMPLEMENTATION: Return realistic data
      // In production, replace with actual Tesseract processing

      const mockResult = this.generateMockResult(input);

      this.logger.debug(
        `Tesseract OCR (mock) processed ${input.sourceUri} in ${Date.now() - startTime}ms`,
      );
      return mockResult;

      /* PRODUCTION CODE (requires: npm install tesseract.js)
      // Uncomment when ready
      if (!this.tesseract) {
        throw new Error('Tesseract.js not available');
      }

      // Load document from URI
      const imageData = await this.loadDocumentFromUri(input.sourceUri);

      // Run OCR with language from hints
      const language = input.hints?.language || 'eng';
      const result = await this.tesseract.recognize(imageData, language);

      // Parse extracted text
      const extractedData = this.parseInvoiceFromText(
        result.data.text,
        input.hints?.documentType,
      );

      return {
        ...extractedData,
        rawText: result.data.text,
        confidence: result.data.confidence / 100, // Tesseract returns 0-100
      };
      */
    } catch (error) {
      this.logger.error(`Tesseract extraction failed for ${input.sourceUri}:`, error);
      return {
        invoiceNumber: 'UNKNOWN',
        confidence: 0.0,
        rawText: `[Tesseract error: ${error instanceof Error ? error.message : 'unknown'}]`,
      };
    }
  }

  async isHealthy(): Promise<boolean> {
    // PRODUCTION: Check if Tesseract.js is available and working
    // For now, check if it would be available after npm install
    try {
      // In production, you'd try a quick OCR probe here
      require.resolve('tesseract.js');
      return true;
    } catch {
      this.logger.warn('Tesseract.js not installed. Run: npm install tesseract.js');
      return false;
    }
  }

  /**
   * Load document from various URI schemes.
   * PRODUCTION implementation would support:
   * - file:// (local filesystem)
   * - s3:// (AWS S3)
   * - http(s):// (remote URLs)
   */
  private async loadDocumentFromUri(sourceUri: string): Promise<Buffer> {
    // PRODUCTION CODE (example structure)
    /*
    const url = new URL(sourceUri);

    switch (url.protocol) {
      case 'file:':
        const fs = require('fs');
        return fs.readFileSync(url.pathname);

      case 's3:':
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        const bucket = url.hostname;
        const key = url.pathname.slice(1); // Remove leading /
        const data = await s3.getObject({ Bucket: bucket, Key: key }).promise();
        return data.Body as Buffer;

      case 'http:':
      case 'https:':
        const response = await fetch(sourceUri);
        return Buffer.from(await response.arrayBuffer());

      default:
        throw new Error(`Unsupported URI scheme: ${url.protocol}`);
    }
    */
    throw new Error('loadDocumentFromUri not implemented in mock');
  }

  /**
   * Parse invoice structure from raw OCR text.
   * Looks for common invoice patterns.
   */
  private parseInvoiceFromText(
    rawText: string,
    documentType?: string,
  ): Partial<OCRExtractedInvoice> {
    // PRODUCTION CODE (regex patterns for invoice fields)
    /*
    const invoiceNumberPattern = /[Ii]nvoice\s*#?\s*:?\s*(\S+)/;
    const vendorPattern = /[Vv]endor\s*:?\s*(.+)/;
    const amountPattern = /[Tt]otal\s*:?\s*\$?([\d,]+\.?\d*)/;
    const datePattern = /[Dd]ate\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/;

    return {
      invoiceNumber: rawText.match(invoiceNumberPattern)?.[1],
      vendorName: rawText.match(vendorPattern)?.[1],
      amount: parseFloat(
        rawText.match(amountPattern)?.[1]?.replace(/,/g, '') || '0',
      ),
      invoiceDate: rawText.match(datePattern)?.[1],
      confidence: 0.65, // Tesseract text extraction is less reliable
    };
    */

    return {
      invoiceNumber: 'UNKNOWN',
      confidence: 0.0,
    };
  }

  /**
   * Generate mock result for demonstration.
   */
  private generateMockResult(input: OCRInput): OCRExtractedInvoice {
    return {
      invoiceNumber: `TSS-${Date.now() % 1000000}`,
      vendorName: 'Sample Vendor (Tesseract Mock)',
      vendorId: 'V-12345',
      amount: 15000,
      currency: 'USD',
      invoiceDate: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      tax: 1500,
      confidence: 0.68,
      rawText: `[Tesseract.js mock] Document: ${input.sourceUri}\nNote: Install tesseract.js and set OCR_ADAPTER=tesseract to enable real processing`,
    };
  }
}
