'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { api } from '@/lib/api-client';
import { History, AlertCircle, RefreshCw, X } from 'lucide-react';

// ── Types ──

interface VersionPromotion {
  id: string;
  packId: string;
  fromVersionId: string;
  toVersionId: string;
  action: string;
  sourceType: string;
  reason?: string;
  decidedBy: string;
  evaluationSummaryJson?: string;
  createdAt: string;
}

interface PromotionStats {
  totalPromotions: number;
  promotionCount: number;
  rollbackCount: number;
}

// ── Page ──

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState<VersionPromotion[]>([]);
  const [stats, setStats] = useState<PromotionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPromotion, setSelectedPromotion] = useState<VersionPromotion | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [actionFilter, setActionFilter] = useState('');
  const [packIdFilter, setPackIdFilter] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (actionFilter) params.set('action', actionFilter);
      if (packIdFilter) params.set('packId', packIdFilter);
      const [promotionsData, statsData] = await Promise.all([
        api.get<{ items: VersionPromotion[] }>(`/release/promotions?${params.toString()}`),
        api.get<PromotionStats>('/release/promotions/stats/summary'),
      ]);
      setPromotions(promotionsData?.items ?? []);
      setStats(statsData ?? null);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [actionFilter, packIdFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSelectPromotion = (promotion: VersionPromotion) => {
    setSelectedPromotion(promotion);
    setShowDetailModal(true);
  };

  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';

  return (
    <div className="p-6">
      <PageHeader
        title="Version History"
        description="Track all version promotions and rollbacks"
        actions={
          <button onClick={fetchData} className="p-1.5 text-muted-dark hover:text-dark transition">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        }
      />

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <SC label="Total Promotions" value={stats.totalPromotions} c="white" />
          <SC label="Promotions" value={stats.promotionCount} c="success" />
          <SC label="Rollbacks" value={stats.rollbackCount} c="danger" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Filters */}
      <div className="mb-6 flex gap-3">
        <input
          type="text"
          value={packIdFilter}
          onChange={(e) => setPackIdFilter(e.target.value)}
          placeholder="Filter by Pack ID..."
          className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs text-gray-900 placeholder-gray-400"
        />
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs text-gray-900"
        >
          <option value="">All Actions</option>
          <option value="PROMOTE">Promote</option>
          <option value="ROLLBACK">Rollback</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <th className="text-left px-4 py-3">Pack</th>
                <th className="text-left px-4 py-3">From Version</th>
                <th className="text-left px-4 py-3">To Version</th>
                <th className="text-center px-4 py-3">Action</th>
                <th className="text-center px-4 py-3">Source Type</th>
                <th className="text-left px-4 py-3">Decided By</th>
                <th className="text-left px-4 py-3">Created</th>
                <th className="text-center px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {promotions.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="text-center text-gray-500 text-xs py-8">
                    No promotions yet
                  </td>
                </tr>
              )}
              {promotions.map((promo) => (
                <tr key={promo.id} className="border-b border-gray-200 hover:bg-gray-50 transition">
                  <td className="px-4 py-3 text-xs text-gray-900 font-medium">
                    {promo.packId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-xs text-accent font-mono">{promo.fromVersionId}</td>
                  <td className="px-4 py-3 text-xs text-accent font-mono">{promo.toVersionId}</td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`text-[10px] font-semibold px-2 py-1 rounded inline-block ${
                        promo.action === 'PROMOTE'
                          ? 'bg-success/20 text-success'
                          : 'bg-danger/20 text-danger'
                      }`}
                    >
                      {promo.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 text-center">{promo.sourceType}</td>
                  <td className="px-4 py-3 text-xs text-gray-900">{promo.decidedBy}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmt(promo.createdAt)}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleSelectPromotion(promo)}
                      className="text-accent hover:text-accent/70 transition text-xs font-semibold"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Modal */}
      {showDetailModal && selectedPromotion && (
        <DetailModal
          promotion={selectedPromotion}
          onClose={() => {
            setShowDetailModal(false);
            setSelectedPromotion(null);
          }}
        />
      )}
    </div>
  );
}

function SC({ label, value, c }: { label: string; value: number | string; c: string }) {
  const cm: Record<string, string> = {
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    white: 'text-gray-900',
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold ${cm[c] ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function DetailModal({ promotion, onClose }: { promotion: VersionPromotion; onClose: () => void }) {
  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';

  const evaluationSummary = promotion.evaluationSummaryJson
    ? (() => {
        try {
          return JSON.parse(promotion.evaluationSummaryJson);
        } catch {
          return null;
        }
      })()
    : null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white border border-gray-200 rounded-lg w-full max-w-2xl p-6 my-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Promotion Details</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Header Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Action</p>
              <span
                className={`text-sm font-semibold px-2 py-1 rounded inline-block ${
                  promotion.action === 'PROMOTE'
                    ? 'bg-success/20 text-success'
                    : 'bg-danger/20 text-danger'
                }`}
              >
                {promotion.action}
              </span>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Source Type</p>
              <p className="text-sm text-gray-900 font-semibold">{promotion.sourceType}</p>
            </div>
          </div>

          {/* Version Info */}
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Pack</p>
              <p className="text-sm text-gray-900 font-mono">{promotion.packId}</p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">From Version</p>
              <p className="text-sm text-accent font-mono">{promotion.fromVersionId}</p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">To Version</p>
              <p className="text-sm text-accent font-mono">{promotion.toVersionId}</p>
            </div>
          </div>

          {/* Metadata */}
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Decided By</p>
              <p className="text-sm text-gray-900 font-medium">{promotion.decidedBy}</p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Created</p>
              <p className="text-sm text-gray-900 font-medium">{fmt(promotion.createdAt)}</p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">ID</p>
              <p className="text-sm text-gray-500 font-mono">{promotion.id.slice(0, 8)}</p>
            </div>
          </div>

          {/* Reason */}
          {promotion.reason && (
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Reason</p>
              <p className="text-sm text-gray-900">{promotion.reason}</p>
            </div>
          )}

          {/* Evaluation Summary */}
          {evaluationSummary && (
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
                Evaluation Summary
              </p>
              <div className="space-y-2">
                {Object.entries(evaluationSummary).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">{key}:</span>
                    <span className="text-gray-900 font-medium">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs font-semibold text-gray-900 hover:bg-gray-100 transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
