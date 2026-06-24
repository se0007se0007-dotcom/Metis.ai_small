'use client';

/**
 * 사용자 관리 (기준정보) — 관리자 전용.
 *
 * 현재 테넌트 구성원(User+Membership)을 등록/수정/삭제한다.
 * 백엔드: GET/POST /admin/users, PATCH/DELETE /admin/users/:userId
 *  - 등록 시 관리자가 초기 비밀번호를 지정(임시) → 사용자에게 전달, 첫 로그인 후 변경 권장
 *  - 본인 계정·마지막 관리자 삭제는 백엔드에서 차단
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '@/lib/api-client';
import {
  Users,
  RefreshCw,
  AlertTriangle,
  Plus,
  Pencil,
  Trash2,
  Search,
  X,
  CheckCircle2,
  Circle,
  ShieldCheck,
} from 'lucide-react';

interface UserRow {
  userId: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

const ROLES: { v: string; l: string; cls: string }[] = [
  { v: 'PLATFORM_ADMIN', l: '플랫폼 관리자', cls: 'bg-purple-50 text-purple-700' },
  { v: 'TENANT_ADMIN', l: '관리자', cls: 'bg-blue-50 text-blue-700' },
  { v: 'OPERATOR', l: '운영자', cls: 'bg-cyan-50 text-cyan-700' },
  { v: 'DEVELOPER', l: '개발자', cls: 'bg-emerald-50 text-emerald-700' },
  { v: 'AUDITOR', l: '감사자', cls: 'bg-amber-50 text-amber-700' },
  { v: 'VIEWER', l: '뷰어', cls: 'bg-gray-100 text-gray-600' },
];
const roleMeta = (v: string) => ROLES.find((r) => r.v === v) ?? { v, l: v, cls: 'bg-gray-100 text-gray-600' };

interface EditState {
  isNew: boolean;
  userId?: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  password: string;
}

export default function UsersAdminPage() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [roleF, setRoleF] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<UserRow | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ items: UserRow[] }>('/admin/users');
      setRows(Array.isArray(res?.items) ? res.items : []);
    } catch (e: any) {
      setError(e?.message ?? '사용자 목록을 불러오지 못했습니다');
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
      .filter((r) => !roleF || r.role === roleF)
      .filter((r) => !needle || r.email.toLowerCase().includes(needle) || (r.name ?? '').toLowerCase().includes(needle));
  }, [rows, q, roleF]);

  const openNew = () =>
    setEdit({ isNew: true, email: '', name: '', role: 'OPERATOR', isActive: true, password: '' });
  const openEdit = (r: UserRow) =>
    setEdit({ isNew: false, userId: r.userId, email: r.email, name: r.name, role: r.role, isActive: r.isActive, password: '' });

  const save = async () => {
    if (!edit) return;
    if (edit.isNew && (!edit.email.includes('@') || edit.password.length < 4)) {
      setNotice({ type: 'err', text: '이메일과 4자 이상 초기 비밀번호가 필요합니다.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      if (edit.isNew) {
        await api.post('/admin/users', {
          email: edit.email.trim(),
          name: edit.name.trim(),
          role: edit.role,
          password: edit.password,
        });
        setNotice({ type: 'ok', text: `${edit.email} 등록 완료` });
      } else {
        await api.patch(`/admin/users/${edit.userId}`, {
          name: edit.name.trim(),
          role: edit.role,
          isActive: edit.isActive,
          ...(edit.password ? { password: edit.password } : {}),
        });
        setNotice({ type: 'ok', text: `${edit.email} 수정 완료` });
      }
      setEdit(null);
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `저장 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (r: UserRow) => {
    setNotice(null);
    try {
      await api.delete(`/admin/users/${r.userId}`);
      setNotice({ type: 'ok', text: `${r.email} 삭제 완료` });
      setConfirmDel(null);
      await fetchAll();
    } catch (e: any) {
      setNotice({ type: 'err', text: `삭제 실패: ${e?.message ?? '알 수 없는 오류'}` });
      setConfirmDel(null);
    }
  };

  const activeCount = rows.filter((r) => r.isActive).length;
  const adminCount = rows.filter((r) => r.role === 'TENANT_ADMIN' || r.role === 'PLATFORM_ADMIN').length;

  return (
    <div className="p-6 bg-gray-50 min-h-full text-gray-900">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Users size={20} className="text-blue-600" /> 사용자 관리
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            현재 조직(테넌트)의 구성원 계정을 등록·수정·삭제합니다. 등록 시 초기 비밀번호를 지정해
            전달하세요(첫 로그인 후 변경 권장).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openNew}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700"
          >
            <Plus size={13} /> 사용자 등록
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
        <Stat icon={<Users size={15} />} label="전체 사용자" value={String(rows.length)} color="text-blue-600" />
        <Stat icon={<CheckCircle2 size={15} />} label="활성" value={String(activeCount)} color="text-emerald-600" />
        <Stat icon={<ShieldCheck size={15} />} label="관리자" value={String(adminCount)} color="text-purple-600" />
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={roleF} onChange={(e) => setRoleF(e.target.value)} className="bg-white border border-gray-200 rounded-lg text-xs px-2.5 py-1.5">
          <option value="">전체 역할</option>
          {ROLES.map((r) => (
            <option key={r.v} value={r.v}>
              {r.l}
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="이메일·이름 검색"
            className="w-full pl-8 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <span className="text-[11px] text-gray-400 ml-auto">{filtered.length}명</span>
      </div>

      {/* 표 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 bg-gray-50 border-b border-gray-100">
              <th className="text-left px-3 py-2">이름</th>
              <th className="text-left px-3 py-2">이메일</th>
              <th className="text-center px-3 py-2">역할</th>
              <th className="text-center px-3 py-2">상태</th>
              <th className="text-left px-3 py-2">가입일</th>
              <th className="text-center px-3 py-2">관리</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6">
                  <div className="h-5 bg-gray-100 rounded animate-pulse" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                  등록된 사용자가 없습니다.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const rm = roleMeta(r.role);
                return (
                  <tr key={r.userId} className={`border-b border-gray-50 hover:bg-gray-50 ${!r.isActive ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2 font-medium text-gray-900">{r.name || '—'}</td>
                    <td className="px-3 py-2 text-gray-600 font-mono">{r.email}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${rm.cls}`}>{rm.l}</span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center gap-1 text-[11px] ${r.isActive ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {r.isActive ? <CheckCircle2 size={12} /> : <Circle size={12} />}
                        {r.isActive ? '활성' : '비활성'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{new Date(r.createdAt).toLocaleDateString('ko-KR')}</td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button onClick={() => openEdit(r)} className="text-gray-500 hover:text-blue-600" title="수정">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => setConfirmDel(r)} className="text-gray-400 hover:text-red-600" title="삭제">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 등록/수정 모달 */}
      {edit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <div className="bg-white rounded-lg w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">{edit.isNew ? '사용자 등록' : '사용자 수정'}</h2>
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <Field label="이메일">
                <input
                  value={edit.email}
                  onChange={(e) => setEdit({ ...edit, email: e.target.value })}
                  disabled={!edit.isNew}
                  placeholder="user@company.com"
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg disabled:bg-gray-50 disabled:text-gray-500 font-mono"
                />
              </Field>
              <Field label="이름">
                <input
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  placeholder="표시 이름"
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                />
              </Field>
              <Field label="역할">
                <select
                  value={edit.role}
                  onChange={(e) => setEdit({ ...edit, role: e.target.value })}
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                >
                  {ROLES.map((r) => (
                    <option key={r.v} value={r.v}>
                      {r.l} ({r.v})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={edit.isNew ? '초기 비밀번호' : '비밀번호 재설정 (비우면 유지)'}>
                <input
                  type="password"
                  value={edit.password}
                  onChange={(e) => setEdit({ ...edit, password: e.target.value })}
                  placeholder={edit.isNew ? '4자 이상' : '변경 시에만 입력'}
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg"
                />
              </Field>
              {!edit.isNew && (
                <label className="flex items-center gap-2 text-xs text-gray-700">
                  <input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} />
                  활성 계정 (로그인 가능)
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setEdit(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 삭제 확인 */}
      {confirmDel && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setConfirmDel(null)}>
          <div className="bg-white rounded-lg w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2 text-red-600">
              <Trash2 size={16} />
              <h2 className="text-sm font-bold">사용자 삭제</h2>
            </div>
            <p className="text-xs text-gray-600">
              <b>{confirmDel.email}</b> 계정을 이 조직에서 삭제합니다. 다른 조직에 소속이 없으면 계정도 완전히
              삭제됩니다. 되돌릴 수 없습니다.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setConfirmDel(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
                취소
              </button>
              <button onClick={() => doDelete(confirmDel)} className="px-4 py-1.5 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700">
                삭제
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
