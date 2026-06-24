'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import { RefreshCw, AlertCircle, Bug, ShieldCheck, Lightbulb, CheckCircle2 } from 'lucide-react';

// ── Types ──

interface ErrorPattern {
  id: string;
  workflowKey: string | null;
  stepKey?: string | null;
  signature: string;
  category: string;
  severity: string;
  occurrences: number;
  sampleMessage: string | null;
  recommendation: string | null;
  status: string;
  firstSeenAt?: string;
  lastSeenAt: string;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-danger-light text-danger',
  warning: 'bg-warning-light text-warning',
  info: 'bg-blue-100 text-accent',
};

const CATEGORY_LABEL: Record<string, string> = {
  execution: '실행',
  quality: '품질',
  security: '보안',
  anomaly: '이상',
};

// ── Page ──

export default function PatternsPage() {
  const [patterns, setPatterns] = useState<ErrorPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ErrorPattern | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const fetchPatterns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ items: ErrorPattern[] }>('/knowledge/error-patterns');
      const items = Array.isArray(data?.items) ? data.items : [];
      setPatterns(items);
      setSelected((prev) => (prev ? (items.find((p) => p.id === prev.id) ?? null) : null));
    } catch (err: any) {
      setError(err?.message ?? '오류 패턴을 불러오지 못했습니다');
      setPatterns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPatterns();
  }, [fetchPatterns]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  // Promote: create a MANUAL knowledge artifact from the pattern recommendation,
  // then promote that artifact to a governance policy.
  async function handlePromote(p: ErrorPattern) {
    if (!confirm(`이 오류 패턴을 지식으로 승격하고 정책으로 등록하시겠습니까?`)) return;
    try {
      const artifact = await api.post<{ id: string; title: string }>('/knowledge/artifacts', {
        title: `[오류패턴] ${p.signature}`,
        category: 'ERROR_PATTERN',
        content:
          `## 오류 패턴\n- 시그니처: ${p.signature}\n- 발생: ${p.occurrences}회 (심각도 ${p.severity})\n` +
          `- 샘플: ${p.sampleMessage ?? '-'}\n\n## 권고 조치\n${p.recommendation ?? '-'}`,
        tags: ['error-pattern', p.category],
        scopeJson: p.workflowKey ? { global: false, workflowKeys: [p.workflowKey] } : { global: true },
        source: 'AUTO_ERROR',
        priority: p.severity === 'critical' ? 10 : 5,
        status: 'ACTIVE',
      });
      const res = await api.post<{ policy: { key?: string; name?: string } }>(
        `/knowledge/artifacts/${artifact.id}/promote-policy`,
      );
      showToast(`정책으로 등록됨: ${res?.policy?.key ?? res?.policy?.name ?? '완료'}`);
      fetchPatterns();
    } catch (err: any) {
      showToast(err?.message ?? '승격 실패');
    }
  }

  const stats = {
    total: patterns.length,
    occurrences: patterns.reduce((s, p) => s + (p.occurrences ?? 0), 0),
    critical: patterns.filter((p) => p.severity === 'critical').length,
    open: patterns.filter((p) => p.status === 'OPEN').length,
  };
  const patternsPage = usePagination(patterns, 10);

  return (
    <div className="p-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 bg-gray-900 text-gray-900 rounded-lg shadow-lg text-xs">
          <CheckCircle2 size={14} className="text-green-400" />
          {toast}
        </div>
      )}

      <PageHeader
        title="오류 패턴 / 지식 후보"
        description="실행 실패에서 자동 수집된 오류 패턴 — 지식화·정책화 후보"
        actions={
          <button
            onClick={fetchPatterns}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        }
      />

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="패턴 수" value={stats.total} color="white" />
        <StatCard label="총 발생" value={stats.occurrences} color="danger" />
        <StatCard label="심각(critical)" value={stats.critical} color="warning" />
        <StatCard label="미처리(OPEN)" value={stats.open} color="accent" />
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      <div className="flex gap-4">
        {/* List */}
        <div className="flex-1">
          <div className="bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Bug size={14} className="text-red-600" />
                <span className="text-xs font-semibold text-gray-900">오류 패턴 목록</span>
              </div>
              <span className="text-[10px] text-gray-500">{patterns.length}개</span>
            </div>

            {loading ? (
              <div className="p-4 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-12 bg-white rounded animate-pulse" />
                ))}
              </div>
            ) : patterns.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <Bug size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-xs">수집된 오류 패턴이 없습니다</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="text-left px-4 py-2">시그니처</th>
                      <th className="text-left px-4 py-2">분류</th>
                      <th className="text-left px-4 py-2">발생</th>
                      <th className="text-left px-4 py-2">심각도</th>
                      <th className="text-left px-4 py-2">상태</th>
                      <th className="text-right px-4 py-2">작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {patternsPage.pageItems.map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => setSelected(p)}
                        className={`border-b border-gray-200 hover:bg-white cursor-pointer transition ${
                          selected?.id === p.id ? 'bg-blue-50' : ''
                        }`}
                      >
                        <td className="px-4 py-2.5 text-xs text-gray-900 font-medium font-mono max-w-[260px] truncate">
                          {p.signature}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">
                          {CATEGORY_LABEL[p.category] ?? p.category}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-red-600 font-semibold">
                          {p.occurrences}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              SEVERITY_STYLE[p.severity] ?? 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {p.severity}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePromote(p);
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-purple-light text-purple rounded text-[10px] font-semibold hover:opacity-80 transition"
                            title="지식으로 승격 + 정책 등록"
                          >
                            <ShieldCheck size={11} />
                            정책으로 등록
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pager p={patternsPage} />
              </div>
            )}
          </div>
        </div>

        {/* Detail */}
        <div className="w-96 flex-shrink-0 space-y-4">
          {selected ? (
            <>
              <div className="bg-gray-50 rounded-lg border border-gray-200">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-red-600 flex items-center gap-1">
                    <Bug size={12} />
                    패턴 상세
                  </span>
                </div>
                <div className="p-4 space-y-3 text-xs">
                  <div>
                    <p className="text-gray-500 mb-1">시그니처</p>
                    <p className="text-gray-900 font-mono break-all bg-white p-2 rounded border border-gray-200">
                      {selected.signature}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-gray-500 mb-1">워크플로우</p>
                      <p className="text-gray-900 font-mono">{selected.workflowKey ?? '-'}</p>
                    </div>
                    <div>
                      <p className="text-gray-500 mb-1">단계</p>
                      <p className="text-gray-900 font-mono">{selected.stepKey ?? '-'}</p>
                    </div>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-1">발생 건수</p>
                    <p className="text-2xl font-bold text-red-600">{selected.occurrences}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-1">마지막 발생</p>
                    <p className="text-gray-900">
                      {new Date(selected.lastSeenAt).toLocaleString('ko-KR')}
                    </p>
                  </div>
                  {selected.sampleMessage && (
                    <div>
                      <p className="text-gray-500 mb-1">샘플 메시지</p>
                      <p className="text-gray-900 bg-white p-2 rounded border border-gray-200">
                        {selected.sampleMessage}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {selected.recommendation && (
                <div className="bg-gray-50 rounded-lg border border-gray-200">
                  <div className="px-4 py-3 border-b border-gray-200">
                    <span className="text-xs font-semibold text-green-600 flex items-center gap-1">
                      <Lightbulb size={12} />
                      권고 조치
                    </span>
                  </div>
                  <div className="p-4 text-xs text-gray-900">{selected.recommendation}</div>
                </div>
              )}

              <button
                onClick={() => handlePromote(selected)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-purple text-gray-900 rounded text-xs font-semibold hover:opacity-90 transition"
              >
                <ShieldCheck size={14} />
                지식으로 승격 + 정책 등록
              </button>
            </>
          ) : (
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-6 flex flex-col items-center text-center">
              <Bug size={32} className="text-gray-500/30 mb-3" />
              <p className="text-xs text-gray-500">왼쪽 목록에서 패턴을 선택하세요</p>
            </div>
          )}
        </div>
      </div>
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
