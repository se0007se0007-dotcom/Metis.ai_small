'use client';

/**
 * Agent 기준정보 (마스터 데이터) — 관리자 전용.
 *
 * - 메인 Agent(Workflow) ↔ 매핑된 Sub-Agent(노드)를 한 곳에서 관리/조회
 * - 표시 이름은 전 화면 공통 표준 `[코드] 이름` (agentDisplayName)
 * - 감시는 Sub-Agent 단위(품질·비용·보안·이상), 대시보드는 메인 기준 그룹핑
 * - Sub-Agent는 정확히 하나의 메인에만 매핑된다(다중 메인 불가)
 *
 * 데이터: 기존 집계 API 재사용
 *   GET /dashboard/agents   — 정의된 모든 메인 Agent + 매핑된 서브(노드) 목록 (spine)
 *   GET /dashboard/overview — 서브별 품질/비용/보안/이상 롤업 (있을 때 enrich)
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import { agentDisplayName } from '@/lib/agent-label';
import { AgentRegisterModal } from '@/components/shared/AgentRegisterModal';
import {
  Bot,
  Layers,
  RefreshCw,
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronRight,
  Gauge,
  DollarSign,
  ShieldCheck,
  Activity,
  Plus,
  Pencil,
  X,
  CheckCircle2,
  Trash2,
} from 'lucide-react';

// 기준정보에서 Sub-Agent 추가 시 고를 수 있는 대략적 유형(빌더에서 세부 설정).
const SUB_TYPES = [
  'ai-processing',
  'api-call',
  'data-collect',
  'data-storage',
  'log-monitor',
  'notification',
  'report',
  'condition',
];

interface EditAgentState {
  key: string;
  name: string;
  code: string;
  launchUrl: string;
  subs: { nodeKey: string; name: string; launchUrl: string }[];
}

interface SubDef {
  name: string;
  uiType: string;
  nodeKey: string;
  launchUrl?: string | null;
}
interface MainAgentDef {
  key: string;
  code?: string | null;
  name: string;
  status: string;
  listed?: boolean;
  description?: string;
  tags: string[];
  health: string;
  executions: number;
  successRate: number;
  avgScore: number;
  anomalyCount: number;
  subAgentCount?: number;
  subAgents?: SubDef[];
  launchUrl?: string | null;
}
interface SubRollup {
  stepKey: string;
  nodeType: string | null;
  agentName: string | null;
  evaluations: number;
  avgScore: number;
  anomalyCount: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  health: string;
  worstSecurityRisk: string | null;
}
interface MainRollup {
  workflowKey: string;
  totalCostUsd: number;
  subAgents: SubRollup[];
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
  s === 'PUBLISHED'
    ? 'bg-green-100 text-green-700'
    : s === 'DRAFT'
      ? 'bg-gray-100 text-gray-600'
      : s === 'ARCHIVED'
        ? 'bg-red-50 text-red-600'
        : 'bg-blue-50 text-blue-700';
const RISK_CLS = (s: string | null) =>
  s === 'critical' || s === 'high'
    ? 'text-red-600'
    : s === 'medium'
      ? 'text-amber-600'
      : 'text-green-600';
const RISK_LABEL = (s: string | null) =>
  !s ? '—' : s === 'critical' ? '심각' : s === 'high' ? '높음' : s === 'medium' ? '중간' : '낮음';

const CATEGORY_TABS = [
  { key: 'all', label: '전체' },
  { key: 'operations', label: '운영(OPS)' },
  { key: 'development', label: '개발(DEV)' },
];

export default function AgentMasterPage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  const [agents, setAgents] = useState<MainAgentDef[]>([]);
  const [rollups, setRollups] = useState<Record<string, MainRollup>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showRegister, setShowRegister] = useState(false);
  const [editAgent, setEditAgent] = useState<EditAgentState | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [newSub, setNewSub] = useState<{ name: string; uiType: string; launchUrl: string }>({
    name: '',
    uiType: 'ai-processing',
    launchUrl: '',
  });
  const [subBusy, setSubBusy] = useState(false);

  const openEdit = (a: MainAgentDef) =>
    setEditAgent({
      key: a.key,
      name: a.name,
      code: a.code ?? '',
      launchUrl: a.launchUrl ?? '',
      subs: (a.subAgents ?? []).map((s) => ({
        nodeKey: s.nodeKey,
        name: s.name,
        launchUrl: s.launchUrl ?? '',
      })),
    });

  const addSub = async () => {
    if (!editAgent) return;
    const name = newSub.name.trim();
    if (!name) {
      setNotice({ type: 'err', text: 'Sub-Agent 이름을 입력하세요.' });
      return;
    }
    setSubBusy(true);
    setNotice(null);
    try {
      const created = await api.post<{ nodeKey: string; name: string; uiType: string; launchUrl: string | null }>(
        `/workflows/by-key/${encodeURIComponent(editAgent.key)}/nodes`,
        { name, uiType: newSub.uiType, launchUrl: newSub.launchUrl.trim() || null },
      );
      setEditAgent({
        ...editAgent,
        subs: [
          ...editAgent.subs,
          { nodeKey: created.nodeKey, name: created.name, launchUrl: created.launchUrl ?? '' },
        ],
      });
      setNewSub({ name: '', uiType: newSub.uiType, launchUrl: '' });
      setNotice({ type: 'ok', text: `Sub-Agent 추가: ${created.name}` });
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `추가 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSubBusy(false);
    }
  };

  // 기존 Sub-Agent 이름/launchUrl 저장(노드 PATCH)
  const saveSub = async (nodeKey: string) => {
    if (!editAgent) return;
    const sub = editAgent.subs.find((s) => s.nodeKey === nodeKey);
    if (!sub) return;
    setSubBusy(true);
    setNotice(null);
    try {
      const res = await api.patch<{ nodeKey: string; name: string; launchUrl: string | null }>(
        `/workflows/by-key/${encodeURIComponent(editAgent.key)}/nodes/${encodeURIComponent(nodeKey)}`,
        { name: sub.name.trim(), launchUrl: sub.launchUrl.trim() || null },
      );
      setEditAgent({
        ...editAgent,
        subs: editAgent.subs.map((s) =>
          s.nodeKey === nodeKey ? { ...s, name: res.name, launchUrl: res.launchUrl ?? '' } : s,
        ),
      });
      setNotice({
        type: 'ok',
        text: `Sub-Agent 저장: ${res.name}${res.launchUrl ? ` · URL ${res.launchUrl}` : ''}`,
      });
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `저장 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSubBusy(false);
    }
  };

  const removeSub = async (nodeKey: string, name: string) => {
    if (!editAgent) return;
    if (!confirm(`Sub-Agent "${name}" 를 삭제할까요? (실행 이력은 보존됩니다)`)) return;
    setSubBusy(true);
    setNotice(null);
    try {
      await api.delete(`/workflows/by-key/${encodeURIComponent(editAgent.key)}/nodes/${encodeURIComponent(nodeKey)}`);
      setEditAgent({ ...editAgent, subs: editAgent.subs.filter((s) => s.nodeKey !== nodeKey) });
      setNotice({ type: 'ok', text: `Sub-Agent 삭제: ${name}` });
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `삭제 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSubBusy(false);
    }
  };

  const setListing = async (key: string, listed: boolean) => {
    setNotice(null);
    try {
      await api.post(`/workflows/by-key/${encodeURIComponent(key)}/listing`, { listed });
      setNotice({
        type: 'ok',
        text: listed ? '게시 완료 — 실행 카탈로그(운영/개발)에 노출됩니다.' : '미노출 전환 완료',
      });
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `처리 실패: ${e?.message ?? '알 수 없는 오류'}` });
    }
  };

  const saveEdit = async () => {
    if (!editAgent) return;
    if (!editAgent.name.trim()) {
      setNotice({ type: 'err', text: 'Agent 이름은 비울 수 없습니다.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const wantUrl = editAgent.launchUrl.trim() || null;
      const res = await api.patch<{
        key: string;
        code: string | null;
        name: string;
        launchUrl?: string | null;
      }>(`/workflows/by-key/${encodeURIComponent(editAgent.key)}/meta`, {
        name: editAgent.name.trim(),
        code: editAgent.code.trim() || null,
        launchUrl: wantUrl,
        nodes: editAgent.subs.map((s) => ({ nodeKey: s.nodeKey, name: s.name })),
      });
      // 저장 검증: 응답에 launchUrl 키가 없으면(=구버전 API) 경고로 즉시 알린다.
      if (wantUrl && !('launchUrl' in (res ?? {}))) {
        setNotice({
          type: 'err',
          text: '저장 요청은 보냈지만 서버 응답에 실행화면 URL이 없습니다. API가 옛 빌드일 수 있어요 — API 재빌드/재시작이 필요합니다.',
        });
      } else if (wantUrl && res?.launchUrl !== wantUrl) {
        setNotice({
          type: 'err',
          text: `실행화면 URL이 저장되지 않았습니다(서버 반환: ${res?.launchUrl ?? '없음'}). API 재시작 후 다시 시도하세요.`,
        });
      } else {
        setNotice({
          type: 'ok',
          text: `${editAgent.name} 저장 완료${wantUrl ? ` · 실행화면 URL: ${res?.launchUrl}` : ''}`,
        });
        setEditAgent(null);
      }
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `저장 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSaving(false);
    }
  };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ag, ov] = await Promise.all([
        // 기준정보(관리) 화면은 심사 전(미승인) Agent도 포함해 보여준다.
        api.get<{ items: MainAgentDef[] }>('/dashboard/agents?days=30&includeUnlisted=true'),
        api.get<{ mainAgents: MainRollup[] }>('/dashboard/overview?days=30'),
      ]);
      setAgents(Array.isArray(ag?.items) ? ag.items : []);
      const map: Record<string, MainRollup> = {};
      for (const m of ov?.mainAgents ?? []) map[m.workflowKey] = m;
      setRollups(map);
    } catch (e: any) {
      setError(e?.message ?? '기준정보를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const inCategory = (a: MainAgentDef, t: string) => {
    if (t === 'all') return true;
    const tags = (a.tags ?? []).map((x) => String(x).toLowerCase());
    const ops = ['operations', 'operation', 'ops', '운영', 'utility', 'util', '편의'];
    const dev = ['development', 'dev', '개발'];
    return tags.some((x) => (t === 'operations' ? ops : dev).includes(x));
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents
      .filter((a) => inCategory(a, tab))
      .filter((a) => {
        if (!needle) return true;
        return (
          agentDisplayName(a).toLowerCase().includes(needle) ||
          a.key.toLowerCase().includes(needle) ||
          (a.subAgents ?? []).some((s) => s.name.toLowerCase().includes(needle))
        );
      });
  }, [agents, q, tab]);

  const totalSubs = agents.reduce((s, a) => s + (a.subAgentCount ?? a.subAgents?.length ?? 0), 0);
  const avgQuality = agents.length
    ? Math.round(agents.reduce((s, a) => s + (a.avgScore || 0), 0) / agents.length)
    : 0;
  const totalAnom = agents.reduce((s, a) => s + (a.anomalyCount || 0), 0);
  const totalCost = Object.values(rollups).reduce((s, m) => s + (m.totalCostUsd || 0), 0);

  const subRollupFor = (key: string, nodeKey: string): SubRollup | undefined =>
    rollups[key]?.subAgents?.find((s) => s.stepKey === nodeKey);

  return (
    <div className="p-6 bg-gray-50 min-h-full text-gray-900">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Bot size={20} className="text-blue-600" /> Agent 기준정보
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            메인 Agent ↔ 매핑된 Sub-Agent를 한 곳에서 관리합니다. 표시 이름은{' '}
            <code className="px-1 bg-gray-100 rounded">[코드] 이름</code> 표준으로 통일되며, 감시는
            Sub-Agent 단위(품질·비용·보안·이상)로, 대시보드는 메인 기준으로 그룹핑됩니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowRegister(true)}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700"
          >
            <Plus size={13} /> Agent 등록
          </button>
          <button
            onClick={fetchAll}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition"
            title="새로고침"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {notice && (
        <div
          className={`flex items-center gap-2 p-2.5 my-3 rounded text-xs border ${
            notice.type === 'ok' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-600'
          }`}
        >
          {notice.type === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100">
            <X size={13} />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 my-3 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* 요약 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 my-4">
        <Stat icon={<Bot size={15} />} label="메인 Agent" value={String(agents.length)} color="text-blue-600" />
        <Stat icon={<Layers size={15} />} label="Sub-Agent" value={String(totalSubs)} color="text-indigo-600" />
        <Stat icon={<Gauge size={15} />} label="평균 품질" value={`${avgQuality}`} unit="/100" color="text-emerald-600" />
        <Stat icon={<AlertTriangle size={15} />} label="이상 합계" value={String(totalAnom)} color={totalAnom > 0 ? 'text-red-600' : 'text-gray-700'} />
        <Stat icon={<DollarSign size={15} />} label="비용(30일)" value={krw(totalCost, { decimals: 0 })} color="text-amber-600" />
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex bg-white border border-gray-200 rounded-lg p-0.5">
          {CATEGORY_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1 rounded text-xs font-semibold transition ${
                tab === t.key ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Agent·코드·Sub 검색"
            className="w-full pl-8 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <span className="text-[11px] text-gray-400 ml-auto">{filtered.length}개 메인 Agent</span>
      </div>

      {/* 목록 */}
      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
        {loading ? (
          <div className="p-6 space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-8 text-center text-xs text-gray-400">조건에 맞는 Agent가 없습니다.</p>
        ) : (
          filtered.map((a) => {
            const subs = a.subAgents ?? [];
            const open = !!expanded[a.key];
            const mainCost = rollups[a.key]?.totalCostUsd ?? 0;
            return (
              <div key={a.key}>
                {/* 메인 행 */}
                <div
                  role="button"
                  onClick={() => setExpanded((p) => ({ ...p, [a.key]: !p[a.key] }))}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition text-left cursor-pointer"
                >
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${HEALTH_COLOR[a.health] ?? 'bg-gray-300'}`} title={HEALTH_LABEL[a.health]} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {a.code && (
                        <span className="px-1.5 py-0.5 rounded bg-gray-900 text-white text-[9px] font-mono font-bold">
                          {a.code}
                        </span>
                      )}
                      <span className="text-sm font-medium text-gray-900 truncate">{a.name}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_CLS(a.status)}`}>{a.status}</span>
                      {a.listed === false && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 font-semibold" title="ORB 심사 승인 후 실행 카탈로그에 노출됩니다">
                          심사중·미노출
                        </span>
                      )}
                      <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[10px] font-semibold">
                        <Layers size={10} /> {subs.length} sub
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-400 truncate mt-0.5">{a.key}</p>
                  </div>
                  {/* 메인 롤업 칩 */}
                  <div className="hidden md:flex items-center gap-3 text-[11px] text-gray-500 flex-shrink-0">
                    <span title="실행 수"><Activity size={11} className="inline mb-0.5" /> {a.executions}</span>
                    <span title="평균 품질"><Gauge size={11} className="inline mb-0.5" /> {a.avgScore}</span>
                    <span title="비용(30일)"><DollarSign size={11} className="inline mb-0.5" /> {krw(mainCost, { decimals: 0 })}</span>
                    <span title="이상" className={a.anomalyCount > 0 ? 'text-red-600 font-semibold' : ''}>
                      <AlertTriangle size={11} className="inline mb-0.5" /> {a.anomalyCount}
                    </span>
                  </div>
                  {a.listed === false ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setListing(a.key, true);
                      }}
                      className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-semibold hover:bg-emerald-700 flex-shrink-0"
                      title="ORB 심사 없이 즉시 게시 — 실행 카탈로그에 노출"
                    >
                      즉시 게시
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setListing(a.key, false);
                      }}
                      className="px-1.5 py-0.5 rounded text-[10px] text-gray-400 hover:text-amber-700 hover:bg-amber-50 flex-shrink-0"
                      title="실행 카탈로그에서 숨김(미노출)"
                    >
                      숨김
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(a);
                    }}
                    className="p-1 text-gray-400 hover:text-blue-600 flex-shrink-0"
                    title="이름·코드 편집"
                  >
                    <Pencil size={13} />
                  </button>
                  {open ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                </div>

                {/* 서브 테이블 */}
                {open && (
                  <div className="px-4 pb-3 bg-gray-50/60">
                    {subs.length === 0 ? (
                      <p className="text-[11px] text-gray-400 px-2 py-3">매핑된 Sub-Agent(노드)가 없습니다.</p>
                    ) : (
                      <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="text-gray-500 bg-gray-50 border-b border-gray-100">
                              <th className="text-left px-3 py-2">Sub-Agent (노드)</th>
                              <th className="text-left px-3 py-2">유형</th>
                              <th className="text-center px-3 py-2"><Gauge size={11} className="inline" /> 품질</th>
                              <th className="text-right px-3 py-2"><DollarSign size={11} className="inline" /> 비용</th>
                              <th className="text-center px-3 py-2"><ShieldCheck size={11} className="inline" /> 보안</th>
                              <th className="text-center px-3 py-2"><AlertTriangle size={11} className="inline" /> 이상</th>
                              <th className="text-center px-3 py-2">상태</th>
                            </tr>
                          </thead>
                          <tbody>
                            {subs.map((s, i) => {
                              const r = subRollupFor(a.key, s.nodeKey);
                              return (
                                <tr key={`${a.key}-${s.nodeKey}-${i}`} className="border-t border-gray-50">
                                  <td className="px-3 py-2 text-gray-900 font-medium">{s.name}</td>
                                  <td className="px-3 py-2 text-gray-500">{s.uiType}</td>
                                  <td className="px-3 py-2 text-center font-semibold text-gray-900">
                                    {r ? r.avgScore : <span className="text-gray-300">—</span>}
                                  </td>
                                  <td className="px-3 py-2 text-right text-gray-600">
                                    {r ? krw(r.avgCostUsd, { decimals: 2 }) : <span className="text-gray-300">—</span>}
                                  </td>
                                  <td className={`px-3 py-2 text-center font-medium ${r ? RISK_CLS(r.worstSecurityRisk) : 'text-gray-300'}`}>
                                    {r ? RISK_LABEL(r.worstSecurityRisk) : '—'}
                                  </td>
                                  <td className={`px-3 py-2 text-center ${r && r.anomalyCount > 0 ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                                    {r ? r.anomalyCount : <span className="text-gray-300">—</span>}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {r ? (
                                      <span className="inline-flex items-center gap-1">
                                        <span className={`w-2 h-2 rounded-full ${HEALTH_COLOR[r.health] ?? 'bg-gray-300'}`} />
                                        {HEALTH_LABEL[r.health] ?? '—'}
                                      </span>
                                    ) : (
                                      <span className="text-gray-300">데이터 없음</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="text-[11px] text-gray-400 mt-3">
        ※ 새로 「Agent 등록」하면 <span className="text-amber-600 font-medium">심사중·미노출</span> 상태로
        시작합니다. 거버넌스 → 「심사·승격」에서 ORB 승인되거나 관리자가 「즉시 게시」를 누르면 실행
        카탈로그(Agent 실행 운영/개발)에 노출되어 실행할 수 있습니다. Sub-Agent는 하나의 메인 Agent에만
        매핑되며(다중 메인 불가), 연필 아이콘으로
        이름·코드·Sub 이름을 편집할 수 있습니다. 단가는 「모델 단가」 화면에서 관리합니다.
      </p>

      {/* Agent 등록 모달 (기준정보로 이동) */}
      {showRegister && (
        <AgentRegisterModal
          onClose={() => setShowRegister(false)}
          onDone={() => {
            setShowRegister(false);
            fetchAll();
          }}
        />
      )}

      {/* Agent 이름/코드/Sub 편집 모달 */}
      {editAgent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditAgent(null)}>
          <div className="bg-white rounded-lg w-full max-w-md max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-sm font-bold text-gray-900">Agent 기준정보 편집</h2>
              <button onClick={() => setEditAgent(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-3 overflow-y-auto">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label className="block text-[11px] font-semibold text-gray-500 mb-1">코드</label>
                  <input
                    value={editAgent.code}
                    onChange={(e) =>
                      setEditAgent({
                        ...editAgent,
                        // 표준 코드 형식 강제: 영문 대문자·숫자·하이픈만
                        code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''),
                      })
                    }
                    placeholder="OPS-001"
                    title="영문 대문자, 숫자, 하이픈(-)만 입력됩니다"
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg font-mono"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold text-gray-500 mb-1">이름</label>
                  <input
                    value={editAgent.name}
                    onChange={(e) => setEditAgent({ ...editAgent, name: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                  />
                </div>
              </div>
              <p className="text-[10px] text-gray-400">
                표시 이름:{' '}
                <span className="font-medium text-gray-600">
                  {agentDisplayName({ code: editAgent.code, name: editAgent.name })}
                </span>
              </p>
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1">
                  전용 실행 화면 URL (선택)
                </label>
                <input
                  value={editAgent.launchUrl}
                  onChange={(e) => setEditAgent({ ...editAgent, launchUrl: e.target.value })}
                  placeholder="예: http://localhost:8600 (FinOps 테스트에이전트, /api/test 는 자동)"
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  외부 전용 기능을 가진 Agent의 베이스 URL. 입력하면 「실행」 시 metis 안에서 소스/입력을 받아
                  metis가 그 기능(<code>{'{base}'}/api/test</code>)을 호출하고, 결과를 화면에 보여주며
                  대시보드·이력(비용·품질·보안·이상)에 기록합니다. (새 탭/별도 설정 불필요)
                </p>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1">
                  Sub-Agent ({editAgent.subs.length}) — 추가/삭제 가능
                </label>
                {editAgent.subs.length > 0 ? (
                  <div className="space-y-2.5">
                    {editAgent.subs.map((s, i) => (
                      <div key={s.nodeKey} className="rounded-lg border border-gray-100 p-2 space-y-1">
                        <div className="flex items-center gap-1.5">
                          <input
                            value={s.name}
                            onChange={(e) => {
                              const subs = editAgent.subs.slice();
                              subs[i] = { ...subs[i], name: e.target.value };
                              setEditAgent({ ...editAgent, subs });
                            }}
                            placeholder="Sub-Agent 이름"
                            className="flex-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                          />
                          <button
                            type="button"
                            onClick={() => void saveSub(s.nodeKey)}
                            disabled={subBusy}
                            className="px-2 py-1.5 bg-gray-800 text-white rounded-lg text-[11px] font-semibold disabled:opacity-50"
                          >
                            저장
                          </button>
                          <button
                            type="button"
                            onClick={() => removeSub(s.nodeKey, s.name)}
                            disabled={subBusy}
                            title="Sub-Agent 삭제"
                            className="px-2 py-1.5 text-rose-500 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <input
                          value={s.launchUrl}
                          onChange={(e) => {
                            const subs = editAgent.subs.slice();
                            subs[i] = { ...subs[i], launchUrl: e.target.value };
                            setEditAgent({ ...editAgent, subs });
                          }}
                          placeholder="전용 실행화면 URL (선택) — 예: http://localhost:8610"
                          className="w-full px-2.5 py-1.5 text-[11px] border border-gray-200 rounded-lg font-mono"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-400 mb-1.5">
                    매핑된 Sub-Agent가 없습니다. 아래에서 추가하세요.
                  </p>
                )}
                {/* 추가 행 */}
                <div className="mt-2 rounded-lg border border-dashed border-gray-200 p-2 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      value={newSub.name}
                      onChange={(e) => setNewSub({ ...newSub, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void addSub();
                        }
                      }}
                      placeholder="새 Sub-Agent 이름"
                      className="flex-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                    />
                    <select
                      value={newSub.uiType}
                      onChange={(e) => setNewSub({ ...newSub, uiType: e.target.value })}
                      className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white"
                    >
                      {SUB_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void addSub()}
                      disabled={subBusy || !newSub.name.trim()}
                      className="px-2.5 py-1.5 bg-gray-800 text-white rounded-lg text-xs font-semibold disabled:opacity-50"
                    >
                      추가
                    </button>
                  </div>
                  <input
                    value={newSub.launchUrl}
                    onChange={(e) => setNewSub({ ...newSub, launchUrl: e.target.value })}
                    placeholder="전용 실행화면 URL (선택) — 개인이 만든 화면 베이스 URL"
                    className="w-full px-2.5 py-1.5 text-[11px] border border-gray-200 rounded-lg font-mono"
                  />
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  Sub-Agent 등록 방법 2가지: (1) <b>전용 실행화면 URL</b>을 넣으면 메인처럼 그 화면을 metis에서
                  실행·기록합니다. (2) 화면 없이 함수만 있으면 <b>연동 설정</b>에서 Ingest 키를 받아 SDK로
                  <code> workflowKey+stepKey</code>를 보고하면 이 Sub-Agent로 집계됩니다. (유형은 대략 분류 —
                  세부 동작·연결은 빌더에서)
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 flex-shrink-0">
              <button onClick={() => setEditAgent(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  unit,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <div className={`flex items-center gap-1 ${color ?? 'text-gray-700'}`}>{icon}</div>
      <p className="text-[10px] text-gray-500 mt-1.5">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color ?? 'text-gray-900'}`}>
        {value}
        {unit && <span className="text-[11px] text-gray-400 font-normal">{unit}</span>}
      </p>
    </div>
  );
}
