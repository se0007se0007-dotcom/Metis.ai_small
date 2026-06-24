'use client';

/**
 * AgentCategoryView - category (operations/development/qa/utility) agent screen.
 *
 * - Runnable agent list (workflows tagged with this category) + run button
 * - Recently used agents (localStorage)
 * - Bottom: execution history table (row click -> detail popup)
 * - Detail popup: quality / security / cost / errors / knowledge / runtime / policy
 *   (GET /dashboard/executions/:id)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import {
  Bot,
  Play,
  RefreshCw,
  Star,
  ChevronRight,
  AlertTriangle,
  X,
  Gauge,
  ShieldCheck,
  DollarSign,
  Bug,
  BookOpen,
  Timer,
  FileCheck,
  Loader2,
  ChevronDown,
  Layers,
  Maximize2,
  Minimize2,
} from 'lucide-react';

interface AgentItem {
  key: string;
  code?: string | null;
  name: string;
  status: string;
  description: string;
  tags: string[];
  updatedAt: string;
  health: string;
  executions: number;
  successRate: number;
  avgScore: number;
  anomalyCount: number;
  subAgentCount?: number;
  subAgents?: Array<{ name: string; uiType: string; nodeKey: string; launchUrl?: string | null }>;
  /** 외부 전용 실행 화면 URL — 있으면 실행 시 그 화면을 임베드(iframe)해 실행·기록한다. */
  launchUrl?: string | null;
  /** 실행 모달이 Sub-Agent 실행일 때의 nodeKey — external-record 에 stepKey 로 전달(Sub 귀속). */
  _stepKey?: string;
}
interface ExecLog {
  id: string;
  workflowKey: string | null;
  capabilityKey: string | null;
  status: string;
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: string;
  triggeredById: string | null;
}

interface ExecStep {
  stepKey: string;
  stepType: string | null;
  capabilityKey: string | null;
  status: string;
  latencyMs: number | null;
  errorMessage: string | null;
}
interface ExecEval {
  stepKey: string | null;
  nodeType: string | null;
  agentName: string | null;
  overallScore: number | null;
  qualityGrade: string | null;
  accuracyScore: number | null;
  hallucationRate: number | null;
  responseQuality: number | null;
  securityScore: number | null;
  securityRiskLevel: string | null;
  inputThreatCount: number | null;
  outputLeakageCount: number | null;
  toolChainRisk: string | null;
  anomalyDetected: boolean | null;
  anomalyEvents: any;
  estimatedCostUsd: number | null;
  executionTimeMs: number | null;
  tokensUsed: number | null;
  costEfficiency: string | null;
  latencyGrade: string | null;
  recommendations: any;
}
interface ExecAlert {
  severity: string;
  status: string;
  summary: string | null;
  score: number | null;
  createdAt: string;
}
interface ExecDetail {
  found: boolean;
  session: {
    id: string;
    workflowKey: string | null;
    workflowName: string | null;
    capabilityKey: string | null;
    category: string | null;
    status: string;
    costUsd: number | null;
    latencyMs: number | null;
    createdAt: string;
    triggeredById: string | null;
  };
  steps: ExecStep[];
  evaluations: ExecEval[];
  alerts: ExecAlert[];
  policies: { name: string; type: string }[];
  knowledge: { title: string; category: string; status: string }[];
}

const HEALTH_COLOR: Record<string, string> = {
  healthy: 'bg-green-500',
  degraded: 'bg-amber-500',
  down: 'bg-red-500',
  idle: 'bg-gray-300',
};
const HEALTH_LABEL: Record<string, string> = {
  healthy: '정상',
  degraded: '주의',
  down: '비정상',
  idle: '유휴',
};
const STATUS_CLS = (s: string) =>
  s === 'SUCCEEDED'
    ? 'bg-green-100 text-green-700'
    : s === 'FAILED' || s === 'BLOCKED'
      ? 'bg-red-100 text-red-700'
      : s === 'RUNNING'
        ? 'bg-blue-100 text-blue-700'
        : 'bg-gray-100 text-gray-600';

const RISK_CLS = (s: string | null) =>
  s === 'HIGH' || s === 'CRITICAL'
    ? 'text-red-600'
    : s === 'MEDIUM'
      ? 'text-amber-600'
      : 'text-green-600';

const SEV_CLS = (s: string) =>
  s === 'CRITICAL' || s === 'HIGH'
    ? 'bg-red-100 text-red-700'
    : s === 'MEDIUM'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-gray-100 text-gray-600';

