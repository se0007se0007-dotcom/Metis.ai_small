'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import {
  RefreshCw,
  AlertTriangle,
  AlertOctagon,
  ShieldAlert,
  Activity,
  AlertCircle,
  Users,
} from 'lucide-react';

// ── Types (백엔드 DTO와 정렬) ──

type AnomalyType =
  | 'latency_trend'
  | 'accuracy_drift'
  | 'token_spike'
  | 'error_surge'
  | 'security_pattern';

type AnomalySeverity = 'critical' | 'warning' | 'info';

interface AnomalyAlert {
  id: string;
  workflowKey: string;
  agentName: string;
  stepKey: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  detail: string;
  value: number;
  threshold: number;
  algorithm: string;
  detectedAt: string;
}

interface AnomalyResponse {
  items: AnomalyAlert[];
  summary: {
    total: number;
    bySeverity: { critical: number; warning: number; info: number };
    byType: {
      latency_trend: number;
      accuracy_drift: number;
      token_spike: number;
      error_surge: number;
      security_pattern: number;
    };
    byAgent: Array<{ agentName: string; count: number }>;
  };
  heatmap: Array<{ date: string; type: AnomalyType; count: number }>;
  window: { days: number; since: string };
}

// ── Constants ──

const TYPE_LABELS: Record<AnomalyType, string> = {
  latency_trend: '지연 추세',
  accuracy_drift: '정확도 드리프트',
  token_spike: '토큰 급증',
  error_surge: '오류 급증',
  security_pattern: '보안 패턴',
};

const TYPE_ORDER: AnomalyType[] = [
  'latency_trend',
  'accuracy_drift',
  'token_spike',
  'error_surge',
  'security_pattern',
];

// ── Helpers ──

function severityBadgeClass(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return 'bg-danger/20 text-danger';
    case 'warning':
      return 'bg-warning/20 text-warning';
    default:
      return 'bg-accent/20 text-accent';
  }
}

function severityLabel(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return 'CRITICAL';
    case 'warning':
      return 'WARNING';
    default:
      return 'INFO';
  }
}

function formatDateTime(iso: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR');
}

// ── Page Component ──

