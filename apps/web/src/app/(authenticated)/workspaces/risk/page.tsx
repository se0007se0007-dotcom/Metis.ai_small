'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { api } from '@/lib/api-client';
import {
  RefreshCw,
  ShieldAlert,
  AlertTriangle,
  AlertOctagon,
  Activity,
  TrendingUp,
  X,
  CheckCircle2,
  ArrowUpCircle,
  Ban,
  EyeOff,
  AlertCircle,
  Layers,
} from 'lucide-react';

// ── Types (백엔드 DTO와 정렬) ──

interface RiskOverview {
  window: { days: number; since: string };
  totals: {
    totalAlerts: number;
    open: number;
    bySeverity: { critical: number; high: number; medium: number; low: number };
    byCategory: {
      security: number;
      quality: number;
      anomaly: number;
      cost: number;
      policy: number;
    };
  };
  agentRisk: Array<{
    workflowKey: string;
    agentName: string;
    evaluations: number;
    riskScore: number;
    securityRiskLevel: string;
    qualityFailRate: number;
    anomalyCount: number;
    openAlerts: number;
  }>;
  timeseries: Array<{ date: string; alerts: number; critical: number; high: number }>;
}

interface AlertItem {
  id: string;
  severity: string;
  status: string;
  summary: string;
  createdAt: string;
  category: string;
  workflowKey: string;
  stepKey: string;
  agentName: string;
  overallScore: number;
  securityRiskLevel: string;
  qualityGrade: string;
  anomalyDetected: boolean;
  score: number;
}

interface AlertListResponse {
  items: AlertItem[];
  summary: { critical: number; high: number; pending: number; processedToday: number };
}

interface AlertDetail extends AlertItem {
  related: Array<{
    id: string;
    severity: string;
    status: string;
    category: string;
    summary: string;
    createdAt: string;
  }>;
}

// ── Constants ──

const CATEGORY_LABELS: Record<string, string> = {
  security: '보안',
  quality: '품질',
  anomaly: '이상',
  cost: '비용',
  policy: '정책',
};

// ── Helpers ──

function severityBadgeClass(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return 'bg-danger/20 text-danger';
    case 'high':
      return 'bg-warning/20 text-warning';
    case 'medium':
      return 'bg-accent/20 text-accent';
    default:
      return 'bg-success/20 text-success';
  }
}

function severityLabel(severity: string): string {
  return (severity ?? '').toUpperCase();
}

function riskBarColor(score: number): string {
  if (score >= 70) return 'bg-danger';
  if (score >= 40) return 'bg-warning';
  return 'bg-success';
}

function riskTextColor(score: number): string {
  if (score >= 70) return 'text-danger';
  if (score >= 40) return 'text-warning';
  return 'text-success';
}

function formatDateTime(iso: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR');
}

// ── Page Component ──

