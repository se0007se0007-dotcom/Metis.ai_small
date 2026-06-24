'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ZapOff,
  Zap,
  TrendingUp,
  Clock,
  Activity,
  Database,
  Server,
  ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api-client';

// ── Types ──

interface GovernanceSummary {
  totalCalls: number;
  successRate: number;
  avgDuration: number;
  totalCost: number;
  errorCount: number;
}

interface ConnectorPerformance {
  connectorId: string;
  name: string;
  callCount: number;
  successRate: number;
  avgDuration: number;
  lastCalled: string;
}

interface TimeSeries {
  timestamp: string;
  value: number;
}

interface GovernanceOverview {
  summary: GovernanceSummary;
  connectors: ConnectorPerformance[];
  circuits: CircuitBreakerState[];
  rateLimits: RateLimitState[];
  lifecycles: LifecycleStatus[];
  timeSeries: TimeSeries[];
}

interface CircuitBreakerState {
  connectorId: string;
  name: string;
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  threshold: number;
  lastStateChange: string;
}

interface RateLimitState {
  connectorId: string;
  name: string;
  tokensRemaining: number;
  tokensPerMinute: number;
  tokensPerHour: number;
  minuteUsage: number;
  hourUsage: number;
}

interface LifecycleStatus {
  serverId: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  lastHeartbeat: string;
}

interface CallLog {
  id: string;
  connectorId: string;
  connectorName: string;
  protocol: string;
  action: string;
  success: boolean;
  duration: number;
  cost: number;
  timestamp: string;
}

interface CallStats {
  period: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalCost: number;
  avgDuration: number;
}

// ── API → UI 정규화 어댑터 ──────────────────────────────────────
// 백엔드(/connectors/governance/overview)는 circuits/rateLimits/lifecycles를
// "커넥터ID 키 객체(Record)"로, connectors/timeSeries를 snake_case 배열로
// 반환한다. UI 타입(배열·camelCase)으로 변환하고 모든 필드를 null-safe 처리.

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function recordToArray<T>(v: unknown, map: (id: string, item: any) => T): T[] {
  if (Array.isArray(v)) return v as T[]; // 이미 배열이면 그대로 (mock 호환)
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, any>)
      .filter(([, item]) => item != null)
      .map(([id, item]) => map(id, item));
  }
  return [];
}

function normalizeOverview(raw: unknown): GovernanceOverview {
  const r = (raw ?? {}) as Record<string, any>;
  const s = (r.summary ?? {}) as Record<string, any>;

  return {
    summary: {
      totalCalls: num(s.totalCalls),
      successRate: num(s.successRate),
      avgDuration: num(s.avgDuration),
      totalCost: num(s.totalCost),
      errorCount: num(s.errorCount ?? s.totalErrors), // 백엔드는 totalErrors
    },
    connectors: recordToArray(r.connectors, (id, c) => c).map((c: any) => ({
      connectorId: c.connectorId ?? c.connector_id ?? '-',
      name: c.name ?? c.connector_name ?? c.connector_id ?? '-',
      callCount: num(c.callCount ?? c.calls),
      successRate: num(c.successRate),
      avgDuration: num(c.avgDuration),
      lastCalled: c.lastCalled ?? '',
    })),
    circuits: recordToArray(r.circuits, (id, c) => ({
      connectorId: id,
      name: c.name ?? id,
      state: (c.state ?? 'closed') as 'closed' | 'open' | 'half-open',
      failureCount: num(c.failureCount),
      threshold: num(c.threshold ?? c.failureThreshold) || 1,
      lastStateChange: c.lastStateChange ?? (c.lastFailure ? new Date(c.lastFailure).toISOString() : ''),
    })),
    rateLimits: recordToArray(r.rateLimits, (id, l) => ({
      connectorId: id,
      name: l.name ?? id,
      tokensRemaining: num(l.tokensRemaining),
      tokensPerMinute: num(l.tokensPerMinute ?? l.maxPerMinute) || 1,
      tokensPerHour: num(l.tokensPerHour ?? l.maxPerHour) || 1,
      minuteUsage: num(l.minuteUsage ?? l.minuteUsed),
      hourUsage: num(l.hourUsage ?? l.hourUsed),
    })),
    lifecycles: recordToArray(r.lifecycles, (id, lf) => ({
      serverId: id,
      name: lf.name ?? lf.serverInfo?.name ?? id,
      status: (lf.status ?? 'disconnected') as 'connected' | 'disconnected' | 'error',
      toolCount: num(lf.toolCount ?? lf.tools),
      lastHeartbeat: lf.lastHeartbeat ?? '',
    })),
    timeSeries: (Array.isArray(r.timeSeries) ? r.timeSeries : []).map((t: any) => ({
      timestamp: t.timestamp ?? t.time ?? '',
      value: num(t.value ?? t.calls),
    })),
  };
}