export default function AnomaliesPage() {
  const [data, setData] = useState<AnomalyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [workflowFilter, setWorkflowFilter] = useState<string>('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('days', String(days));
      if (workflowFilter.trim()) params.set('workflowKey', workflowFilter.trim());
      if (severityFilter) params.set('severity', severityFilter);
      if (typeFilter) params.set('type', typeFilter);
      const res = await api.get<AnomalyResponse>(`/evaluator/anomalies?${params.toString()}`);
      setData(res);
    } catch (err: any) {
      setError(err?.message ?? '이상 감지 데이터를 불러오지 못했습니다');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days, severityFilter, typeFilter, workflowFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const summary = data?.summary;
  const items = data?.items ?? [];
  const itemsPage = usePagination(items, 10);
  const heatmap = data?.heatmap ?? [];

  // heatmap: date × type → count
  const heatmapDates = Array.from(new Set(heatmap.map((h) => h.date))).sort();
  const heatmapMap = new Map<string, number>();
  let maxHeat = 1;
  for (const h of heatmap) {
    heatmapMap.set(`${h.date}|${h.type}`, h.count);
    if (h.count > maxHeat) maxHeat = h.count;
  }

  return (
    <div className="p-6">
      <SubTabs items={[{ label: '이상 감지', href: '/insights/anomalies' }, { label: '리스크 워크스페이스', href: '/workspaces/risk' }]} />
      <PageHeader
        title="이상 감지 (Anomalies)"
        description="에이전트 평가 신호 기반 이상 탐지 — 지연·정확도·토큰·오류·보안 패턴"
        actions={
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {([7, 30, 90] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded border transition ${
                    days === d
                      ? 'bg-accent/20 border-accent text-accent'
                      : 'border-border text-muted-dark hover:text-dark'
                  }`}
                >
                  {d}일
                </button>
              ))}
            </div>
            <button onClick={fetchData} className="p-1.5 text-muted-dark hover:text-dark transition">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* KPI 타일 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={Activity} label="총 이상 건수" value={summary?.total ?? 0} color="accent" />
        <StatCard
          icon={ShieldAlert}
          label="CRITICAL"
          value={summary?.bySeverity?.critical ?? 0}
          color="danger"
        />
        <StatCard
          icon={AlertOctagon}
          label="WARNING"
          value={summary?.bySeverity?.warning ?? 0}
          color="warning"
        />
        <StatCard
          icon={AlertTriangle}
          label="INFO"
          value={summary?.bySeverity?.info ?? 0}
          color="accent"
        />
      </div>

      {/* 유형 분포 + 상위 에이전트 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <p className="text-xs font-semibold text-gray-900 mb-3">유형별 분포 (5 유형)</p>
          {!summary ? (
            <div className="h-10 bg-gray-100 rounded animate-pulse" />
          ) : (
            <div className="space-y-2.5">
              {TYPE_ORDER.map((t) => {
                const count = summary.byType[t] ?? 0;
                const total = TYPE_ORDER.reduce((acc, k) => acc + (summary.byType[k] ?? 0), 0);
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <div key={t}>
                    <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
                      <span>{TYPE_LABELS[t]}</span>
                      <span className="font-mono text-gray-900">{count}</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
            <Users size={14} className="text-accent" />
            <span className="text-xs font-semibold text-gray-900">상위 에이전트</span>
            <span className="text-[10px] text-gray-500 ml-auto">{summary?.byAgent?.length ?? 0}개</span>
          </div>
          {loading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : !summary?.byAgent?.length ? (
            <div className="p-8 text-center text-gray-500">
              <Users size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-xs">에이전트 데이터가 없습니다</p>
            </div>
          ) : (
            <div className="divide-y divide-white/10">
              {summary.byAgent.map((a) => {
                const max = Math.max(1, ...summary.byAgent.map((x) => x.count));
                const pct = (a.count / max) * 100;
                return (
                  <div key={a.agentName} className="px-4 py-2.5">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-gray-900 font-medium truncate">{a.agentName}</span>
                      <span className="font-mono text-gray-500">{a.count}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-warning rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 히트맵 (날짜 × 유형) */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 mb-6">
        <p className="text-xs font-semibold text-gray-900 mb-4">
          이상 발생 히트맵 (가로축=날짜, 세로축=유형)
        </p>
        {loading ? (
          <div className="h-32 bg-gray-100 rounded animate-pulse" />
        ) : !heatmapDates.length ? (
          <div className="p-6 text-center text-gray-500 text-xs">히트맵 데이터가 없습니다</div>
        ) : (
          <div className="overflow-x-auto">
            <div className="flex gap-2">
              {/* 유형 라벨 */}
              <div className="flex flex-col gap-0.5 justify-start pt-0 shrink-0">
                {TYPE_ORDER.map((t) => (
                  <div
                    key={t}
                    className="h-6 flex items-center text-[10px] text-gray-500 whitespace-nowrap pr-2"
                  >
                    {TYPE_LABELS[t]}
                  </div>
                ))}
              </div>
              {/* 셀 */}
              <div className="flex gap-1">
                {heatmapDates.map((date) => (
                  <div key={date} className="flex flex-col gap-0.5">
                    {TYPE_ORDER.map((t) => {
                      const count = heatmapMap.get(`${date}|${t}`) ?? 0;
                      const intensity = count > 0 ? 0.2 + (count / maxHeat) * 0.8 : 0;
                      return (
                        <div
                          key={t}
                          className="w-6 h-6 rounded border border-gray-200"
                          style={{
                            backgroundColor:
                              count > 0 ? `rgba(0, 180, 216, ${intensity})` : 'rgba(255,255,255,0.04)',
                          }}
                          title={`${date} · ${TYPE_LABELS[t]} · ${count}건`}
                        />
                      );
                    })}
                    <div className="text-[8px] text-gray-500/60 text-center mt-0.5 w-6 truncate">
                      {date.slice(5)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 필터 + 상세 목록 */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-900 mr-auto">이상 상세 목록</span>
          <input
            type="text"
            value={workflowFilter}
            onChange={(e) => setWorkflowFilter(e.target.value)}
            placeholder="workflowKey"
            className="px-3 py-1.5 text-xs bg-white border border-gray-200 rounded text-gray-900 placeholder:text-gray-400/50 focus:outline-none focus:ring-1 focus:ring-accent/50 w-40"
          />
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-gray-200 rounded text-gray-900 focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            <option value="">모든 심각도</option>
            <option value="critical">CRITICAL</option>
            <option value="warning">WARNING</option>
            <option value="info">INFO</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-gray-200 rounded text-gray-900 focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            <option value="">모든 유형</option>
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-gray-500">{items.length}건</span>
        </div>

        {loading ? (
          <div className="p-4 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <AlertCircle size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-xs">해당하는 이상이 없습니다</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                  <th className="text-left px-4 py-2">시각</th>
                  <th className="text-left px-4 py-2">에이전트</th>
                  <th className="text-left px-4 py-2">유형</th>
                  <th className="text-center px-4 py-2">심각도</th>
                  <th className="text-left px-4 py-2">설명</th>
                  <th className="text-right px-4 py-2">값 / 임계값</th>
                  <th className="text-left px-4 py-2">알고리즘</th>
                </tr>
              </thead>
              <tbody>
                {itemsPage.pageItems.map((a, idx) => (
                  <tr
                    key={`${a.id}-${a.type}-${idx}`}
                    className="border-b border-gray-200 hover:bg-gray-50 transition align-top"
                  >
                    <td className="px-4 py-2.5 text-[11px] text-gray-500 whitespace-nowrap">
                      {formatDateTime(a.detectedAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="text-xs text-gray-900 font-medium">{a.agentName}</p>
                      <p className="text-[10px] text-gray-500 font-mono">{a.workflowKey}</p>
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-gray-500 whitespace-nowrap">
                      {TYPE_LABELS[a.type] ?? a.type}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${severityBadgeClass(a.severity)}`}
                      >
                        {severityLabel(a.severity)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-gray-500 max-w-xs">{a.detail}</td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500 whitespace-nowrap">
                      {a.value} / {a.threshold}
                    </td>
                    <td className="px-4 py-2.5 text-[10px] text-gray-500 font-mono whitespace-nowrap">
                      {a.algorithm}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager p={itemsPage} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub Components ──

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any;
  label: string;
  value: number | string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
        <Icon size={14} className={colorMap[color] ?? 'text-gray-900'} />
      </div>
      <p className={`text-2xl font-bold ${colorMap[color] ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
