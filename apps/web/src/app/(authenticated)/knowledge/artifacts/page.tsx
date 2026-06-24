'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { api } from '@/lib/api-client';
import { RefreshCw, AlertCircle, TrendingUp, TrendingDown, Users } from 'lucide-react';

// ── Types ──

interface UtilRow {
  id: string;
  title: string;
  category: string;
  usageCount: number;
  lastUsedAt: string | null;
}

interface Utilization {
  mostUsed: UtilRow[];
  unused: UtilRow[];
  byAgent?: { agentName: string; count: number }[];
  totals?: { totalActive: number; totalUsedInWindow: number; windowDays: number };
  totalActive?: number;
  totalUsedInWindow?: number;
}

// ── Page ──

export default function ArtifactsPage() {
  const [data, setData] = useState<Utilization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  const fetchUtil = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Utilization>(`/knowledge/utilization?days=${days}`);
      setData(res);
    } catch (err: any) {
      setError(err?.message ?? '활용도 데이터를 불러오지 못했습니다');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchUtil();
  }, [fetchUtil]);

  const totalActive = data?.totals?.totalActive ?? data?.totalActive ?? 0;
  const totalUsed = data?.totals?.totalUsedInWindow ?? data?.totalUsedInWindow ?? 0;
  const unusedCount = data?.unused?.length ?? 0;
  const maxUsage = Math.max(1, ...(data?.mostUsed ?? []).map((m) => m.usageCount));

  return (
    <div className="p-6">
      <SubTabs items={[{ label: '지식 등록·관리', href: '/knowledge/registry' }, { label: '활용도', href: '/knowledge/artifacts' }]} />
      <PageHeader
        title="지식 활용도 (Knowledge Utilization)"
        description="어떤 운영 지식이 얼마나 쓰이고, 어떤 지식이 사용되지 않는지 추적합니다"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="px-2 py-1 bg-gray-50 border border-gray-200 rounded text-xs text-gray-900"
            >
              <option value={7}>최근 7일</option>
              <option value={30}>최근 30일</option>
              <option value={90}>최근 90일</option>
            </select>
            <button
              onClick={fetchUtil}
              className="p-1.5 text-gray-500 hover:text-gray-900 transition"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
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

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="활성 지식" value={totalActive} color="white" />
        <StatCard label={`최근 ${days}일 사용 지식`} value={totalUsed} color="success" />
        <StatCard label="미활용 지식" value={unusedCount} color="danger" />
        <StatCard
          label="활용률"
          value={totalActive > 0 ? `${Math.round((totalUsed / totalActive) * 100)}%` : '0%'}
          color="accent"
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-4">
          {[...Array(2)].map((_, i) => (
            <div
              key={i}
              className="h-64 bg-gray-50 rounded-lg border border-gray-200 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {/* Most used */}
          <div className="bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
              <TrendingUp size={14} className="text-green-600" />
              <span className="text-xs font-semibold text-gray-900">
                많이 쓰이는 지식 (Top {data?.mostUsed?.length ?? 0})
              </span>
            </div>
            <div className="p-3 space-y-2">
              {(data?.mostUsed?.length ?? 0) === 0 ? (
                <p className="text-xs text-gray-500 py-6 text-center">활용된 지식이 없습니다</p>
              ) : (
                data!.mostUsed.map((m, idx) => (
                  <div key={m.id} className="p-2.5 bg-white rounded border border-gray-200">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-900 truncate">
                        <span className="text-gray-500 mr-1.5">#{idx + 1}</span>
                        {m.title}
                      </span>
                      <span className="text-xs font-bold text-green-600 flex-shrink-0">
                        {m.usageCount}회
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${(m.usageCount / maxUsage) * 100}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500">
                      <span>{m.category}</span>
                      <span>
                        {m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleDateString('ko-KR') : '-'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Unused */}
          <div className="bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
              <TrendingDown size={14} className="text-red-600" />
              <span className="text-xs font-semibold text-gray-900">
                미활용 지식 ({data?.unused?.length ?? 0}) — 정리/개선 후보
              </span>
            </div>
            <div className="p-3 space-y-2 max-h-[420px] overflow-y-auto">
              {(data?.unused?.length ?? 0) === 0 ? (
                <p className="text-xs text-gray-500 py-6 text-center">
                  모든 활성 지식이 활용되고 있습니다
                </p>
              ) : (
                data!.unused.map((u) => (
                  <div
                    key={u.id}
                    className="p-2.5 bg-red-50 rounded border border-red-200 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-900 truncate">{u.title}</p>
                      <p className="text-[10px] text-gray-500">{u.category}</p>
                    </div>
                    <span className="text-[10px] text-red-600 font-semibold flex-shrink-0">
                      {u.usageCount === 0 ? '0회' : `오래됨 (${u.usageCount}회)`}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* By agent */}
      {!loading && data?.byAgent && data.byAgent.length > 0 && (
        <div className="mt-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
            <Users size={14} className="text-accent" />
            <span className="text-xs font-semibold text-gray-900">에이전트별 지식 활용</span>
          </div>
          <div className="p-3 grid grid-cols-2 md:grid-cols-3 gap-2">
            {data.byAgent.map((b) => (
              <div
                key={b.agentName}
                className="flex items-center justify-between p-2 bg-white rounded border border-gray-200"
              >
                <span className="text-xs text-gray-900 truncate">{b.agentName}</span>
                <span className="text-xs font-semibold text-accent flex-shrink-0">{b.count}회</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stat Card ──

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    accent: 'text-blue-600',
    success: 'text-green-600',
    warning: 'text-amber-600',
    danger: 'text-red-600',
    white: 'text-gray-900',
  };

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorMap[color] ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
