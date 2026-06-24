'use client';

/**
 * Governance > 정책 제안 (Phase 2)
 *
 * 평가 이력 분석으로 생성된 정책 조정 제안을 검토/승인/거부한다.
 * 백엔드:
 *   POST /governance/policy-suggestions/analyze
 *   GET  /governance/policy-suggestions?status=
 *   POST /governance/policy-suggestions/:id/approve
 *   POST /governance/policy-suggestions/:id/reject
 *   GET  /governance/policy-suggestions/sampling
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { api } from '@/lib/api-client';
import {
  RefreshCw,
  Play,
  Check,
  X,
  AlertCircle,
  CheckCircle2,
  TrendingDown,
  ShieldAlert,
  DollarSign,
  Activity,
  Gauge,
} from 'lucide-react';

interface ProposedChange {
  field: string;
  from: number | boolean;
  to: number | boolean;
}

interface PolicySuggestion {
  id: string;
  policyName: string;
  agentGroup: string | null;
  patternType: string;
  agentName: string | null;
  severity: 'low' | 'medium' | 'high';
  title: string;
  rationale: string;
  proposedChanges: ProposedChange[];
  evidenceJson: Record<string, unknown> | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED';
  createdAt: string;
}

interface SamplingRate {
  key: string;
  rate: number;
  healthyStreak: number;
}

const PATTERN_META: Record<string, { label: string; icon: React.ReactNode }> = {
  repeated_security_failure: {
    label: '보안 반복 실패',
    icon: <ShieldAlert size={14} className="text-red-500" />,
  },
  quality_decline: {
    label: '품질 하락',
    icon: <TrendingDown size={14} className="text-amber-500" />,
  },
  cost_overrun: { label: '비용 초과', icon: <DollarSign size={14} className="text-emerald-500" /> },
  anomaly_surge: { label: '이상 급증', icon: <Activity size={14} className="text-violet-500" /> },
};

const SEVERITY_STYLE: Record<string, string> = {
  high: 'bg-red-100 text-red-700 border-red-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  low: 'bg-blue-100 text-blue-700 border-blue-200',
};

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  APPLIED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-gray-200 text-gray-600',
};

export default function PolicySuggestionsPage() {
  const [items, setItems] = useState<PolicySuggestion[]>([]);
  const [sampling, setSampling] = useState<SamplingRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('PENDING');

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = statusFilter ? `?status=${statusFilter}` : '';
      const [list, samp] = await Promise.all([
        api.get<{ items: PolicySuggestion[] }>(`/governance/policy-suggestions${q}`),
        api
          .get<{ rates: SamplingRate[] }>('/governance/policy-suggestions/sampling')
          .catch(() => ({ rates: [] })),
      ]);
      setItems(Array.isArray(list?.items) ? list.items : []);
      setSampling(Array.isArray(samp?.rates) ? samp.rates : []);
    } catch (err: any) {
      setError(err?.message ?? '제안 목록을 불러오지 못했습니다');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const runAnalysis = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await api.post<{ count: number }>(
        '/governance/policy-suggestions/analyze?days=30',
      );
      showToast(`분석 완료 — 새 제안 ${res?.count ?? 0}건`);
      setStatusFilter('PENDING');
      await fetchData();
    } catch (err: any) {
      setError(err?.message ?? '분석에 실패했습니다');
    } finally {
      setAnalyzing(false);
    }
  };

  const decide = async (id: string, action: 'approve' | 'reject') => {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/governance/policy-suggestions/${id}/${action}`);
      showToast(action === 'approve' ? '제안을 승인·적용했습니다.' : '제안을 거부했습니다.');
      await fetchData();
    } catch (err: any) {
      setError(err?.message ?? '처리에 실패했습니다');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6">
      <SubTabs items={[{ label: '정책코드', href: '/governance/policies' }, { label: '평가 Gate', href: '/governance/evaluation-policy' }, { label: '정책 제안', href: '/governance/policy-suggestions' }]} />
      <PageHeader
        title="정책 제안 (Feedback Loop)"
        description="평가 이력 분석으로 도출된 Gate 정책 조정 제안을 검토하고 승인합니다."
        actions={
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-1.5 bg-white border border-gray-200 rounded text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
            >
              <option value="">전체</option>
              <option value="PENDING">검토 대기</option>
              <option value="APPLIED">적용됨</option>
              <option value="APPROVED">승인됨</option>
              <option value="REJECTED">거부됨</option>
            </select>
            <button
              onClick={fetchData}
              className="p-1.5 text-gray-500 hover:text-gray-900 transition"
              title="새로고침"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={runAnalysis}
              disabled={analyzing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-gray-50 rounded text-xs font-semibold hover:bg-blue-600/90 disabled:opacity-50 transition"
            >
              <Play size={13} className={analyzing ? 'animate-pulse' : ''} />
              지금 분석
            </button>
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2 bg-green-100 border border-green-200 rounded text-xs text-green-700">
          <CheckCircle2 size={14} />
          {toast}
        </div>
      )}

      {/* 적응형 샘플링 현황 */}
      {sampling.length > 0 && (
        <div className="bg-gray-50 rounded-lg border border-gray-200 mb-6">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
            <Gauge size={14} className="text-violet-600" />
            <span className="text-xs font-semibold text-gray-900">
              적응형 샘플링 현황 (LLM Judge 빈도)
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
            {sampling.map((s) => (
              <div key={s.key} className="bg-white rounded border border-gray-200 p-3">
                <p className="text-[10px] text-gray-500 truncate" title={s.key}>
                  {s.key.split('::').pop()}
                </p>
                <p className="text-lg font-bold text-gray-900">{Math.round(s.rate * 100)}%</p>
                <p className="text-[10px] text-gray-400">정상 연속 {s.healthyStreak}회</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 제안 목록 */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-28 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-10 text-center">
          <Activity size={28} className="mx-auto mb-3 text-gray-300" />
          <p className="text-xs text-gray-500">
            표시할 제안이 없습니다. "지금 분석"으로 최근 평가 이력을 점검하세요.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((s) => {
            const meta = PATTERN_META[s.patternType] ?? {
              label: s.patternType,
              icon: <Activity size={14} />,
            };
            return (
              <div key={s.id} className="bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex items-start justify-between gap-4 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      {meta.icon}
                      <span className="text-[10px] text-gray-500">{meta.label}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${SEVERITY_STYLE[s.severity]}`}
                      >
                        {s.severity.toUpperCase()}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${STATUS_STYLE[s.status]}`}
                      >
                        {s.status}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-1">{s.title}</h3>
                    <p className="text-xs text-gray-600 leading-relaxed">{s.rationale}</p>

                    {Array.isArray(s.proposedChanges) && s.proposedChanges.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {s.proposedChanges.map((c, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded text-[10px] font-mono text-gray-700"
                          >
                            {c.field}:{' '}
                            <span className="text-gray-400 line-through">{String(c.from)}</span> →{' '}
                            <span className="text-blue-600 font-semibold">{String(c.to)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {Array.isArray(s.proposedChanges) && s.proposedChanges.length === 0 && (
                      <p className="mt-2 text-[10px] text-gray-400">
                        자동 정책 변경 없음 — 운영자 검토 권고만 제시
                      </p>
                    )}
                  </div>

                  {s.status === 'PENDING' && (
                    <div className="flex flex-col gap-2 flex-shrink-0">
                      <button
                        onClick={() => decide(s.id, 'approve')}
                        disabled={busyId === s.id}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-700 disabled:opacity-50 transition"
                      >
                        <Check size={13} /> 승인·적용
                      </button>
                      <button
                        onClick={() => decide(s.id, 'reject')}
                        disabled={busyId === s.id}
                        className="flex items-center gap-1 px-3 py-1.5 border border-gray-200 text-gray-600 rounded text-xs font-semibold hover:text-gray-900 disabled:opacity-50 transition"
                      >
                        <X size={13} /> 거부
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
