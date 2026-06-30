'use client';

/**
 * 관리자 — Ingest API Key 현황표.
 * 키 기준으로 비용·품질·보안·활용·이상동작을 연결해 본다.
 * 발급/수정 폼은 리스트 선택(메인 Agent·Sub-Agent·팀) 기반으로 공통화 — 자유입력 최소화.
 * 생성 후에도 매핑(팀/Agent/Sub-Agent/이름) 수정 가능.
 */
import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import type { LucideIcon } from 'lucide-react';
import {
  KeyRound,
  CheckCircle2,
  Activity,
  DollarSign,
  Target,
  ShieldCheck,
  AlertTriangle,
  Users,
  Boxes,
  Globe,
} from 'lucide-react';

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  env: string;
  teamId: string | null;
  teamName: string | null;
  agentKey: string | null;
  subAgentKey: string | null;
  agentName: string | null;
  allowedAgentNames: string[];
  callCount: number;
  calls7d: number;
  cost7d: number;
  evalN: number;
  avgQuality: number | null;
  avgSecurity: number | null;
  anomalyRate: number;
  lastRunAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  active: boolean;
  createdAt: string;
}
interface Group {
  label: string;
  keys: number;
  calls7d: number;
  cost7d: number;
  avgQuality: number | null;
  avgSecurity: number | null;
  anomalyRate: number;
}
interface Overview {
  keys: KeyRow[];
  groups: { byTeam: Group[]; bySubAgent: Group[]; byEnv: Group[] };
  totals: {
    keys: number;
    active: number;
    calls7d: number;
    cost7d: number;
    avgQuality: number | null;
    avgSecurity: number | null;
    anomalyRate: number;
  };
}
interface AgentOpt {
  key: string;
  name: string;
}
interface NodeOpt {
  nodeKey: string;
  name: string;
  uiType: string;
  workflows: Array<{ workflowKey: string; workflowName: string }>;
}

const usd = (v: number) => krw(v ?? 0, { decimals: 2 });
const fdate = (s: string | null) => (s ? new Date(s).toLocaleString('ko-KR') : '—');
const score = (v: number | null) => (v == null ? '—' : String(v));
const qTone = (v: number | null) =>
  v == null ? 'text-gray-400' : v >= 80 ? 'text-emerald-600' : v >= 60 ? 'text-amber-600' : 'text-rose-600';
const anomTone = (v: number) => (v >= 20 ? 'text-rose-600' : v >= 5 ? 'text-amber-600' : 'text-emerald-600');

function Card({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
        <Icon className="h-3.5 w-3.5 text-gray-400" />
        {label}
      </div>
      <div className={`mt-0.5 text-xl font-bold ${tone ?? 'text-gray-900'}`}>{value}</div>
    </div>
  );
}

