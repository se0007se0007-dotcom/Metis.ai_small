'use client';

/**
 * 감사 로그 (AI 활동 로그) — 모든 상태 변경·실행·정책 검사 이벤트의 불변 추적.
 * 누가(actor)·언제(createdAt)·무엇을(action+target)·결과(policyResult/statusCode)를
 * 자유 검색 + 액션/기간 필터 + 행 클릭 상세로 제대로 보여준다.
 * API: GET /governance/audit-logs (q/action/targetType/from/to/page) + /audit-logs/summary
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';

interface AuditRow {
  id: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  policyResult?: string | null;
  correlationId: string;
  createdAt: string;
  actor?: { id: string; name?: string | null; email?: string | null } | null;
  metadataJson?: { method?: string; path?: string; durationMs?: number; statusCode?: number } | null;
}
interface AuditResp { items: AuditRow[]; total: number; page: number; pageSize: number; hasMore: boolean }
interface Summary {
  windowDays: number;
  total: number;
  byAction: { action: string; count: number }[];
  activeActors: number;
  lastEventAt: string | null;
}

const PAGE_SIZE = 10;

// 액션 한글 라벨 + 색
const ACTION_META: Record<string, { ko: string; cls: string }> = {
  CREATE: { ko: '생성', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  UPDATE: { ko: '수정', cls: 'text-blue-700 bg-blue-50 border-blue-200' },
  DELETE: { ko: '삭제', cls: 'text-rose-700 bg-rose-50 border-rose-200' },
  EXECUTE: { ko: '실행', cls: 'text-violet-700 bg-violet-50 border-violet-200' },
  POLICY_CHECK: { ko: '정책 검사', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  LOGIN: { ko: '로그인', cls: 'text-slate-700 bg-slate-100 border-slate-200' },
  PUBLISH: { ko: '게시', cls: 'text-cyan-700 bg-cyan-50 border-cyan-200' },
  STATUS_TRANSITION: { ko: '상태 전이', cls: 'text-indigo-700 bg-indigo-50 border-indigo-200' },
  BLOCK: { ko: '차단', cls: 'text-rose-700 bg-rose-50 border-rose-200' },
  CERTIFY: { ko: '인증', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  REVOKE_CERTIFICATION: { ko: '인증 취소', cls: 'text-rose-700 bg-rose-50 border-rose-200' },
  ARCHIVE: { ko: '보관', cls: 'text-gray-700 bg-gray-100 border-gray-200' },
  RESTORE: { ko: '복원', cls: 'text-blue-700 bg-blue-50 border-blue-200' },
  INSTALL: { ko: '설치', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  UNINSTALL: { ko: '제거', cls: 'text-rose-700 bg-rose-50 border-rose-200' },
  CANARY_PROMOTE: { ko: '카나리 승격', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  CANARY_ROLLBACK: { ko: '카나리 롤백', cls: 'text-rose-700 bg-rose-50 border-rose-200' },
  VERSION_PROMOTE: { ko: '버전 승격', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  VERSION_ROLLBACK: { ko: '버전 롤백', cls: 'text-rose-700 bg-rose-50 border-rose-200' },
};
const FILTER_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'EXECUTE', 'POLICY_CHECK', 'PUBLISH', 'STATUS_TRANSITION', 'BLOCK', 'LOGIN'];
const actionLabel = (a: string) => ACTION_META[a]?.ko ?? a;
const actionCls = (a: string) => ACTION_META[a]?.cls ?? 'text-gray-700 bg-gray-100 border-gray-200';

function relTime(s: string): string {
  const t = new Date(s).getTime();
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}일 전`;
  return new Date(s).toLocaleDateString('ko-KR');
}
function absTime(s: string): string {
  try { return new Date(s).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'medium' }); } catch { return s; }
}
function resultBadge(r: AuditRow): { txt: string; cls: string } {
  const sc = r.metadataJson?.statusCode;
  if (r.policyResult) {
    const ok = /allow|pass|ok|success/i.test(r.policyResult);
    return { txt: r.policyResult, cls: ok ? 'text-emerald-700' : 'text-rose-700' };
  }
  if (typeof sc === 'number') {
    const ok = sc < 400;
    return { txt: `HTTP ${sc}`, cls: ok ? 'text-emerald-700' : 'text-rose-700' };
  }
  return { txt: '—', cls: 'text-gray-400' };
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [detail, setDetail] = useState<AuditRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set('q', q.trim());
      if (action) p.set('action', action);
      if (from) p.set('from', new Date(from).toISOString());
      if (to) p.set('to', new Date(to + 'T23:59:59').toISOString());
      p.set('page', String(page));
      p.set('pageSize', String(PAGE_SIZE));
      const r = await api.get<AuditResp>(`/governance/audit-logs?${p.toString()}`);
      setRows(r?.items ?? []);
      setTotal(r?.total ?? 0);
    } catch (e: any) {
      setError(e?.message ?? '감사 로그를 불러오지 못했습니다 (AUDITOR 이상 권한 필요).');
      setRows([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [q, action, from, to, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<Summary>('/governance/audit-logs/summary?days=7').then(setSummary).catch(() => setSummary(null));
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const doSearch = () => { setPage(1); setQ(qInput); };
  const reset = () => { setQInput(''); setQ(''); setAction(''); setFrom(''); setTo(''); setPage(1); };

  return (
    <div className="p-6 pt-2">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900">AI 활동 로그</h2>
        <p className="text-sm text-gray-500">실행·상태 변경·정책 검사 이벤트의 불변 추적 — 누가 · 언제 · 무엇을 · 결과 (기간·액션 검색)</p>
      </div>

      {/* 요약 — 좌: 핵심 수치 / 우: 액션 분포 비율 막대 (한눈에) */}
      {(() => {
        const RISK_ACTIONS = ['DELETE', 'BLOCK', 'REVOKE_CERTIFICATION', 'CANARY_ROLLBACK', 'VERSION_ROLLBACK'];
        const total = summary?.total ?? 0;
        const byAction = summary?.byAction ?? [];
        const riskCount = byAction
          .filter((b) => RISK_ACTIONS.includes(b.action))
          .reduce((s, b) => s + b.count, 0);
        const top = byAction[0];
        const maxCount = Math.max(...byAction.map((b) => b.count), 1);
        return (
          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1.4fr] gap-3 mb-5">
            {/* 핵심 수치 4종 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="text-[11px] text-gray-500">최근 7일 이벤트</div>
                <div className="text-2xl font-extrabold text-gray-900 mt-0.5">{total.toLocaleString()}</div>
                <div className="text-[10px] text-gray-400 mt-1">
                  {summary?.lastEventAt ? `최근: ${relTime(summary.lastEventAt)}` : '—'}
                </div>
              </div>
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="text-[11px] text-gray-500">활성 사용자</div>
                <div className="text-2xl font-extrabold text-gray-900 mt-0.5">
                  {summary?.activeActors ?? 0}
                  <span className="text-sm text-gray-400 ml-1">명</span>
                </div>
                <div className="text-[10px] text-gray-400 mt-1">기간 내 활동한 actor</div>
              </div>
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="text-[11px] text-gray-500">최다 액션</div>
                <div className="text-base font-bold text-gray-900 mt-1 truncate">
                  {top ? actionLabel(top.action) : '—'}
                </div>
                <div className="text-[10px] text-gray-400 mt-1">
                  {top ? `${top.count.toLocaleString()}건 (${Math.round((top.count / total) * 100)}%)` : '—'}
                </div>
              </div>
              <div
                className={`rounded-lg p-4 border ${riskCount > 0 ? 'bg-rose-50 border-rose-200' : 'bg-white border-gray-200'}`}
              >
                <div className="text-[11px] text-gray-500">위험 액션 (삭제·차단·롤백)</div>
                <div className={`text-2xl font-extrabold mt-0.5 ${riskCount > 0 ? 'text-rose-600' : 'text-gray-900'}`}>
                  {riskCount.toLocaleString()}
                </div>
                <div className="text-[10px] text-gray-400 mt-1">
                  {riskCount > 0 ? '클릭하여 해당 이벤트 확인' : '주의 이벤트 없음'}
                </div>
              </div>
            </div>

            {/* 액션 분포 비율 막대 */}
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-gray-900">최근 7일 액션 분포</span>
                <span className="text-[10px] text-gray-400">막대/태그 클릭 → 해당 액션 필터</span>
              </div>
              {byAction.length === 0 ? (
                <p className="text-xs text-gray-400 py-6 text-center">데이터가 없습니다.</p>
              ) : (
                <>
                  {/* 누적 비율 스택바 */}
                  <div className="flex h-2.5 rounded overflow-hidden border border-gray-100 mb-3">
                    {byAction.slice(0, 8).map((b) => {
                      const m = ACTION_META[b.action];
                      const bg = RISK_ACTIONS.includes(b.action)
                        ? '#C77B7B'
                        : m?.cls.includes('emerald')
                          ? '#6FAF9A'
                          : m?.cls.includes('blue') || m?.cls.includes('cyan') || m?.cls.includes('indigo')
                            ? '#4F6BD8'
                            : m?.cls.includes('amber')
                              ? '#C9A45C'
                              : m?.cls.includes('violet')
                                ? '#8B7BD8'
                                : '#9CA3AF';
                      return (
                        <button
                          key={b.action}
                          onClick={() => { setAction(b.action); setPage(1); }}
                          title={`${actionLabel(b.action)} ${b.count}건 (${Math.round((b.count / total) * 100)}%)`}
                          style={{ width: `${(b.count / total) * 100}%`, backgroundColor: bg }}
                        />
                      );
                    })}
                  </div>
                  {/* Top 액션 행 + 미니 바 */}
                  <div className="space-y-1.5 max-h-[112px] overflow-y-auto">
                    {byAction.slice(0, 6).map((b) => (
                      <button
                        key={b.action}
                        onClick={() => { setAction(b.action); setPage(1); }}
                        className="w-full flex items-center gap-2 text-left group"
                      >
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${actionCls(b.action)}`}>
                          {actionLabel(b.action)}
                        </span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded overflow-hidden">
                          <div
                            className="h-full rounded bg-accent/60 group-hover:bg-accent transition-colors"
                            style={{ width: `${(b.count / maxCount) * 100}%` }}
                          />
                        </div>
                        <span className="text-[11px] font-semibold text-gray-700 w-12 text-right shrink-0">
                          {b.count.toLocaleString()}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* 필터 */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input
            type="text"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            placeholder="검색: 사용자(이름·이메일) · 대상 · 결과 · Correlation ID"
            className="flex-1 min-w-[260px] bg-white border border-gray-200 rounded px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-600 focus:outline-none"
          />
          <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="bg-white border border-gray-200 rounded px-3 py-2 text-sm text-gray-700">
            <option value="">전체 액션</option>
            {FILTER_ACTIONS.map((a) => <option key={a} value={a}>{actionLabel(a)} ({a})</option>)}
          </select>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="bg-white border border-gray-200 rounded px-2 py-2 text-sm text-gray-700" title="시작일" />
          <span className="text-gray-400 text-sm">~</span>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="bg-white border border-gray-200 rounded px-2 py-2 text-sm text-gray-700" title="종료일" />
          <button onClick={doSearch} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded px-4 py-2">검색</button>
          <button onClick={reset} className="bg-white border border-gray-200 text-gray-600 text-sm rounded px-3 py-2 hover:bg-gray-100">초기화</button>
        </div>

        <div className="text-xs text-gray-500 mb-2">총 {total.toLocaleString()}건 {loading ? '· 불러오는 중…' : ''}{action ? ` · 액션: ${actionLabel(action)}` : ''}</div>

        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 px-3">시간</th>
                <th className="py-2 px-3">액션</th>
                <th className="py-2 px-3">대상</th>
                <th className="py-2 px-3">사용자</th>
                <th className="py-2 px-3">결과</th>
                <th className="py-2 px-3">경로</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {error ? (
                <tr><td className="py-4 px-3 text-rose-600" colSpan={7}>{error}</td></tr>
              ) : !loading && rows.length === 0 ? (
                <tr><td className="py-6 px-3 text-gray-500 text-center" colSpan={7}>조건에 맞는 감사 로그가 없습니다.</td></tr>
              ) : (
                rows.map((r) => {
                  const res = resultBadge(r);
                  return (
                    <tr key={r.id} onClick={() => setDetail(r)} className="border-b border-gray-100 text-gray-700 hover:bg-blue-50/40 cursor-pointer">
                      <td className="py-2.5 px-3 whitespace-nowrap" title={absTime(r.createdAt)}>{relTime(r.createdAt)}</td>
                      <td className="py-2.5 px-3"><span className={`px-2 py-0.5 rounded border font-semibold ${actionCls(r.action)}`}>{actionLabel(r.action)}</span></td>
                      <td className="py-2.5 px-3">{r.targetType}{r.targetId ? <span className="text-gray-400"> · {r.targetId.slice(0, 10)}</span> : null}</td>
                      <td className="py-2.5 px-3">{r.actor?.name || r.actor?.email || <span className="text-gray-400">시스템</span>}</td>
                      <td className={`py-2.5 px-3 font-medium ${res.cls}`}>{res.txt}</td>
                      <td className="py-2.5 px-3 font-mono text-gray-400">{r.metadataJson?.method ? `${r.metadataJson.method} ${(r.metadataJson.path ?? '').slice(0, 28)}` : '—'}</td>
                      <td className="py-2.5 px-3 text-blue-600">상세 →</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-2 mt-4 text-sm">
            <button disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} className="px-3 py-1 rounded border border-gray-200 bg-white text-gray-700 disabled:opacity-40">이전</button>
            <span className="text-gray-500">{page} / {totalPages}</span>
            <button disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 rounded border border-gray-200 bg-white text-gray-700 disabled:opacity-40">다음</button>
          </div>
        )}
      </div>

      {/* 상세 모달 */}
      {detail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-lg w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded border font-semibold ${actionCls(detail.action)}`}>{actionLabel(detail.action)}</span>
                {detail.targetType}
              </h3>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
            </div>
            <dl className="text-sm divide-y divide-gray-100">
              {[
                ['언제', absTime(detail.createdAt) + ` (${relTime(detail.createdAt)})`],
                ['누가', detail.actor?.name || detail.actor?.email || '시스템'],
                ['이메일', detail.actor?.email || '—'],
                ['무엇을(액션)', `${actionLabel(detail.action)} · ${detail.action}`],
                ['대상', `${detail.targetType}${detail.targetId ? ' · ' + detail.targetId : ''}`],
                ['결과', detail.policyResult || (detail.metadataJson?.statusCode ? `HTTP ${detail.metadataJson.statusCode}` : '—')],
                ['HTTP', detail.metadataJson?.method ? `${detail.metadataJson.method} ${detail.metadataJson.path ?? ''}` : '—'],
                ['소요시간', detail.metadataJson?.durationMs != null ? `${detail.metadataJson.durationMs} ms` : '—'],
                ['Correlation ID', detail.correlationId],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3 py-2">
                  <dt className="w-28 flex-none text-gray-500">{k}</dt>
                  <dd className="flex-1 text-gray-900 break-all font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => { setQInput(detail.correlationId); setQ(detail.correlationId); setPage(1); setDetail(null); }}
                className="text-sm px-3 py-1.5 rounded border border-gray-200 text-gray-700 hover:bg-gray-100"
              >
                같은 Correlation 추적
              </button>
              <button onClick={() => setDetail(null)} className="text-sm px-4 py-1.5 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700">닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
