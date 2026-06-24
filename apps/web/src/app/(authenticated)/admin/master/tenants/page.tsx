'use client';

/**
 * 테넌트·팀 기준정보 (마스터 데이터) — 관리자 전용.
 *
 * 조직 그룹 = 테넌트, 그 아래 하위 팀 = Team. 조직(테넌트)을 추가/선택하고,
 * 선택한 조직의 하위 팀을 관리한다. 비용·Ingest 키 등은 팀 단위로 귀속된다.
 *
 * 백엔드:
 *   GET    /tenants/all                         — 전체 조직 목록
 *   POST   /tenants                             — 조직 생성
 *   DELETE /tenants/by-id/:id                   — 조직 삭제(본인 조직 불가, 데이터 없는 조직만)
 *   GET    /tenants/by-id/:id/org               — 특정 조직 + 팀 목록
 *   POST   /tenants/by-id/:id/teams             — 팀 생성
 *   PATCH  /tenants/by-id/:id/teams/:teamId     — 팀 이름 변경
 *   DELETE /tenants/by-id/:id/teams/:teamId     — 팀 삭제
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import {
  Database,
  Building2,
  Users,
  RefreshCw,
  AlertTriangle,
  Plus,
  Pencil,
  Trash2,
  X,
  CheckCircle2,
  KeyRound,
  ChevronRight,
} from 'lucide-react';

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  memberCount: number;
  teamCount: number;
}
interface Team {
  id: string;
  name: string;
  createdAt: string;
  keyCount: number;
}
interface OrgDetail {
  tenant: { id: string; slug: string; name: string; createdAt: string; memberCount: number };
  teams: Team[];
}

export default function TenantTeamMasterPage() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgLoading, setOrgLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [teamEdit, setTeamEdit] = useState<{ id?: string; name: string } | null>(null);
  const [tenantAdd, setTenantAdd] = useState<{ name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Team | null>(null);
  const [confirmDelTenant, setConfirmDelTenant] = useState<TenantRow | null>(null);

  const fetchOrg = useCallback(async (id: string) => {
    setOrgLoading(true);
    try {
      const res = await api.get<OrgDetail>(`/tenants/by-id/${id}/org`);
      setOrg(res ?? null);
    } catch (e: any) {
      setNotice({ type: 'err', text: `조직 상세를 불러오지 못했습니다: ${e?.message ?? ''}` });
      setOrg(null);
    } finally {
      setOrgLoading(false);
    }
  }, []);

  const fetchTenants = useCallback(
    async (selectId?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<{ items: TenantRow[] }>('/tenants/all');
        const items = Array.isArray(res?.items) ? res.items : [];
        setTenants(items);
        const target = selectId ?? selectedId ?? items[0]?.id ?? null;
        setSelectedId(target);
        if (target) await fetchOrg(target);
      } catch (e: any) {
        setError(e?.message ?? '조직 목록을 불러오지 못했습니다');
      } finally {
        setLoading(false);
      }
    },
    [selectedId, fetchOrg],
  );

  useEffect(() => {
    fetchTenants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectTenant = (id: string) => {
    setSelectedId(id);
    fetchOrg(id);
  };

  const addTenant = async () => {
    if (!tenantAdd) return;
    const name = tenantAdd.name.trim();
    if (!name) {
      setNotice({ type: 'err', text: '조직 이름을 입력하세요.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const created = await api.post<TenantRow>('/tenants', { name });
      setNotice({ type: 'ok', text: `조직 생성: ${name}` });
      setTenantAdd(null);
      await fetchTenants(created?.id);
    } catch (e: any) {
      setNotice({ type: 'err', text: `조직 생성 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSaving(false);
    }
  };

  const saveTeam = async () => {
    if (!teamEdit || !selectedId) return;
    const name = teamEdit.name.trim();
    if (!name) {
      setNotice({ type: 'err', text: '팀 이름을 입력하세요.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      if (teamEdit.id) {
        await api.patch(`/tenants/by-id/${selectedId}/teams/${teamEdit.id}`, { name });
        setNotice({ type: 'ok', text: `팀 이름 변경: ${name}` });
      } else {
        await api.post(`/tenants/by-id/${selectedId}/teams`, { name });
        setNotice({ type: 'ok', text: `팀 생성: ${name}` });
      }
      setTeamEdit(null);
      await fetchOrg(selectedId);
      await fetchTenants(selectedId);
    } catch (e: any) {
      setNotice({ type: 'err', text: `저장 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSaving(false);
    }
  };

  const doDeleteTeam = async (t: Team) => {
    if (!selectedId) return;
    setNotice(null);
    try {
      await api.delete(`/tenants/by-id/${selectedId}/teams/${t.id}`);
      setNotice({ type: 'ok', text: `팀 삭제: ${t.name}` });
      setConfirmDel(null);
      await fetchOrg(selectedId);
      await fetchTenants(selectedId);
    } catch (e: any) {
      setNotice({ type: 'err', text: `삭제 실패: ${e?.message ?? '알 수 없는 오류'}` });
      setConfirmDel(null);
    }
  };

  const doDeleteTenant = async (t: TenantRow) => {
    setNotice(null);
    try {
      await api.delete(`/tenants/by-id/${t.id}`);
      setNotice({ type: 'ok', text: `조직 삭제: ${t.name}` });
      setConfirmDelTenant(null);
      // 선택 중이던 조직을 지웠으면 선택 해제 후 목록 갱신
      const wasSelected = selectedId === t.id;
      if (wasSelected) {
        setSelectedId(null);
        setOrg(null);
      }
      await fetchTenants(wasSelected ? undefined : selectedId ?? undefined);
    } catch (e: any) {
      setNotice({ type: 'err', text: `조직 삭제 실패: ${e?.message ?? '알 수 없는 오류'}` });
      setConfirmDelTenant(null);
    }
  };

  return (
    <div className="p-6 bg-gray-50 min-h-full text-gray-900">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Database size={20} className="text-blue-600" /> 테넌트·팀 기준정보
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            조직(테넌트)을 추가·선택하고, 선택한 조직의 하위 <b>팀</b>을 관리합니다. 비용·Ingest 키 등은 팀
            단위로 귀속됩니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTenantAdd({ name: '' })}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700"
          >
            <Plus size={13} /> 테넌트 추가
          </button>
          <button onClick={() => fetchTenants()} className="p-1.5 text-gray-500 hover:text-gray-900" title="새로고침">
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

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mt-4">
        {/* 조직(테넌트) 목록 */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Building2 size={14} className="text-blue-600" />
            <span className="text-xs font-semibold text-gray-900">조직 (테넌트)</span>
            <span className="text-[11px] text-gray-400 ml-auto">{tenants.length}개</span>
          </div>
          <div className="divide-y divide-gray-50 max-h-[480px] overflow-y-auto">
            {loading ? (
              <div className="p-4 space-y-2">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            ) : tenants.length === 0 ? (
              <p className="p-6 text-xs text-gray-400 text-center">등록된 조직이 없습니다.</p>
            ) : (
              tenants.map((t) => {
                const sel = t.id === selectedId;
                return (
                  <div
                    key={t.id}
                    className={`group w-full flex items-center gap-2 px-4 py-2.5 transition ${
                      sel ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <button
                      onClick={() => selectTenant(t.id)}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-medium truncate ${sel ? 'text-blue-700' : 'text-gray-900'}`}>{t.name}</p>
                        <p className="text-[10px] text-gray-400 truncate font-mono">{t.slug}</p>
                      </div>
                      <span className="text-[10px] text-gray-500 flex items-center gap-1 flex-shrink-0">
                        <Users size={10} /> {t.memberCount}
                      </span>
                      <span className="text-[10px] text-gray-500 flex items-center gap-1 flex-shrink-0">
                        <Database size={10} /> {t.teamCount}
                      </span>
                      <ChevronRight size={13} className={sel ? 'text-blue-500' : 'text-gray-300'} />
                    </button>
                    <button
                      onClick={() => setConfirmDelTenant(t)}
                      title="조직 삭제"
                      className="flex-shrink-0 p-1 text-gray-300 hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 선택 조직의 팀 */}
        <div className="lg:col-span-3 bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Users size={14} className="text-indigo-600" />
            <span className="text-xs font-semibold text-gray-900">
              하위 팀{org ? ` — ${org.tenant.name}` : ''}
            </span>
            <button
              onClick={() => selectedId && setTeamEdit({ name: '' })}
              disabled={!selectedId}
              className="ml-auto flex items-center gap-1 px-2.5 py-1 bg-indigo-600 text-white rounded text-[11px] font-semibold hover:bg-indigo-700 disabled:opacity-40"
            >
              <Plus size={12} /> 팀 추가
            </button>
          </div>

          {!selectedId ? (
            <p className="p-8 text-center text-xs text-gray-400">왼쪽에서 조직을 선택하세요.</p>
          ) : orgLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-gray-500 bg-gray-50 border-b border-gray-100">
                  <th className="text-left px-4 py-2">팀 이름</th>
                  <th className="text-center px-3 py-2">Ingest 키</th>
                  <th className="text-left px-3 py-2">생성일</th>
                  <th className="text-center px-3 py-2">관리</th>
                </tr>
              </thead>
              <tbody>
                {!org || org.teams.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                      등록된 팀이 없습니다. “팀 추가”로 만드세요.
                    </td>
                  </tr>
                ) : (
                  org.teams.map((t) => (
                    <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-2 font-medium text-gray-900">{t.name}</td>
                      <td className="px-3 py-2 text-center text-gray-600">
                        <span className="inline-flex items-center gap-1">
                          <KeyRound size={11} className="text-gray-400" /> {t.keyCount}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-500">{new Date(t.createdAt).toLocaleDateString('ko-KR')}</td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button onClick={() => setTeamEdit({ id: t.id, name: t.name })} className="text-gray-500 hover:text-blue-600" title="이름 변경">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => setConfirmDel(t)} className="text-gray-400 hover:text-red-600" title="삭제">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <p className="text-[11px] text-gray-400 mt-3">
        ※ 팀 삭제 시 연결된 Ingest 키는 삭제되지 않고 팀 연결만 해제됩니다(키 자체는 「Ingest 키 현황」에서 관리).
      </p>

      {/* 조직 추가 모달 */}
      {tenantAdd && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setTenantAdd(null)}>
          <div className="bg-white rounded-lg w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">테넌트(조직) 추가</h2>
              <button onClick={() => setTenantAdd(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <label className="block text-[11px] font-semibold text-gray-500 mb-1">조직 이름</label>
              <input
                autoFocus
                value={tenantAdd.name}
                onChange={(e) => setTenantAdd({ name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addTenant()}
                placeholder="예: KT CRM본부"
                className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <p className="text-[10px] text-gray-400 mt-1.5">식별자(slug)는 이름에서 자동 생성됩니다.</p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setTenantAdd(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button onClick={addTenant} disabled={saving} className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50">
                {saving ? '생성 중...' : '생성'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 팀 생성/수정 모달 */}
      {teamEdit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setTeamEdit(null)}>
          <div className="bg-white rounded-lg w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">{teamEdit.id ? '팀 이름 변경' : '팀 추가'}</h2>
              <button onClick={() => setTeamEdit(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <label className="block text-[11px] font-semibold text-gray-500 mb-1">팀 이름</label>
              <input
                autoFocus
                value={teamEdit.name}
                onChange={(e) => setTeamEdit({ ...teamEdit, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && saveTeam()}
                placeholder="예: CRM운영팀"
                className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setTeamEdit(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button onClick={saveTeam} disabled={saving} className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 팀 삭제 확인 */}
      {confirmDel && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setConfirmDel(null)}>
          <div className="bg-white rounded-lg w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2 text-red-600">
              <Trash2 size={16} />
              <h2 className="text-sm font-bold">팀 삭제</h2>
            </div>
            <p className="text-xs text-gray-600">
              <b>{confirmDel.name}</b> 팀을 삭제합니다. 연결된 Ingest 키({confirmDel.keyCount}개)는 팀 연결만
              해제됩니다. 되돌릴 수 없습니다.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setConfirmDel(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button onClick={() => doDeleteTeam(confirmDel)} className="px-4 py-1.5 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700">
                삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 조직(테넌트) 삭제 확인 */}
      {confirmDelTenant && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setConfirmDelTenant(null)}>
          <div className="bg-white rounded-lg w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2 text-red-600">
              <Trash2 size={16} />
              <h2 className="text-sm font-bold">조직(테넌트) 삭제</h2>
            </div>
            <p className="text-xs text-gray-600">
              <b>{confirmDelTenant.name}</b> 조직을 삭제합니다. 되돌릴 수 없습니다.
            </p>
            <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              안전을 위해 <b>에이전트·실행 이력이 있는 조직은 삭제되지 않습니다</b>. 또한 현재 로그인한
              조직은 삭제할 수 없습니다. (서버에서 한 번 더 검증)
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setConfirmDelTenant(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button onClick={() => doDeleteTenant(confirmDelTenant)} className="px-4 py-1.5 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700">
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