function GroupTable({ icon: Icon, title, rows }: { icon: LucideIcon; title: string; rows: Group[] }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-gray-900 border-b border-gray-100 bg-gray-50">
        <Icon className="h-3.5 w-3.5 text-gray-400" />
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-gray-500 border-b border-gray-100">
              <th className="text-left px-2 py-1.5">그룹</th>
              <th className="text-right px-2 py-1.5">키</th>
              <th className="text-right px-2 py-1.5">호출</th>
              <th className="text-right px-2 py-1.5">비용</th>
              <th className="text-right px-2 py-1.5">품질</th>
              <th className="text-right px-2 py-1.5">보안</th>
              <th className="text-right px-2 py-1.5">이상</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-gray-400 py-3">
                  데이터 없음
                </td>
              </tr>
            )}
            {rows.map((g, i) => (
              <tr key={i} className="border-b border-gray-50">
                <td className="px-2 py-1.5 text-gray-800 whitespace-nowrap">{g.label}</td>
                <td className="px-2 py-1.5 text-right">{g.keys}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{g.calls7d}</td>
                <td className="px-2 py-1.5 text-right text-gray-500">{usd(g.cost7d)}</td>
                <td className={`px-2 py-1.5 text-right font-semibold ${qTone(g.avgQuality)}`}>{score(g.avgQuality)}</td>
                <td className={`px-2 py-1.5 text-right font-semibold ${qTone(g.avgSecurity)}`}>{score(g.avgSecurity)}</td>
                <td className={`px-2 py-1.5 text-right font-semibold ${anomTone(g.anomalyRate)}`}>{g.anomalyRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface FormState {
  name: string;
  env: string;
  teamId: string;
  agentKey: string;
  subAgentKey: string;
  allowedAgentNames: string;
}
const emptyForm: FormState = { name: '', env: 'live', teamId: '', agentKey: '', subAgentKey: '', allowedAgentNames: '' };

export default function IngestKeysAdminPage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  const [ov, setOv] = useState<Overview | null>(null);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [agentOpts, setAgentOpts] = useState<AgentOpt[]>([]);
  const [nodeOpts, setNodeOpts] = useState<NodeOpt[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newKeyPlain, setNewKeyPlain] = useState<string | null>(null);

  // 폼 모달: mode = create | edit
  const [form, setForm] = useState<{ open: boolean; mode: 'create' | 'edit'; id?: string; f: FormState } | null>(null);
  const [newTeam, setNewTeam] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [o, t, ag, nd] = await Promise.all([
        api.get<Overview>('/ingest/keys/overview'),
        api.get<{ items: Array<{ id: string; name: string }> }>('/ingest/teams').catch(() => ({ items: [] })),
        api.get<{ items: AgentOpt[] }>('/dashboard/agents').catch(() => ({ items: [] })),
        api.get<{ grouped: NodeOpt[] }>('/dashboard/nodes').catch(() => ({ grouped: [] })),
      ]);
      setOv(o);
      setTeams(t.items ?? []);
      setAgentOpts((ag.items ?? []).map((a: any) => ({ key: a.key ?? a.workflowKey, name: a.name ?? a.key })));
      setNodeOpts(nd.grouped ?? []);
    } catch (e) {
      setErr((e as Error)?.message ?? '불러오기 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => setForm({ open: true, mode: 'create', f: { ...emptyForm } });
  const openEdit = (k: KeyRow) =>
    setForm({
      open: true,
      mode: 'edit',
      id: k.id,
      f: {
        name: k.name,
        env: k.env,
        teamId: k.teamId ?? '',
        agentKey: k.agentKey ?? '',
        subAgentKey: k.subAgentKey ?? '',
        allowedAgentNames: (k.allowedAgentNames ?? []).join(', '),
      },
    });

  const submitForm = async () => {
    if (!form) return;
    const f = form.f;
    // 표시용 agentName = 선택한 Sub-Agent 또는 메인 Agent 라벨
    const subLabel = nodeOpts.find((n) => n.nodeKey === f.subAgentKey)?.name;
    const agentLabel = agentOpts.find((a) => a.key === f.agentKey)?.name;
    const body = {
      name: f.name || (subLabel ?? agentLabel ?? 'External Agent Key'),
      teamId: f.teamId || undefined,
      agentKey: f.agentKey || undefined,
      subAgentKey: f.subAgentKey || undefined,
      agentName: subLabel ?? agentLabel ?? undefined,
      allowedAgentNames: f.allowedAgentNames
        ? f.allowedAgentNames.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    };
    setErr(null);
    try {
      if (form.mode === 'create') {
        const res = await api.post<{ key: string }>('/ingest/keys', { ...body, env: f.env });
        setNewKeyPlain(res.key);
      } else {
        await api.patch(`/ingest/keys/${form.id}`, body);
      }
      setForm(null);
      await load();
    } catch (e) {
      setErr((e as Error)?.message ?? '저장 실패');
    }
  };

  const revoke = async (id: string) => {
    if (!confirm('이 키를 폐기하시겠습니까? (외부 Agent ingest 불가, 기록은 보존)')) return;
    try {
      await api.delete(`/ingest/keys/${id}`);
      await load();
    } catch (e) {
      setErr((e as Error)?.message ?? '폐기 실패');
    }
  };
  const hardDelete = async (id: string) => {
    if (!confirm('이 키를 완전 삭제할까요? 되돌릴 수 없습니다. (과거 호출 기록은 남습니다)')) return;
    try {
      await api.delete(`/ingest/keys/${id}?hard=true`);
      await load();
    } catch (e) {
      setErr((e as Error)?.message ?? '삭제 실패');
    }
  };
  const createTeam = async () => {
    if (!newTeam.trim()) return;
    try {
      await api.post('/ingest/teams', { name: newTeam.trim() });
      setNewTeam('');
      const t = await api.get<{ items: Array<{ id: string; name: string }> }>('/ingest/teams');
      setTeams(t.items ?? []);
    } catch (e) {
      setErr((e as Error)?.message ?? '팀 생성 실패');
    }
  };

  // 선택한 메인 Agent의 하위 Sub-Agent만 노출(없으면 전체)
  const subForAgent = (agentKey: string) => {
    const list = agentKey
      ? nodeOpts.filter((n) => n.workflows?.some((w) => w.workflowKey === agentKey))
      : nodeOpts;
    // nodeKey 중복 제거(동일 노드키가 여러 uiType로 그룹될 수 있어 React key/옵션 값 충돌 방지).
    const seen = new Set<string>();
    return list.filter((n) => {
      if (seen.has(n.nodeKey)) return false;
      seen.add(n.nodeKey);
      return true;
    });
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Ingest 키 현황 (관리자)"
        description="키 기준으로 비용·품질·보안·활용·이상동작을 연결해 봅니다. 발급/수정은 리스트에서 선택."
        actions={
          <div className="flex gap-2">
            <button onClick={() => void load()} className="px-3 py-1.5 border border-gray-200 text-xs font-semibold rounded hover:border-blue-300">
              새로고침
            </button>
            <button onClick={openCreate} className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-700">
              키 발급
            </button>
          </div>
        }
      />

      <div className="space-y-4">
        {err && <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-700">{err}</div>}
        {newKeyPlain && (
          <div className="px-3 py-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900">
            <div className="font-bold mb-1">새 키 (한 번만 표시) — 지금 복사하세요:</div>
            <code className="block bg-white border border-amber-200 rounded p-2 break-all">{newKeyPlain}</code>
            <button onClick={() => setNewKeyPlain(null)} className="mt-2 text-amber-700 underline">
              닫기
            </button>
          </div>
        )}

        <div className="px-3 py-2 bg-blue-50 border border-blue-100 rounded text-[11px] text-blue-800">
          이 표가 <b>키 기준 통합 뷰</b>입니다. 외부 SDK Agent가 이 키로 <code>/ingest/runs</code> 호출하면 같은 4Gate
          평가를 받고, 키·팀·Sub-Agent별로 호출/비용/품질/보안/이상이 집계됩니다. (최근 7일 · 이름 중복 발급은
          가능하며 prefix로 구분됩니다.)
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <Card icon={KeyRound} label="키 전체" value={String(ov?.totals.keys ?? 0)} />
          <Card icon={CheckCircle2} label="활성 키" value={String(ov?.totals.active ?? 0)} />
          <Card icon={Activity} label="호출(7일)" value={String(ov?.totals.calls7d ?? 0)} />
          <Card icon={DollarSign} label="비용(7일)" value={usd(ov?.totals.cost7d ?? 0)} />
          <Card icon={Target} label="평균 품질" value={score(ov?.totals.avgQuality ?? null)} tone={qTone(ov?.totals.avgQuality ?? null)} />
          <Card icon={ShieldCheck} label="평균 보안" value={score(ov?.totals.avgSecurity ?? null)} tone={qTone(ov?.totals.avgSecurity ?? null)} />
          <Card icon={AlertTriangle} label="이상 비율" value={`${ov?.totals.anomalyRate ?? 0}%`} tone={anomTone(ov?.totals.anomalyRate ?? 0)} />
        </div>

        {/* Groups */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <GroupTable icon={Users} title="팀별" rows={ov?.groups.byTeam ?? []} />
          <GroupTable icon={Boxes} title="Sub-Agent별" rows={ov?.groups.bySubAgent ?? []} />
          <GroupTable icon={Globe} title="환경(env)별" rows={ov?.groups.byEnv ?? []} />
        </div>

        {/* Key table */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold text-gray-900 border-b border-gray-100 bg-gray-50 flex justify-between">
            <span>키 목록</span>
            {loading && <span className="text-gray-400">불러오는 중…</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-100 bg-gray-50">
                  {['이름', 'prefix', 'env', '팀', '메인 Agent', 'Sub-Agent', '호출', '비용', '품질', '보안', '이상', '마지막', '상태', ''].map(
                    (h, i) => (
                      <th key={i} className="text-left px-2 py-1.5 whitespace-nowrap">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {(ov?.keys ?? []).length === 0 && !loading && (
                  <tr>
                    <td colSpan={14} className="text-center text-gray-400 py-6">
                      발급된 키가 없습니다. "키 발급"으로 외부/내부 Agent용 Ingest 키를 만드세요.
                    </td>
                  </tr>
                )}
                {(ov?.keys ?? []).map((k) => (
                  <tr key={k.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-medium text-gray-900 whitespace-nowrap">{k.name}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-500">{k.prefix}…</td>
                    <td className="px-2 py-1.5">{k.env}</td>
                    <td className="px-2 py-1.5">{k.teamName ?? '—'}</td>
                    <td className="px-2 py-1.5">{agentOpts.find((a) => a.key === k.agentKey)?.name ?? k.agentKey ?? '—'}</td>
                    <td className="px-2 py-1.5">{nodeOpts.find((n) => n.nodeKey === k.subAgentKey)?.name ?? k.subAgentKey ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{k.calls7d}</td>
                    <td className="px-2 py-1.5 text-right text-gray-500">{usd(k.cost7d)}</td>
                    <td className={`px-2 py-1.5 text-right font-semibold ${qTone(k.avgQuality)}`}>{score(k.avgQuality)}</td>
                    <td className={`px-2 py-1.5 text-right font-semibold ${qTone(k.avgSecurity)}`}>{score(k.avgSecurity)}</td>
                    <td className={`px-2 py-1.5 text-right font-semibold ${anomTone(k.anomalyRate)}`}>{k.anomalyRate}%</td>
                    <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{fdate(k.lastRunAt ?? k.lastUsedAt)}</td>
                    <td className="px-2 py-1.5">
                      {k.active ? (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">활성</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">폐기</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(k)} className="text-blue-600 hover:underline mr-2" title="매핑 수정">
                        수정
                      </button>
                      {k.active && (
                        <button onClick={() => revoke(k.id)} className="text-amber-600 hover:underline mr-2" title="폐기(기록 보존)">
                          폐기
                        </button>
                      )}
                      <button onClick={() => hardDelete(k.id)} className="text-rose-600 hover:underline" title="완전 삭제">
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Team manage */}
        <div className="bg-white border border-gray-200 rounded-lg p-3">
          <div className="text-xs font-semibold text-gray-900 mb-2">팀 관리</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={newTeam} onChange={(e) => setNewTeam(e.target.value)} placeholder="새 팀 이름" className="px-2 py-1 border border-gray-300 rounded text-xs" />
            <button onClick={createTeam} className="px-2.5 py-1 bg-gray-800 text-white text-xs rounded">
              팀 추가
            </button>
            <div className="flex flex-wrap gap-1 ml-2">
              {teams.map((t) => (
                <span key={t.id} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-[10px] rounded">
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 발급/수정 공용 모달 (리스트 선택) */}
      {form?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setForm(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-gray-900">
              {form.mode === 'create' ? 'Ingest 키 발급' : 'Ingest 키 수정'}
            </h3>
            <p className="text-[11px] text-gray-500">
              메인 Agent·Sub-Agent·팀을 <b>목록에서 선택</b>하면 됩니다. 키 값은 변경되지 않고 매핑만 바뀝니다.
            </p>

            <div>
              <label className="block text-[10px] text-gray-600 mb-0.5">키 이름 (선택 — 비우면 Agent명 사용)</label>
              <input
                value={form.f.name}
                onChange={(e) => setForm({ ...form, f: { ...form.f, name: e.target.value } })}
                placeholder="예: 결제리뷰 SDK 키"
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-600 mb-0.5">메인 Agent</label>
                <select
                  value={form.f.agentKey}
                  onChange={(e) => setForm({ ...form, f: { ...form.f, agentKey: e.target.value, subAgentKey: '' } })}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
                >
                  <option value="">(없음 / 외부 Agent)</option>
                  {agentOpts.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-gray-600 mb-0.5">Sub-Agent</label>
                <select
                  value={form.f.subAgentKey}
                  onChange={(e) => setForm({ ...form, f: { ...form.f, subAgentKey: e.target.value } })}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
                >
                  <option value="">(전체 / 미지정)</option>
                  {subForAgent(form.f.agentKey).map((n) => (
                    <option key={n.nodeKey} value={n.nodeKey}>
                      {n.name} ({n.uiType})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-600 mb-0.5">팀</label>
                <select
                  value={form.f.teamId}
                  onChange={(e) => setForm({ ...form, f: { ...form.f, teamId: e.target.value } })}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
                >
                  <option value="">(없음)</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              {form.mode === 'create' && (
                <div>
                  <label className="block text-[10px] text-gray-600 mb-0.5">환경</label>
                  <select
                    value={form.f.env}
                    onChange={(e) => setForm({ ...form, f: { ...form.f, env: e.target.value } })}
                    className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
                  >
                    <option value="live">live</option>
                    <option value="test">test</option>
                  </select>
                </div>
              )}
            </div>

            <details className="text-[11px]">
              <summary className="cursor-pointer text-gray-500">고급: 허용 agentName 제한 (선택)</summary>
              <p className="mt-1 text-[10px] text-gray-400">
                비워두면 제한 없음. 선택한 Agent 이름만 이 키로 ingest가 허용됩니다.
              </p>
              <div className="mt-1 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 grid grid-cols-2 gap-1">
                {agentOpts.length === 0 ? (
                  <span className="text-[10px] text-gray-400">등록된 Agent가 없습니다</span>
                ) : (
                  agentOpts.map((a) => {
                    const sel = form.f.allowedAgentNames
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    const checked = sel.includes(a.name);
                    return (
                      <label key={a.key} className="flex items-center gap-1 text-[11px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const set = new Set(sel);
                            if (checked) set.delete(a.name);
                            else set.add(a.name);
                            setForm({
                              ...form,
                              f: { ...form.f, allowedAgentNames: [...set].join(', ') },
                            });
                          }}
                        />
                        <span className="truncate">{a.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
            </details>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setForm(null)} className="px-3 py-1.5 text-xs border border-gray-200 rounded">
                취소
              </button>
              <button onClick={submitForm} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded font-semibold">
                {form.mode === 'create' ? '➕ 발급' : '💾 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
