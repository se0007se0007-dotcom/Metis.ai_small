'use client';

import { ReactNode, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { usePagination, Pager } from './usePagination';

export interface ColumnDef<T> {
  key: keyof T;
  header: string;
  render?: (value: unknown, row: T) => ReactNode;
  width?: string;
  sortable?: boolean;
}

interface DataTableProps<T extends { id?: string }> {
  columns: ColumnDef<T>[];
  data: T[];
  isLoading?: boolean;
  isEmpty?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  selectedRowId?: string;
  rowKey?: keyof T;
  pageSize?: number;
}

function SkeletonLoader() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-10 bg-table-alt rounded animate-pulse" />
      ))}
    </div>
  );
}

export function DataTable<T extends { id?: string }>({
  columns,
  data,
  isLoading = false,
  isEmpty = false,
  emptyMessage = 'No data available',
  onRowClick,
  selectedRowId,
  rowKey = 'id' as keyof T,
  pageSize = 10,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<keyof T | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const paged = usePagination(data, pageSize);

  const handleSort = (key: keyof T) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  if (isLoading) {
    return <SkeletonLoader />;
  }

  if (isEmpty || data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 border border-border rounded-lg bg-table-alt">
        <p className="text-sm text-muted-dark">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      {/* Table Header */}
      <div className="grid gap-0 bg-table-header border-b border-border">
        <div
          className="grid gap-0"
          style={{ gridTemplateColumns: columns.map((c) => c.width || '1fr').join(' ') }}
        >
          {columns.map((col) => (
            <div
              key={String(col.key)}
              className="px-4 py-3 flex items-center gap-2 text-xs font-semibold text-muted-dark uppercase tracking-wide cursor-pointer hover:bg-table-alt transition-colors"
              onClick={() => col.sortable && handleSort(col.key)}
            >
              <span>{col.header}</span>
              {col.sortable &&
                sortKey === col.key &&
                (sortDirection === 'asc' ? (
                  <ChevronUp size={14} className="text-accent" />
                ) : (
                  <ChevronDown size={14} className="text-accent" />
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Table Rows */}
      <div className="divide-y divide-border">
        {paged.pageItems.map((row, idx) => {
          const rowId = String(row[rowKey] ?? idx);
          const isSelected = rowId === selectedRowId;

          return (
            <div
              key={rowId}
              onClick={() => onRowClick?.(row)}
              className={clsx(
                'grid gap-0 px-0 transition-colors bg-card',
                onRowClick && 'cursor-pointer hover:bg-table-alt',
                isSelected && 'bg-table-alt border-l-2 border-accent',
              )}
              style={{
                gridTemplateColumns: columns.map((c) => c.width || '1fr').join(' '),
              }}
            >
              {columns.map((col) => (
                <div key={String(col.key)} className="px-4 py-3 text-sm text-dark truncate">
                  {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '-')}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <Pager p={paged} />
    </div>
  );
}