export function AgentCategoryView({
  category,
  title,
  description,
}: {
  category: string;
  title: string;
  description: string;
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [history, setHistory] = useState<ExecLog[]>([]);
  const [histPage, setHistPage] = useState(1);
  const HIST_PAGE_SIZE = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExecDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 직접 실행 상태
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  // metis 내 실행 창 — 여러 개를 동시에 띄워 이동·병행 실행 가능(닫기 전엔 유지).
  const [runWins, setRunWins] = useState<Array<{ id: number; agent: AgentItem; stepKey?: string }>>(
    [],
  );
  const winSeq = useRef(0);

  const recentKey = `metis_recent_agents`;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ag, hist] = await Promise.all([
        api.get<{ items: AgentItem[] }>(
          `/dashboard/agents?days=30&category=${encodeURIComponent(category)}`,
        ),
        api.get<{ items: ExecLog[] }>(
          `/dashboard/history?days=30&category=${encodeURIComponent(category)}&limit=100`,
        ),
      ]);
      setAgents(Array.isArray(ag?.items) ? ag.items : []);
      setHistory(Array.isArray(hist?.items) ? hist.items : []);
      setHistPage(1);
    } catch (err: any) {
      setError(err?.message ?? '데이터를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const s = JSON.parse(localStorage.getItem(recentKey) || '[]');
      if (Array.isArray(s)) setRecent(s);
    } catch {}
  }, [recentKey]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await api.get<ExecDetail>(`/dashboard/executions/${encodeURIComponent(id)}`);
      setDetail(d);
    } catch {
      setDetail({ found: false } as ExecDetail);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const rememberRecent = useCallback(
    (key: string) => {
      if (typeof window === 'undefined') return;
      try {
        const next = [key, ...recent.filter((k) => k !== key)].slice(0, 6);
        localStorage.setItem(recentKey, JSON.stringify(next));
        setRecent(next);
      } catch {}
    },
    [recent, recentKey],
  );

  /** 실행 클릭 → 새 실행 창을 띄운다(기존 창은 닫지 않음 → 병행 실행 가능). */
  const openRun = useCallback((agent: AgentItem) => {
    winSeq.current += 1;
    const id = winSeq.current;
    setRunWins((ws) => [...ws, { id, agent }]);
    rememberRecent(agent.key);
    setNotice(null);
  }, [rememberRecent]);

  /** Sub-Agent 실행 — 그 Sub의 전용화면(launchUrl)을 임베드, 기록은 stepKey(=nodeKey)로 귀속. */
  const openRunSub = useCallback(
    (parent: AgentItem, sub: { name: string; nodeKey: string; launchUrl?: string | null }) => {
      winSeq.current += 1;
      const id = winSeq.current;
      setRunWins((ws) => [
        ...ws,
        {
          id,
          stepKey: sub.nodeKey,
          agent: { ...parent, name: sub.name, code: null, launchUrl: sub.launchUrl ?? null },
        },
      ]);
      rememberRecent(parent.key);
      setNotice(null);
    },
    [rememberRecent],
  );

  const closeWin = useCallback((id: number) => {
    setRunWins((ws) => ws.filter((w) => w.id !== id));
  }, []);

  const openBuilder = (key: string) => {
    rememberRecent(key);
    router.push(`/orchestration/builder?workflow=${encodeURIComponent(key)}`);
  };

  const recentAgents = recent
    .map((k) => agents.find((a) => a.key === k))
    .filter(Boolean) as AgentItem[];
  const activeCount = agents.filter((a) => a.health !== 'idle').length;
  const avgScore = agents.length
    ? Math.round(agents.reduce((s, a) => s + a.avgScore, 0) / agents.length)
    : 0;

  return (
    <div className="px-6 pt-4 pb-6">
      {/* 카테고리 소제목 행 — 헤더/탭은 /agent 레이아웃에 고정 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">{title}</h2>
          <p className="text-[11px] text-muted-dark mt-0.5">{description}</p>
        </div>
        <button onClick={fetchAll} className="p-1.5 text-gray-500 hover:text-gray-900 transition" title="새로고침">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {notice && (
        <div
          className={`flex items-center gap-2 p-3 mb-4 rounded text-xs border ${
            notice.type === 'ok'
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-red-50 border-red-200 text-red-600'
          }`}
        >
          {notice.type === 'ok' ? <FileCheck size={14} /> : <AlertTriangle size={14} />}
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="text-current opacity-60 hover:opacity-100">
            <X size={13} />
          </button>
        </div>
      )}

      {/* summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatBox label="등록 Agent" value={agents.length} sub="개" />
        <StatBox label="활성" value={activeCount} sub="동작 중" color="text-green-600" />
        <StatBox label="평균 품질점수" value={avgScore} sub="100점 만점" color="text-blue-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* runnable agents */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Bot size={14} className="text-blue-600" />
            <span className="text-xs font-semibold text-gray-900">{title} 목록 (실행 가능)</span>
          </div>
          <div className="divide-y divide-gray-50 max-h-[420px] overflow-y-auto">
            {loading ? (
              <div className="p-4">
                <Skeleton />
              </div>
            ) : agents.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-xs text-gray-400">이 카테고리에 등록된 Agent가 없습니다.</p>
                <p className="text-[11px] text-gray-400 mt-1">
                  워크플로우 빌더에서 워크플로우를 만들고 태그에 "{category}"를 추가하면 여기에
                  표시됩니다.
                </p>
              </div>
            ) : (
              agents.map((a) => {
                const subCount = a.subAgentCount ?? a.subAgents?.length ?? 0;
                const expanded = expandedKey === a.key;
                return (
                  <div key={a.key} className="px-4 py-2.5 hover:bg-gray-50 transition">
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${HEALTH_COLOR[a.health]}`}
                        title={HEALTH_LABEL[a.health]}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate flex items-center gap-1.5">
                          {a.code && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-900 text-white text-[9px] font-mono font-bold flex-shrink-0">
                              {a.code}
                            </span>
                          )}
                          <span className="truncate">{a.name}</span>
                          {subCount > 0 && (
                            <button
                              onClick={() => setExpandedKey(expanded ? null : a.key)}
                              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[9px] font-semibold flex-shrink-0 hover:bg-indigo-100"
                              title="Sub-Agent 펼치기"
                            >
                              <Layers size={9} /> {subCount} sub agents
                              {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                            </button>
                          )}
                        </p>
                        <p className="text-[10px] text-gray-400 truncate">
                          {a.key} · {a.executions}회 · 성공률 {a.successRate}% · 점수 {a.avgScore}
                          {a.anomalyCount > 0 ? ` · 이상 ${a.anomalyCount}` : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => openBuilder(a.key)}
                        className="px-2 py-1 text-[11px] text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded transition flex-shrink-0"
                        title="빌더에서 편집"
                      >
                        편집
                      </button>
                      <button
                        onClick={() => openRun(a)}
                        className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 text-white rounded text-[11px] font-semibold hover:bg-blue-700 transition flex-shrink-0"
                      >
                        <Play size={11} /> 실행
                      </button>
                    </div>
                    {expanded && a.subAgents && a.subAgents.length > 0 && (
                      <div className="mt-2 ml-5 pl-3 border-l-2 border-indigo-100 space-y-1">
                        {a.subAgents.map((s, si) => (
                          <div
                            key={`${a.key}-sub-${si}`}
                            className="flex items-center gap-2 text-[10px] text-gray-600"
                          >
                            <span className="w-1 h-1 rounded-full bg-indigo-300 flex-shrink-0" />
                            <span className="font-medium text-gray-700">{s.name}</span>
                            <span className="text-gray-400">· {s.uiType}</span>
                            {s.launchUrl ? (
                              <button
                                onClick={() => openRunSub(a, s)}
                                title="이 Sub-Agent 전용화면 실행"
                                className="ml-auto flex items-center gap-1 px-2 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-semibold hover:bg-indigo-700 transition flex-shrink-0"
                              >
                                <Play size={9} /> 실행
                              </button>
                            ) : (
                              <span
                                className="ml-auto text-[9px] text-gray-300"
                                title="전용화면 URL 미등록 — 기준정보에서 등록하거나 SDK로 보고"
                              >
                                URL 미등록
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* recent */}
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Star size={14} className="text-amber-500" />
            <span className="text-xs font-semibold text-gray-900">최근 사용한 Agent</span>
          </div>
          <div className="divide-y divide-gray-50">
            {recentAgents.length === 0 ? (
              <p className="p-6 text-xs text-gray-400 text-center">최근 실행한 Agent가 없습니다.</p>
            ) : (
              recentAgents.map((a) => (
                <button
                  key={a.key}
                  onClick={() => openRun(a)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 transition text-left"
                  title="실행"
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${HEALTH_COLOR[a.health]}`}
                  />
                  <span className="flex-1 text-xs text-gray-900 truncate">{a.name}</span>
                  <Play size={12} className="text-blue-500" />
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* execution history */}
      <div className="bg-white border border-gray-200 rounded-lg">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-900">실행 이력 (최근 30일)</span>
          <span className="text-[10px] text-gray-400">{history.length}건</span>
        </div>
        {loading ? (
          <div className="p-4">
            <Skeleton />
          </div>
        ) : history.length === 0 ? (
          <p className="p-8 text-xs text-gray-400 text-center">실행 이력이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-gray-500 bg-gray-50 border-b border-gray-100">
                  <th className="text-left px-3 py-2">시간</th>
                  <th className="text-left px-3 py-2">Agent</th>
                  <th className="text-left px-3 py-2">기능</th>
                  <th className="text-center px-3 py-2">상태</th>
                  <th className="text-right px-3 py-2">지연</th>
                  <th className="text-right px-3 py-2">비용</th>
                  <th className="text-center px-3 py-2">상세</th>
                </tr>
              </thead>
              <tbody>
                {history.slice((histPage - 1) * HIST_PAGE_SIZE, histPage * HIST_PAGE_SIZE).map((h) => (
                  <tr
                    key={h.id}
                    className="border-b border-gray-50 hover:bg-gray-50 transition cursor-pointer"
                    onClick={() => openDetail(h.id)}
                  >
                    <td className="px-3 py-2 text-gray-500 font-mono whitespace-nowrap">
                      {new Date(h.createdAt).toLocaleString('ko-KR')}
                    </td>
                    <td className="px-3 py-2 text-gray-900">{h.workflowKey ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-500">{h.capabilityKey ?? '—'}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_CLS(h.status)}`}>
                        {h.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {h.latencyMs != null ? `${h.latencyMs}ms` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {h.costUsd != null ? `$${h.costUsd.toFixed(4)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <ChevronRight size={13} className="text-gray-400 inline" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {history.length > HIST_PAGE_SIZE && (
              <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 text-[11px] text-gray-500">
                <span>
                  {(histPage - 1) * HIST_PAGE_SIZE + 1}–{Math.min(histPage * HIST_PAGE_SIZE, history.length)} / {history.length}건
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setHistPage((p) => Math.max(1, p - 1))}
                    disabled={histPage === 1}
                    className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
                  >
                    이전
                  </button>
                  <span className="px-1">
                    {histPage} / {Math.ceil(history.length / HIST_PAGE_SIZE)}
                  </span>
                  <button
                    onClick={() =>
                      setHistPage((p) => Math.min(Math.ceil(history.length / HIST_PAGE_SIZE), p + 1))
                    }
                    disabled={histPage >= Math.ceil(history.length / HIST_PAGE_SIZE)}
                    className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
                  >
                    다음
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 실행 창 — 여러 개 동시(이동·전체화면·닫기 전까지 유지) → 병행 실행 */}
      {runWins.map((w, i) => (
        <RunWindow
          key={w.id}
          agent={w.agent}
          stepKey={w.stepKey}
          index={i}
          onClose={() => closeWin(w.id)}
          onOpenDetail={openDetail}
          onRecorded={fetchAll}
        />
      ))}

      {/* detail popup */}
      {selectedId && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedId(null)}
        >
          <div
            className="bg-white rounded-lg w-full max-w-2xl max-h-[88vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-sm font-bold text-gray-900">실행 상세</h2>
              <button
                onClick={() => setSelectedId(null)}
                className="text-gray-400 hover:text-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 overflow-y-auto">
              {detailLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
                  <Loader2 size={18} className="animate-spin" />
                  <span className="text-xs">상세 정보를 불러오는 중...</span>
                </div>
              ) : !detail || !detail.found ? (
                <p className="py-12 text-center text-xs text-gray-400">
                  상세 정보를 찾을 수 없습니다.
                </p>
              ) : (
                <ExecutionDetailBody
                  detail={detail}
                  onOpenBuilder={(k) =>
                    router.push(`/orchestration/builder?workflow=${encodeURIComponent(k)}`)
                  }
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Detail body: quality / security / cost / errors / knowledge / runtime / policy */
function ExecutionDetailBody({
  detail,
  onOpenBuilder,
}: {
  detail: ExecDetail;
  onOpenBuilder: (workflowKey: string) => void;
}) {
  const s = detail.session;
  const evals = detail.evaluations || [];
  const qualityVals = evals.map((e) => e.overallScore).filter((v): v is number => v != null);
  const avgQuality = qualityVals.length
    ? Math.round(qualityVals.reduce((a, b) => a + b, 0) / qualityVals.length)
    : null;
  const secVals = evals.map((e) => e.securityScore).filter((v): v is number => v != null);
  const avgSec = secVals.length
    ? Math.round(secVals.reduce((a, b) => a + b, 0) / secVals.length)
    : null;
  const totalThreats = evals.reduce(
    (a, e) => a + (e.inputThreatCount ?? 0) + (e.outputLeakageCount ?? 0),
    0,
  );
  const worstRisk =
    evals.find((e) => e.securityRiskLevel === 'CRITICAL')?.securityRiskLevel ??
    evals.find((e) => e.securityRiskLevel === 'HIGH')?.securityRiskLevel ??
    evals.find((e) => e.securityRiskLevel === 'MEDIUM')?.securityRiskLevel ??
    'LOW';
  const totalEvalCost = evals.reduce((a, e) => a + (e.estimatedCostUsd ?? 0), 0);
  const totalTokens = evals.reduce((a, e) => a + (e.tokensUsed ?? 0), 0);
  const errorSteps = (detail.steps || []).filter((st) => st.errorMessage || st.status === 'FAILED');
  const anomalies = evals.filter((e) => e.anomalyDetected);

  return (
    <div className="space-y-5">
      {/* meta */}
      <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
        <Meta k="실행 ID" v={s.id} mono />
        <Meta k="상태" v={s.status} />
        <Meta k="Agent (메인)" v={s.workflowName ?? s.workflowKey ?? '—'} />
        <Meta k="기능" v={s.capabilityKey ?? '—'} />
        <Meta k="실행 시각" v={new Date(s.createdAt).toLocaleString('ko-KR')} />
        <Meta k="실행자" v={s.triggeredById ?? '—'} mono />
      </div>

      {/* 4-axis summary */}
      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          icon={<Gauge size={14} />}
          label="품질"
          value={avgQuality != null ? `${avgQuality}` : '—'}
          unit={avgQuality != null ? '/100' : ''}
          color="text-blue-600"
        />
        <MetricCard
          icon={<ShieldCheck size={14} />}
          label="보안"
          value={avgSec != null ? `${avgSec}` : '—'}
          unit={avgSec != null ? '/100' : ''}
          color={RISK_CLS(worstRisk)}
        />
        <MetricCard
          icon={<DollarSign size={14} />}
          label="비용"
          value={`$${(s.costUsd ?? totalEvalCost ?? 0).toFixed(4)}`}
          unit=""
          color="text-emerald-600"
        />
        <MetricCard
          icon={<Timer size={14} />}
          label="수행시간"
          value={s.latencyMs != null ? `${s.latencyMs}` : '—'}
          unit={s.latencyMs != null ? 'ms' : ''}
          color="text-violet-600"
        />
      </div>

      {/* 구간별 소요 (실행 타임라인) — 어디서 시간이 걸렸는지 한눈에 */}
      <Section icon={<Timer size={13} />} title="구간별 소요 (어디서 시간이 걸렸나)">
        {(detail.steps || []).length === 0 ? (
          <Empty>
            구간 정보가 없습니다. 외부 전용화면 Agent는 실행 화면이 구간 타이밍을 보고할 때 표시됩니다.
          </Empty>
        ) : (
          (() => {
            const steps = (detail.steps || []).filter((st) => (st.latencyMs ?? 0) >= 0);
            const total = steps.reduce((a, st) => a + (st.latencyMs ?? 0), 0) || s.latencyMs || 1;
            const maxMs = Math.max(...steps.map((st) => st.latencyMs ?? 0), 1);
            const slowest = steps.reduce(
              (m, st) => ((st.latencyMs ?? 0) > (m.latencyMs ?? 0) ? st : m),
              steps[0],
            );
            const pct = (ms: number) => Math.round((ms / total) * 100);
            const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
            return (
              <div className="space-y-2">
                {steps.map((st, i) => {
                  const ms = st.latencyMs ?? 0;
                  const isMax = st === slowest;
                  return (
                    <div key={`${st.stepKey}-${i}`} className="text-[11px]">
                      <div className="flex justify-between mb-0.5">
                        <span className="truncate" title={st.stepKey}>
                          {st.stepKey}
                          {st.stepType ? (
                            <span className="text-gray-400"> · {st.stepType}</span>
                          ) : null}
                        </span>
                        <span className={isMax ? 'text-violet-700 font-semibold' : 'text-gray-500'}>
                          {fmt(ms)} · {pct(ms)}%
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded">
                        <div
                          className={`h-2 rounded ${isMax ? 'bg-violet-500' : 'bg-violet-300'}`}
                          style={{ width: `${Math.max(2, Math.round((ms / maxMs) * 100))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                <p className="text-[11px] text-gray-500 pt-1 leading-relaxed">
                  총 {fmt(total)} 중 <b className="text-violet-700">{slowest?.stepKey}</b> 구간이
                  가장 큽니다 ({pct(slowest?.latencyMs ?? 0)}%). 이 구간부터 개선(병렬화·캐시·모델/토큰
                  조정)하면 체감 효과가 가장 큽니다.
                </p>
              </div>
            );
          })()
        )}
      </Section>

      {/* quality per sub-agent */}
      <Section icon={<Gauge size={13} />} title="품질 (Sub-Agent 별 평가)">
        {evals.length === 0 ? (
          <Empty>평가 데이터가 없습니다.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 bg-gray-50">
                  <th className="text-left px-2 py-1.5">Sub-Agent (노드)</th>
                  <th className="text-center px-2 py-1.5">종합</th>
                  <th className="text-center px-2 py-1.5">등급</th>
                  <th className="text-center px-2 py-1.5">정확도</th>
                  <th className="text-center px-2 py-1.5">환각률</th>
                </tr>
              </thead>
              <tbody>
                {evals.map((e, i) => (
                  <tr key={i} className="border-t border-gray-50">
                    <td className="px-2 py-1.5 text-gray-900">
                      {e.agentName || e.stepKey || `노드 ${i + 1}`}
                      {e.nodeType ? <span className="text-gray-400"> · {e.nodeType}</span> : null}
                    </td>
                    <td className="px-2 py-1.5 text-center font-semibold text-gray-900">
                      {e.overallScore ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                        {e.qualityGrade ?? '—'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-center text-gray-600">
                      {e.accuracyScore != null ? `${e.accuracyScore}%` : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-center text-gray-600">
                      {e.hallucationRate != null ? `${e.hallucationRate}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* security */}
      <Section icon={<ShieldCheck size={13} />} title="보안">
        {evals.length === 0 ? (
          <Empty>보안 평가 데이터가 없습니다.</Empty>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <KV k="위험 수준" v={worstRisk} valueClass={RISK_CLS(worstRisk)} />
            <KV k="입력 위협" v={`${evals.reduce((a, e) => a + (e.inputThreatCount ?? 0), 0)}건`} />
            <KV
              k="출력 유출"
              v={`${evals.reduce((a, e) => a + (e.outputLeakageCount ?? 0), 0)}건`}
            />
            <KV
              k="위협 합계"
              v={`${totalThreats}건`}
              valueClass={totalThreats > 0 ? 'text-red-600' : ''}
            />
          </div>
        )}
      </Section>

      {/* cost */}
      <Section icon={<DollarSign size={13} />} title="비용">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
          <KV k="세션 비용" v={`$${(s.costUsd ?? 0).toFixed(4)}`} />
          <KV k="평가 합산 비용" v={`$${totalEvalCost.toFixed(4)}`} />
          <KV k="토큰 사용량" v={`${totalTokens.toLocaleString()} tok`} />
        </div>
      </Section>

      {/* errors / anomalies */}
      <Section icon={<Bug size={13} />} title="오류사항 / 이상 감지">
        {errorSteps.length === 0 && anomalies.length === 0 ? (
          <Empty>감지된 오류/이상이 없습니다.</Empty>
        ) : (
          <div className="space-y-1.5">
            {errorSteps.map((st, i) => (
              <div
                key={`err-${i}`}
                className="flex items-start gap-2 p-2 bg-red-50 border border-red-100 rounded text-[11px]"
              >
                <AlertTriangle size={12} className="text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <span className="font-medium text-red-700">{st.stepKey}</span>
                  <span className="text-red-600"> — {st.errorMessage || `상태: ${st.status}`}</span>
                </div>
              </div>
            ))}
            {anomalies.map((e, i) => (
              <div
                key={`ano-${i}`}
                className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-100 rounded text-[11px]"
              >
                <AlertTriangle size={12} className="text-amber-500 mt-0.5 flex-shrink-0" />
                <span className="text-amber-700">
                  이상 패턴 감지 · {e.agentName || e.stepKey || '노드'}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* policy */}
      <Section icon={<FileCheck size={13} />} title="정책">
        {detail.alerts && detail.alerts.length > 0 ? (
          <div className="space-y-1.5 mb-2">
            {detail.alerts.slice(0, 6).map((al, i) => (
              <div
                key={i}
                className="flex items-center gap-2 p-2 border border-gray-100 rounded text-[11px]"
              >
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${SEV_CLS(al.severity)}`}>
                  {al.severity}
                </span>
                <span className="flex-1 text-gray-700 truncate">
                  {al.summary || '정책 위반 알람'}
                </span>
                <span className="text-gray-400">{al.status}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-gray-400 mb-2">연결된 정책 위반 알람이 없습니다.</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {detail.policies && detail.policies.length > 0 ? (
            detail.policies.map((pol, i) => (
              <span
                key={i}
                className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px]"
                title={pol.type}
              >
                {pol.name}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-gray-400">활성 정책 없음</span>
          )}
        </div>
      </Section>

      {/* knowledge */}
      <Section icon={<BookOpen size={13} />} title="관련 지식정보">
        {detail.knowledge && detail.knowledge.length > 0 ? (
          <div className="space-y-1">
            {detail.knowledge.map((k, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-[11px] text-gray-700 py-1 border-b border-gray-50 last:border-0"
              >
                <BookOpen size={11} className="text-gray-400 flex-shrink-0" />
                <span className="flex-1 truncate">{k.title}</span>
                <span className="text-gray-400">{k.category}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>연결된 지식 자료가 없습니다.</Empty>
        )}
      </Section>

      {s.workflowKey && (
        <button
          onClick={() => onOpenBuilder(s.workflowKey!)}
          className="w-full py-2 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700"
        >
          빌더에서 이 Agent 열기
        </button>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number;
  sub: string;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-xs text-gray-600 uppercase tracking-wider font-semibold">{label}</p>
      <p className={`text-3xl font-bold mt-2 ${color ?? 'text-gray-900'}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-1">{sub}</p>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  unit,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit: string;
  color: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
      <div className={`flex items-center justify-center gap-1 ${color}`}>{icon}</div>
      <p className="text-[10px] text-gray-500 mt-1">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${color}`}>
        {value}
        <span className="text-[10px] text-gray-400 font-normal">{unit}</span>
      </p>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 text-gray-700">
        {icon}
        <span className="text-xs font-semibold">{title}</span>
      </div>
      {children}
    </div>
  );
}

function KV({ k, v, valueClass }: { k: string; v: string; valueClass?: string }) {
  return (
    <div className="bg-gray-50 rounded px-2 py-1.5">
      <p className="text-[10px] text-gray-500">{k}</p>
      <p className={`font-semibold text-gray-900 ${valueClass ?? ''}`}>{v}</p>
    </div>
  );
}

function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-500">{k}</span>
      <span
        className={`text-gray-900 ${mono ? 'font-mono text-[10px]' : 'font-medium'} text-right break-all`}
      >
        {v}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-gray-400">{children}</p>;
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-5 bg-gray-100 rounded animate-pulse" />
      ))}
    </div>
  );
}

/** 경량 Markdown 렌더 — 외부 Agent 리포트(헤딩/굵게/목록/코드블록/구분선)를 보기 좋게 표시. */
function ReportView({ md }: { md: string }) {
  const lines = (md || '').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const inline = (text: string): React.ReactNode =>
    text.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**') ? (
        <strong key={j} className="text-gray-900">
          {p.slice(2, -2)}
        </strong>
      ) : (
        <span key={j}>{p}</span>
      ),
    );
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre
          key={key++}
          className="bg-gray-900 text-gray-100 rounded p-2 text-[10px] overflow-x-auto my-1.5"
        >
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const level = (line.match(/^#+/) as RegExpMatchArray)[0].length;
      const text = line.replace(/^#+\s/, '');
      const cls =
        level <= 1
          ? 'text-sm font-bold mt-3 mb-1 text-gray-900'
          : level === 2
            ? 'text-xs font-bold mt-2.5 mb-1 text-gray-900'
            : 'text-[11px] font-bold mt-2 mb-0.5 text-gray-700';
      blocks.push(
        <p key={key++} className={cls}>
          {inline(text)}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc pl-4 my-1 space-y-0.5 text-[11px] text-gray-700">
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-2 border-gray-100" />);
      i++;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    blocks.push(
      <p key={key++} className="text-[11px] text-gray-700 my-1 leading-relaxed">
        {inline(line)}
      </p>,
    );
    i++;
  }
  return <div>{blocks}</div>;
}

// ── 실행 창(독립·이동형) — 여러 개 동시 띄워 병행 실행. iframe 결과는 자기 창에서만 기록. ──
function RunWindow({
  agent,
  stepKey,
  index,
  onClose,
  onOpenDetail,
  onRecorded,
}: {
  agent: AgentItem;
  stepKey?: string;
  index: number;
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onRecorded: () => void;
}) {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [full, setFull] = useState(false);
  const [pos, setPos] = useState({ x: 70 + index * 34, y: 64 + index * 34 });
  const [z, setZ] = useState(60 + index);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const front = () => setZ(Math.floor(Date.now() % 100000) + 60);

  // iframe 결과 기록 — 이 창의 iframe(contentWindow)에서 온 메시지만 처리(다중 창 구분).
  useEffect(() => {
    if (!agent.launchUrl) return;
    const onMsg = async (e: MessageEvent) => {
      const d: any = e?.data;
      if (!d || d.source !== 'metis-test-agent') return;
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      const p = d.payload || {};
      try {
        const res = await api.post<{ execution?: { executionSessionId?: string } }>(
          '/workflows/external-record',
          {
            workflowKey: agent.key,
            input: p.filename ? `[${p.filename}] ${p.language ?? ''}` : '',
            output: p.markdown || '',
            model: p.mode || 'external',
            costUsd: Number(p.cost) || 0,
            latencyMs: Math.round((Number(p.elapsed_s) || 0) * 1000),
            timings: p.timings ?? null,
            stepKey: stepKey || undefined,
          },
        );
        setSessionId(res?.execution?.executionSessionId ?? null);
        setNote({ type: 'ok', text: 'metis 대시보드·실행 이력에 기록되었습니다.' });
        onRecorded();
      } catch (err: any) {
        setNote({ type: 'err', text: `기록 실패: ${err?.message ?? '오류'}` });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [agent.launchUrl, agent.key, stepKey, onRecorded]);

  const doRun = useCallback(async () => {
    setBusy(true);
    setOutput(null);
    setSessionId(null);
    try {
      let res: { execution?: { executionSessionId?: string }; finalOutput?: string };
      if (agent.launchUrl) {
        res = await api.post('/workflows/run-external', {
          workflowKey: agent.key,
          filename: 'input.py',
          code: input,
        });
      } else {
        res = await api.post('/workflows/run-by-key', { workflowKey: agent.key, input });
      }
      setOutput(res?.finalOutput ?? '(출력 텍스트 없음 — 4게이트 상세에서 확인하세요)');
      setSessionId(res?.execution?.executionSessionId ?? null);
      onRecorded();
    } catch (err: any) {
      setOutput(`실행 실패: ${err?.message ?? '알 수 없는 오류'}`);
    } finally {
      setBusy(false);
    }
  }, [agent, input, onRecorded]);

  const onHeaderDown = (e: React.MouseEvent) => {
    if (full) return;
    front();
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: Math.max(0, ev.clientX - dragRef.current.dx),
        y: Math.max(0, ev.clientY - dragRef.current.dy),
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const style: React.CSSProperties = full
    ? { left: 0, top: 0, width: '100vw', height: '100vh', zIndex: z }
    : {
        left: pos.x,
        top: pos.y,
        width: agent.launchUrl ? 'min(960px, 94vw)' : 'min(560px, 94vw)',
        maxHeight: '88vh',
        zIndex: z,
      };

  return (
    <div
      className="fixed bg-white border border-gray-300 rounded-lg shadow-2xl flex flex-col overflow-hidden"
      style={style}
      onMouseDown={front}
    >
      <div
        onMouseDown={onHeaderDown}
        className={`flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50 select-none ${
          full ? '' : 'cursor-move'
        }`}
      >
        <h2 className="text-sm font-bold text-gray-900 flex items-center gap-1.5 truncate">
          <Play size={13} className="text-blue-600" />
          <span className="truncate">
            {agent.code ? `[${agent.code}] ` : ''}
            {agent.name}
          </span>
        </h2>
        <div className="flex items-center gap-2 flex-shrink-0">
          {sessionId && (
            <button
              onClick={() => onOpenDetail(sessionId)}
              className="text-[11px] text-blue-600 hover:underline font-semibold"
            >
              4게이트 상세 →
            </button>
          )}
          <button
            onClick={() => setFull((v) => !v)}
            title={full ? '창 모드' : '전체화면'}
            className="text-gray-400 hover:text-gray-700"
          >
            {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button onClick={onClose} title="닫기" className="text-gray-400 hover:text-gray-700">
            <X size={16} />
          </button>
        </div>
      </div>

      {note && (
        <div
          className={`px-4 py-1.5 text-[11px] flex-shrink-0 ${
            note.type === 'ok' ? 'text-emerald-700 bg-emerald-50' : 'text-rose-700 bg-rose-50'
          }`}
        >
          {note.text}
        </div>
      )}

      {agent.launchUrl ? (
        <div className="flex-1 flex flex-col min-h-0">
          <iframe
            ref={iframeRef}
            src={agent.launchUrl ?? undefined}
            title={agent.name}
            className="w-full flex-1 border-0"
            style={{ minHeight: full ? '0' : '60vh' }}
          />
        </div>
      ) : (
        <div className="p-4 space-y-3 overflow-y-auto">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={6}
            placeholder="이 Agent에 전달할 입력(비워도 실행)"
            className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg font-mono"
          />
          <button
            onClick={doRun}
            disabled={busy}
            className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 size={13} className="animate-spin" /> 실행 중…
              </>
            ) : (
              <>
                <Play size={13} /> 실행
              </>
            )}
          </button>
          {output !== null && (
            <pre className="p-3 text-[11px] text-gray-800 whitespace-pre-wrap max-h-72 overflow-y-auto border border-gray-200 rounded-lg">
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
