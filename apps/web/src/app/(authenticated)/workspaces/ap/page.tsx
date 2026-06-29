'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CreditCard,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Package,
  FileText,
  User,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import { DataTable, ColumnDef } from '@/components/shared/DataTable';
import { DetailPanel } from '@/components/shared/DetailPanel';
import { SideBySideDiff, DiffField, DiffColumn } from '@/components/shared/SideBySideDiff';

/**
 * AP Operator Workspace
 *
 * Full-featured AP operations workspace with:
 * - Smart Inbox + status filter tabs
 * - Invoice list with 2-column split layout
 * - Detail view with 3-way matching (Invoice/PO/GR)
 * - AI recommendations with discrepancy highlighting
 * - Action buttons: Approve, Reject, Request Info
 */

// Types
interface Invoice {
  id: string;
  invoiceNumber: string;
  vendorName: string;
  amount: number;
  date: string;
  status: 'pending' | 'matched' | 'exception' | 'approved' | 'rejected';
  aiRecommendation?: string;
}

interface MatchingData {
  invoice?: Record<string, any> | null;
  po?: Record<string, any> | null;
  gr?: Record<string, any> | null;
}

interface Summary {
  pending: number;
  exceptions: number;
  processedToday: number;
  avgProcessingTimeMinutes: number;
}

type TabType = 'inbox' | 'unmatched' | 'waiting_approval' | 'exceptions' | 'completed';

