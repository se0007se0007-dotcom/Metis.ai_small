/**
 * OCR Adapter Interface
 *
 * Defines the contract for pluggable invoice document OCR (Optical Character Recognition) implementations.
 * Allows swapping between different OCR backends: mock, Tesseract, AWS Textract, Google Vision, etc.
 *
 * Responsibilities:
 * - Read document from URI (local file, S3, HTTP)
 * - Extract structured invoice data
 * - Return confidence scores for extracted fields
 */

export interface OCRInput {
  /** Document location: s3://bucket/key, file:///path, http(s)://... */
  sourceUri: string;

  /** MIME type hint (optional): 'application/pdf', 'image/png', 'image/jpeg' */
  mimeType?: string;

  /** Optional: Hints to improve extraction accuracy */
  hints?: {
    /** Language code: 'ko' (Korean), 'en' (English), 'zh' (Chinese), etc. */
    language?: string;

    /** Document type: 'invoice', 'receipt', 'contract', 'po', etc. */
    documentType?: 'invoice' | 'receipt' | 'contract' | 'po' | 'gr';

    /** Optional: Expected vendor name for validation */
    expectedVendor?: string;
  };
}

export interface OCRLineItem {
  /** Product/service description */
  description: string;

  /** Quantity ordered */
  qty: number;

  /** Price per unit */
  unitPrice: number;

  /** Total line amount (qty * unitPrice) */
  total: number;
}

export interface OCRExtractedInvoice {
  /** Invoice number/ID */
  invoiceNumber?: string;

  /** Vendor/supplier name */
  vendorName?: string;

  /** Vendor unique identifier */
  vendorId?: string;

  /** Total invoice amount */
  amount?: number;

  /** Currency code: 'KRW', 'USD', 'EUR', etc. */
  currency?: string;

  /** Invoice date (ISO 8601: YYYY-MM-DD) */
  invoiceDate?: string;

  /** Due date (ISO 8601: YYYY-MM-DD) */
  dueDate?: string;

  /** Line items (optional, if detailed extraction) */
  lineItems?: Array<OCRLineItem>;

  /** Tax amount */
  tax?: number;

  /** Overall confidence in extraction (0..1) */
  confidence: number;

  /** Raw extracted text (useful for debugging) */
  rawText?: string;
}

/**
 * OCRAdapter interface
 *
 * Implementations should:
 * - Handle multiple file formats (PDF, images)
 * - Support multiple languages (via hints.language)
 * - Return structured data with confidence scores
 * - Implement graceful error handling
 * - Complete within reasonable timeout (15s recommended)
 */
export interface OCRAdapter {
  /** Human-readable name of the adapter (e.g., 'mock', 'tesseract', 'aws-textract') */
  readonly name: string;

  /** Semantic version of the adapter (e.g., '1.0', '2.1.3') */
  readonly version: string;

  /**
   * Extract invoice data from document.
   *
   * @param input OCRInput with document source and optional hints
   * @returns Promise resolving to OCRExtractedInvoice with extracted data
   * @throws May throw for critical errors (adapter should log and handle gracefully)
   */
  extract(input: OCRInput): Promise<OCRExtractedInvoice>;

  /**
   * Health check for the adapter.
   * Used by ops teams to validate adapter readiness.
   *
   * @returns Promise<true> if adapter is healthy, <false> if degraded or unavailable
   */
  isHealthy(): Promise<boolean>;
}
