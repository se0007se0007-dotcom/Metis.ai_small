'use client';

/**
 * 증거팩(Evidence Pack) 조회 — 감사용 변조방지 해시체인 열람 + 무결성 검증.
 *   GET /governance/evidence-packs            — 목록(kind/기간 필터 + 페이지네이션)
 *   GET /governance/evidence-packs/verify-chain — 해시체인 무결성 검증
 * 승인/승격/런타임 거버넌스/FinOps 이벤트가 발생할 때마다 증거팩이 1건씩 쌓이고,
 * 각 팩은 직전 팩 해시(previousHash)에 연결되어(packHash) 위변조를 탐지할 수 있다.
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { api } from '@/lib/api-client';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2, Link2 } from 'lucide-react';

interface EvidencePack {
  id: string;
  kind: string; // RUNTIME | REGISTRATION | FINOPS
  executionSessionId?: string | null;
  workflowId?: string | null;
  orbGovernanceReviewId?: string | null;
  modelId?: string | null;
  packHash: string;
  previousHash?: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  REGISTRATION: { label: '등록·승격', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  RUNTIME: { label: '런타임 통제', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  FINOPS: { label: '비용', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

export default function EvidencePackPage() {
  const [packs, setPacks] = useState<EvidencePack[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('');
  const [chain, setChain] = useState<{ valid: boolean; checked: number; brokenAt?: string } | null>(
    null,
  );
  const [verifying, setVerifying] = useState(false);

  const fetchPacks = useCallback(async () => {
    setLoading(true);
    try {
      const q = kind ? `?kind=${encodeURIComponent(kind)}&limit=200` : '?limit=200';
      const res = await api.get<{ items: EvidencePack[]; total: number }>(
        `/governance/evidence-packs${q}`,
      );
      setPacks(Array.isArray(res?.items) ? res.items : []);
      setTotal(res?.total ?? 0);
    } catch {
      setPacks([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    fetchPacks();
  }, [fetchPacks]);

  const verifyChain = useCallback(async () => {
    setVerifying(true);
    try {
      const res = await api.get<{ valid: boolean; checked: number; brokenAt?: string }>(
        '/governance/evidence-packs/verify-chain?limit=1000',
      );
      setChain(res ?? null);
    } catch {
      setChain(null);
    } finally {
      setVerifying(false);
    }
  }, []);

  const page = usePagination(packs, 15);

  return (
    <div className="p-6">
      <PageHeader
        title="증거팩 (Evidence)"
        description="감사용 변조방지 해시체인 — 승인·승격·런타임 통제·비용 이벤트의 불변 증거"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={verifyChain}
              disabled={verifying}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <ShieldCheck size={15} className={verifying ? 'animate-pulse' : ''} />
              체인 무결성 검증
            </button>
            <button
              onClick={fetchPacks}
              className="p-2 text-muted-dark hover:text-gray-900"
              title="새로고침"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {/* 무결성 검증 결과 */}
      {chain && (
        <div
          className={`flex items-start gap-2 p-3 mb-4 rounded-lg text-sm border ${
            chain.valid
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {chain.valid ? (
            <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          )}
          <span>
            {chain.valid ? (
              <>
                <b>무결성 정상</b> — 증거 {chain.checked}건의 해시체인이 끊김 없이 연결되어 있습니다.
                (위변조 없음)
              </>
            ) : (
              <>
                <b>무결성 경고</b> — 해시체인이 <b>{short(chain.brokenAt)}</b> 지점에서 끊어졌습니다.
                위변조 또는 누락 의심. (검사 {chain.checked}건)
              </>
            )}
          </span>
        </div>
      )}

      {/* 필터 */}
      <div className="flex items-center gap-1.5 mb-3">
        <span className="text-[11px] text-muted-dark">종류</span>
        {[
          { v: '', l: `전체 (${total})` },
          { v: 'REGISTRATION', l: '등록·승격' },
          { v: 'RUNTIME', l: '런타임 통제' },
          { v: 'FINOPS', l: '비용' },
        ].map((o) => (
          <button
            key={o.v}
            onClick={() => setKind(o.v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
              kind === o.v ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {o.l}
          </button>
        ))}
      </div>

      {/* 목록 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-sm text-muted-dark">불러오는 중…</div>
        ) : packs.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-dark">
            증거팩이 아직 없습니다. 승인·승격이나 런타임 통제가 발생하면 자동으로 쌓입니다.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-[10px] text-gray-500">
                    <th className="text-left px-3 py-2">생성 시각</th>
                    <th className="text-left px-3 py-2">종류</th>
                    <th className="text-left px-3 py-2">대상</th>
                    <th className="text-left px-3 py-2">모델</th>
                    <th className="text-left px-3 py-2">증거 해시</th>
                    <th className="text-left px-3 py-2">직전 연결</th>
                  </tr>
                </thead>
                <tbody>
                  {page.pageItems.map((p) => {
                    const k = KIND_LABEL[p.kind] ?? {
                      label: p.kind,
                      cls: 'bg-gray-50 text-gray-600 border-gray-200',
                    };
                    return (
                      <tr key={p.id} className="border-b border-gray-100 last:border-0">
                        <td className="px-3 py-2 text-muted-dark whitespace-nowrap">
                          {new Date(p.createdAt).toLocaleString('ko-KR')}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${k.cls}`}>
                            {k.label}
                          </span>
                        </td>
                        <td
                          className="px-3 py-2 text-gray-700 truncate max-w-[200px]"
                          title={p.orbGovernanceReviewId || p.workflowId || p.executionSessionId || ''}
                        >
                          {p.orbGovernanceReviewId
                            ? `심사 ${p.orbGovernanceReviewId.slice(0, 8)}`
                            : p.workflowId
                              ? `WF ${p.workflowId.slice(0, 8)}`
                              : p.executionSessionId
                                ? `실행 ${p.executionSessionId.slice(0, 8)}`
                                : '—'}
                        </td>
                        <td className="px-3 py-2 text-muted-dark">{p.modelId ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-gray-900" title={p.packHash}>
                          {short(p.packHash)}
                        </td>
                        <td className="px-3 py-2 font-mono text-muted-dark" title={p.previousHash ?? ''}>
                          <span className="inline-flex items-center gap-1">
                            <Link2 size={11} className="text-gray-400" />
                            {short(p.previousHash)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager p={page} />
          </>
        )}
      </div>

      <p className="mt-3 text-[11px] text-muted-dark leading-relaxed">
        ※ 각 증거팩의 <b>증거 해시(packHash)</b>는 직전 팩 해시(previousHash)에 연결되어 사슬을
        이룹니다. 중간에 한 건이라도 변조·삭제되면 사슬이 끊어져 <b>체인 무결성 검증</b>에서 즉시
        드러납니다. 규제·감사 시 "언제·무엇을·누가 승인/실행했는가"의 위변조 불가능한 근거로 사용합니다.
      </p>
    </div>
  );
}