// ── Main Component ──

export default function GovernanceMonitoringPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [data, setData] = useState<GovernanceOverview | null>(null);
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [callStats, setCallStats] = useState<CallStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedConnector, setSelectedConnector] = useState<string>('');
  const [logFilter, setLogFilter] = useState({ connector: '', success: '' });
  const [logPage, setLogPage] = useState(0);

  const fetchOverview = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const overview = await api.get<unknown>('/connectors/governance/overview');
      setData(overview ? normalizeOverview(overview) : getMockOverview());
    } catch (err: any) {
      setError(err.message ?? 'Failed to load governance data');
      setData(getMockOverview());
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCallLogs = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (logFilter.connector) query.append('connectorId', logFilter.connector);
      if (logFilter.success) query.append('success', logFilter.success);
      query.append('limit', '50');
      query.append('offset', (logPage * 50).toString());

      const res = await api.get<{ items?: any[]; logs?: any[] }>(
        `/connectors/governance/call-logs?${query.toString()}`,
      );
      // 백엔드는 { total, logs: [...] } (snake_case) — UI 타입으로 정규화.
      const rawLogs = res.logs ?? res.items ?? [];
      if (rawLogs.length === 0) {
        setCallLogs([]);
      } else {
        setCallLogs(
          rawLogs.map((l: any) => ({
            id: l.id ?? `${l.timestamp}-${l.connector_id}`,
            connectorId: l.connectorId ?? l.connector_id ?? '-',
            connectorName: l.connectorName ?? l.connector_name ?? '-',
            protocol: l.protocol ?? '-',
            action: l.action ?? '-',
            success: !!l.success,
            duration: l.duration ?? l.duration_ms ?? 0,
            cost: l.cost ?? l.cost_estimate ?? 0,
            timestamp: l.timestamp ?? '',
          })),
        );
      }
    } catch (err) {
      setCallLogs(getMockCallLogs());
    }
  }, [logFilter, logPage]);

  const fetchCallStats = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (selectedConnector) query.append('connectorId', selectedConnector);
      query.append('period', '1h');

      const raw = await api.get<any>(`/connectors/governance/call-stats?${query.toString()}`);
      // 백엔드 형태 2종: connectorId 지정 시 {totalCalls, successRate, errorCount, ...},
      // 미지정 시 {summary: {...}} — 모두 UI CallStats로 정규화.
      const src = raw?.summary ?? raw ?? {};
      const totalCalls = num(src.totalCalls);
      const failed = num(src.errorCount ?? src.totalErrors);
      setCallStats({
        period: raw?.period ?? src.period ?? '1h',
        totalCalls,
        successCalls: Math.max(0, totalCalls - failed),
        failedCalls: failed,
        totalCost: num(src.totalCost),
        avgDuration: num(src.avgDuration),
      });
    } catch (err) {
      setCallStats(getMockCallStats());
    }
  }, [selectedConnector]);

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 30000);
    return () => clearInterval(interval);
  }, [fetchOverview]);

  useEffect(() => {
    if (activeTab === 'call-logs') {
      fetchCallLogs();
    }
  }, [activeTab, logFilter, logPage, fetchCallLogs]);

  useEffect(() => {
    if (activeTab === 'overview' && selectedConnector) {
      fetchCallStats();
    }
  }, [activeTab, selectedConnector, fetchCallStats]);

  const getCircuitColor = (state: string) => {
    if (state === 'closed') return 'text-success bg-success/10';
    if (state === 'open') return 'text-danger bg-danger/10';
    return 'text-warning bg-warning/10';
  };

  const getStatusColor = (status: string) => {
    if (status === 'connected') return 'text-success bg-success/10';
    if (status === 'error') return 'text-danger bg-danger/10';
    return 'text-warning bg-warning/10';
  };

  const tabs = [
    { id: 'overview', label: '개요 (Overview)' },
    { id: 'circuits', label: '서킷 브레이커 (Circuit Breakers)' },
    { id: 'rate-limits', label: '레이트 제한 (Rate Limits)' },
    { id: 'call-logs', label: '호출 로그 (Call Logs)' },
    { id: 'lifecycle', label: '생명주기 (Lifecycle)' },
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-dark mb-1">커넥터 모니터링</h1>
          <p className="text-xs text-muted-dark">
            외부 시스템 커넥터(MCP)의 호출량·성공률·비용·레이트 제한 현황 — Agent 실행 통제는{' '}
            <a href="/governance/runtime" className="text-accent underline">
              런타임 거버넌스
            </a>
            에서 확인하세요.
          </p>
        </div>
        <button
          onClick={fetchOverview}
          className="p-2 text-muted-dark hover:text-dark transition"
          title="Refresh data"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex gap-2 mb-6 border-b border-border overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              setLogPage(0);
            }}
            className={`px-4 py-2 text-xs font-semibold transition whitespace-nowrap ${
              activeTab === tab.id
                ? 'text-accent border-b-2 border-accent'
                : 'text-muted-dark hover:text-dark border-b-2 border-transparent'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab
          data={data}
          loading={loading}
          onSelectConnector={setSelectedConnector}
          selectedConnector={selectedConnector}
          callStats={callStats}
        />
      )}
      {activeTab === 'circuits' && (
        <CircuitsTab data={data} loading={loading} getCircuitColor={getCircuitColor} />
      )}
      {activeTab === 'rate-limits' && <RateLimitsTab data={data} loading={loading} />}
      {activeTab === 'call-logs' && (
        <CallLogsTab
          logs={callLogs}
          loading={loading}
          filter={logFilter}
          onFilterChange={setLogFilter}
          page={logPage}
          onPageChange={setLogPage}
          connectors={data?.connectors || []}
        />
      )}
      {activeTab === 'lifecycle' && (
        <LifecycleTab data={data} loading={loading} getStatusColor={getStatusColor} />
      )}
    </div>
  );
}

// ── Overview Tab ──

function OverviewTab({
  data,
  loading,
  onSelectConnector,
  selectedConnector,
  callStats,
}: {
  data: GovernanceOverview | null;
  loading: boolean;
  onSelectConnector: (id: string) => void;
  selectedConnector: string;
  callStats: CallStats | null;
}) {
  if (!data) return null;

  // Null-safe normalization: the API may return a partial overview (or a
  // shape mismatch) — never crash the page on a missing/null field.
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const raw = (data.summary ?? {}) as Partial<GovernanceSummary>;
  const summary = {
    totalCalls: n(raw.totalCalls),
    successRate: n(raw.successRate),
    avgDuration: n(raw.avgDuration),
    totalCost: n(raw.totalCost),
    errorCount: n(raw.errorCount),
  };
  const connectors = data.connectors ?? [];
  const timeSeries = data.timeSeries ?? [];

  const maxValue = Math.max(...timeSeries.map((ts) => ts.value), 1);
  const maxHeight = 80;

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard
          label="총 호출"
          value={summary.totalCalls.toLocaleString()}
          icon={<Activity size={14} className="text-accent" />}
        />
        <StatCard
          label="성공률"
          value={`${summary.successRate.toFixed(1)}%`}
          icon={<CheckCircle2 size={14} className="text-success" />}
        />
        <StatCard
          label="평균 소요시간"
          value={`${summary.avgDuration.toFixed(0)}ms`}
          icon={<Clock size={14} className="text-warning" />}
        />
        <StatCard
          label="총 비용"
          value={`$${summary.totalCost.toFixed(2)}`}
          icon={<TrendingUp size={14} className="text-accent" />}
        />
        <StatCard
          label="에러"
          value={summary.errorCount.toLocaleString()}
          icon={<AlertCircle size={14} className="text-danger" />}
        />
      </div>

      {/* Time Series Chart */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-gray-900 flex items-center gap-2">
            <TrendingUp size={13} className="text-accent" />
            호출량 추이 (1시간)
          </h3>
          <span className="text-[10px] text-gray-500">{timeSeries.length} 데이터 포인트</span>
        </div>

        <div className="flex items-end gap-1 h-24 justify-between">
          {timeSeries.slice(-24).map((ts, idx) => {
            const height = (ts.value / maxValue) * maxHeight;
            return (
              <div
                key={idx}
                className="flex-1 bg-accent/30 rounded-t hover:bg-accent/50 transition group relative"
                style={{ height: `${Math.max(height, 2)}px` }}
                title={`${ts.timestamp}: ${ts.value} calls`}
              >
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-white-darker rounded text-[10px] text-gray-900 opacity-0 group-hover:opacity-100 transition whitespace-nowrap z-10">
                  {ts.value}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Connector Performance Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="text-xs font-semibold text-gray-900 flex items-center gap-2">
            <Server size={13} className="text-accent" />
            커넥터 성능
          </h3>
          <span className="text-[10px] text-gray-500">{connectors.length}개</span>
        </div>

        {loading ? (
          <div className="p-4 space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : connectors.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Server size={24} className="mx-auto mb-2 opacity-30" />
            <p className="text-xs">커넥터가 없습니다</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                  <th className="text-left px-4 py-2">이름</th>
                  <th className="text-right px-4 py-2">호출</th>
                  <th className="text-right px-4 py-2">성공률</th>
                  <th className="text-right px-4 py-2">평균 응답</th>
                  <th className="text-left px-4 py-2">마지막 호출</th>
                  <th className="text-center px-4 py-2">작업</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((conn) => (
                  <tr
                    key={conn.connectorId}
                    className="border-b border-gray-100 hover:bg-gray-50 transition"
                  >
                    <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{conn.name}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">{conn.callCount}</td>
                    <td className="px-4 py-2.5 text-xs text-right">
                      <span className={conn.successRate >= 95 ? 'text-success' : 'text-warning'}>
                        {conn.successRate.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                      {conn.avgDuration.toFixed(0)}ms
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">
                      {new Date(conn.lastCalled).toLocaleTimeString('ko-KR')}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => onSelectConnector(conn.connectorId)}
                        className={`p-1 rounded transition ${
                          selectedConnector === conn.connectorId
                            ? 'text-accent'
                            : 'text-gray-500 hover:text-gray-900'
                        }`}
                      >
                        <ChevronRight size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Call Stats Detail */}
      {selectedConnector && callStats && (
        <div className="grid grid-cols-5 gap-3">
          <StatCard
            label="이 시간 호출"
            value={callStats.totalCalls.toLocaleString()}
            icon={<Activity size={14} className="text-accent" />}
          />
          <StatCard
            label="성공"
            value={callStats.successCalls.toLocaleString()}
            icon={<CheckCircle2 size={14} className="text-success" />}
          />
          <StatCard
            label="실패"
            value={callStats.failedCalls.toLocaleString()}
            icon={<AlertCircle size={14} className="text-danger" />}
          />
          <StatCard
            label="비용"
            value={`$${callStats.totalCost.toFixed(2)}`}
            icon={<TrendingUp size={14} className="text-accent" />}
          />
          <StatCard
            label="평균 응답"
            value={`${callStats.avgDuration.toFixed(0)}ms`}
            icon={<Clock size={14} className="text-warning" />}
          />
        </div>
      )}
    </div>
  );
}

// ── Circuit Breakers Tab ──

function CircuitsTab({
  data,
  loading,
  getCircuitColor,
}: {
  data: GovernanceOverview | null;
  loading: boolean;
  getCircuitColor: (state: string) => string;
}) {
  if (!data) return null;

  const { circuits } = data;

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h3 className="text-xs font-semibold text-gray-900 flex items-center gap-2">
          <ZapOff size={13} className="text-accent" />
          서킷 브레이커 상태
        </h3>
        <span className="text-[10px] text-gray-500">{circuits.length}개</span>
      </div>

      {loading ? (
        <div className="p-4 space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      ) : circuits.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          <ZapOff size={24} className="mx-auto mb-2 opacity-30" />
          <p className="text-xs">서킷 데이터가 없습니다</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <th className="text-left px-4 py-2">커넥터</th>
                <th className="text-center px-4 py-2">상태</th>
                <th className="text-right px-4 py-2">실패 횟수</th>
                <th className="text-right px-4 py-2">임계값</th>
                <th className="text-left px-4 py-2">상태 변경 시간</th>
                <th className="text-right px-4 py-2">상태율</th>
              </tr>
            </thead>
            <tbody>
              {circuits.map((circuit) => {
                const healthPercent =
                  ((circuit.threshold - circuit.failureCount) / circuit.threshold) * 100;
                return (
                  <tr
                    key={circuit.connectorId}
                    className="border-b border-gray-100 hover:bg-gray-50 transition"
                  >
                    <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{circuit.name}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={`inline-block px-2.5 py-1 rounded text-[10px] font-semibold ${getCircuitColor(circuit.state)}`}
                      >
                        {circuit.state === 'closed'
                          ? '정상 (Closed)'
                          : circuit.state === 'open'
                            ? '차단 (Open)'
                            : '부분 (Half-Open)'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                      {circuit.failureCount}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                      {circuit.threshold}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">
                      {new Date(circuit.lastStateChange).toLocaleTimeString('ko-KR')}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-16 h-1.5 bg-white/[0.1] rounded overflow-hidden">
                          <div
                            className={`h-full rounded transition ${
                              healthPercent > 50 ? 'bg-success' : 'bg-warning'
                            }`}
                            style={{ width: `${healthPercent}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500 min-w-fit">
                          {healthPercent.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Rate Limits Tab ──

function RateLimitsTab({ data, loading }: { data: GovernanceOverview | null; loading: boolean }) {
  if (!data) return null;

  // Null-safe: missing/partial rows must not crash the table.
  const rateLimits = (data.rateLimits ?? []).map((l) => ({
    ...l,
    tokensPerMinute: l.tokensPerMinute || 1,
    tokensPerHour: l.tokensPerHour || 1,
    minuteUsage: l.minuteUsage ?? 0,
    hourUsage: l.hourUsage ?? 0,
    tokensRemaining: l.tokensRemaining ?? 0,
  }));

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h3 className="text-xs font-semibold text-gray-900 flex items-center gap-2">
          <Zap size={13} className="text-accent" />
          레이트 제한
        </h3>
        <span className="text-[10px] text-gray-500">{rateLimits.length}개</span>
      </div>

      {loading ? (
        <div className="p-4 space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      ) : rateLimits.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          <Zap size={24} className="mx-auto mb-2 opacity-30" />
          <p className="text-xs">레이트 제한 데이터가 없습니다</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <th className="text-left px-4 py-2">커넥터</th>
                <th className="text-right px-4 py-2">남은 토큰</th>
                <th className="text-right px-4 py-2">분당 제한</th>
                <th className="text-right px-4 py-2">현재 사용 (분)</th>
                <th className="text-right px-4 py-2">분당 사용률</th>
                <th className="text-right px-4 py-2">시간당 사용률</th>
              </tr>
            </thead>
            <tbody>
              {rateLimits.map((limit) => {
                const minutePercent = (limit.minuteUsage / limit.tokensPerMinute) * 100;
                const hourPercent = (limit.hourUsage / limit.tokensPerHour) * 100;
                return (
                  <tr
                    key={limit.connectorId}
                    className="border-b border-gray-100 hover:bg-gray-50 transition"
                  >
                    <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{limit.name}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                      {limit.tokensRemaining.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                      {limit.tokensPerMinute}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                      {limit.minuteUsage}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-16 h-1.5 bg-white/[0.1] rounded overflow-hidden">
                          <div
                            className={`h-full rounded transition ${
                              minutePercent > 80
                                ? 'bg-danger'
                                : minutePercent > 50
                                  ? 'bg-warning'
                                  : 'bg-success'
                            }`}
                            style={{ width: `${Math.min(minutePercent, 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500 min-w-fit">
                          {minutePercent.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-16 h-1.5 bg-white/[0.1] rounded overflow-hidden">
                          <div
                            className={`h-full rounded transition ${
                              hourPercent > 80
                                ? 'bg-danger'
                                : hourPercent > 50
                                  ? 'bg-warning'
                                  : 'bg-success'
                            }`}
                            style={{ width: `${Math.min(hourPercent, 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500 min-w-fit">
                          {hourPercent.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Call Logs Tab ──

function CallLogsTab({
  logs,
  loading,
  filter,
  onFilterChange,
  page,
  onPageChange,
  connectors,
}: {
  logs: CallLog[];
  loading: boolean;
  filter: { connector: string; success: string };
  onFilterChange: (filter: { connector: string; success: string }) => void;
  page: number;
  onPageChange: (page: number) => void;
  connectors: ConnectorPerformance[];
}) {
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={filter.connector}
          onChange={(e) => {
            onFilterChange({ ...filter, connector: e.target.value });
            onPageChange(0);
          }}
          className="px-3 py-1.5 bg-white border border-gray-200 rounded text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-accent/50"
        >
          <option value="">모든 커넥터</option>
          {connectors.map((conn) => (
            <option key={conn.connectorId} value={conn.connectorId}>
              {conn.name}
            </option>
          ))}
        </select>

        <select
          value={filter.success}
          onChange={(e) => {
            onFilterChange({ ...filter, success: e.target.value });
            onPageChange(0);
          }}
          className="px-3 py-1.5 bg-white border border-gray-200 rounded text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-accent/50"
        >
          <option value="">모든 상태</option>
          <option value="true">성공만</option>
          <option value="false">실패만</option>
        </select>
      </div>

      {/* Logs Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="text-xs font-semibold text-gray-900 flex items-center gap-2">
            <Database size={13} className="text-accent" />
            호출 로그
          </h3>
          <span className="text-[10px] text-gray-500">{logs.length}개 항목</span>
        </div>

        {loading ? (
          <div className="p-4 space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Database size={24} className="mx-auto mb-2 opacity-30" />
            <p className="text-xs">호출 로그가 없습니다</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                  <th className="text-left px-4 py-2">커넥터</th>
                  <th className="text-left px-4 py-2">프로토콜</th>
                  <th className="text-left px-4 py-2">작업</th>
                  <th className="text-center px-4 py-2">상태</th>
                  <th className="text-right px-4 py-2">소요시간</th>
                  <th className="text-right px-4 py-2">비용</th>
                  <th className="text-left px-4 py-2">시간</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
                    <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">
                      {log.connectorName}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{log.protocol}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{log.action}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                          log.success ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'
                        }`}
                      >
                        {log.success ? '성공' : '실패'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">{log.duration}ms</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                      ${log.cost.toFixed(4)}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">
                      {new Date(log.timestamp).toLocaleTimeString('ko-KR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
          <span className="text-[10px] text-gray-500">페이지 {page + 1}</span>
          <div className="flex gap-2">
            <button
              onClick={() => onPageChange(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2 py-1 text-[10px] border border-gray-200 rounded text-gray-900 hover:border-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              이전
            </button>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={logs.length < 50}
              className="px-2 py-1 text-[10px] border border-gray-200 rounded text-gray-900 hover:border-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              다음
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Lifecycle Tab ──

function LifecycleTab({
  data,
  loading,
  getStatusColor,
}: {
  data: GovernanceOverview | null;
  loading: boolean;
  getStatusColor: (status: string) => string;
}) {
  if (!data) return null;

  const { lifecycles } = data;

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h3 className="text-xs font-semibold text-gray-900 flex items-center gap-2">
          <Server size={13} className="text-accent" />
          MCP 서버 생명주기
        </h3>
        <span className="text-[10px] text-gray-500">{lifecycles.length}개</span>
      </div>

      {loading ? (
        <div className="p-4 space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      ) : lifecycles.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          <Server size={24} className="mx-auto mb-2 opacity-30" />
          <p className="text-xs">생명주기 데이터가 없습니다</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <th className="text-left px-4 py-2">서버 이름</th>
                <th className="text-center px-4 py-2">상태</th>
                <th className="text-right px-4 py-2">도구 수</th>
                <th className="text-left px-4 py-2">마지막 하트비트</th>
              </tr>
            </thead>
            <tbody>
              {lifecycles.map((lifecycle) => (
                <tr
                  key={lifecycle.serverId}
                  className="border-b border-gray-100 hover:bg-gray-50 transition"
                >
                  <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{lifecycle.name}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span
                      className={`inline-block px-2.5 py-1 rounded text-[10px] font-semibold ${getStatusColor(lifecycle.status)}`}
                    >
                      {lifecycle.status === 'connected'
                        ? '연결됨 (Connected)'
                        : lifecycle.status === 'error'
                          ? '에러 (Error)'
                          : '연결 해제 (Disconnected)'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 text-right">
                    {lifecycle.toolCount}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500">
                    {new Date(lifecycle.lastHeartbeat).toLocaleTimeString('ko-KR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Stat Card Component ──

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3">
      {icon && <div className="mb-2">{icon}</div>}
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-lg font-bold text-gray-900">{value}</p>
    </div>
  );
}

// ── Mock Data ──

function getMockOverview(): GovernanceOverview {
  return {
    summary: {
      totalCalls: 45230,
      successRate: 98.5,
      avgDuration: 234,
      totalCost: 127.45,
      errorCount: 678,
    },
    connectors: [
      {
        connectorId: 'conn-1',
        name: 'Salesforce',
        callCount: 12450,
        successRate: 99.2,
        avgDuration: 145,
        lastCalled: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      },
      {
        connectorId: 'conn-2',
        name: 'Slack',
        callCount: 8930,
        successRate: 98.1,
        avgDuration: 89,
        lastCalled: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
      {
        connectorId: 'conn-3',
        name: 'Jira',
        callCount: 15230,
        successRate: 97.8,
        avgDuration: 312,
        lastCalled: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
      },
      {
        connectorId: 'conn-4',
        name: 'GitHub',
        callCount: 8620,
        successRate: 99.5,
        avgDuration: 167,
        lastCalled: new Date(Date.now() - 30 * 1000).toISOString(),
      },
    ],
    circuits: [
      {
        connectorId: 'conn-1',
        name: 'Salesforce',
        state: 'closed',
        failureCount: 2,
        threshold: 10,
        lastStateChange: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        connectorId: 'conn-2',
        name: 'Slack',
        state: 'closed',
        failureCount: 1,
        threshold: 10,
        lastStateChange: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      },
      {
        connectorId: 'conn-3',
        name: 'Jira',
        state: 'half-open',
        failureCount: 7,
        threshold: 10,
        lastStateChange: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      },
      {
        connectorId: 'conn-4',
        name: 'GitHub',
        state: 'closed',
        failureCount: 0,
        threshold: 10,
        lastStateChange: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      },
    ],
    rateLimits: [
      {
        connectorId: 'conn-1',
        name: 'Salesforce',
        tokensRemaining: 8500,
        tokensPerMinute: 1000,
        tokensPerHour: 50000,
        minuteUsage: 245,
        hourUsage: 12350,
      },
      {
        connectorId: 'conn-2',
        name: 'Slack',
        tokensRemaining: 9200,
        tokensPerMinute: 10000,
        tokensPerHour: 100000,
        minuteUsage: 1850,
        hourUsage: 42300,
      },
      {
        connectorId: 'conn-3',
        name: 'Jira',
        tokensRemaining: 7800,
        tokensPerMinute: 500,
        tokensPerHour: 25000,
        minuteUsage: 180,
        hourUsage: 8950,
      },
      {
        connectorId: 'conn-4',
        name: 'GitHub',
        tokensRemaining: 9900,
        tokensPerMinute: 5000,
        tokensPerHour: 250000,
        minuteUsage: 890,
        hourUsage: 18400,
      },
    ],
    lifecycles: [
      {
        serverId: 'srv-1',
        name: 'Salesforce MCP',
        status: 'connected',
        toolCount: 24,
        lastHeartbeat: new Date(Date.now() - 5 * 1000).toISOString(),
      },
      {
        serverId: 'srv-2',
        name: 'Slack MCP',
        status: 'connected',
        toolCount: 18,
        lastHeartbeat: new Date(Date.now() - 3 * 1000).toISOString(),
      },
      {
        serverId: 'srv-3',
        name: 'Jira MCP',
        status: 'error',
        toolCount: 32,
        lastHeartbeat: new Date(Date.now() - 45 * 1000).toISOString(),
      },
      {
        serverId: 'srv-4',
        name: 'GitHub MCP',
        status: 'connected',
        toolCount: 28,
        lastHeartbeat: new Date(Date.now() - 2 * 1000).toISOString(),
      },
    ],
    timeSeries: Array.from({ length: 24 }, (_, i) => ({
      timestamp: new Date(Date.now() - (23 - i) * 5 * 60 * 1000).toISOString(),
      value: Math.floor(Math.random() * 3000) + 500,
    })),
  };
}

function getMockCallLogs(): CallLog[] {
  const logs: CallLog[] = [];
  for (let i = 0; i < 50; i++) {
    logs.push({
      id: `log-${i}`,
      connectorId: `conn-${(i % 4) + 1}`,
      connectorName: ['Salesforce', 'Slack', 'Jira', 'GitHub'][i % 4],
      protocol: ['REST', 'GraphQL', 'WebSocket'][i % 3],
      action: ['GET', 'POST', 'PUT', 'DELETE'][i % 4],
      success: Math.random() > 0.02,
      duration: Math.floor(Math.random() * 500) + 50,
      cost: Math.random() * 0.5,
      timestamp: new Date(Date.now() - i * 3 * 60 * 1000).toISOString(),
    });
  }
  return logs;
}

function getMockCallStats(): CallStats {
  return {
    period: '1h',
    totalCalls: 2450,
    successCalls: 2413,
    failedCalls: 37,
    totalCost: 18.75,
    avgDuration: 189,
  };
}
