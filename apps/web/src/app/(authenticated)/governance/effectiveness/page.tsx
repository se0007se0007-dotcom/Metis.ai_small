'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import {
  RefreshCw,
  AlertCircle,
  Clock,
  TrendingUp,
  DollarSign,
  Timer,
  Bell,
  Server,
  Target,
} from 'lucide-react';

// ── Types (백엔드 GET /v1/dashboard/effectiveness 와 정렬) ──

interface EffWindow {
  days: number;
  since: string;
}
interface EffSummary {
  totalTimeSavedHours: number;
  avgTimeSavedPct: number;
  totalNetValueUsd: number;
  roiRatio: number | null;
  avgMttrHours: number | null;
  resolvedAlertCount: number;
  openAlertCount: number;
  systemCount: number;
  mttdSampleCount?: number;
  coverageSampleCount?: number;
}
interface EffRoi {
  hourlyRateUsd: number;
  laborValueUsd: number;
  netValueUsd: number;
  ratio: number | null;
}
interface EffMttd {
  /** 설정된 MTTD 목표(%) — 측정값 아님. */
  targetPct: number | null;
  /** 실측/근사 평균 탐지 시간(분). */
  actualMinutes: number | null;
  /** 'signal' = 원천신호 실측, 'latency-proxy' = 평균 지연 근사, null = 데이터 없음. */
  source: 'signal' | 'latency-proxy' | null;
  /** 실측 표본 수(원천신호 기준). */
  samples: number;
}
interface EffMttr {
  actualHours: number | null;
  resolvedCount: number;
  openCount: number;
}
interface EffCoverage {
  /** 설정된 커버리지 목표 배수(x) — 측정값 아님. */
  targetX: number | null;
  /** 실측 커버리지(%) — 원천신호(COVERAGE) 수집 시. */
  actualPct: number | null;
  /** 누적 테스트 총 개수. */
  testsTotal: number;
  /** 누적 통과 테스트 개수. */
  testsPassed: number;
  /** 실측 표본 수(원천신호 기준). */
  samples: number;
}
interface EffAgent {
  workflowKey: string;
  name: string;
  system: string | null;
  domain: string | null;
  valueLabel: string | null;
  category: string | null;
  executions: number;
  successRate: number;
  manualMinutesPerRun: number;
  aiMinutesPerRun: number;
  timeSavedPct: number;
  timeSavedHours: number;
  roi: EffRoi;
  mttd: EffMttd;
  mttr: EffMttr;
  coverage: EffCoverage;
  /** @deprecated 레거시 — coverage.targetX 사용. */
  coverageTargetX: number | null;
  trend?: unknown;
}
interface EffSystemRow {
  system: string;
  agentCount: number;
  totalTimeSavedHours: number;
  avgTimeSavedPct: number;
  totalNetValueUsd: number;
  avgMttrHours: number | null;
  executions: number;
  successRate: number;
  failedCount: number;
  errorRate: number;
  securityIssueCount: number;
  criticalSecurityCount: number;
}
interface EffectivenessResponse {
  window: EffWindow;
  summary: EffSummary;
  agents: EffAgent[];
  bySystem: EffSystemRow[];
}

// ── Helpers ──

const EM = '—';

/** null/0/NaN 은 측정값 없음으로 보고 em dash 로 렌더. */
function dashIfEmpty(n: number | null | undefined): boolean {
  return n == null || !Number.isFinite(n) || n === 0;
}
function fmtPct(n: number | null | undefined): string {
  if (dashIfEmpty(n)) return EM;
  return `${(n as number).toFixed(1)}%`;
}
function fmtHours(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EM;
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EM;
  const v = Math.round(Number(n));
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString()}`;
}
function fmtMinutes(n: number | null | undefined): string {
  if (dashIfEmpty(n)) return EM;
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}분`;
}

// ── Page Component ──

interface TrendPoint {
  date: string;
  executions: number;
  costUsd: number;
  avgScore: number;
}