export default function RiskWorkspacePage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [overview, setOverview] = useState<RiskOverview | null>(null);
  const [alertSummary, setAlertSummary] = useState<AlertListResponse['summary'] | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 알람 피드 필터
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  // 상세 드로어
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // ── Overview ──
  const fetchOverview = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<RiskOverview>(`/fds/risk/overview?days=${days}`);
      setOverview(data);
    } catch (err: any) {
      setError(err?.message ?? '리스크 개요를 불러오지 못했습니다');
    }
  }, [days]);

  // ── Alert feed ──
  const fetchAlerts = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (severityFilter) params.set('severity', severityFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      params.set('days', String(days));
      const data = await api.get<AlertListResponse>(`/fds/alerts?${params.toString()}`);
      setAlerts(data.items ?? []);
      setAlertSummary(data.summary ?? null);
    } catch (err: any) {
      setError((prev) => prev ?? (err?.message ?? '알람을 불러오지 못했습니다'));
    }
  }, [days, statusFilter, severityFilter, categoryFilter]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchOverview(), fetchAlerts()]);
    setLoading(false);
  }, [fetchOverview, fetchAlerts]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Detail ──
  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = await api.get<AlertDetail>(`/fds/alerts/${id}`);
      setDetail(data);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
  }, []);

  const runAction = useCallback(
    async (action: 'resolve' | 'escalate' | 'block' | 'ignore') => {
      if (!selectedId) return;
      setActionLoading(action);
      try {
        await api.post(`/fds/alerts/${selectedId}/${action}`, {});
        closeDetail();
        await refresh();
      } catch {
        // keep panel open on failure
      } finally {
        setActionLoading(null);
      }
    },
    [selectedId, closeDetail, refresh],
  );

  const totals = overview?.totals;
  const open = totals?.open ?? alertSummary?.pending ?? 0;
  const totalAlerts = totals?.totalAlerts ?? 0;
  const criticalCount = totals?.bySeverity?.critical ?? alertSummary?.critical ?? 0;
  const highCount = totals?.bySeverity?.high ?? alertSummary?.high ?? 0;

  const maxTs = Math.max(1, ...(overview?.timeseries ?? []).map((p) => p.alerts));

  return (
    <div className="p-6">
      <SubTabs items={[{ label: '이상 감지', href: '/insights/anomalies' }, { label: '리스크 워크스페이스', href: '/workspaces/risk' }]} />
      <PageHeader
        title="에이전트 운영 리스크"
        description="에이전트 운영 전반의 보안·품질·이상·비용·정책 리스크 통합 모니터링"
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
            <button
              onClick={refresh}
              className="p-1.5 text-muted-dark hover:text-dark transition"
            >
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
        <StatCard icon={Activity} label="전체 알람" value={totalAlerts} color="accent" />
        <StatCard icon={AlertTriangle} label="처리대기" value={open} color="warning" />
        <StatCard icon={ShieldAlert} label="CRITICAL" value={criticalCount} color="danger" />
        <StatCard icon={AlertOctagon} label="HIGH" value={highCount} color="warning" />
      </div>

      {/* 카테고리 분포 */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 mb-6">
        <p className="text-xs font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <Layers size={14} className="text-accent" />
          카테고리 분포
        </p>
        {!totals ? (
          <div className="h-10 bg-gray-100 rounded animate-pulse" />
        ) : (
          <div className="grid grid-cols-5 gap-3">
            {(['security', 'quality', 'anomaly', 'cost', 'policy'] as const).map((cat) => {
              const count = totals.byCategory[cat] ?? 0;
              const total = Object.values(totals.byCategory).reduce((a, b) => a + b, 0);
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={cat}>
                  <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
                    <span>{CATEGORY_LABELS[cat]}</span>
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

      {/* 추이 + 에이전트 순위 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-6">
        {/* 추이 (timeseries) */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <p className="text-xs font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <TrendingUp size={14} className="text-accent" />
            알람 추이 (최근 {days}일)
          </p>
          {loading ? (
            <div className="h-28 bg-gray-100 rounded animate-pulse" />
          ) : !overview?.timeseries?.length ? (
            <div className="p-6 text-center text-gray-500 text-xs">데이터가 없습니다</div>
          ) : (
            <div className="flex items-end gap-1 h-28 overflow-x-auto">
              {overview.timeseries.map((p) => {
                const height = (p.alerts / maxTs) * 100;
                return (
                  <div
                    key={p.date}
                    className="flex-1 min-w-[6px] flex flex-col items-center justify-end h-full group"
                    title={`${p.date} · 전체 ${p.alerts} · CRITICAL ${p.critical} · HIGH ${p.high}`}
                  >
                    <div
                      className="w-full bg-accent/70 group-hover:bg-accent rounded-t transition-all"
                      style={{ height: `${Math.max(height, 2)}%` }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 에이전트별 리스크 순위 */}
        <div className="xl:col-span-2 bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-900">에이전트별 리스크 순위</span>
            <span className="text-[10px] text-gray-500">{overview?.agentRisk?.length ?? 0}개</span>
          </div>
          {loading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : !overview?.agentRisk?.length ? (
            <div className="p-8 text-center text-gray-500">
              <ShieldAlert size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-xs">리스크 데이터가 없습니다</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                    <th className="text-left px-4 py-2">에이전트</th>
                    <th className="text-left px-4 py-2 w-40">리스크점수</th>
                    <th className="text-center px-4 py-2">보안등급</th>
                    <th className="text-right px-4 py-2">품질실패율</th>
                    <th className="text-right px-4 py-2">이상감지</th>
                    <th className="text-right px-4 py-2">미처리알람</th>
                  </tr>
                </thead>
                <tbody>
                  {[...overview.agentRisk]
                    .sort((a, b) => b.riskScore - a.riskScore)
                    .map((a, idx) => (
                      <tr
                        key={`${a.workflowKey}-${a.agentName}-${idx}`}
                        className="border-b border-gray-200 hover:bg-gray-50 transition"
                      >
                        <td className="px-4 py-2.5">
                          <p className="text-xs text-gray-900 font-medium">{a.agentName}</p>
                          <p className="text-[10px] text-gray-500 font-mono">{a.workflowKey}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${riskBarColor(a.riskScore)} rounded-full`}
                                style={{ width: `${Math.min(a.riskScore, 100)}%` }}
                              />
                            </div>
                            <span
                              className={`text-xs font-mono font-semibold ${riskTextColor(a.riskScore)}`}
                            >
                              {Math.round(a.riskScore)}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <span className="text-[11px] text-gray-500">{a.securityRiskLevel}</span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right font-mono text-gray-500">
                          {a.qualityFailRate?.toFixed(1)}%
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right font-mono text-gray-500">
                          {a.anomalyCount}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right font-mono">
                          <span className={a.openAlerts > 0 ? 'text-warning' : 'text-gray-500'}>
                            {a.openAlerts}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 알람 피드 */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-900 mr-auto">알람 피드</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-gray-200 rounded text-gray-900 focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            <option value="">모든 상태</option>
            <option value="open">open</option>
            <option value="pending">pending</option>
            <option value="resolved">resolved</option>
            <option value="escalated">escalated</option>
          </select>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-gray-200 rounded text-gray-900 focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            <option value="">모든 심각도</option>
            <option value="critical">CRITICAL</option>
            <option value="high">HIGH</option>
            <option value="medium">MEDIUM</option>
            <option value="low">LOW</option>
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-gray-200 rounded text-gray-900 focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            <option value="">모든 카테고리</option>
            <option value="security">보안</option>
            <option value="quality">품질</option>
            <option value="anomaly">이상</option>
            <option value="cost">비용</option>
            <option value="policy">정책</option>
          </select>
          <span className="text-[10px] text-gray-500">{alerts.length}건</span>
        </div>

        {loading ? (
          <div className="p-4 space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-14 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : alerts.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <AlertCircle size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-xs">해당하는 알람이 없습니다</p>
          </div>
        ) : (
          <div className="divide-y divide-white/10">
            {alerts.map((a) => (
              <button
                key={a.id}
                onClick={() => openDetail(a.id)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 transition flex items-start justify-between gap-3"
              >
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 ${severityBadgeClass(a.severity)}`}
                  >
                    {severityLabel(a.severity)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] text-gray-500 uppercase">
                        {CATEGORY_LABELS[a.category] ?? a.category}
                      </span>
                      <span className="text-[11px] text-gray-900 font-medium truncate">
                        {a.agentName}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-500 truncate">{a.summary}</p>
                    <p className="text-[10px] text-gray-500/60 mt-1">{formatDateTime(a.createdAt)}</p>
                  </div>
                </div>
                <span className="text-[10px] text-gray-500 shrink-0">{a.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 상세 드로어 */}
      {selectedId && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/50" onClick={closeDetail} />
          <div className="w-full max-w-md bg-white border-l border-gray-200 h-full overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
              <span className="text-sm font-semibold text-gray-900">알람 상세</span>
              <button onClick={closeDetail} className="text-gray-500 hover:text-gray-900 transition">
                <X size={18} />
              </button>
            </div>

            {detailLoading ? (
              <div className="p-5 space-y-3">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            ) : !detail ? (
              <div className="p-8 text-center text-gray-500 text-xs">상세 정보를 불러오지 못했습니다</div>
            ) : (
              <div className="p-5 space-y-5">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold ${severityBadgeClass(detail.severity)}`}
                    >
                      {severityLabel(detail.severity)}
                    </span>
                    <span className="text-[10px] text-gray-500 uppercase">
                      {CATEGORY_LABELS[detail.category] ?? detail.category}
                    </span>
                    <span className="text-[10px] text-gray-500 ml-auto">{detail.status}</span>
                  </div>
                  <p className="text-sm text-gray-900 font-medium">{detail.summary}</p>
                  <p className="text-[10px] text-gray-500/60 mt-1">{formatDateTime(detail.createdAt)}</p>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <Field label="에이전트" value={detail.agentName} />
                  <Field label="워크플로우" value={detail.workflowKey} mono />
                  <Field label="스텝" value={detail.stepKey} mono />
                  <Field label="보안등급" value={detail.securityRiskLevel} />
                  <Field label="품질등급" value={detail.qualityGrade} />
                  <Field
                    label="종합점수"
                    value={detail.overallScore != null ? String(detail.overallScore) : '-'}
                  />
                  <Field label="이상감지" value={detail.anomalyDetected ? '예' : '아니오'} />
                  <Field label="점수" value={detail.score != null ? String(detail.score) : '-'} />
                </div>

                {/* 관련 알람 */}
                <div>
                  <p className="text-xs font-semibold text-gray-900 mb-2">관련 알람</p>
                  {!detail.related?.length ? (
                    <p className="text-[11px] text-gray-500">관련 알람이 없습니다</p>
                  ) : (
                    <div className="space-y-2">
                      {detail.related.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => openDetail(r.id)}
                          className="w-full text-left p-2.5 rounded border border-gray-200 hover:border-accent/50 hover:bg-gray-50 transition"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${severityBadgeClass(r.severity)}`}
                            >
                              {severityLabel(r.severity)}
                            </span>
                            <span className="text-[10px] text-gray-500 uppercase">
                              {CATEGORY_LABELS[r.category] ?? r.category}
                            </span>
                          </div>
                          <p className="text-[11px] text-gray-500 truncate">{r.summary}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 액션 버튼 */}
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <ActionButton
                    label="조치완료"
                    icon={CheckCircle2}
                    loading={actionLoading === 'resolve'}
                    disabled={actionLoading != null}
                    onClick={() => runAction('resolve')}
                    className="bg-success/20 text-success hover:bg-success/30 border-success/30"
                  />
                  <ActionButton
                    label="에스컬레이션"
                    icon={ArrowUpCircle}
                    loading={actionLoading === 'escalate'}
                    disabled={actionLoading != null}
                    onClick={() => runAction('escalate')}
                    className="bg-warning/20 text-warning hover:bg-warning/30 border-warning/30"
                  />
                  <ActionButton
                    label="차단"
                    icon={Ban}
                    loading={actionLoading === 'block'}
                    disabled={actionLoading != null}
                    onClick={() => runAction('block')}
                    className="bg-danger/20 text-danger hover:bg-danger/30 border-danger/30"
                  />
                  <ActionButton
                    label="무시"
                    icon={EyeOff}
                    loading={actionLoading === 'ignore'}
                    disabled={actionLoading != null}
                    onClick={() => runAction('ignore')}
                    className="bg-gray-50 text-gray-500 hover:bg-gray-100 border-gray-200"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
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

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`text-gray-900 ${mono ? 'font-mono text-[11px]' : ''}`}>{value || '-'}</p>
    </div>
  );
}

function ActionButton({
  label,
  icon: Icon,
  loading,
  disabled,
  onClick,
  className,
}: {
  label: string;
  icon: any;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  className: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded border transition disabled:opacity-50 ${className}`}
    >
      <Icon size={14} className={loading ? 'animate-spin' : ''} />
      {label}
    </button>
  );
}
