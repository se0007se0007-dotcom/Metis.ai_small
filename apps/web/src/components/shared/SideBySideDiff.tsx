'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Represents a single column in the diff view
 */
export interface DiffColumn {
  title: string;
  subtitle?: string;
  data: Record<string, any> | null;
  emptyLabel?: string;
}

/**
 * Represents a single field to compare across columns
 */
export interface DiffField {
  key: string;
  label: string;
  format?: (value: any) => string;
  severity?: (values: any[]) => 'ok' | 'warn' | 'error';
}

/**
 * Props for SideBySideDiff component
 */
interface SideBySideDiffProps {
  left: DiffColumn;
  middle?: DiffColumn;
  right?: DiffColumn;
  compareFields: DiffField[];
}

/**
 * SideBySideDiff
 *
 * A 3-column document comparison view used for Invoice/PO/GR matching.
 * - Renders headers with titles and optional subtitles
 * - Each row shows a field value in 2-3 columns
 * - Row background color reflects severity: ok=white, warn=amber-50, error=red-50
 * - Missing columns display em-dash (—) with tooltip
 */
export function SideBySideDiff({ left, middle, right, compareFields }: SideBySideDiffProps) {
  const columns = [left, middle, right].filter(Boolean) as DiffColumn[];
  const numColumns = columns.length;

  /**
   * Get the value for a field from a column
   */
  const getValue = (column: DiffColumn, field: DiffField): any => {
    if (!column.data) return null;
    return column.data[field.key] ?? null;
  };

  /**
   * Format a value for display
   */
  const formatValue = (field: DiffField, value: any): string => {
    if (value === null || value === undefined) return '';
    if (field.format) return field.format(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  /**
   * Determine row severity by comparing values across columns
   */
  const getSeverity = (field: DiffField): 'ok' | 'warn' | 'error' => {
    if (!field.severity) return 'ok';
    const values = columns.map((col) => getValue(col, field));
    return field.severity(values);
  };

  /**
   * Get background color class for severity
   */
  const getSeverityClass = (severity: 'ok' | 'warn' | 'error'): string => {
    switch (severity) {
      case 'ok':
        return 'bg-white';
      case 'warn':
        return 'bg-amber-50';
      case 'error':
        return 'bg-red-50';
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white border border-border rounded-lg">
      {/* Header Row */}
      <div
        className="border-b border-border bg-table-header sticky top-0"
        style={{
          display: 'grid',
          gridTemplateColumns: `150px ${columns.map(() => '1fr').join(' ')}`,
        }}
      >
        <div className="px-4 py-3 bg-table-alt" />
        {columns.map((col, idx) => (
          <div
            key={idx}
            className={clsx('px-4 py-3', idx < columns.length - 1 && 'border-r border-border')}
          >
            <div className="text-xs font-semibold text-dark uppercase tracking-wide">
              {col.title}
            </div>
            {col.subtitle && <div className="text-xs text-muted-dark mt-1">{col.subtitle}</div>}
          </div>
        ))}
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {compareFields.map((field, fieldIdx) => {
          const severity = getSeverity(field);
          const severityClass = getSeverityClass(severity);

          return (
            <div
              key={fieldIdx}
              className={clsx('border-b border-border transition-colors', severityClass)}
              style={{
                display: 'grid',
                gridTemplateColumns: `150px ${columns.map(() => '1fr').join(' ')}`,
              }}
            >
              {/* Field Label Column */}
              <div className="px-4 py-3 border-r border-border bg-table-alt">
                <div className="text-xs font-semibold text-dark">{field.label}</div>
              </div>

              {/* Value Cells */}
              {columns.map((col, colIdx) => {
                const value = getValue(col, field);
                const displayValue =
                  value !== null && value !== undefined ? formatValue(field, value) : '';

                return (
                  <div
                    key={colIdx}
                    className={clsx(
                      'px-4 py-3 text-sm text-dark',
                      colIdx < columns.length - 1 && 'border-r border-border',
                    )}
                    title={displayValue}
                  >
                    {value === null || value === undefined ? (
                      <span className="text-muted-dark" title={col.emptyLabel || '데이터 없음'}>
                        —
                      </span>
                    ) : (
                      <span className="font-mono">{displayValue}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Empty State */}
      {compareFields.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-dark">비교할 항목이 없습니다.</p>
        </div>
      )}
    </div>
  );
}
