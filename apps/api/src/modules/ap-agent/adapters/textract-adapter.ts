/**
 * AWS Textract OCR Adapter
 *
 * Implementation structure for AWS Textract-based invoice OCR.
 * Currently returns mock data for demonstration.
 *
 * To enable real AWS Textract:
 * 1. Install: npm install aws-sdk
 * 2. Configure AWS credentials (IAM role or env vars)
 * 3. Set OCR_ADAPTER=textract and OCR_TEXTRACT_REGION environment variables
 * 4. Uncomment the real implementation code below
 *
 * AWS Textract features:
 * - High accuracy (especially for business documents)
 * - Supports complex forms and tables
 * - AnalyzeExpense API specifically for invoices
 * - Batch processing support
 * - Costs ~$1.50 per page
 *
 * Useful for:
 * - Cloud-native deployments
 * - High accuracy requirements
 * - Complex invoice formats
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OCRAdapter, OCRInput, OCRExtractedInvoice, OCRLineItem } from './ocr-adapter.interface';

@Injectable()
export class TextractOCRAdapter implements OCRAdapter {
  private readonly logger = new Logger(TextractOCRAdapter.name);

  readonly name = 'aws-textract';
  readonly version = '1.0';

  private readonly region: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;

  constructor(private configService: ConfigService) {
    this.region = this.configService.get('OCR_TEXTRACT_REGION') || 'us-east-1';
    this.accessKeyId = this.configService.get('AWS_ACCESS_KEY_ID');
    this.secretAccessKey = this.configService.get('AWS_SECRET_ACCESS_KEY');

    // PRODUCTION CODE (optional initialization)
    // Uncomment when ready to use real AWS SDK
    /*
    try {
      this.textractClient = new AWS.Textract({
        region: this.region,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      });
    } catch (error) {
      this.logger.error('Failed to initialize AWS Textract client:', error);
      this.textractClient = null;
    }
    */
  }

  /**
   * Extract invoice using AWS Textract AnalyzeExpense API.
   *
   * In production, this would:
   * 1. Download document from sourceUri to S3 (if needed)
   * 2. Call AnalyzeExpense API (optimized for invoices/receipts)
   * 3. Parse response and extract line items
   * 4. Return structured OCRExtractedInvoice
   *
   * AWS AnalyzeExpense API response structure:
   * {
   *   ExpenseDocuments: [{
   *     SummaryFields: [
   *       { Type: { Text: "INVOICE_NUMBER" }, ValueDetection: { Text: "INV-123" } },
   *       { Type: { Text: "VENDOR_NAME" }, ValueDetection: { Text: "Acme Corp" } },
   *       { Type: { Text: "DUE_DATE" }, ValueDetection: { Text: "2024-04-15" } }
   *     ],
   *     LineItemGroups: [{
   *       LineItems: [
   *         { LineItemExpenseFields: [...] },
   *       ]
   *     }]
   *   }]
   * }
   */
  async extract(input: OCRInput): Promise<OCRExtractedInvoice> {
    const startTime = Date.now();

    try {
      // MOCK IMPLEMENTATION: Return realistic data
      const mockResult = this.generateMockResult(input);

      this.logger.debug(
        `Textract OCR (mock) processed ${input.sourceUri} in ${Date.now() - startTime}ms`,
      );
      return mockResult;

      /* PRODUCTION CODE (requires: npm install aws-sdk)
      // Uncomment when ready
      if (!this.textractClient) {
        throw new Error('Textract client not initialized');
      }

      // Prepare document location
      const documentLocation = await this.prepareDocumentLocation(input.sourceUri);

      // Call AnalyzeExpense API
      const response = await this.textractClient.analyzeExpense({
        Document: documentLocation,
      }).promise();

      // Parse response
      const extracted = this.parseTextractResponse(response, input.hints?.language);

      return {
        ...extracted,
        confidence: this.calculateConfidence(response),
      };
      */
    } catch (error) {
      this.logger.error(`Textract extraction failed for ${input.sourceUri}:`, error);
      return {
        invoiceNumber: 'UNKNOWN',
        confidence: 0.0,
        rawText: `[Textract error: ${error instanceof Error ? error.message : 'unknown'}]`,
      };
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // PRODUCTION: Attempt to call a lightweight Textract API
      // For now, check if AWS credentials are configured
      if (!this.accessKeyId || !this.secretAccessKey) {
        this.logger.warn('AWS credentials not configured');
        return false;
      }

      // In production, you could call AnalyzeExpense with a test document
      // to verify the API is accessible
      return true;
    } catch (error) {
      this.logger.error('Textract health check failed:', error);
      return false;
    }
  }

  /**
   * Prepare document location for Textract API.
   * Handles local files, S3, and HTTP URIs.
   */
  private async prepareDocumentLocation(
    sourceUri: string,
  ): Promise<{ S3Object: { Bucket: string; Name: string } } | { Bytes: Buffer }> {
    // PRODUCTION CODE (example structure)
    /*
    const url = new URL(sourceUri);

    if (url.protocol === 's3:') {
      // Already in S3, use directly
      const bucket = url.hostname;
      const key = url.pathname.slice(1);
      return {
        S3Object: { Bucket: bucket, Name: key },
      };
    }

    // For file:// and http(s)://, upload to temporary S3 bucket
    const tempBucket = this.configService.get('OCR_TEXTRACT_TEMP_BUCKET');
    if (!tempBucket) {
      throw new Error('OCR_TEXTRACT_TEMP_BUCKET not configured for non-S3 sources');
    }

    const buffer = await this.downloadFile(sourceUri);
    const s3Key = `temp/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Upload to S3
    await s3Client.putObject({
      Bucket: tempBucket,
      Key: s3Key,
      Body: buffer,
    }).promise();

    return {
      S3Object: { Bucket: tempBucket, Name: s3Key },
    };
    */

    throw new Error('prepareDocumentLocation not implemented in mock');
  }

  /**
   * Parse Textract AnalyzeExpense response.
   * Extracts summary fields and line items.
   */
  private parseTextractResponse(response: any, language?: string): Partial<OCRExtractedInvoice> {
    // PRODUCTION CODE (example parsing)
    /*
    const document = response.ExpenseDocuments?.[0];
    if (!document) {
      return { invoiceNumber: 'UNKNOWN' };
    }

    const summaryFields = document.SummaryFields || [];
    const lineItemGroups = document.LineItemGroups || [];

    // Extract summary fields
    const fieldMap = this.buildFieldMap(summaryFields);
    const invoiceNumber = fieldMap['INVOICE_NUMBER']?.ValueDetection?.Text;
    const vendorName = fieldMap['VENDOR_NAME']?.ValueDetection?.Text;
    const dueDate = fieldMap['DUE_DATE']?.ValueDetection?.Text;
    const invoiceDate = fieldMap['INVOICE_DATE']?.ValueDetection?.Text;

    // Extract line items
    const lineItems = this.parseLineItems(lineItemGroups);

    // Calculate totals
    const amount = lineItems.reduce((sum, item) => sum + item.total, 0);
    const tax = fieldMap['TAX']?.ValueDetection?.Text
      ? parseFloat(fieldMap['TAX'].ValueDetection.Text)
      : undefined;

    return {
      invoiceNumber,
      vendorName,
      dueDate,
      invoiceDate,
      lineItems,
      amount,
      tax,
      currency: language === 'ko' ? 'KRW' : 'USD',
    };
    */

    return {
      invoiceNumber: 'UNKNOWN',
    };
  }

  /**
   * Calculate overall confidence from Textract response.
   */
  private calculateConfidence(response: any): number {
    // PRODUCTION CODE
    // Average confidence of all detected values in the response
    // Textract returns Confidence (0-100) for each field
    /*
    const confidences: number[] = [];

    const sumField = (field: any) => {
      if (field.ValueDetection?.Confidence) {
        confidences.push(field.ValueDetection.Confidence / 100);
      }
    };

    response.ExpenseDocuments?.[0]?.SummaryFields?.forEach(sumField);
    response.ExpenseDocuments?.[0]?.LineItemGroups?.forEach(group => {
      group.LineItems?.forEach(item => {
        item.LineItemExpenseFields?.forEach(sumField);
      });
    });

    if (confidences.length === 0) return 0.5;
    return confidences.reduce((a, b) => a + b) / confidences.length;
    */

    return 0.88; // Mock confidence
  }

  /**
   * Build field map from Textract summary fields for easy lookup.
   */
  private buildFieldMap(summaryFields: any[]): Record<string, any> {
    const map: Record<string, any> = {};
    summaryFields.forEach((field) => {
      const type = field.Type?.Text;
      if (type) {
        map[type] = field;
      }
    });
    return map;
  }

  /**
   * Parse line items from Textract LineItemGroups.
   */
  private parseLineItems(lineItemGroups: any[]): OCRLineItem[] {
    // PRODUCTION CODE
    /*
    const items: OCRLineItem[] = [];

    lineItemGroups.forEach(group => {
      group.LineItems?.forEach((item: any) => {
        const fields = this.buildFieldMap(item.LineItemExpenseFields);
        items.push({
          description: fields['ITEM']?.ValueDetection?.Text || 'Unknown',
          qty: parseFloat(fields['QUANTITY']?.ValueDetection?.Text || '1'),
          unitPrice: parseFloat(fields['UNIT_PRICE']?.ValueDetection?.Text || '0'),
          total: parseFloat(fields['LINE_TOTAL']?.ValueDetection?.Text || '0'),
        });
      });
    });

    return items;
    */

    return [];
  }

  /**
   * Generate mock result for demonstration.
   */
  private generateMockResult(input: OCRInput): OCRExtractedInvoice {
    return {
      invoiceNumber: `TXR-${Date.now() % 1000000}`,
      vendorName: 'Premium Vendor (Textract Mock)',
      vendorId: 'V-67890',
      amount: 25000,
      currency: 'USD',
      invoiceDate: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      lineItems: [
        {
          description: 'Professional Services',
          qty: 1,
          unitPrice: 20000,
          total: 20000,
        },
        {
          description: 'Support & Maintenance',
          qty: 1,
          unitPrice: 5000,
          total: 5000,
        },
      ],
      tax: 2500,
      confidence: 0.94,
      rawText: `[Textract.js mock] Document: ${input.sourceUri}\nNote: Configure AWS credentials and set OCR_ADAPTER=textract to enable real processing`,
    };
  }
}
