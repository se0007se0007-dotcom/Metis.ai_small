/**
 * AP Matching Helper — Pure function for 3-way matching logic.
 * Compares Invoice vs PO vs GR data and returns structured recommendation.
 */

export interface MatchingDiscrepancy {
  field: string;
  invoiceValue: any;
  poValue?: any;
  grValue?: any;
  severity: 'warn' | 'error';
}

export interface Match3WayResult {
  result: 'FULL_MATCH' | 'PARTIAL_MATCH' | 'NO_MATCH' | 'NOT_APPLICABLE';
  discrepancies: MatchingDiscrepancy[];
  recommendation: 'approve' | 'review' | 'reject';
  confidence: number; // 0..1
  summary: string; // Korean one-line summary
}

export interface InvoiceData {
  amount: number;
  vendorName: string;
  vendorId?: string;
  invoiceNumber: string;
  invoiceDate: Date;
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
}

export interface POData {
  amount: number;
  vendorName: string;
  vendorId?: string;
  poNumber: string;
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
}

export interface GRData {
  amount: number;
  vendorName: string;
  grNumber: string;
  receivedQuantity?: number;
  receivedDate?: Date;
  lineItems?: Array<{
    description: string;
    receivedQuantity: number;
  }>;
}

/**
 * Core 3-way matching logic.
 * PO/GR can be null (treated as NOT_APPLICABLE for that leg).
 */
export function match3way(
  invoice: InvoiceData,
  poData?: POData | null,
  grData?: GRData | null,
): Match3WayResult {
  const discrepancies: MatchingDiscrepancy[] = [];
  let matchCount = 0;
  let totalLegs = 1; // Invoice is always there

  // ───────────────────────────────────────────────────────────
  // 1. Invoice vs PO (if PO exists)
  // ───────────────────────────────────────────────────────────
  if (poData) {
    totalLegs++;
    let poMatches = true;

    // Check vendor match
    if (poData.vendorId && invoice.vendorId && poData.vendorId !== invoice.vendorId) {
      discrepancies.push({
        field: 'vendorId (PO vs Invoice)',
        invoiceValue: invoice.vendorId,
        poValue: poData.vendorId,
        severity: 'error',
      });
      poMatches = false;
    } else if (poData.vendorName.toLowerCase() !== invoice.vendorName.toLowerCase()) {
      discrepancies.push({
        field: 'vendorName (PO vs Invoice)',
        invoiceValue: invoice.vendorName,
        poValue: poData.vendorName,
        severity: 'error',
      });
      poMatches = false;
    }

    // Check amount with 1% tolerance = warn, >5% = error
    const amountDiff = Math.abs(poData.amount - invoice.amount);
    const amountDiffPct = (amountDiff / poData.amount) * 100;

    if (amountDiffPct > 0.01) {
      const severity = amountDiffPct > 5 ? 'error' : 'warn';
      discrepancies.push({
        field: 'amount (PO vs Invoice)',
        invoiceValue: invoice.amount,
        poValue: poData.amount,
        severity,
      });
      if (severity === 'error') poMatches = false;
    }

    if (poMatches) {
      matchCount++;
    }
  }

  // ───────────────────────────────────────────────────────────
  // 2. Invoice vs GR (if GR exists)
  // ───────────────────────────────────────────────────────────
  if (grData) {
    totalLegs++;
    let grMatches = true;

    // Check vendor match (simpler for GR — just name)
    if (grData.vendorName.toLowerCase() !== invoice.vendorName.toLowerCase()) {
      discrepancies.push({
        field: 'vendorName (GR vs Invoice)',
        invoiceValue: invoice.vendorName,
        grValue: grData.vendorName,
        severity: 'error',
      });
      grMatches = false;
    }

    // Check amount (GR vs Invoice, same tolerance)
    const amountDiff = Math.abs(grData.amount - invoice.amount);
    const amountDiffPct = (amountDiff / grData.amount) * 100;

    if (amountDiffPct > 0.01) {
      const severity = amountDiffPct > 5 ? 'error' : 'warn';
      discrepancies.push({
        field: 'amount (GR vs Invoice)',
        invoiceValue: invoice.amount,
        grValue: grData.amount,
        severity,
      });
      if (severity === 'error') grMatches = false;
    }

    if (grMatches) {
      matchCount++;
    }
  }

  // ───────────────────────────────────────────────────────────
  // 3. Determine result and recommendation
  // ───────────────────────────────────────────────────────────
  let result: Match3WayResult['result'];
  let recommendation: 'approve' | 'review' | 'reject';
  let confidence = 1.0;
  let summary = '';

  // If neither PO nor GR provided
  if (!poData && !grData) {
    result = 'NOT_APPLICABLE';
    recommendation = 'review'; // Always need human review without reference documents
    confidence = 0.5;
    summary = '참조 문서(PO/GR) 없음. 인적 검토 필요';
  } else if (discrepancies.length === 0) {
    // All checks passed
    result = 'FULL_MATCH';
    recommendation = 'approve';
    confidence = 0.95;
    summary = '완벽 일치. 승인 권장';
  } else {
    // Has discrepancies — check severity
    const hasErrors = discrepancies.some((d) => d.severity === 'error');

    if (hasErrors) {
      result = 'NO_MATCH';
      recommendation = 'reject';
      confidence = 0.1;
      summary = `불일치 감지: ${discrepancies
        .filter((d) => d.severity === 'error')
        .map((d) => d.field)
        .join(', ')}`;
    } else {
      // Only warnings
      result = 'PARTIAL_MATCH';
      recommendation = 'review';
      confidence = 0.65;
      summary = `경미한 불일치: ${discrepancies.map((d) => d.field).join(', ')}`;
    }
  }

  return {
    result,
    discrepancies,
    recommendation,
    confidence,
    summary,
  };
}