export default function EffectivenessPage() {
  const [data, setData] = useState<EffectivenessResponse | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, ov] = await Promise.all([
        api.get<EffectivenessResponse>(`/dashboard/effectiveness?days=${days}`),
        api
          .get<{ timeseries?: TrendPoint[] }>(`/dashboard/overview?days=${days}`)
          .catch(() => null),
      ]);
      setData(res);
      setTrend(ov?.timeseries ?? []);
    } catch (err: any) {
      setError(err?.message ?? '효과성 지표를 불러오지 못했습니다');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const summary = data?.summary;
  const agents = data?.agents ?? [];
  const bySystem = data?.bySystem ?? [];
  const agentsPage = usePagination(agents, 10);
  const mttdSampleCount = summary?.mttdSampleCount ?? 0;
  const coverageSampleCount = summary?.coverageSampleCount ?? 0;
  const hasSignalCollection = mttdSampleCount > 0 || coverageSampleCount > 0;

  return (
    <div className="p-6">
      <PageHeader
        title="성과 / 효과성 지표"
        description="에이전트가 가져온 효과성 — 수작업 대비 시간 절감, ROI, MTTD/MTTR (시스템·에이전트 단위)"
        actions={
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {([7, 30, 90] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded border transition ${
                    days === d
                      ? 'bg-accent/20 border-accent text-accent'
                      : 'border-border text-muted-dark hover:text-dark'
                  }`}
                >
                  {d}일
                </button>
              ))}
            </div>
            <button
              onClick={fetchData}
              className="p-1.5 text-muted-dark hover:text-dark transition"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* SUMMARY 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <SummaryCard
          icon={Clock}
          label="총 절감 시간"
          value={loading ? EM : fmtHours(summary?.totalTimeSavedHours ?? 0)}
          sub="수작업 대비 누적"
          color="success"
        />
        <SummaryCard
          icon={TrendingUp}
          label="평균 시간 절감률"
          value={loading ? EM : fmtPct(summary?.avgTimeSavedPct)}
          sub="실행 보유 에이전트 평균"
          color="accent"
        />
        <SummaryCard
          icon={DollarSign}
          label="총 순가치"
          value={loading ? EM : fmtUsd(summary?.totalNetValueUsd ?? 0)}
          sub={
            summary?.roiRatio != null && Number.isFinite(summary.roiRatio)
              ? `ROI ${summary.roiRatio.toFixed(1)}x`
              : 'ROI —'
          }
          color="accent"
        />
        <SummaryCard
          icon={Timer}
          label="평균 MTTR"
          value={loading ? EM : fmtHours(summary?.avgMttrHours)}
          sub="알람 평균 복구 시간"
          color="warning"
        />
        <SummaryCard
          icon={Bell}
          label="알람 처리/미처리"
          value={
            loading ? EM : `${summary?.resolvedAlertCount ?? 0} / ${summary?.openAlertCount ?? 0}`
          }
          sub={`시스템 ${summary?.systemCount ?? 0}개`}
          color="danger"
        />
      </div>

      {/* 성과 추이 — 일별 실행·비용 / 품질점수 ({days}일) */}
      {trend.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* 실행량·비용 막대 */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-900 flex items-center gap-1.5">
                <TrendingUp size={13} className="text-accent" /> 일별 실행·비용 추이
              </span>
              <div className="flex items-center gap-3 text-[10px] text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-accent/70" /> 실행
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-[#C9A45C]" /> 비용($)
                </span>
              </div>
            </div>
            {(() => {
              const maxE = Math.max(...trend.map((t) => t.executions), 1);
              const maxC = Math.max(...trend.map((t) => t.costUsd), 0.0001);
              return (
                <div className="flex items-end gap-0.5 h-28">
                  {trend.map((t, i) => (
                    <div
                      key={i}
                      className="flex-1 flex items-end gap-px group"
                      title={`${t.date} · 실행 ${t.executions} · 비용 $${t.costUsd.toFixed(3)}`}
                    >
                      <div
                        className="flex-1 rounded-t bg-accent/70 group-hover:bg-accent transition-colors"
                        style={{ height: `${Math.max(2, (t.executions / maxE) * 104)}px` }}
                      />
                      <div
                        className="flex-1 rounded-t bg-[#C9A45C]"
                        style={{ height: `${Math.max(1, (t.costUsd / maxC) * 104)}px` }}
                      />
                    </div>
                  ))}
                </div>
              );
            })()}
            <div className="flex justify-between text-[9px] text-gray-400 mt-1">
              <span>{trend[0]?.date?.slice(5)}</span>
              <span>{trend[trend.length - 1]?.date?.slice(5)}</span>
            </div>
          </div>

          {/* 품질점수 라인 */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-900 flex items-center gap-1.5">
                <Target size={13} className="text-success" /> 일별 평균 품질점수
              </span>
              <span className="text-[10px] text-gray-400">0~100</span>
            </div>
            {(() => {
              const W = 560;
              const H = 112;
              const pts = trend.map((t, i) => {
                const x = trend.length > 1 ? (i / (trend.length - 1)) * W : W / 2;
                const y = H - Math.max(0, Math.min(100, t.avgScore)) * (H / 100);
                return { x, y, t };
              });
              const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
              return (
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28">
                  {[25, 50, 75].map((g) => (
                    <line key={g} x1={0} x2={W} y1={H - g * (H / 100)} y2={H - g * (H / 100)} stroke="#F1F3F7" />
                  ))}
                  <path d={path} fill="none" stroke="#6FAF9A" strokeWidth={2} />
                  {pts.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#6FAF9A">
                      <title>{`${p.t.date} · ${p.t.avgScore}점`}</title>
                    </circle>
                  ))}
                </svg>
              );
            })()}
            <div className="flex justify-between text-[9px] text-gray-400 mt-1">
              <span>{trend[0]?.date?.slice(5)}</span>
              <span>{trend[trend.length - 1]?.date?.slice(5)}</span>
            </div>
          </div>
        </div>
      )}

      {/* 에이전트별 효과성 테이블 */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm mb-6">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-200">
          <Target size={14} className="text-accent" />
          <span className="text-xs font-semibold text-gray-900">에이전트별 효과성</span>
          <span className="text-[10px] text-gray-500 ml-auto">{agents.length}개</span>
        </div>

        {/* 범례 / 주석 */}
        <div className="px-4 py-2 border-b border-gray-200 text-[10px] text-gray-500 leading-relaxed">
          <span className="text-muted-dark">측정 안내</span> · MTTD·커버리지:
          원천신호(EffectivenessSignal) 수집 시 <span className="text-success/90">실측</span>,
          없으면 MTTD는 <span className="text-accent/90">평균 지연 근사</span> · MTTR 실측 = 알람
          평균 복구 시간 ·<span className="text-warning/90"> 목표(MTTD %·커버리지 x)</span> 는
          설정값 · 실측/이력이 없는 항목은 {EM} 으로 표시
          {!loading && hasSignalCollection && (
            <span className="block mt-1 text-success/80">
              원천신호 수집: MTTD {mttdSampleCount}표본 · 커버리지 {coverageSampleCount}건
            </span>
          )}
        </div>

        {loading ? (
          <div className="p-4 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Target size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-xs">효과성 기준이 설정된 에이전트가 없습니다</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                  <th className="text-left px-4 py-2">에이전트</th>
                  <th className="text-left px-4 py-2">시스템</th>
                  <th className="text-left px-4 py-2">도메인</th>
                  <th className="text-right px-4 py-2">수작업 → 실제</th>
                  <th className="text-left px-4 py-2 min-w-[140px]">시간 절감률</th>
                  <th className="text-right px-4 py-2">절감 시간</th>
                  <th className="text-right px-4 py-2">순가치</th>
                  <th className="text-right px-4 py-2">MTTD</th>
                  <th className="text-right px-4 py-2">MTTR</th>
                  <th className="text-right px-4 py-2">커버리지</th>
                </tr>
              </thead>
              <tbody>
                {agentsPage.pageItems.map((a) => {
                  const pctEmpty = dashIfEmpty(a.timeSavedPct);
                  const pctVal = pctEmpty ? 0 : Math.min(100, Math.max(0, a.timeSavedPct));
                  const mttd = a.mttd;
                  const cov = a.coverage;
                  const covPctEmpty = dashIfEmpty(cov?.actualPct);
                  return (
                    <tr
                      key={a.workflowKey}
                      className="border-b border-gray-200 hover:bg-gray-50 transition align-top"
                    >
                      <td className="px-4 py-2.5">
                        <p className="text-xs text-gray-900 font-medium">{a.name}</p>
                        <p className="text-[10px] text-gray-500 font-mono">{a.workflowKey}</p>
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-gray-500 whitespace-nowrap">
                        {a.system ?? EM}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-gray-500 whitespace-nowrap">
                        {a.domain ?? EM}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500 whitespace-nowrap">
                        {fmtMinutes(a.manualMinutesPerRun)} → {fmtMinutes(a.aiMinutesPerRun)}
                      </td>
                      <td className="px-4 py-2.5">
                        {pctEmpty ? (
                          <span className="text-[11px] text-gray-500">{EM}</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-success rounded-full"
                                style={{ width: `${pctVal}%` }}
                              />
                            </div>
                            <span className="text-[11px] font-mono text-gray-900 whitespace-nowrap">
                              {a.timeSavedPct.toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500 whitespace-nowrap">
                        {fmtHours(a.timeSavedHours)}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-900 whitespace-nowrap">
                        {fmtUsd(a.roi?.netValueUsd)}
                      </td>
                      {/* MTTD — 실측(원천신호) vs 근사(지연) vs 목표 */}
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <p className="text-[11px] font-mono text-gray-900">
                          {fmtMinutes(mttd?.actualMinutes)}
                        </p>
                        {mttd?.source === 'signal' && (
                          <p className="text-[9px] text-success/80">실측·{mttd.samples}표본</p>
                        )}
                        {mttd?.source === 'latency-proxy' && (
                          <p className="text-[9px] text-accent/80">근사(지연)</p>
                        )}
                        {mttd?.targetPct != null && (
                          <p className="text-[9px] text-warning/80">목표 {mttd.targetPct}%</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <p className="text-[11px] font-mono text-gray-500">
                          {fmtHours(a.mttr?.actualHours)}
                        </p>
                        <p className="text-[9px] text-gray-500/70">
                          해결 {a.mttr?.resolvedCount ?? 0} · 미처리 {a.mttr?.openCount ?? 0}
                        </p>
                      </td>
                      {/* 커버리지 — 실측 % vs 목표 x */}
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <p
                          className={`text-[11px] font-mono ${
                            covPctEmpty ? 'text-gray-500' : 'text-success'
                          }`}
                          title={
                            cov && (cov.testsTotal > 0 || cov.testsPassed > 0)
                              ? `통과 ${cov.testsPassed} / 총 ${cov.testsTotal}`
                              : undefined
                          }
                        >
                          {fmtPct(cov?.actualPct)}
                        </p>
                        {cov && cov.samples > 0 && (
                          <p className="text-[9px] text-success/80">{cov.samples}건</p>
                        )}
                        {cov?.targetX != null && (
                          <p className="text-[9px] text-warning/80">목표 {cov.targetX}x</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pager p={agentsPage} />
          </div>
        )}
      </div>

      {/* 시스템별 롤업 */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
          <Server size={14} className="text-accent" />
          <span className="text-xs font-semibold text-gray-900">시스템별 롤업</span>
          <span className="text-[10px] text-gray-500 ml-auto">{bySystem.length}개 시스템</span>
        </div>

        {loading ? (
          <div className="p-4 space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : bySystem.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Server size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-xs">시스템 집계 데이터가 없습니다</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                  <th className="text-left px-4 py-2">시스템</th>
                  <th className="text-right px-4 py-2">에이전트 수</th>
                  <th className="text-right px-4 py-2">총 절감 시간</th>
                  <th className="text-right px-4 py-2">평균 절감률</th>
                  <th className="text-right px-4 py-2">총 순가치</th>
                  <th className="text-right px-4 py-2">평균 MTTR</th>
                  <th className="text-right px-4 py-2">활용</th>
                  <th className="text-right px-4 py-2">오류</th>
                  <th className="text-right px-4 py-2">보안</th>
                </tr>
              </thead>
              <tbody>
                {bySystem.map((s) => (
                  <tr
                    key={s.system}
                    className="border-b border-gray-200 hover:bg-gray-50 transition"
                  >
                    <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{s.system}</td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500">
                      {s.agentCount}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500">
                      {fmtHours(s.totalTimeSavedHours)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500">
                      {fmtPct(s.avgTimeSavedPct)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-900">
                      {fmtUsd(s.totalNetValueUsd)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500">
                      {fmtHours(s.avgMttrHours)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono text-gray-500">
                      <span className="text-gray-900">{s.executions.toLocaleString()}</span>
                      <span className="text-gray-500"> / {fmtPct(s.successRate)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono">
                      <span className={s.failedCount > 0 ? 'text-danger' : 'text-gray-500'}>
                        {s.failedCount.toLocaleString()}
                      </span>
                      <span
                        className={
                          s.errorRate >= 5
                            ? 'text-danger font-semibold'
                            : s.errorRate > 0
                              ? 'text-warning'
                              : 'text-gray-500'
                        }
                      >
                        {' '}
                        / {fmtPct(s.errorRate)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-right font-mono">
                      {s.securityIssueCount > 0 ? (
                        <>
                          <span
                            className={
                              s.criticalSecurityCount > 0
                                ? 'text-danger font-semibold'
                                : 'text-warning'
                            }
                          >
                            {s.securityIssueCount.toLocaleString()}
                          </span>
                          {s.criticalSecurityCount > 0 && (
                            <span className="text-danger font-semibold">
                              {' '}
                              (심각 {s.criticalSecurityCount.toLocaleString()})
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-500">{EM}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub Components ──

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: any;
  label: string;
  value: string | number;
  sub: string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
        <Icon size={14} className={colorMap[color] ?? 'text-gray-900'} />
      </div>
      <p className={`text-2xl font-bold ${colorMap[color] ?? 'text-gray-900'}`}>{value}</p>
      <p className="text-[10px] text-gray-500 mt-1">{sub}</p>
    </div>
  );
}