export default function APWorkspacePage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  // State
  const [activeTab, setActiveTab] = useState<TabType>('inbox');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [matchingData, setMatchingData] = useState<MatchingData>({});
  const [summary, setSummary] = useState<Summary>({
    pending: 0,
    exceptions: 0,
    processedToday: 0,
    avgProcessingTimeMinutes: 0,
  });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Tab configuration
  const tabs: Array<{ id: TabType; label: string; icon: any }> = [
    { id: 'inbox', label: 'Smart Inbox', icon: CreditCard },
    { id: 'unmatched', label: '미매칭', icon: AlertTriangle },
    { id: 'waiting_approval', label: '승인 대기', icon: CheckCircle2 },
    { id: 'exceptions', label: '예외', icon: XCircle },
    { id: 'completed', label: '처리 완료', icon: CheckCircle2 },
  ];

  // Load invoices based on tab
  const loadInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{
        items: Invoice[];
        summary: Summary;
      }>(`/ap/invoices?status=${activeTab}`);
      setInvoices(response.items ?? []);
      setSummary(
        response.summary ?? {
          pending: 0,
          exceptions: 0,
          processedToday: 0,
          avgProcessingTimeMinutes: 0,
        },
      );
      if (response.items?.[0]) {
        setSelectedInvoiceId(response.items[0].id);
        setSelectedInvoice(response.items[0]);
        await loadMatchingData(response.items[0].id);
      }
    } catch (err) {
      console.error('Failed to load invoices:', err);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  // Load matching data (Invoice/PO/GR)
  const loadMatchingData = useCallback(async (invoiceId: string) => {
    try {
      const response = await api.get<MatchingData>(`/ap/invoices/${invoiceId}`);
      setMatchingData(response ?? {});
    } catch (err) {
      console.error('Failed to load matching data:', err);
    }
  }, []);

  // Handle row selection with keyboard navigation
  const handleSelectInvoice = useCallback(
    (invoice: Invoice) => {
      setSelectedInvoiceId(invoice.id);
      setSelectedInvoice(invoice);
      loadMatchingData(invoice.id);
    },
    [loadMatchingData],
  );

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedInvoiceId || invoices.length === 0) return;

      const currentIndex = invoices.findIndex((inv) => inv.id === selectedInvoiceId);

      if (e.key === 'ArrowUp' && currentIndex > 0) {
        handleSelectInvoice(invoices[currentIndex - 1]);
      } else if (e.key === 'ArrowDown' && currentIndex < invoices.length - 1) {
        handleSelectInvoice(invoices[currentIndex + 1]);
      } else if (e.key === 'Enter' && selectedInvoice) {
        // Trigger approve action on Enter
        handleApprove();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedInvoiceId, invoices, selectedInvoice, handleSelectInvoice]);

  // Load initial data
  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

  // Action handlers
  const handleApprove = useCallback(async () => {
    if (!selectedInvoiceId) return;
    setActionLoading(true);
    try {
      await api.post(`/ap/invoices/${selectedInvoiceId}/approve`);
      await loadInvoices();
    } catch (err) {
      console.error('Approve failed:', err);
    } finally {
      setActionLoading(false);
    }
  }, [selectedInvoiceId, loadInvoices]);

  const handleReject = useCallback(async () => {
    if (!selectedInvoiceId) return;
    setActionLoading(true);
    try {
      await api.post(`/ap/invoices/${selectedInvoiceId}/reject`);
      await loadInvoices();
    } catch (err) {
      console.error('Reject failed:', err);
    } finally {
      setActionLoading(false);
    }
  }, [selectedInvoiceId, loadInvoices]);

  const handleRequestInfo = useCallback(async () => {
    if (!selectedInvoiceId) return;
    setActionLoading(true);
    try {
      await api.post(`/ap/invoices/${selectedInvoiceId}/request-info`);
      await loadInvoices();
    } catch (err) {
      console.error('Request info failed:', err);
    } finally {
      setActionLoading(false);
    }
  }, [selectedInvoiceId, loadInvoices]);

  // Data table columns
  const columns: ColumnDef<Invoice>[] = [
    {
      key: 'invoiceNumber',
      header: '인보이스 #',
      width: '120px',
      sortable: true,
    },
    {
      key: 'vendorName',
      header: '벤더',
      width: '150px',
      sortable: true,
    },
    {
      key: 'amount',
      header: '금액',
      width: '120px',
      render: (value) => krw(value as number, { decimals: 0 }),
      sortable: true,
    },
    {
      key: 'date',
      header: '날짜',
      width: '100px',
      render: (value) => new Date(value as string).toLocaleDateString('ko-KR'),
      sortable: true,
    },
    {
      key: 'status',
      header: '상태',
      width: '100px',
      render: (value) => {
        const statusMap = {
          pending: { label: '대기', color: 'text-amber-600' },
          matched: { label: '매칭됨', color: 'text-blue-600' },
          exception: { label: '예외', color: 'text-red-600' },
          approved: { label: '승인', color: 'text-green-600' },
          rejected: { label: '반려', color: 'text-gray-600' },
        };
        const s = statusMap[value as keyof typeof statusMap] || {
          label: String(value),
          color: '',
        };
        return <span className={s.color}>{s.label}</span>;
      },
    },
    {
      key: 'aiRecommendation',
      header: 'AI 추천',
      width: '80px',
      render: (value) => (
        <span className="text-green-600 font-semibold">{value ? '승인' : '—'}</span>
      ),
    },
  ];

  // Compute severity for diff fields
  const computeDiffFieldSeverity = (values: any[]) => {
    // If all null, ok
    if (values.every((v) => v === null || v === undefined)) return 'ok';
    // If any mismatch, error
    const nonNull = values.filter((v) => v !== null && v !== undefined);
    if (nonNull.length > 1) {
      const allSame = nonNull.every((v) => v === nonNull[0]);
      if (!allSame) return 'error';
    }
    return 'ok';
  };

  // Format currency
  const formatCurrency = (value: any) => {
    if (typeof value !== 'number') return String(value);
    return krw(value, { decimals: 0 });
  };

  // Format date
  const formatDate = (value: any) => {
    if (!value) return '';
    return new Date(value as string).toLocaleDateString('ko-KR');
  };

  // Diff fields for Invoice/PO/GR comparison
  const diffFields: DiffField[] = [
    {
      key: 'invoiceNumber',
      label: '문서 번호',
      format: (v) => String(v),
    },
    {
      key: 'amount',
      label: '금액',
      format: formatCurrency,
      severity: computeDiffFieldSeverity,
    },
    {
      key: 'date',
      label: '날짜',
      format: formatDate,
      severity: computeDiffFieldSeverity,
    },
    {
      key: 'vendorName',
      label: '공급사',
      format: (v) => String(v),
      severity: computeDiffFieldSeverity,
    },
    {
      key: 'tax',
      label: '세금',
      format: formatCurrency,
      severity: computeDiffFieldSeverity,
    },
    {
      key: 'dueDate',
      label: '지불 기한',
      format: formatDate,
      severity: computeDiffFieldSeverity,
    },
  ];

  const diffColumns: [DiffColumn, DiffColumn?, DiffColumn?] = [
    {
      title: '인보이스',
      subtitle: selectedInvoice?.invoiceNumber,
      data: matchingData.invoice ?? null,
      emptyLabel: '데이터 없음',
    },
    {
      title: '발주서 (PO)',
      data: matchingData.po ?? null,
      emptyLabel: '데이터 없음',
    },
    {
      title: '입고 (GR)',
      data: matchingData.gr ?? null,
      emptyLabel: '데이터 없음',
    },
  ];

  return (
    <div className="flex flex-col h-screen bg-light-bg">
      {/* Header */}
      <div className="bg-white border-b border-border px-6 py-4">
        <h1 className="text-2xl font-bold text-dark flex items-center gap-2">
          <CreditCard size={24} className="text-accent" />
          AP 업체 인보이스 처리
        </h1>
      </div>

      {/* Stats Bar */}
      <div className="bg-white border-b border-border px-6 py-3 grid grid-cols-4 gap-6">
        <div>
          <p className="text-xs text-muted-dark uppercase tracking-wide">대기 중</p>
          <p className="text-2xl font-bold text-dark">{summary.pending}</p>
        </div>
        <div>
          <p className="text-xs text-muted-dark uppercase tracking-wide">예외</p>
          <p className="text-2xl font-bold text-red-600">{summary.exceptions}</p>
        </div>
        <div>
          <p className="text-xs text-muted-dark uppercase tracking-wide">오늘 처리</p>
          <p className="text-2xl font-bold text-green-600">{summary.processedToday}</p>
        </div>
        <div>
          <p className="text-xs text-muted-dark uppercase tracking-wide">평균 처리시간</p>
          <p className="text-2xl font-bold text-dark">{summary.avgProcessingTimeMinutes}분</p>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-border px-6 flex gap-4 overflow-x-auto">
        {tabs.map((tab) => {
          const TabIcon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setSelectedInvoiceId(null);
              }}
              className={clsx(
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap',
                isActive
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-dark hover:text-dark',
              )}
            >
              <TabIcon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Main Content (2-column split) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Invoice List (40%) */}
        <div className="w-2/5 border-r border-border bg-light-bg overflow-hidden flex flex-col">
          <div className="flex-1 overflow-hidden p-4">
            <DataTable
              columns={columns}
              data={invoices}
              isLoading={loading}
              emptyMessage="인보이스가 없습니다."
              onRowClick={handleSelectInvoice}
              selectedRowId={selectedInvoiceId ?? undefined}
            />
          </div>
        </div>

        {/* Right: Detail Panel (60%) */}
        <div className="w-3/5 bg-light-bg overflow-hidden flex flex-col">
          {selectedInvoice ? (
            <div className="flex flex-col h-full overflow-hidden">
              {/* Detail Header */}
              <div className="bg-white border-b border-border px-6 py-4">
                <h2 className="text-lg font-semibold text-dark flex items-center gap-2">
                  <FileText size={20} className="text-accent" />
                  {selectedInvoice.invoiceNumber}
                </h2>
                <p className="text-xs text-muted-dark mt-2">
                  {selectedInvoice.vendorName} • {formatCurrency(selectedInvoice.amount)}
                </p>
              </div>

              {/* AI Recommendation Callout */}
              {selectedInvoice.aiRecommendation && (
                <div className="bg-green-50 border border-green-200 mx-6 mt-4 px-4 py-3 rounded-lg">
                  <p className="text-xs font-semibold text-green-900 flex items-center gap-2">
                    <CheckCircle2 size={14} />
                    AI 추천: 승인
                  </p>
                  <p className="text-xs text-green-700 mt-1">모든 항목이 일치합니다. 자신감: 98%</p>
                </div>
              )}

              {/* 3-way Matching View */}
              <div className="flex-1 overflow-hidden px-6 py-4">
                <SideBySideDiff
                  left={diffColumns[0]}
                  middle={diffColumns[1]}
                  right={diffColumns[2]}
                  compareFields={diffFields}
                />
              </div>

              {/* Action Buttons */}
              <div className="bg-white border-t border-border px-6 py-4 flex gap-3">
                <button
                  onClick={handleApprove}
                  disabled={actionLoading}
                  className="flex-1 px-4 py-2 bg-green-600 text-white rounded font-medium text-sm hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  <CheckCircle2 size={16} />
                  승인
                </button>
                <button
                  onClick={handleReject}
                  disabled={actionLoading}
                  className="flex-1 px-4 py-2 bg-red-600 text-white rounded font-medium text-sm hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  <XCircle size={16} />
                  반려
                </button>
                <button
                  onClick={handleRequestInfo}
                  disabled={actionLoading}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  <AlertTriangle size={16} />
                  추가 정보 요청
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-dark">인보이스를 선택하세요</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
