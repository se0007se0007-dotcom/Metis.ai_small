'use client';

/**
 * ORB 거버넌스 심사 콘솔 — Patent 2 (등록 전 자동 심사·승격) 테스트 화면.
 *
 * 시나리오 1: 임시등록 → Fingerprint → Sandbox Replay → (정책 패치) → 승인 → 승격
 * 시나리오 2: 승인 후 워크플로우 변경 → 승격 시 drift 차단(409) 확인
 * 시나리오 3: Evidence Pack 해시체인 무결성 검증
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { api } from '@/lib/api-client';
import {
  ShieldCheck,
  Fingerprint,
  PlayCircle,
  Wrench,
  CheckCircle2,
  Rocket,
  GitCompareArrows,
  Link2,
  Loader2,
  AlertTriangle,
  RefreshCw,
  History,
  XCircle,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────

interface WorkflowSummary {
  id: string;
  key: string;
  name: string;
  status: string;
}

interface GovReview {
  id: string;
  workflowId: string;
  status: string;
  fingerprintHash: string | null;
  replayRunId: string | null;
  readinessScore: number | null;
  reviewerId: string | null;
  approvalHash: string | null;
  approvedAt: string | null;
  promotedVersionId: string | null;
  rejectionReason: string | null;
  historyJson: Array<{ from: string; to: string; note?: unknown; at: string }>;
  createdAt: string;
}

interface ReplayResult {
  runId: string;
  status: string;
  nextStatus: string;
  readinessScore: number;
  securityScore: number;
  policyScore: number;
  costScore: number;
  reliabilityScore: number;
  humanReviewScore: number;
  nodes: Array<{
    nodeKey: string;
    actionType: string;
    riskLevel: string;
    nodeScore: number;
    policyViolations: number;
    failed: boolean;
    notes: string[];
  }>;
}

interface DriftResult {
  drifted: boolean;
  approvedFingerprintHash?: string;
  currentFingerprintHash: string;
  changedComponents: string[];
}

interface ChainResult {
  valid: boolean;
  checked: number;
  brokenAt?: string;
}

// ── Status helpers ─────────────────────────────────────────────

const STATUS_FLOW = [
  'TEMP_REGISTERED',
  'NODE_RESOLVED',
  'FINGERPRINTED',
  'SANDBOX_REPLAYED',
  'AUTO_SCORED',
  'HUMAN_REVIEW',
  'APPROVED',
  'PROMOTED',
  'ACTIVE',
];

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'bg-success/15 text-success border-success/30',
  PROMOTED: 'bg-success/15 text-success border-success/30',
  APPROVED: 'bg-accent/15 text-accent border-accent/30',
  HUMAN_REVIEW: 'bg-warning/15 text-warning border-warning/30',
  NEEDS_REPAIR: 'bg-warning/15 text-warning border-warning/30',
  POLICY_INJECTED: 'bg-warning/15 text-warning border-warning/30',
  REJECTED: 'bg-danger/15 text-danger border-danger/30',
  DRIFT_DETECTED: 'bg-danger/15 text-danger border-danger/30',
  REVOKED: 'bg-danger/15 text-danger border-danger/30',
};

function statusBadge(status: string) {
  const cls = STATUS_COLOR[status] ?? 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-[11px] font-bold ${cls}`}>
      {status}
    </span>
  );
}

function scoreColor(v: number) {
  return v >= 90 ? 'text-success' : v >= 75 ? 'text-accent' : v >= 60 ? 'text-warning' : 'text-danger';
}

// ── Page ───────────────────────────────────────────────────────

export default function OrbGovernancePage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWf, setSelectedWf] = useState('');
  const [reviews, setReviews] = useState<GovReview[]>([]);
  const [selected, setSelected] = useState<GovReview | null>(null);
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [drift, setDrift] = useState<DriftResult | null>(null);
  const [chain, setChain] = useState<ChainResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false); // 고급(정책패치·드리프트·체인검증) 접기
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [wfRes, rvRes] = await Promise.all([
        api.get<{ items: WorkflowSummary[] }>('/workflows?limit=300'),
        api.get<GovReview[]>('/orb/governance-reviews'),
      ]);
      setWorkflows(wfRes.items ?? []);
      setReviews(rvRes ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const refreshSelected = useCallback(
    async (id: string) => {
      try {
        const review = await api.get<GovReview>(`/orb/governance-reviews/${id}`);
        setSelected(review);
        setReviews((prev) => prev.map((r) => (r.id === id ? review : r)));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  /** Run an action against the selected review and refresh state. */
  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        await fn();
      } catch (e) {
        setError(`${label} 실패: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // ── Actions ──────────────────────────────────────────────────

  const register = () =>
    run('임시등록', async () => {
      if (!selectedWf) throw new Error('워크플로우를 선택하세요.');
      const review = await api.post<GovReview>('/orb/governance-reviews', {
        workflowId: selectedWf,
      });
      setSelected(review);
      setReplay(null);
      setDrift(null);
      setNotice('임시등록 완료 — Fingerprint를 생성하세요.');
      await loadAll();
    });

  const doFingerprint = () =>
    run('Fingerprint', async () => {
      if (!selected) return;
      await api.post(`/orb/governance-reviews/${selected.id}/fingerprint`);
      setNotice('Fingerprint 생성 완료 — Sandbox Replay를 실행하세요.');
      await refreshSelected(selected.id);
    });

  const doReplay = () =>
    run('Sandbox Replay', async () => {
      if (!selected) return;
      const result = await api.post<ReplayResult>(
        `/orb/governance-reviews/${selected.id}/sandbox-replay`,
        {},
      );
      setReplay(result);
      setNotice(
        `Replay 완료 — readiness ${result.readinessScore.toFixed(1)} → ${result.nextStatus}`,
      );
      await refreshSelected(selected.id);
    });

  const doPatches = () =>
    run('정책 패치', async () => {
      if (!selected) return;
      const result = await api.post<{ patchesCreated: number; patchedNodeKeys: string[] }>(
        `/orb/governance-reviews/${selected.id}/apply-governance-patches`,
      );
      setNotice(
        `패치 ${result.patchesCreated}건 적용 (${result.patchedNodeKeys.join(', ') || '없음'}) — 정의가 변경되었으므로 Fingerprint를 재생성하세요.`,
      );
      await refreshSelected(selected.id);
    });

  const doApprove = () =>
    run('승인', async () => {
      if (!selected) return;
      await api.post(`/orb/governance-reviews/${selected.id}/approve`);
      setNotice('승인 완료 — fingerprint가 APPROVED 상태가 되었습니다. 이제 승격하세요.');
      await refreshSelected(selected.id);
    });

  const doPromote = () =>
    run('승격', async () => {
      if (!selected) return;
      try {
        const result = await api.post<{ version: { versionNumber: number } }>(
          `/orb/governance-reviews/${selected.id}/promote`,
        );
        setNotice(
          `승격 완료 — immutable v${result.version.versionNumber} 가 ACTIVE 되었습니다.`,
        );
      } catch (e) {
        // 시나리오 2: drift 차단 — 409가 정상 동작이다.
        await refreshSelected(selected.id);
        throw new Error(
          `${(e as Error).message} (승인 후 워크플로우가 변경된 경우 정상적인 차단입니다 — Drift 검사로 확인)`,
        );
      }
      await refreshSelected(selected.id);
    });

  const doDriftCheck = () =>
    run('Drift 검사', async () => {
      if (!selected) return;
      const result = await api.get<DriftResult>(
        `/orb/governance-reviews/${selected.id}/drift-check`,
      );
      setDrift(result);
      setNotice(
        result.drifted
          ? `DRIFT 감지 — 변경: ${result.changedComponents.join(', ')}`
          : 'Drift 없음 — 승인 fingerprint와 일치합니다.',
      );
      await refreshSelected(selected.id);
    });

  const doVerifyChain = () =>
    run('체인 검증', async () => {
      const result = await api.get<ChainResult>('/governance/evidence-packs/verify-chain');
      setChain(result);
    });

  // ── Button enable rules (state machine mirror) ───────────────

  const st = selected?.status ?? '';
  const canFingerprint = ['NODE_RESOLVED', 'POLICY_INJECTED', 'DRIFT_DETECTED'].includes(st);
  const canReplay = st === 'FINGERPRINTED';
  const canPatch = st === 'NEEDS_REPAIR';
  const canApprove = st === 'HUMAN_REVIEW';
  const canPromote = st === 'APPROVED';

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="pb-10">
      <PageHeader
        title="ORB 거버넌스 심사"
        description="등록 전 Fingerprint · Sandbox Replay · 자동 정책삽입 · Immutable 승격 · Drift 차단 테스트 콘솔"
        actions={
          <div className="flex items-center gap-2">
            <a
              href="/orchestration/builder"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
            >
              + 워크플로우 빌더
            </a>
            <button
              onClick={() => void loadAll()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
            >
              <RefreshCw size={13} /> 새로고침
            </button>
          </div>
        }
      />

      <SubTabs
        items={[
          { label: '① ORB 심사 (자동평가→사람심사)', href: '/governance/orb' },
          { label: '② 거버넌스 승격', href: '/governance/orb-governance' },
        ]}
      />

      <div className="px-6">
        {/* 이용 안내 — 한 줄 스텝 가이드 */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4 p-3 bg-accent/5 border border-accent/20 rounded-lg">
          <span className="text-[11px] font-bold text-accent mr-1">이렇게 진행하세요</span>
          {[
            '워크플로우 선택 후 임시등록',
            'Fingerprint 생성 (구성 지문)',
            'Sandbox Replay (자동 채점)',
            '점수 미달 시 정책 패치 → 재심사',
            '승인',
            '승격 (운영 배포)',
          ].map((t, i, arr) => (
            <span key={i} className="flex items-center gap-1.5">
              <span className="flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded-full text-[10.5px] text-gray-700">
                <span className="w-4 h-4 rounded-full bg-accent text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                {t}
              </span>
              {i < arr.length - 1 && <span className="text-gray-300 text-[10px]">→</span>}
            </span>
          ))}
          <span className="w-full mt-1 text-[10px] text-gray-500">
            승인 후 워크플로우를 수정하면 승격이 자동 차단됩니다(Drift). 모든 단계는 Evidence
            체인에 기록되며 우측 상단 버튼으로 무결성을 검증할 수 있습니다.
          </span>
        </div>

        {/* 등록 바 */}
        <div className="flex flex-wrap items-center gap-2 mb-4 p-3 bg-white border border-gray-200 rounded-lg">
          <select
            value={selectedWf}
            onChange={(e) => setSelectedWf(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-2 min-w-[260px] bg-white"
          >
            <option value="">
              {workflows.length === 0 ? '워크플로우 없음 — 빌더에서 먼저 생성하세요' : '심사할 워크플로우 선택…'}
            </option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.key}) — {w.status}
              </option>
            ))}
          </select>
          <button
            onClick={register}
            disabled={!selectedWf || busy != null}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-white bg-accent rounded-lg disabled:opacity-40 hover:opacity-90 transition"
          >
            {busy === '임시등록' ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
            심사 임시등록
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={doVerifyChain}
              disabled={busy != null}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
            >
              {busy === '체인 검증' ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Evidence 체인 검증
            </button>
            {chain && (
              <span
                className={`text-[11px] font-bold ${chain.valid ? 'text-success' : 'text-danger'}`}
              >
                {chain.valid ? `✓ 무결 (${chain.checked}개)` : `✗ 변조 의심: ${chain.brokenAt}`}
              </span>
            )}
          </div>
        </div>

        {/* 알림 */}
        {error && (
          <div className="flex items-center gap-2 p-2.5 mb-3 bg-danger/10 border border-danger/20 rounded-lg text-xs text-danger">
            <XCircle size={14} className="shrink-0" /> {error}
          </div>
        )}
        {notice && (
          <div className="flex items-center gap-2 p-2.5 mb-3 bg-accent/10 border border-accent/20 rounded-lg text-xs text-accent">
            <CheckCircle2 size={14} className="shrink-0" /> {notice}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
          {/* 심사 목록 */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden self-start">
            <div className="px-3 py-2.5 border-b border-gray-200 text-xs font-bold text-gray-900">
              심사 목록 ({reviews.length})
            </div>
            <div className="max-h-[480px] overflow-y-auto divide-y divide-gray-100">
              {reviews.length === 0 && (
                <p className="p-4 text-xs text-gray-400">등록된 심사가 없습니다.</p>
              )}
              {reviews.map((r) => {
                const wf = workflows.find((w) => w.id === r.workflowId);
                return (
                  <button
                    key={r.id}
                    onClick={() => {
                      setSelected(r);
                      setReplay(null);
                      setDrift(null);
                      void refreshSelected(r.id);
                    }}
                    className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition ${selected?.id === r.id ? 'bg-accent/5 border-l-2 border-accent' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-semibold text-gray-900 truncate">
                        {wf?.name ?? r.workflowId.slice(0, 12)}
                      </span>
                      {statusBadge(r.status)}
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {r.readinessScore != null && (
                        <span className={`font-bold mr-2 ${scoreColor(r.readinessScore)}`}>
                          {r.readinessScore.toFixed(1)}점
                        </span>
                      )}
                      {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 상세 */}
          <div className="space-y-4">
            {!selected ? (
              <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-xs text-gray-400">
                좌측에서 심사를 선택하거나, 워크플로우를 임시등록하세요.
              </div>
            ) : (
              <>
                {/* 상태 + 액션 */}
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <span className="text-sm font-bold text-gray-900">
                      {workflows.find((w) => w.id === selected.workflowId)?.name ?? '워크플로우'}
                    </span>
                    {statusBadge(selected.status)}
                    {selected.readinessScore != null && (
                      <span className={`text-xs font-bold ${scoreColor(selected.readinessScore)}`}>
                        readiness {selected.readinessScore.toFixed(1)}
                      </span>
                    )}
                  </div>

                  {/* 진행 스텝 */}
                  <div className="flex flex-wrap items-center gap-1 mb-4">
                    {STATUS_FLOW.map((s, i) => {
                      const reached =
                        STATUS_FLOW.indexOf(selected.status) >= i ||
                        selected.historyJson?.some((h) => h.to === s);
                      return (
                        <span key={s} className="flex items-center gap-1">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${reached ? 'bg-accent/15 text-accent' : 'bg-gray-100 text-gray-400'}`}
                          >
                            {s}
                          </span>
                          {i < STATUS_FLOW.length - 1 && (
                            <span className="text-gray-300 text-[9px]">→</span>
                          )}
                        </span>
                      );
                    })}
                  </div>

                  {/* 액션 버튼 */}
                  <div className="flex flex-wrap gap-2">
                    <ActionBtn
                      icon={<Fingerprint size={13} />}
                      label="① Fingerprint 생성"
                      onClick={doFingerprint}
                      enabled={canFingerprint}
                      busy={busy === 'Fingerprint'}
                    />
                    <ActionBtn
                      icon={<PlayCircle size={13} />}
                      label="② Sandbox Replay"
                      onClick={doReplay}
                      enabled={canReplay}
                      busy={busy === 'Sandbox Replay'}
                    />
                    {showAdvanced && (
                      <ActionBtn
                        icon={<Wrench size={13} />}
                        label="정책 패치 자동삽입"
                        onClick={doPatches}
                        enabled={canPatch}
                        busy={busy === '정책 패치'}
                      />
                    )}
                    <ActionBtn
                      icon={<CheckCircle2 size={13} />}
                      label="③ 승인"
                      onClick={doApprove}
                      enabled={canApprove}
                      busy={busy === '승인'}
                    />
                    <ActionBtn
                      icon={<Rocket size={13} />}
                      label="④ 승격(운영 배포)"
                      onClick={doPromote}
                      enabled={canPromote}
                      busy={busy === '승격'}
                      primary
                    />
                    {showAdvanced && (
                      <ActionBtn
                        icon={<GitCompareArrows size={13} />}
                        label="Drift 검사"
                        onClick={doDriftCheck}
                        enabled={!!selected.fingerprintHash}
                        busy={busy === 'Drift 검사'}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => setShowAdvanced((v) => !v)}
                      className="ml-auto text-[11px] font-semibold text-accent hover:underline"
                    >
                      {showAdvanced ? '고급 숨기기' : '고급 거버넌스 ▾ (정책패치·Drift)'}
                    </button>
                  </div>

                  {/* 해시 정보 */}
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 text-[10px] text-gray-500 font-mono">
                    {selected.fingerprintHash && (
                      <p className="truncate" title={selected.fingerprintHash}>
                        fingerprint: {selected.fingerprintHash}
                      </p>
                    )}
                    {selected.approvalHash && (
                      <p className="truncate" title={selected.approvalHash}>
                        approval: {selected.approvalHash}
                      </p>
                    )}
                  </div>
                  {selected.rejectionReason && (
                    <p className="mt-2 text-[11px] text-danger flex items-center gap-1">
                      <AlertTriangle size={12} /> {selected.rejectionReason}
                    </p>
                  )}
                </div>

                {/* Drift 결과 */}
                {drift && (
                  <div
                    className={`border rounded-lg p-4 ${drift.drifted ? 'bg-danger/5 border-danger/30' : 'bg-success/5 border-success/30'}`}
                  >
                    <p className="text-xs font-bold mb-2">
                      {drift.drifted ? '⚠ DRIFT 감지 — 승격/실행 차단 대상' : '✓ Drift 없음'}
                    </p>
                    <div className="text-[10px] font-mono text-gray-500 space-y-1">
                      <p className="truncate">approved: {drift.approvedFingerprintHash ?? '—'}</p>
                      <p className="truncate">current : {drift.currentFingerprintHash}</p>
                      {drift.changedComponents.length > 0 && (
                        <p className="text-danger">변경 컴포넌트: {drift.changedComponents.join(', ')}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Replay 점수 */}
                {replay && (
                  <div className="bg-white border border-gray-200 rounded-lg p-4">
                    <p className="text-xs font-bold text-gray-900 mb-3">
                      Sandbox Replay 결과 ({replay.status}) → 다음 상태: {replay.nextStatus}
                    </p>
                    <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
                      {(
                        [
                          ['Readiness', replay.readinessScore],
                          ['Security', replay.securityScore],
                          ['Policy', replay.policyScore],
                          ['Cost', replay.costScore],
                          ['Reliability', replay.reliabilityScore],
                          ['HumanReview', replay.humanReviewScore],
                        ] as const
                      ).map(([label, v]) => (
                        <div key={label} className="border border-gray-100 rounded-lg p-2 text-center">
                          <p className="text-[9px] text-gray-400">{label}</p>
                          <p className={`text-base font-bold ${scoreColor(v)}`}>{v.toFixed(1)}</p>
                        </div>
                      ))}
                    </div>
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-left text-gray-400 border-b border-gray-100">
                          <th className="py-1 pr-2">노드</th>
                          <th className="py-1 pr-2">Action</th>
                          <th className="py-1 pr-2">Risk</th>
                          <th className="py-1 pr-2">점수</th>
                          <th className="py-1 pr-2">위반</th>
                          <th className="py-1">비고</th>
                        </tr>
                      </thead>
                      <tbody>
                        {replay.nodes.map((n) => (
                          <tr key={n.nodeKey} className="border-b border-gray-50">
                            <td className="py-1 pr-2 font-mono">{n.nodeKey}</td>
                            <td className="py-1 pr-2">{n.actionType}</td>
                            <td className="py-1 pr-2">{n.riskLevel}</td>
                            <td className={`py-1 pr-2 font-bold ${scoreColor(n.nodeScore)}`}>
                              {n.nodeScore}
                            </td>
                            <td className="py-1 pr-2">{n.policyViolations}</td>
                            <td className="py-1 text-gray-400">{n.notes.join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 상태 전이 이력 */}
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <p className="flex items-center gap-1.5 text-xs font-bold text-gray-900 mb-3">
                    <History size={13} /> 상태 전이 이력 (심사 증거)
                  </p>
                  <div className="space-y-1.5">
                    {(selected.historyJson ?? []).map((h, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px]">
                        <span className="text-gray-400 font-mono shrink-0">
                          {new Date(h.at).toLocaleTimeString()}
                        </span>
                        <span className="text-gray-500">{h.from}</span>
                        <span className="text-gray-300">→</span>
                        <span className="font-semibold text-gray-900">{h.to}</span>
                        <span className="text-gray-400 truncate">
                          {typeof h.note === 'string' ? h.note : JSON.stringify(h.note)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small components ───────────────────────────────────────────

function ActionBtn({
  icon,
  label,
  onClick,
  enabled,
  busy,
  primary,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  enabled: boolean;
  busy: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!enabled || busy}
      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg transition disabled:opacity-35 ${
        primary
          ? 'bg-accent text-white hover:opacity-90'
          : 'border border-gray-200 hover:border-accent/40'
      }`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}
