'use client';

/**
 * 모델 단가 기준정보 (마스터 데이터) — 관리자 전용.
 *
 * LLM 모델별 호출 단가(1M 토큰당 USD)의 단일 소스. 모든 Agent의 비용 계산이
 * 이 값을 기준으로 이뤄진다(FinOps ModelPrice). 글로벌 공통값이며 테넌트 구분 없음.
 *
 * 백엔드(기존):
 *   GET /finops/model-prices            — 목록 (DB + 빌트인 폴백)
 *   PUT /finops/model-prices/:modelId   — 등록/수정 (upsert, TENANT_ADMIN)
 *
 * 하드 삭제는 없고 active=false 로 비활성화한다(원가 이력 보존).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '@/lib/api-client';
import {
  Sparkles,
  RefreshCw,
  AlertTriangle,
  Plus,
  Pencil,
  Search,
  X,
  DollarSign,
  CheckCircle2,
  Circle,
} from 'lucide-react';

interface ModelPrice {
  modelId: string;
  provider: string;
  inputPerMUsd: number;
  outputPerMUsd: number;
  cachedInputPerMUsd?: number | null;
  tier: number;
  active: boolean;
  source?: string;
}

const PROVIDERS = ['anthropic', 'openai', 'google', 'selfhost', 'unknown'];
const PROVIDER_CLS: Record<string, string> = {
  anthropic: 'bg-orange-50 text-orange-700',
  openai: 'bg-emerald-50 text-emerald-700',
  google: 'bg-blue-50 text-blue-700',
  selfhost: 'bg-violet-50 text-violet-700',
  unknown: 'bg-gray-100 text-gray-600',
};
const TIER_LABEL: Record<number, string> = { 1: 'T1 경량', 2: 'T2 표준', 3: 'T3 고급' };
const SOURCE_CLS: Record<string, string> = {
  BUILTIN: 'bg-gray-100 text-gray-500',
  MANUAL: 'bg-blue-50 text-blue-700',
  SYNCED: 'bg-emerald-50 text-emerald-700',
};

const EMPTY: ModelPrice = {
  modelId: '',
  provider: 'anthropic',
  inputPerMUsd: 0,
  outputPerMUsd: 0,
  cachedInputPerMUsd: null,
  tier: 2,
  active: true,
};

export default function ModelPriceMasterPage() {
  const [rows, setRows] = useState<ModelPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [providerF, setProviderF] = useState('');
  const [editing, setEditing] = useState<ModelPrice | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ items: ModelPrice[] }>('/finops/model-prices');
      const items = Array.isArray(res?.items) ? res.items : [];
      items.sort((a, b) => a.provider.localeCompare(b.provider) || b.tier - a.tier || a.modelId.localeCompare(b.modelId));
      setRows(items);
    } catch (e: any) {
      setError(e?.message ?? '모델 단가를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => !providerF || r.provider === providerF)
      .filter((r) => !needle || r.modelId.toLowerCase().includes(needle) || r.provider.toLowerCase().includes(needle));
  }, [rows, q, providerF]);

  const openNew = () => {
    setEditing({ ...EMPTY });
    setIsNew(true);
  };
  const openEdit = (r: ModelPrice) => {
    setEditing({ ...r });
    setIsNew(false);
  };

  const save = async () => {
    if (!editing) return;
    const id = editing.modelId.trim();
    if (!id) {
      setNotice({ type: 'err', text: '모델 ID는 필수입니다.' });
      return;
    }
    if (!(editing.inputPerMUsd >= 0) || !(editing.outputPerMUsd >= 0)) {
      setNotice({ type: 'err', text: '입력/출력 단가는 0 이상 숫자여야 합니다.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await api.put(`/finops/model-prices/${encodeURIComponent(id)}`, {
        provider: editing.provider,
        inputPerMUsd: Number(editing.inputPerMUsd),
        outputPerMUsd: Number(editing.outputPerMUsd),
        cachedInputPerMUsd:
          editing.cachedInputPerMUsd === null || editing.cachedInputPerMUsd === undefined || (editing.cachedInputPerMUsd as any) === ''
            ? null
            : Number(editing.cachedInputPerMUsd),
        tier: Number(editing.tier) || 2,
        active: editing.active,
      });
      setNotice({ type: 'ok', text: `${id} 저장 완료` });
      setEditing(null);
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `저장 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (r: ModelPrice) => {
    try {
      await api.put(`/finops/model-prices/${encodeURIComponent(r.modelId)}`, {
        provider: r.provider,
        inputPerMUsd: r.inputPerMUsd,
        outputPerMUsd: r.outputPerMUsd,
        cachedInputPerMUsd: r.cachedInputPerMUsd ?? null,
        tier: r.tier,
        active: !r.active,
      });
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `상태 변경 실패: ${e?.message ?? ''}` });
    }
  };

  const activeCount = rows.filter((r) => r.active).length;
  const providerCount = new Set(rows.map((r) => r.provider)).size;

  return (
    <div className="p-6 bg-gray-50 min-h-full text-gray-900">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Sparkles size={20} className="text-violet-600" /> 모델 단가 기준정보
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            LLM 모델별 호출 단가(<b>1M 토큰당 USD</b>)의 단일 소스입니다. 모든 Agent의 비용 계산이 이
            값을 기준으로 이뤄집니다. 글로벌 공통값(테넌트 구분 없음).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openNew}
            className="flex items-center gap-1 px-3 py-1.5 bg-violet-600 text-white rounded-lg text-xs font-semibold hover:bg-violet-700"
          >
            <Plus size={13} /> 모델 추가
          </button>
          <button onClick={fetchAll} className="p-1.5 text-gray-500 hover:text-gray-900" title="새로고침">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 my-3 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
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

      {/* 요약 */}
      <div className="grid grid-cols-3 gap-3 my-4">
        <Stat icon={<Sparkles size={15} />} label="등록 모델" value={String(rows.length)} color="text-violet-600" />
        <Stat icon={<CheckCircle2 size={15} />} label="활성" value={String(activeCount)} color="text-emerald-600" />
        <Stat icon={<DollarSign size={15} />} label="공급자" value={String(providerCount)} color="text-blue-600" />
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={providerF}
          onChange={(e) => setProviderF(e.target.value)}
          className="bg-white border border-gray-200 rounded-lg text-xs px-2.5 py-1.5"
        >
          <option value="">전체 공급자</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="모델 ID·공급자 검색"
            className="w-full pl-8 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-400"
          />
        </div>
        <span className="text-[11px] text-gray-400 ml-auto">{filtered.length}개</span>
      </div>

      {/* 표 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 bg-gray-50 border-b border-gray-100">
              <th className="text-left px-3 py-2">모델 ID</th>
              <th className="text-left px-3 py-2">공급자</th>
              <th className="text-center px-3 py-2">티어</th>
              <th className="text-right px-3 py-2">입력 $/1M</th>
              <th className="text-right px-3 py-2">출력 $/1M</th>
              <th className="text-right px-3 py-2">캐시입력 $/1M</th>
              <th className="text-center px-3 py-2">출처</th>
              <th className="text-center px-3 py-2">상태</th>
              <th className="text-center px-3 py-2">관리</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="px-3 py-6">
                  <div className="h-5 bg-gray-100 rounded animate-pulse" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-400">
                  등록된 모델 단가가 없습니다.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.modelId} className={`border-b border-gray-50 hover:bg-gray-50 ${!r.active ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2 font-mono text-gray-900">{r.modelId}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${PROVIDER_CLS[r.provider] ?? PROVIDER_CLS.unknown}`}>
                      {r.provider}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center text-gray-600">{TIER_LABEL[r.tier] ?? `T${r.tier}`}</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-900">${r.inputPerMUsd}</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-900">${r.outputPerMUsd}</td>
                  <td className="px-3 py-2 text-right text-gray-500">
                    {r.cachedInputPerMUsd != null ? `$${r.cachedInputPerMUsd}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${SOURCE_CLS[r.source ?? 'BUILTIN'] ?? SOURCE_CLS.BUILTIN}`}>
                      {r.source ?? 'BUILTIN'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleActive(r)}
                      className={`inline-flex items-center gap-1 text-[11px] ${r.active ? 'text-emerald-600' : 'text-gray-400'}`}
                      title={r.active ? '활성 — 클릭 시 비활성' : '비활성 — 클릭 시 활성'}
                    >
                      {r.active ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                      {r.active ? '활성' : '비활성'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => openEdit(r)} className="text-gray-500 hover:text-violet-600" title="수정">
                      <Pencil size={13} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-400 mt-3">
        ※ 단가는 1M(백만) 토큰당 USD입니다. 캐시입력은 공급자 캐시 적중 시 단가(Anthropic≈입력의 10%,
        OpenAI≈50%). 하드 삭제는 제공하지 않으며 비활성화로 관리합니다(이력 보존).
      </p>

      {/* 등록/수정 모달 */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-lg w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">{isNew ? '모델 단가 추가' : '모델 단가 수정'}</h2>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <Field label="모델 ID (canonical)">
                <input
                  value={editing.modelId}
                  onChange={(e) => setEditing({ ...editing, modelId: e.target.value })}
                  disabled={!isNew}
                  placeholder="예: claude-sonnet-4-6, gpt-4o"
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg disabled:bg-gray-50 disabled:text-gray-500 font-mono"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="공급자">
                  <select
                    value={editing.provider}
                    onChange={(e) => setEditing({ ...editing, provider: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="티어">
                  <select
                    value={editing.tier}
                    onChange={(e) => setEditing({ ...editing, tier: Number(e.target.value) })}
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                  >
                    {[1, 2, 3].map((t) => (
                      <option key={t} value={t}>
                        {TIER_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="입력 단가 ($/1M)">
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={editing.inputPerMUsd}
                    onChange={(e) => setEditing({ ...editing, inputPerMUsd: Number(e.target.value) })}
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                  />
                </Field>
                <Field label="출력 단가 ($/1M)">
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={editing.outputPerMUsd}
                    onChange={(e) => setEditing({ ...editing, outputPerMUsd: Number(e.target.value) })}
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                  />
                </Field>
              </div>
              <Field label="캐시입력 단가 ($/1M, 선택)">
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={editing.cachedInputPerMUsd ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, cachedInputPerMUsd: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  placeholder="비우면 입력 단가로 계산"
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                />
              </Field>
              <label className="flex items-center gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                활성 (Agent 비용 계산에 사용)
              </label>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-1.5 bg-violet-600 text-white rounded-lg text-xs font-semibold hover:bg-violet-700 disabled:opacity-50"
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

function Stat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <div className={`flex items-center gap-1 ${color ?? 'text-gray-700'}`}>{icon}</div>
      <p className="text-[10px] text-gray-500 mt-1.5">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
