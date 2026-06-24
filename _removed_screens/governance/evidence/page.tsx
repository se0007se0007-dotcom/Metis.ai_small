'use client';

/**
 * Evidence Pack 콘솔 — 실제 EvidencePack 테이블/해시체인 기반 (점검 H-3).
 *
 * 거버넌스의 모든 결정(등록 심사·실행 판정·FinOps 차단)이 남기는 위변조
 * 검증 가능한 증거를 조회하고, 해시체인 무결성을 검증한다.
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { api } from '@/lib/api-client';
import {
  RefreshCw,
  FileArchive,
  Link2,
  Loader2,
  XCircle,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';

// ── Types ──

interface EvidencePack {
  id: string;
  kind: string; // RUNTIME | REGISTRATION | FINOPS
  executionSessionId: string | null;
  workflowId: string | null;
  governanceDecisionId: string | null;
  orbGovernanceReviewId: string | null;
  policyVersionHash: string | null;
  workflowHash: string | null;
  promptHash: string | null;
  modelId: string | null;
  evaluationJson: Record<string, unknown>;
  fdsAlertIdsJson: string[] | null;
  autoActionJson: Record<string, unknown> | null;
  previousHash: string | null;
  packHash: string;
  createdAt: string;
}

interface ChainResult {
  valid: boolean;
  checked: number;
  brokenAt?: string;
}

const KIND_STYLE: Record<string, string> = {
  RUNTIME: 'bg-danger/15 text-danger border-danger/30',
  REGISTRATION: 'bg-warning/15 text-warning border-warning/30',
  FINOPS: 'bg-success/15 text-success border-success/30',
};

const KIND_LABEL: Record<string, string> = {
  RUNTIME: '수행',
  REGISTRATION: '등록',
  FINOPS: 'FinOps',
};

function kindBadge(kind: string) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${KIND_STYLE[kind] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

export default function EvidencePackPage() {
  const [packs, setPacks] = useState<EvidencePack[]>([]);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<EvidencePack | null>(null);
  const [chain, setChain] = useState<ChainResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const q = kind ? `?kind=${kind}&limit=100` : '?limit=100';
      const res = await api.get<{ items: EvidencePack[]; total: number }>(
        `/governance/evidence-packs${q}`,
      );
      setPacks(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const verifyChain = useCallback(async () => {
    setBusy('chain');
    setError(null);
    try {
      setChain(await api.get<ChainResult>('/governance/evidence-packs/verify-chain?limit=1000'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const counts = {
    RUNTIME: packs.filter((p) => p.kind === 'RUNTIME').length,
    REGISTRATION: packs.filter((p) => p.kind === 'REGISTRATION').length,
    FINOPS: packs.filter((p) => p.kind === 'FINOPS').length,
  };

  return (
    <div className="pb-10">
      <PageHeader
        title="Evidence Pack"
        description="거버넌스 결정의 위변조 검증 가능한 증거 — 등록·수행·FinOps 전 결정을 해시체인으로 보존"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => void verifyChain()}
              disabled={busy != null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
            >
              {busy === 'chain' ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              해시체인 무결성 검증
            </button>
            <button
              onClick={() => void load()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
            >
              <RefreshCw size={13} /> 새로고침
            </button>
          </div>
        }
      />

      <div className="px-6">
        {/* 체인 검증 결과 배너 */}
        {chain && (
          <div
            className={`flex items-center gap-2 p-3 mb-4 rounded-lg border text-xs ${chain.valid ? 'bg-success/10 border-success/30 text-success' : 'bg-danger/10 border-danger/30 text-danger'}`}
          >
            <ShieldCheck size={16} className="shrink-0" />
            {chain.valid ? (
              <span>
                <b>무결성 검증 통과</b> — {chain.checked}개 증거팩의 해시체인이 연속적이며 위변조
                흔적이 없습니다.
              </span>
            ) : (
              <span>
                <b>무결성 경고</b> — 체인 {chain.checked}개 중 {chain.brokenAt} 지점에서 연결이
                끊겼습니다. 변조 가능성을 조사하세요.
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-2.5 mb-3 bg-danger/10 border border-danger/20 rounded-lg text-xs text-danger">
            <XCircle size={14} className="shrink-0" /> {error}
          </div>
        )}

        {/* 종류 필터 + 요약 */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {['', 'RUNTIME', 'REGISTRATION', 'FINOPS'].map((k) => (
            <button
              key={k || 'ALL'}
              onClick={() => setKind(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${kind === k ? 'bg-accent text-white border-accent' : 'border-gray-200 hover:border-accent/40'}`}
            >
              {k === '' ? `전체 (${total})` : `${KIND_LABEL[k]} (${counts[k as keyof typeof counts]})`}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
          {/* 목록 */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden self-start">
            <div className="px-3 py-2.5 border-b border-gray-200 text-xs font-bold text-gray-900 flex items-center gap-1.5">
              <FileArchive size={13} /> 증거팩 목록 ({packs.length})
            </div>
            <div className="max-h-[540px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="py-2 px-3">생성시각</th>
                    <th className="py-2 pr-2">종류</th>
                    <th className="py-2 pr-2">이벤트</th>
                    <th className="py-2 pr-2">packHash</th>
                    <th className="py-2 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {packs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-gray-400">
                        증거팩이 없습니다. 런타임 거버넌스/심사를 실행하면 자동 생성됩니다.
                      </td>
                    </tr>
                  )}
                  {packs.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => setSelected(p)}
                      className={`border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${selected?.id === p.id ? 'bg-accent/5' : ''}`}
                    >
                      <td className="py-1.5 px-3 text-gray-400 font-mono whitespace-nowrap">
                        {new Date(p.createdAt).toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-2">{kindBadge(p.kind)}</td>
                      <td className="py-1.5 pr-2 text-gray-600">
                        {String((p.evaluationJson?.event as string) ?? p.evaluationJson?.decision ?? '—')}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-gray-400">
                        {p.packHash.slice(0, 12)}…
                      </td>
                      <td className="py-1.5 pr-2 text-gray-300">
                        <ChevronRight size={13} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 상세 */}
          <div className="bg-white border border-gray-200 rounded-lg p-4 self-start">
            <p className="text-xs font-bold text-gray-900 mb-3">증거팩 상세</p>
            {!selected ? (
              <p className="text-xs text-gray-400">좌측에서 증거팩을 선택하세요.</p>
            ) : (
              <div className="space-y-3 text-[11px]">
                <div className="flex items-center gap-2">
                  {kindBadge(selected.kind)}
                  <span className="text-gray-400 font-mono">{selected.id.slice(0, 10)}…</span>
                </div>

                <div className="space-y-1">
                  <HashRow label="packHash" value={selected.packHash} strong />
                  <HashRow label="previousHash" value={selected.previousHash ?? '— (체인 시작)'} />
                  {selected.policyVersionHash && (
                    <HashRow label="policyHash" value={selected.policyVersionHash} />
                  )}
                  {selected.workflowHash && (
                    <HashRow label="workflowHash" value={selected.workflowHash} />
                  )}
                </div>

                {/* 연결 객체 */}
                <div className="grid grid-cols-2 gap-1.5">
                  {selected.executionSessionId && (
                    <RefChip label="세션" value={selected.executionSessionId} />
                  )}
                  {selected.workflowId && <RefChip label="워크플로우" value={selected.workflowId} />}
                  {selected.governanceDecisionId && (
                    <RefChip label="판정" value={selected.governanceDecisionId} />
                  )}
                  {selected.orbGovernanceReviewId && (
                    <RefChip label="심사" value={selected.orbGovernanceReviewId} />
                  )}
                  {selected.modelId && <RefChip label="모델" value={selected.modelId} />}
                  {(selected.fdsAlertIdsJson?.length ?? 0) > 0 && (
                    <RefChip label="FDS알림" value={`${selected.fdsAlertIdsJson!.length}건`} />
                  )}
                </div>

                <div>
                  <p className="text-[10px] text-gray-400 mb-1">평가 내용 (evaluationJson)</p>
                  <pre className="text-[9.5px] bg-gray-50 border border-gray-100 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
                    {JSON.stringify(selected.evaluationJson, null, 2)}
                  </pre>
                </div>
                {selected.autoActionJson && (
                  <div>
                    <p className="text-[10px] text-gray-400 mb-1">자동조치</p>
                    <pre className="text-[9.5px] bg-gray-50 border border-gray-100 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(selected.autoActionJson, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function HashRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-[9px] text-gray-400">{label}</span>
      <span
        className={`font-mono text-[9.5px] break-all ${strong ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function RefChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 border border-gray-100 rounded px-1.5 py-1">
      <span className="text-[8.5px] text-gray-400">{label}</span>
      <p className="text-[9px] font-mono text-gray-600 truncate" title={value}>
        {value}
      </p>
    </div>
  );
}
