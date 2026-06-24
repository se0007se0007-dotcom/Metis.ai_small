'use client';

/**
 * 런타임 거버넌스 콘솔 — Patent 1 (실행 중 자동 거버넌스) 테스트 화면.
 *
 * 시나리오 A: 안전 워크플로우 실행 → 노드별 ALLOW 판정 확인
 * 시나리오 B: 고위험(결제 승인) 노드 실행 → REQUIRE_APPROVAL + 파이프라인 중단
 * 공통: 판정별 gate 점수·사유, FDS Alert 연계, Evidence Pack 해시체인 확인
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import {
  ShieldAlert,
  PlayCircle,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Link2,
  FlaskConical,
  FileArchive,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────

interface GovDecision {
  id: string;
  executionSessionId: string;
  executionStepId: string | null;
  workflowId: string | null;
  nodeKey: string | null;
  decision: string;
  severity: string;
  reasonJson: { reasons?: string[] };
  gateResultsJson: {
    quality?: number;
    security?: number;
    cost?: number;
    policy?: number;
    anomaly?: number;
  };
  autoActionJson: { autoAction?: string } | null;
  createdAt: string;
}

interface RiskSummary {
  decisions: Record<string, number>;
  governanceAlerts: number;
}

interface PipelineRunResult {
  executionSessionId: string;
  nodeResults: Array<{
    nodeId: string;
    nodeName: string;
    success: boolean;
    output?: { data?: { governance?: { decision?: { decision: string }; haltPipeline?: boolean } } };
  }>;
}

const DECISION_COLOR: Record<string, string> = {
  ALLOW: 'bg-success/15 text-success border-success/30',
  WARN: 'bg-warning/15 text-warning border-warning/30',
  REQUIRE_APPROVAL: 'bg-warning/15 text-warning border-warning/30',
  BLOCK: 'bg-danger/15 text-danger border-danger/30',
  QUARANTINE: 'bg-danger/15 text-danger border-danger/30',
};

function decisionBadge(d: string) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded border text-[11px] font-bold ${DECISION_COLOR[d] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}
    >
      {d}
    </span>
  );
}

// 데모 워크플로우 정의 (passthrough executor로 안전하게 실행됨)
const SAFE_DEMO_NODES = [
  { id: 'jira.read.issue', type: 'data-read', name: '이슈 조회', order: 1, settings: {} },
  { id: 'summary.transform', type: 'transform', name: '요약 변환', order: 2, settings: {} },
];

const RISKY_DEMO_NODES = [
  { id: 'jira.read.issue', type: 'data-read', name: '이슈 조회', order: 1, settings: {} },
  {
    id: 'payment.approve',
    type: 'payment-approve',
    name: '비용 결제 승인',
    order: 2,
    settings: {},
  },
  { id: 'slack.send.message', type: 'external-send', name: 'Slack 통보', order: 3, settings: {} },
];

export default function RuntimeGovernancePage() {
  const [summary, setSummary] = useState<RiskSummary | null>(null);
  const [decisions, setDecisions] = useState<GovDecision[]>([]);
  const decisionsPage = usePagination(decisions, 10);
  const [selected, setSelected] = useState<GovDecision | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chain, setChain] = useState<{ valid: boolean; checked: number } | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        api.get<RiskSummary>('/governance/runtime/risk-summary?hours=24'),
        api.get<GovDecision[]>('/governance/runtime/decisions?hours=24'),
      ]);
      setSummary(s);
      setDecisions(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const runDemo = useCallback(
    async (label: string, nodes: typeof SAFE_DEMO_NODES) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        const result = await api.post<PipelineRunResult>('/api/workflow-nodes/execute-sync', {
          title: `governance-demo: ${label}`,
          nodes,
        });
        const halted = result.nodeResults.some(
          (n) => n.output?.data?.governance?.haltPipeline === true,
        );
        const executed = result.nodeResults.length;
        setNotice(
          halted
            ? `${label} — ${executed}/${nodes.length}개 노드 실행 후 거버넌스가 파이프라인을 중단했습니다 (세션 ${result.executionSessionId.slice(0, 10)}…). 아래 판정 목록에서 확인하세요.`
            : `${label} — ${executed}개 노드 모두 실행 완료 (세션 ${result.executionSessionId.slice(0, 10)}…).`,
        );
        await loadAll();
      } catch (e) {
        setError(`${label} 실패: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [loadAll],
  );

  const verifyChain = useCallback(async () => {
    setBusy('chain');
    try {
      setChain(await api.get('/governance/evidence-packs/verify-chain'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const gates = selected?.gateResultsJson;

  const override = useCallback(
    async (decisionId: string, approve: boolean) => {
      setBusy('override');
      setError(null);
      setNotice(null);
      try {
        await api.post(`/governance/runtime/decisions/${decisionId}/override`, {
          approve,
          reason: approve ? '운영자 승인 (콘솔)' : '운영자 반려 (콘솔)',
        });
        setNotice(
          approve
            ? '승인 처리 완료 — 판정이 ALLOW로 변경되고 연계 FDS 알림이 해소되었습니다. 승인 행위는 증거팩으로 기록됩니다.'
            : '반려 처리 완료 — 판정이 BLOCK으로 확정되었습니다.',
        );
        await loadAll();
        setSelected(null);
      } catch (e) {
        setError(`승인/반려 실패: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [loadAll],
  );

  const needsApproval = (d: string) => d === 'REQUIRE_APPROVAL' || d === 'BLOCK' || d === 'QUARANTINE';

  return (
    <div className="pb-10">
      <PageHeader
        title="런타임 거버넌스"
        description="노드 실행 직후 5-gate 평가 → 정책 판정 → FDS Alert → 자동조치 → Evidence Pack (실행 중 자동 차단 테스트 콘솔)"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadAll()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
            >
              <RefreshCw size={13} /> 새로고침
            </button>
          </div>
        }
      />

      <div className="px-6">
        {/* 데모 실행 바 */}
        <div className="flex flex-wrap items-center gap-2 mb-4 p-3 bg-white border border-gray-200 rounded-lg">
          <FlaskConical size={14} className="text-accent" />
          <span className="text-xs font-bold text-gray-900 mr-2">데모 실행:</span>
          <button
            onClick={() => void runDemo('시나리오 A (안전)', SAFE_DEMO_NODES)}
            disabled={busy != null}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-success/40 text-success rounded-lg hover:bg-success/5 transition disabled:opacity-40"
          >
            {busy === '시나리오 A (안전)' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <PlayCircle size={13} />
            )}
            시나리오 A — 안전 워크플로우 (조회·변환, 기대: ALLOW)
          </button>
          <button
            onClick={() => void runDemo('시나리오 B (고위험)', RISKY_DEMO_NODES)}
            disabled={busy != null}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-danger/40 text-danger rounded-lg hover:bg-danger/5 transition disabled:opacity-40"
          >
            {busy === '시나리오 B (고위험)' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <ShieldAlert size={13} />
            )}
            시나리오 B — 결제승인 포함 (기대: REQUIRE_APPROVAL + 중단)
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void verifyChain()}
              disabled={busy != null}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
            >
              {busy === 'chain' ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Evidence 체인 검증
            </button>
            {chain && (
              <span className={`text-[11px] font-bold ${chain.valid ? 'text-success' : 'text-danger'}`}>
                {chain.valid ? `✓ 무결 (${chain.checked}개)` : '✗ 변조 의심'}
              </span>
            )}
          </div>
        </div>

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

        {/* 요약 카드 — 판정 분포가 한눈에 들어오도록 컬러·스택바 */}
        {(() => {
          const DCOLORS: Record<string, string> = {
            ALLOW: '#6FAF9A',
            WARN: '#C9A45C',
            REQUIRE_APPROVAL: '#B07D2B',
            BLOCK: '#C77B7B',
            QUARANTINE: '#9A4B4B',
          };
          const DLABEL: Record<string, string> = {
            ALLOW: '허용',
            WARN: '경고',
            REQUIRE_APPROVAL: '승인요청',
            BLOCK: '차단',
            QUARANTINE: '격리',
          };
          const keys = ['ALLOW', 'WARN', 'REQUIRE_APPROVAL', 'BLOCK', 'QUARANTINE'];
          const total = keys.reduce((s, k) => s + (summary?.decisions?.[k] ?? 0), 0);
          return (
            <div className="mb-4">
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-2">
                {keys.map((d) => (
                  <div
                    key={d}
                    className="bg-white border border-gray-200 rounded-lg p-2.5 text-center overflow-hidden relative"
                  >
                    <div
                      className="absolute top-0 left-0 right-0 h-1"
                      style={{ backgroundColor: DCOLORS[d] }}
                    />
                    <p className="text-[9px] text-gray-400 truncate" title={d}>
                      {DLABEL[d]} <span className="hidden md:inline">({d})</span>
                    </p>
                    <p className="text-lg font-bold" style={{ color: DCOLORS[d] }}>
                      {summary?.decisions?.[d] ?? 0}
                    </p>
                  </div>
                ))}
                <div className="bg-white border border-gray-200 rounded-lg p-2.5 text-center overflow-hidden relative">
                  <div className="absolute top-0 left-0 right-0 h-1 bg-danger" />
                  <p className="text-[9px] text-gray-400">FDS Alerts</p>
                  <p className="text-lg font-bold text-danger">{summary?.governanceAlerts ?? 0}</p>
                </div>
              </div>
              {/* 분포 스택바 */}
              {total > 0 && (
                <div className="flex h-2 rounded overflow-hidden border border-gray-100">
                  {keys.map((d) => {
                    const v = summary?.decisions?.[d] ?? 0;
                    if (!v) return null;
                    return (
                      <div
                        key={d}
                        title={`${DLABEL[d]} ${v}건 (${Math.round((v / total) * 100)}%)`}
                        style={{ width: `${(v / total) * 100}%`, backgroundColor: DCOLORS[d] }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4">
          {/* 판정 목록 */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden self-start">
            <div className="px-3 py-2.5 border-b border-gray-200 text-xs font-bold text-gray-900">
              최근 24시간 거버넌스 판정 ({decisions.length})
            </div>
            <div className="max-h-[520px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="py-2 px-3">시각</th>
                    <th className="py-2 pr-2">노드</th>
                    <th className="py-2 pr-2">판정</th>
                    <th className="py-2 pr-2">심각도</th>
                    <th className="py-2 pr-2">자동조치</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-gray-400">
                        판정 기록이 없습니다. 위의 데모 실행 버튼으로 생성하세요.
                      </td>
                    </tr>
                  )}
                  {decisionsPage.pageItems.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => setSelected(d)}
                      className={`border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${selected?.id === d.id ? 'bg-accent/5' : ''}`}
                    >
                      <td className="py-1.5 px-3 text-gray-400 font-mono">
                        {new Date(d.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 pr-2 font-mono">{d.nodeKey ?? '—'}</td>
                      <td className="py-1.5 pr-2">{decisionBadge(d.decision)}</td>
                      <td className="py-1.5 pr-2">{d.severity}</td>
                      <td className="py-1.5 pr-2 text-gray-500">
                        {d.autoActionJson?.autoAction ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager p={decisionsPage} />
            </div>
          </div>

          {/* 판정 상세 */}
          <div className="bg-white border border-gray-200 rounded-lg p-4 self-start">
            <p className="text-xs font-bold text-gray-900 mb-3">판정 상세</p>
            {!selected ? (
              <p className="text-xs text-gray-400">좌측 목록에서 판정을 선택하세요.</p>
            ) : (
              <div className="space-y-3 text-[11px]">
                <div className="flex items-center gap-2">
                  {decisionBadge(selected.decision)}
                  <span className="font-mono text-gray-500">{selected.nodeKey}</span>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 mb-1">5-Gate 점수 (0~1)</p>
                  {(
                    [
                      ['Quality', gates?.quality],
                      ['Security', gates?.security],
                      ['Cost', gates?.cost],
                      ['Policy', gates?.policy],
                      ['Anomaly', gates?.anomaly],
                    ] as const
                  ).map(([label, v]) => (
                    <div key={label} className="flex items-center gap-2 mb-1">
                      <span className="w-16 text-gray-500">{label}</span>
                      <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
                        <div
                          className={`h-full ${label === 'Anomaly' ? ((v ?? 0) > 0.5 ? 'bg-danger' : 'bg-success') : (v ?? 0) >= 0.7 ? 'bg-success' : (v ?? 0) >= 0.4 ? 'bg-warning' : 'bg-danger'}`}
                          style={{ width: `${Math.round((v ?? 0) * 100)}%` }}
                        />
                      </div>
                      <span className="w-9 text-right font-mono">{(v ?? 0).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 mb-1">판정 사유</p>
                  <ul className="space-y-0.5">
                    {(selected.reasonJson?.reasons ?? []).map((r, i) => (
                      <li key={i} className="text-gray-600">
                        · {r}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="text-[10px] text-gray-400 font-mono truncate">
                  session: {selected.executionSessionId}
                </p>

                {/* 사람 승인 경로 — REQUIRE_APPROVAL/BLOCK/QUARANTINE 판정 처리 */}
                {needsApproval(selected.decision) && (
                  <div className="pt-2 mt-1 border-t border-gray-100">
                    <p className="text-[10px] text-gray-400 mb-1.5">사람 승인 처리</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void override(selected.id, true)}
                        disabled={busy != null}
                        className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-bold text-white bg-success rounded-lg disabled:opacity-40 hover:opacity-90 transition"
                      >
                        {busy === 'override' ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={12} />
                        )}
                        승인 (ALLOW)
                      </button>
                      <button
                        onClick={() => void override(selected.id, false)}
                        disabled={busy != null}
                        className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-bold text-white bg-danger rounded-lg disabled:opacity-40 hover:opacity-90 transition"
                      >
                        <XCircle size={12} /> 반려 (BLOCK)
                      </button>
                    </div>
                    <p className="text-[9px] text-gray-400 mt-1.5">
                      승인 시 판정이 ALLOW로 변경되고, 처리 행위가 증거팩 체인에 기록됩니다.
                    </p>
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
