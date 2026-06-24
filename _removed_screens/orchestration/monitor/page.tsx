'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { api } from '@/lib/api-client';

// ── Types ──

interface ExecutionStep {
  id: string;
  stepKey: string;
  stepType: string;
  status: string;
}

interface ExecutionSession {
  id: string;
  workflowKey: string | null;
  capabilityKey: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  latencyMs: number | null;
  steps: ExecutionStep[];
  createdAt: string;
  metadata?: Record<string, any>;
}

interface ExecutionStats {
  total: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  queued: number;
  avgLatencyMs: number;
  successRate: number;
}

// ── Page ──

interface ExecutionData {
  items: ExecutionSession[];
  total: number;
}

export default function MonitorPage() {
  const [executions, setExecutions] = useState<ExecutionSession[]>([]);
  const [stats, setStats] = useState<ExecutionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedExec, setSelectedExec] = useState<ExecutionSession | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [policyViolations, setPolicyViolations] = useState<any[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      params.set('pageSize', '20');

      let execData: ExecutionData | null = null;
      let statsData: ExecutionStats | null = null;

      try {
        execData = await api.get<ExecutionData>(`/executions?${params.toString()}`);
      } catch (err: any) {
        console.warn('Failed to fetch executions:', err);
        execData = null;
      }

      try {
        statsData = await api.get<ExecutionStats>('/executions/stats');
      } catch (err: any) {
        console.warn('Failed to fetch execution stats:', err);
        statsData = null;
      }

      // Load from localStorage (Builder execution history)
      let localExecs: ExecutionSession[] = [];
      try {
        const stored = localStorage.getItem('metis_flo_executions');
        if (stored) {
          const parsed = JSON.parse(stored);
          localExecs = (parsed || []).map((exec: any) => ({
            id: exec.id,
            status: exec.status,
            workflowKey: exec.workflowName || null,
            capabilityKey: null,
            startedAt: exec.startedAt,
            endedAt: exec.completedAt,
            latencyMs: exec.totalDuration,
            createdAt: exec.startedAt || new Date().toISOString(),
            steps: (exec.nodes || []).map((n: any, i: number) => ({
              id: `step-${i}`,
              stepKey: n.name,
              stepType: 'flo_node',
              status:
                n.status === 'completed'
                  ? 'SUCCEEDED'
                  : n.status === 'failed'
                    ? 'FAILED'
                    : 'RUNNING',
            })),
            metadata: { sourceType: 'flo' },
          }));
        }
      } catch (e) {
        console.warn('Failed to load local executions:', e);
      }

      // Merge local and API data
      const apiExecs = execData?.items ?? [];
      const mergedExecs = [...localExecs, ...apiExecs];

      setExecutions(mergedExecs);
      setStats(statsData ?? null);
    } catch (err: any) {
      setExecutions([]);
      setStats(null);
      console.warn('Error loading executions:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const hasRunning = executions.some((e) => e.status === 'RUNNING' || e.status === 'QUEUED');
    if (!hasRunning) return;
    const iv = setInterval(fetchData, 3000);
    return () => clearInterval(iv);
  }, [executions, fetchData]);

  useEffect(() => {
    if (!selectedExec) {
      setPolicyViolations([]);
      return;
    }
    const fetchPolicyViolations = async () => {
      try {
        const violations = await api.get<{ items: any[] }>(
          `/governance/audit-logs?targetId=${selectedExec.id}&action=POLICY_CHECK`,
        );
        setPolicyViolations(violations?.items ?? []);
      } catch (err: any) {
        console.error('Failed to load policy violations:', err);
        setPolicyViolations([]);
      }
    };
    fetchPolicyViolations();
  }, [selectedExec]);

  const handleKill = async (execId: string) => {
    if (!confirm('이 실행을 중단하시겠습니까?')) return;
    try {
      await api.post(`/executions/${execId}/kill`, { reason: '수동 중단' });
      fetchData();
    } catch (err: any) {
      alert((err as Error).message ?? '중단 실패');
    }
  };

  const fmt = (ms: number | null) => {
    if (!ms) return '-';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  };
  const fmtTime = (d: string | null) =>
    d
      ? new Date(d).toLocaleTimeString('ko-KR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '-';

  const getSourceTag = (exec: ExecutionSession) => {
    if (!exec.metadata) return null;
    const sourceType = exec.metadata.sourceType || exec.workflowKey?.split(':')[0];
    if (sourceType === 'canary') return { label: 'Canary', color: 'cyan' };
    if (sourceType === 'shadow') return { label: 'Shadow', color: 'purple' };
    if (sourceType === 'replay') return { label: 'Replay', color: 'orange' };
    return null;
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <PageHeader
        title="실행 모니터링"
        description="워크플로우 실행 상태 실시간 모니터링 및 성능 분석"
        actions={
          <button
            onClick={fetchData}
            className="p-1.5 text-gray-600 hover:text-gray-900 transition"
          >
            <span className={loading ? 'animate-spin inline-block' : ''}>🔄</span>
          </button>
        }
      />

      {/* Stats — 5 columns */}
      {stats && (
        <div className="grid grid-cols-5 gap-4 mb-6">
          <SC label="전체 실행" value={stats.total} c="dark" />
          <SC label="실행 중" value={stats.running} c="blue" />
          <SC label="성공" value={stats.succeeded} c="green" />
          <SC label="실패" value={stats.failed} c="red" />
          <SC
            label="평균 소요시간"
            value={fmt(stats.avgLatencyMs)}
            c="amber"
            sub={`성공률 ${stats.successRate}%`}
          />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          ⚠️ {error}
        </div>
      )}

      {/* Two-column layout */}
      <div className="flex gap-4">
        {/* Left: Table */}
        <div className="flex-1">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <span>📊</span>
                <span className="text-sm font-semibold text-gray-900">실시간 실행 현황</span>
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">전체</option>
                <option value="RUNNING">실행 중</option>
                <option value="QUEUED">대기 중</option>
                <option value="SUCCEEDED">성공</option>
                <option value="FAILED">실패</option>
                <option value="CANCELLED">중단됨</option>
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[11px] text-gray-500 uppercase tracking-wider border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-4 py-2.5 font-semibold">워크플로우</th>
                    <th className="text-left px-4 py-2.5 font-semibold">현재 단계</th>
                    <th className="text-left px-4 py-2.5 font-semibold">진행률</th>
                    <th className="text-left px-4 py-2.5 font-semibold">시작 시간</th>
                    <th className="text-left px-4 py-2.5 font-semibold">소요 시간</th>
                    <th className="text-left px-4 py-2.5 font-semibold">상태</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.length === 0 && !loading && (
                    <tr>
                      <td colSpan={6} className="text-center text-gray-500 text-xs py-8">
                        실행 기록이 없습니다
                      </td>
                    </tr>
                  )}
                  {executions.map((ex) => {
                    const done =
                      (ex.steps ?? [])?.filter((s) => s?.status === 'SUCCEEDED').length ?? 0;
                    const tot = (ex.steps ?? [])?.length ?? 0;
                    const pct = tot > 0 ? Math.round((done / tot) * 100) : 0;
                    const cur =
                      (ex.steps ?? [])?.find((s) => s?.status === 'RUNNING')?.stepKey ??
                      (ex.steps ?? [])?.[(ex.steps ?? []).length - 1]?.stepKey ??
                      '-';
                    return (
                      <tr
                        key={ex.id}
                        onClick={() => setSelectedExec(ex)}
                        className={`border-b border-gray-100 hover:bg-blue-50 cursor-pointer transition ${selectedExec?.id === ex.id ? 'bg-blue-50' : ''}`}
                      >
                        <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">
                          <div className="flex items-center gap-2">
                            {ex.workflowKey ?? ex.capabilityKey ?? ex.id.slice(0, 8)}
                            {(() => {
                              const tag = getSourceTag(ex);
                              if (!tag) return null;
                              return (
                                <span
                                  className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                                    tag.color === 'cyan'
                                      ? 'bg-cyan-100 text-cyan-700'
                                      : tag.color === 'purple'
                                        ? 'bg-purple-100 text-purple-700'
                                        : 'bg-orange-100 text-orange-700'
                                  }`}
                                >
                                  {tag.label}
                                </span>
                              );
                            })()}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-700 font-mono">{cur}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${ex.status === 'SUCCEEDED' ? 'bg-green-500' : ex.status === 'FAILED' ? 'bg-red-500' : ex.status === 'RUNNING' ? 'bg-blue-500' : 'bg-gray-400'}`}
                                style={{ width: `${ex.status === 'SUCCEEDED' ? 100 : pct}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-gray-600 font-medium">
                              {ex.status === 'SUCCEEDED' ? 100 : pct}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-600">
                          {fmtTime(ex.startedAt)}
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-gray-600">
                          {fmt(ex.latencyMs)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <StatusBadge status={ex.status} />
                            {['RUNNING', 'QUEUED'].includes(ex.status) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleKill(ex.id);
                                }}
                                className="p-1 text-red-400 hover:text-red-600 transition"
                                title="실행 중단"
                              >
                                ⏹️
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: Detail Panel (320px) */}
        <div className="w-80 flex-shrink-0 space-y-4">
          {selectedExec ? (
            <>
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-green-700 flex items-center gap-1">
                    ▶️ 실행 흐름
                  </span>
                  <p className="text-[10px] text-gray-500 mt-0.5 font-mono">
                    {selectedExec.workflowKey ??
                      selectedExec.capabilityKey ??
                      selectedExec.id.slice(0, 12)}
                  </p>
                </div>
                <div className="p-4 space-y-0">
                  {(selectedExec.steps?.length ?? 0) === 0 ? (
                    <p className="text-[11px] text-gray-500">단계 정보 없음</p>
                  ) : (
                    (selectedExec.steps ?? []).map((step, i) => (
                      <div key={step?.id} className="relative pb-4 flex">
                        {i < ((selectedExec.steps ?? [])?.length ?? 0) - 1 && (
                          <div className="absolute left-2.5 top-5 w-0.5 h-6 bg-gray-200" />
                        )}
                        <div className="flex items-start gap-3 relative z-10 w-full">
                          <div
                            className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 ${step?.status === 'SUCCEEDED' ? 'bg-green-500 text-white' : step?.status === 'FAILED' ? 'bg-red-500 text-white' : step?.status === 'RUNNING' ? 'bg-blue-500 text-white animate-pulse' : 'bg-gray-200 text-gray-600'}`}
                          >
                            {i + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] text-gray-900 font-medium truncate">
                              {step?.stepKey}
                            </p>
                            <p className="text-[9px] text-gray-500">{step?.stepType}</p>
                          </div>
                          <StatusBadge status={step?.status ?? 'PENDING'} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-900">정책 위반</span>
                </div>
                <div className="p-3">
                  {policyViolations.length === 0 ? (
                    <p className="text-[11px] text-gray-500">정책 위반이 없습니다</p>
                  ) : (
                    <div className="space-y-2">
                      {policyViolations.map((violation, i) => (
                        <div key={i} className="p-2 bg-red-50 rounded border border-red-200">
                          <div className="flex items-start gap-2">
                            <span className="text-red-500 flex-shrink-0 mt-0.5">🛡️</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] text-gray-900 font-semibold truncate">
                                {violation?.ruleName ?? violation?.rule ?? '알 수 없는 규칙'}
                              </p>
                              <p
                                className={`text-[9px] mt-0.5 ${violation?.result === 'PASS' ? 'text-green-600' : 'text-red-600'}`}
                              >
                                {violation?.result === 'PASS' ? '✓ 통과' : '✗ 위반'}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Source Link */}
              {getSourceTag(selectedExec) && (
                <a
                  href={
                    getSourceTag(selectedExec)!.label === 'Canary'
                      ? '/release/canary'
                      : getSourceTag(selectedExec)!.label === 'Shadow'
                        ? '/release/shadow'
                        : '/release/replay'
                  }
                  className="block bg-white rounded-lg border border-gray-200 shadow-sm p-3 hover:border-blue-300 transition"
                >
                  <span
                    className={`text-[10px] font-semibold ${
                      getSourceTag(selectedExec)!.color === 'cyan'
                        ? 'text-cyan-700'
                        : getSourceTag(selectedExec)!.color === 'purple'
                          ? 'text-purple-700'
                          : 'text-orange-700'
                    }`}
                  >
                    {getSourceTag(selectedExec)!.label} 상세 페이지로 이동 →
                  </span>
                </a>
              )}

              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-900">실행 로그</span>
                </div>
                <div className="p-3">
                  <div className="bg-gray-900 rounded-lg p-3 font-mono text-[10px] text-gray-300 leading-relaxed max-h-40 overflow-y-auto">
                    <div>
                      <span className="text-gray-500">[{fmtTime(selectedExec.startedAt)}]</span>{' '}
                      <span className="text-yellow-400">실행 시작</span>
                    </div>
                    {(selectedExec.steps ?? []).map((s) => (
                      <div key={s?.id}>
                        <span className="text-gray-500">[--:--:--]</span>{' '}
                        <span
                          className={
                            s?.status === 'SUCCEEDED'
                              ? 'text-green-400'
                              : s?.status === 'FAILED'
                                ? 'text-red-400'
                                : 'text-cyan-400'
                          }
                        >
                          {s?.stepKey}
                        </span>{' '}
                        {s?.status === 'SUCCEEDED' ? '✓' : s?.status === 'FAILED' ? '✗' : '...'}
                      </div>
                    ))}
                    {selectedExec.endedAt && (
                      <div>
                        <span className="text-gray-500">[{fmtTime(selectedExec.endedAt)}]</span>{' '}
                        <span
                          className={
                            selectedExec.status === 'SUCCEEDED' ? 'text-green-400' : 'text-red-400'
                          }
                        >
                          실행 완료 ({fmt(selectedExec.latencyMs)})
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 flex flex-col items-center text-center">
              <span className="text-3xl text-gray-400 mb-3">📋</span>
              <p className="text-xs text-gray-600">왼쪽 목록에서 실행을 선택하세요</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SC({
  label,
  value,
  c,
  sub,
}: {
  label: string;
  value: number | string;
  c: string;
  sub?: string;
}) {
  const cm: Record<string, string> = {
    blue: 'text-blue-600',
    green: 'text-green-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
    dark: 'text-gray-900',
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 font-semibold">
        {label}
      </p>
      <p className={`text-xl font-bold ${cm[c] ?? 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}
