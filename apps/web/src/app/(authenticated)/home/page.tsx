'use client';

/**
 * 홈 대시보드 — DB 기반 (main agent = Workflow, sub agent = node)
 *
 * - 기간 선택(7/30/90/180일) → 모든 데이터 자동 재조회
 * - 성과/품질: 임원용 시계열 그래프(인라인 SVG) + 상세 팝업
 * - APM X-View: /executions 산점도(가로=24h 시각, 세로=소요 ms), 드래그 영역 선택 → 상세
 * - Agent 현황: 14개 main agent 막대 그래프, 클릭 시 sub 상세 팝업
 * - 상단 실행요약 숫자 클릭 → 이력 팝업
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/shared/PageHeader';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import { agentDisplayName } from '@/lib/agent-label';
import { useOpsRef, mmHours } from '@/lib/opsRef';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  Clock,
  DollarSign,
  AlertTriangle,
  Bot,
  Play,
  ShieldCheck,
  RefreshCw,
  Gauge,
  ChevronRight,
  Star,
  X,
  ExternalLink,
  Layers,
  Crosshair,
} from 'lucide-react';

// ── Types ──
interface Kpi {
  totalExecutions: number;
  successRate: number;
  avgLatencyMs: number;
  monthlyCostUsd: number;
  anomalyCount: number;
}
interface Quality {
  avgOverallScore: number;
  avgAccuracy: number;
  avgHallucinationRate: number;
  gradeDistribution: Record<string, number>;
  evaluatedCount: number;
}
interface Health {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  idle: number;
}
interface SubAgent {
  stepKey: string;
  nodeType: string | null;
  agentName: string | null;
  evaluations: number;
  avgScore: number;
  anomalyCount: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  health: string;
  worstSecurityRisk: string | null;
}
interface MetricTrend {
  current: number;
  previous: number;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
}
interface AgentTrend {
  quality: MetricTrend;
  security: MetricTrend;
  cost: MetricTrend;
  success: MetricTrend;
  costImprovingDirection: 'down';
}
interface AgentEffectiveness {
  timeSavedHours: number;
  actualAgentHours: number;
  costUsd: number;
  roi: { hourlyRateUsd: number; laborValueUsd: number; netValueUsd: number; ratio: number | null };
  coverageTargetX: number | null;
  mttdTargetPct: number | null;
  valueLabel: string | null;
  // MEASURED extras (overview.mainAgents[].effectiveness, via computeEffectiveness)
  manualMinutesPerRun?: number;
  aiMinutesPerRun?: number;
  timeSavedPct?: number;
  system?: string | null;
}
interface MainAgent {
  workflowKey: string;
  name?: string | null;
  code?: string | null;
  executions: number;
  successRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  avgScore: number;
  anomalyCount: number;
  health: string;
  subAgents: SubAgent[];
  trend: AgentTrend | null;
  effectiveness: AgentEffectiveness | null;
}
interface DailyPoint {
  date: string;
  executions: number;
  successRate: number;
  costUsd: number;
  avgScore: number;
  anomalies: number;
}
interface EffectivenessSummary {
  agentsWithConfig: number;
  totalTimeSavedHours: number;
  totalLaborValueUsd: number;
  totalCostUsd: number;
  totalNetValueUsd: number;
  roiRatio: number | null;
  avgQualityDeltaPct: number | null;
  avgSecurityDeltaPct: number | null;
  avgCostDeltaPct: number | null;
}
interface UtilizationEntry {
  workflowKey: string;
  name: string;
  code?: string | null;
  executions: number;
  successRate: number;
  avgScore: number;
}
interface Utilization {
  mostUsed: UtilizationEntry[];
  leastUsed: UtilizationEntry[];
}
interface Overview {
  kpi: Kpi;
  quality: Quality;
  health: Health;
  mainAgents: MainAgent[];
  timeseries: DailyPoint[];
  effectiveness: EffectivenessSummary;
  utilization: Utilization;
  window: { days: number; since: string };
}
interface AgentItem {
  key: string;
  name: string;
  code?: string | null;
  status: string;
  description: string;
  tags: string[];
  updatedAt: string;
  health: string;
  executions: number;
  successRate: number;
  avgScore: number;
  anomalyCount: number;
}
interface ExecLog {
  id: string;
  workflowKey?: string | null;
  status: string;
  costUsd?: number | null;
  latencyMs?: number | null;
  createdAt: string;
}

// ── Effectiveness detail (GET /dashboard/effectiveness) ──
interface EffAgent {
  workflowKey: string;
  name: string;
  code?: string | null;
  system: string | null;
  timeSavedPct: number | null;
  timeSavedHours: number | null;
  roi: { netValueUsd: number | null } | null;
  mttd: { actualMinutes: number | null; source: string | null; targetPct: number | null } | null;
  mttr: { actualHours: number | null; resolvedCount: number; openCount: number } | null;
  coverage: { actualPct: number | null; targetX: number | null } | null;
}
interface EffBySystem {
  system: string;
  agentCount: number;
  executions: number;
  successRate: number;
  errorRate: number;
  securityIssueCount: number;
  totalTimeSavedHours: number;
  avgTimeSavedPct: number;
  totalNetValueUsd: number;
}
interface EffDetail {
  summary: {
    systemCount: number;
    avgMttrHours: number | null;
    totalTimeSavedHours?: number;
    totalNetValueUsd?: number;
    roiRatio?: number | null;
    avgTimeSavedPct?: number;
  };
  agents: EffAgent[];
  bySystem: EffBySystem[];
}

const HEALTH_COLOR: Record<string, string> = {
  healthy: 'bg-[#6FAF9A]',
  degraded: 'bg-[#C9A45C]',
  down: 'bg-[#C77B7B]',
  idle: 'bg-muted-dark',
};
const HEALTH_HEX: Record<string, string> = {
  healthy: '#6FAF9A',
  degraded: '#C9A45C',
  down: '#C77B7B',
  idle: '#5A6A7E',
};
const HEALTH_TEXT: Record<string, string> = {
  healthy: 'text-success bg-success/15 border-success/20',
  degraded: 'text-warning bg-warning/15 border-warning/20',
  down: 'text-danger bg-danger/15 border-danger/20',
  idle: 'text-gray-500 bg-gray-50 border-gray-200',
};
const HEALTH_LABEL: Record<string, string> = {
  healthy: '정상',
  degraded: '주의',
  down: '비정상',
  idle: '유휴',
};
const RECENT_KEY = 'metis_recent_agents';
const PERIODS = [
  { d: 7, l: '7일' },
  { d: 30, l: '30일' },
  { d: 90, l: '90일' },
  { d: 180, l: '180일' },
];

// status → dot color for APM scatter
const STATUS_HEX = (s: string) =>
  s === 'SUCCEEDED' ? '#6FAF9A' : s === 'FAILED' ? '#C77B7B' : '#C9A45C';
const STATUS_LABEL = (s: string) =>
  s === 'SUCCEEDED' ? '성공' : s === 'FAILED' ? '실패' : '실행중';

// 표시 이름 표준 ([코드] 이름) — 전 화면 공통 유틸 사용.
const agentLabel = agentDisplayName;

export default function HomePage() {
  const router = useRouter();
  useOpsRef(); // 운영 기준값(월 근무시간 등) 로드 — MM 환산이 기준정보 기반이 되도록
  const [days, setDays] = useState(30);
  // 메인 Agent(workflowKey) / Sub-Agent(agentName) 필터 — 대시보드 전체가 해당 범위로 좁혀짐.
  const [mainF, setMainF] = useState('');
  const [subF, setSubF] = useState('');
  const [subOpts, setSubOpts] = useState<string[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [eff, setEff] = useState<EffDetail | null>(null);
  const [execPoints, setExecPoints] = useState<ExecLog[]>([]);
  const [apmDays, setApmDays] = useState(1); // APM 전용 기간(일) — 기본 최근 1일
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [agentModal, setAgentModal] = useState<MainAgent | null>(null);
  const [historyModal, setHistoryModal] = useState<{
    kind: 'total' | 'success' | 'latency' | 'cost' | 'anomaly';
    title: string;
  } | null>(null);
  const [perfModal, setPerfModal] = useState(false);
  const [qualModal, setQualModal] = useState(false);
  const [apmSel, setApmSel] = useState<ExecLog[] | null>(null);
  const [systemUsageModal, setSystemUsageModal] = useState(false);
  const [savingsModal, setSavingsModal] = useState(false);
  const [qualityDeltaModal, setQualityDeltaModal] = useState(false);
  const [agentUsageModal, setAgentUsageModal] = useState<{
    label: string;
    system: string;
    executions: number;
    successRate: number;
    avgScore: number;
    timeSavedHours: number | null;
  } | null>(null);

  const fetchAll = useCallback(async (d: number, mf = '', sf = '') => {
    setLoading(true);
    setError(null);
    const ovq =
      `days=${d}` +
      (mf ? `&workflowKey=${encodeURIComponent(mf)}` : '') +
      (sf ? `&subAgent=${encodeURIComponent(sf)}` : '');
    try {
      const [ov, ag] = await Promise.all([
        api.get<Overview>(`/dashboard/overview?${ovq}`),
        api.get<{ items: AgentItem[] }>(`/dashboard/agents?days=${d}`),
      ]);
      setOverview(ov);
      setAgents(Array.isArray(ag?.items) ? ag.items : []);
    } catch (err: any) {
      setError(err?.message ?? '대시보드를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
    // best-effort: 한쪽이 실패해도 홈은 깨지지 않음
    api
      .get<EffDetail>(`/dashboard/effectiveness?days=${d}`)
      .then((res) => setEff(res ?? null))
      .catch(() => setEff(null));
  }, []);

  useEffect(() => {
    fetchAll(days, mainF, subF);
  }, [days, mainF, subF, fetchAll]);

  // APM X-View는 전역 기간과 독립. 최신 100건을 한 번에 받아두고(서버 기간 필터 없음),
  // 기간(apmDays)은 화면에서 필터 — 기간 전환이 즉시이고 최근 실행이 절대 누락되지 않는다.
  const loadApm = useCallback(() => {
    api
      .get<{ items: ExecLog[] }>(`/executions?pageSize=100`)
      .then((res) => setExecPoints(Array.isArray(res?.items) ? res.items : []))
      .catch(() => setExecPoints([]));
  }, []);
  useEffect(() => {
    loadApm();
  }, [loadApm]);
  // Sub-Agent 드롭다운 옵션: 필터 미적용 상태의 overview에서 distinct agentName 수집(선택 후엔 유지).
  useEffect(() => {
    if (subF || !overview) return;
    const set = new Set<string>();
    for (const m of overview.mainAgents ?? []) {
      for (const s of m.subAgents ?? []) {
        const an = s.agentName ?? s.stepKey;
        if (an) set.add(an);
      }
    }
    setSubOpts(Array.from(set).sort());
  }, [overview, subF]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const s = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      if (Array.isArray(s)) setRecent(s);
    } catch {}
  }, []);

  const launchAgent = (key: string) => {
    if (typeof window !== 'undefined') {
      try {
        const next = [key, ...recent.filter((k) => k !== key)].slice(0, 6);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        setRecent(next);
      } catch {}
    }
    router.push(`/orchestration/builder?workflow=${encodeURIComponent(key)}`);
  };

  const kpi = overview?.kpi,
    quality = overview?.quality,
    health = overview?.health;
  const ts = overview?.timeseries ?? [];
  const effSummary = overview?.effectiveness;
  const util = overview?.utilization;
  const fmtDelta = (d: number | null | undefined) =>
    d == null ? '—' : `${d > 0 ? '▲ +' : d < 0 ? '▼ ' : ''}${d.toFixed(1)}%`;
  const recentAgents = recent
    .map((k) => agents.find((a) => a.key === k))
    .filter(Boolean) as AgentItem[];

  // 빠른 실행 단축버튼: 최근 1 + 인기 2 (중복 제거)
  const quickLaunch: { key: string; label: string; tag: '최근' | '인기' }[] = [];
  {
    const seen = new Set<string>();
    const r0 = recentAgents[0];
    if (r0?.key) {
      quickLaunch.push({ key: r0.key, label: agentLabel(r0), tag: '최근' });
      seen.add(r0.key);
    }
    for (const e of util?.mostUsed ?? []) {
      if (quickLaunch.length >= 3) break;
      if (!e.workflowKey || seen.has(e.workflowKey)) continue;
      quickLaunch.push({ key: e.workflowKey, label: agentLabel(e), tag: '인기' });
      seen.add(e.workflowKey);
    }
  }

  // workflowKey → 표시명 (APM 모달/팝업용)
  const nameOf = (key?: string | null): string => {
    if (!key) return '—';
    const a = agents.find((x) => x.key === key);
    if (a) return agentLabel(a);
    const m = eff?.agents?.find((x) => x.workflowKey === key);
    if (m) return agentLabel(m);
    return key;
  };

  const systemCount = eff?.summary?.systemCount;

  // 활용 랭킹 행 클릭 → Agent 사용 상세 (eff로 시스템/절감 공수 보강)
  const openAgentUsage = (e: UtilizationEntry) => {
    const m = eff?.agents?.find((x) => x.workflowKey === e.workflowKey);
    setAgentUsageModal({
      label: agentLabel(e),
      system: m?.system ?? '미지정',
      executions: e.executions,
      successRate: e.successRate,
      avgScore: e.avgScore,
      timeSavedHours: m?.timeSavedHours ?? null,
    });
  };

  return (
    <div className="p-6 bg-light-bg min-h-full text-gray-900">
      <PageHeader
        title="대시보드"
        description="Agent 운영 현황 — 성과 · 품질 · 현황 (DB 집계)"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {quickLaunch.length > 0 && (
              <div className="flex items-center gap-1.5 pr-2 mr-0.5 border-r border-gray-200">
                {quickLaunch.map((q) => (
                  <button
                    key={q.key}
                    onClick={() => launchAgent(q.key)}
                    title={`${q.tag} · ${q.label}`}
                    className="flex items-center gap-1 bg-white border border-gray-200 text-xs text-gray-900 rounded px-2 py-1 hover:bg-gray-50 transition"
                  >
                    <Play size={11} className="text-accent flex-shrink-0" />
                    <span className="text-[9px] text-muted-dark flex-shrink-0">{q.tag}</span>
                    <span className="truncate max-w-[7rem]">{q.label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex bg-white rounded-lg p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.d}
                  onClick={() => setDays(p.d)}
                  className={`px-2.5 py-1 rounded text-xs font-semibold transition ${days === p.d ? 'bg-accent text-white shadow-sm' : 'text-muted-dark hover:text-gray-900'}`}
                >
                  {p.l}
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                fetchAll(days, mainF, subF);
                loadApm();
              }}
              className="p-1.5 text-muted-dark hover:text-gray-900 transition"
              title="새로고침"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {/* 메인 Agent / Sub-Agent 필터 — 우측 정렬. 라벨 대신 「필터 해제」 (필터 없으면 숨김) */}
      <div className="flex flex-wrap items-center justify-end gap-2 mb-4">
        <button
          onClick={() => {
            setMainF('');
            setSubF('');
          }}
          aria-hidden={!(mainF || subF)}
          tabIndex={mainF || subF ? 0 : -1}
          className={`text-[11px] font-semibold text-accent hover:underline mr-0.5 ${
            mainF || subF ? 'visible' : 'invisible'
          }`}
        >
          필터 해제
        </button>
        <select
          value={mainF}
          onChange={(e) => {
            setMainF(e.target.value);
            setSubF('');
          }}
          title="메인 Agent 필터"
          className="bg-white border border-gray-200 rounded-lg text-xs text-gray-900 px-2.5 py-1.5 min-w-[14rem]"
        >
          <option value="">🤖 전체 메인 Agent</option>
          {agents.map((a) => {
            const k = (a as any).key ?? (a as any).workflowKey;
            return (
              <option key={k} value={k}>
                {agentLabel(a)}
              </option>
            );
          })}
        </select>
        <select
          value={subF}
          onChange={(e) => setSubF(e.target.value)}
          title="Sub-Agent 필터"
          className="bg-white border border-gray-200 rounded-lg text-xs text-gray-900 px-2.5 py-1.5 min-w-[14rem]"
        >
          <option value="">🧩 전체 Sub-Agent ({subOpts.length})</option>
          {subOpts.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* 실행 요약 + 효과성 요약 — 한 줄 통합 (클릭 → 이력/상세 팝업) */}
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-9 gap-2 mb-6">
        <SummaryStat
          icon={<Activity size={16} className="text-accent" />}
          label="Agent 총 수행"
          value={kpi ? kpi.totalExecutions.toLocaleString() : '—'}
          onClick={() => setHistoryModal({ kind: 'total', title: '전체 실행 이력 — 에이전트별 분포' })}
        />
        <SummaryStat
          icon={<CheckCircle2 size={16} className="text-success" />}
          label="수행 성공률"
          value={kpi ? `${kpi.successRate}%` : '—'}
          onClick={() => setHistoryModal({ kind: 'success', title: '수행 성공률 — 성공/실패 분석' })}
        />
        <SummaryStat
          icon={<Clock size={16} className="text-warning" />}
          label="평균 속도"
          value={kpi ? fmtMs(kpi.avgLatencyMs) : '—'}
          onClick={() => setHistoryModal({ kind: 'latency', title: '평균 속도 — 지연 분포·느린 실행' })}
        />
        <SummaryStat
          icon={<DollarSign size={16} className="text-success" />}
          label="토큰 비용"
          value={kpi ? `$${kpi.monthlyCostUsd.toLocaleString()}` : '—'}
          onClick={() => setHistoryModal({ kind: 'cost', title: '토큰 비용 — 에이전트별·고비용 실행' })}
        />
        <SummaryStat
          icon={<AlertTriangle size={16} className="text-danger" />}
          label="이상 감지"
          value={kpi ? String(kpi.anomalyCount) : '—'}
          highlight={!!kpi && kpi.anomalyCount > 0}
          onClick={() => setHistoryModal({ kind: 'anomaly', title: '이상 감지 — 실패·이상 실행' })}
        />
        <SummaryStat
          icon={<Layers size={16} className="text-accent" />}
          label="활용 시스템"
          value={systemCount != null ? String(systemCount) : '—'}
          sub={systemCount != null ? `${systemCount}/${systemCount} 연결` : undefined}
          accent="indigo"
          onClick={() => setSystemUsageModal(true)}
        />
        {effSummary && effSummary.agentsWithConfig > 0 && (
          <>
            <SummaryStat
              icon={<TrendingUp size={16} className="text-success" />}
              label="총 절감 공수"
              value={`${(effSummary.totalTimeSavedHours / mmHours()).toFixed(1)} MM`}
              sub={`${effSummary.agentsWithConfig}개 Agent 기준 · 순가치 $${Math.round(
                effSummary.totalNetValueUsd ?? 0,
              ).toLocaleString()}`}
              valueClass="text-success"
              onClick={() => setSavingsModal(true)}
            />
            <SummaryStat
              icon={<DollarSign size={16} className="text-accent" />}
              label="ROI"
              value={effSummary.roiRatio != null ? `${effSummary.roiRatio.toFixed(1)}x` : '—'}
              sub={`인건비 환산 $${Math.round(
                effSummary.totalLaborValueUsd ?? 0,
              ).toLocaleString()} vs 비용 $${Math.round(effSummary.totalCostUsd ?? 0).toLocaleString()}`}
              valueClass="text-accent"
            />
            <SummaryStat
              icon={<Gauge size={16} className="text-purple" />}
              label="품질 평균 증감"
              value={fmtDelta(effSummary.avgQualityDeltaPct)}
              sub="이전 기간 대비 (실측)"
              valueClass={
                effSummary.avgQualityDeltaPct == null
                  ? 'text-gray-500'
                  : effSummary.avgQualityDeltaPct < 0
                    ? 'text-danger'
                    : 'text-success'
              }
              onClick={() => setQualityDeltaModal(true)}
            />
          </>
        )}
      </div>

      {/* SCENARIO 4: 활용 랭킹 (실데이터) — 활용 Top 3 / 미활용 Top 3 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <UtilCard
          title="활용 Top 3"
          subtitle="실행 횟수 기준 (최다 사용)"
          icon={<TrendingUp size={16} className="text-accent" />}
          loading={loading}
          entries={util?.mostUsed ?? []}
          emptyText="실행 데이터가 아직 없습니다."
          onRowClick={openAgentUsage}
        />
        <UtilCard
          title="미활용 Top 3"
          subtitle="실행 횟수 기준 (최소/미사용) — 0회는 미사용"
          icon={<TrendingDown size={16} className="text-warning" />}
          loading={loading}
          entries={util?.leastUsed ?? []}
          emptyText="등록된 Agent가 없습니다."
          highlightZero
          onRowClick={openAgentUsage}
        />
      </div>

      {/* 성과 · 품질 그래프 (임원용) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartCard
          title="성과 추이 (실행량 · 성공률)"
          icon={<TrendingUp size={16} className="text-accent" />}
          onDetail={() => setPerfModal(true)}
          onAnalyze={() => router.push('/governance/effectiveness')}
        >
          {loading ? <Skeleton /> : <PerfChart data={ts} />}
        </ChartCard>
        <ChartCard
          title="품질 추이 (평균 종합점수 · 이상)"
          icon={<Gauge size={16} className="text-purple" />}
          onDetail={() => setQualModal(true)}
          onAnalyze={() => router.push('/insights/evaluator')}
        >
          {loading ? <Skeleton /> : <QualityChart data={ts} />}
        </ChartCard>
      </div>

      {/* APM X-View (제니퍼 스타일) — /executions 산점도 + 드래그 선택 */}
      <ApmXView
        points={execPoints}
        loading={loading}
        days={apmDays}
        onDays={setApmDays}
        onSelect={(sel) => setApmSel(sel)}
      />

      {/* Agent 현황 — 14개 main agent 막대 그래프 */}
      <div className="bg-white border border-gray-200 rounded-lg mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-success" />
            <span className="text-xs font-semibold text-gray-900">Agent 현황 (Main Agent별)</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-gray-500">
            <Legend cls="bg-success" t={`정상 ${health?.healthy ?? 0}`} />
            <Legend cls="bg-[#C9A45C]" t={`주의 ${health?.degraded ?? 0}`} />
            <Legend cls="bg-[#C77B7B]" t={`비정상 ${health?.down ?? 0}`} />
            <Legend cls="bg-muted-dark" t={`유휴 ${health?.idle ?? 0}`} />
          </div>
        </div>
        <div className="p-4">
          {loading ? (
            <Skeleton />
          ) : (overview?.mainAgents.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-dark text-center py-6">
              실행/평가 데이터가 아직 없습니다. Agent를 실행하면 여기에 표시됩니다.
            </p>
          ) : (
            <div className="space-y-1 max-h-[360px] overflow-y-auto pr-1">
              {overview!.mainAgents.map((m) => (
                <button
                  key={m.workflowKey}
                  onClick={() => setAgentModal(m)}
                  className="w-full flex items-center gap-2.5 hover:bg-gray-50 rounded px-2 py-1 transition text-left"
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${HEALTH_COLOR[m.health]}`}
                  />
                  <span
                    className="w-40 text-xs text-gray-900 truncate flex-shrink-0"
                    title={agentLabel(m)}
                  >
                    {agentLabel(m)}
                  </span>
                  <div className="flex-1 h-2.5 bg-gray-100 rounded overflow-hidden">
                    <div
                      className="h-full rounded transition-all"
                      style={{
                        width: `${Math.max(2, m.avgScore)}%`,
                        backgroundColor: HEALTH_HEX[m.health],
                      }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs font-semibold text-gray-500 flex-shrink-0">
                    {m.avgScore}
                  </span>
                  <span
                    className={`w-16 text-right text-[10px] font-semibold flex-shrink-0 ${
                      !m.trend || m.trend.quality.direction === 'flat'
                        ? 'text-muted-dark'
                        : m.trend.quality.direction === 'up'
                          ? 'text-success'
                          : 'text-danger'
                    }`}
                    title="품질 추이 (이전 기간 대비)"
                  >
                    {m.trend
                      ? m.trend.quality.direction === 'up'
                        ? `▲ ${m.trend.quality.deltaPct != null ? Math.abs(m.trend.quality.deltaPct) + '%' : ''}`
                        : m.trend.quality.direction === 'down'
                          ? `▼ ${m.trend.quality.deltaPct != null ? Math.abs(m.trend.quality.deltaPct) + '%' : ''}`
                          : '—'
                      : '—'}
                  </span>
                  <span className="w-24 text-right text-[10px] text-muted-dark flex-shrink-0">
                    {m.executions}회 · 이상{m.anomalyCount}
                  </span>
                  <ChevronRight size={13} className="text-muted-dark flex-shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Agent 상세 팝업 */}
      {agentModal && (
        <AgentDetailModal
          main={agentModal}
          onClose={() => setAgentModal(null)}
          onOpenBuilder={(k) =>
            router.push(`/orchestration/builder?workflow=${encodeURIComponent(k)}`)
          }
        />
      )}
      {/* 이력 팝업 */}
      {historyModal && (
        <HistoryModal
          kind={historyModal.kind}
          title={historyModal.title}
          days={days}
          onClose={() => setHistoryModal(null)}
        />
      )}
      {/* 성과 상세 팝업 */}
      {perfModal && (
        <PerfDetailModal
          eff={eff}
          effSummary={effSummary}
          onClose={() => setPerfModal(false)}
          onAnalyze={() => {
            setPerfModal(false);
            router.push('/governance/effectiveness');
          }}
        />
      )}
      {/* 품질 상세 팝업 */}
      {qualModal && (
        <QualDetailModal
          quality={quality}
          mainAgents={overview?.mainAgents ?? []}
          onClose={() => setQualModal(false)}
          onAnalyze={() => {
            setQualModal(false);
            router.push('/insights/evaluator');
          }}
        />
      )}
      {/* APM 선택 상세 팝업 */}
      {apmSel && (
        <ApmSelectionModal points={apmSel} nameOf={nameOf} onClose={() => setApmSel(null)} />
      )}
      {/* 시스템별 사용 Agent 팝업 (활용 시스템 KPI 클릭) */}
      {systemUsageModal && (
        <SystemUsageModal eff={eff} onClose={() => setSystemUsageModal(false)} />
      )}
      {/* Agent별 절감 효과 팝업 (총 절감 공수 클릭) */}
      {savingsModal && <SavingsModal eff={eff} onClose={() => setSavingsModal(false)} />}
      {/* Agent별 품질 증감 팝업 (품질 평균 증감 클릭) */}
      {qualityDeltaModal && (
        <QualityDeltaModal
          mainAgents={overview?.mainAgents ?? []}
          onClose={() => setQualityDeltaModal(false)}
        />
      )}
      {/* Agent 사용 상세 팝업 (활용/미활용 행 클릭) */}
      {agentUsageModal && (
        <AgentUsageModal detail={agentUsageModal} onClose={() => setAgentUsageModal(null)} />
      )}
    </div>
  );
}

// ── Executive charts (inline SVG) ──
// X축 날짜 틱 인덱스(처음/중간/끝 + 균등) 선택
function dateTickIdx(n: number): number[] {
  if (n <= 1) return [0];
  if (n <= 4) return data_range(n);
  const idx = new Set<number>([0, Math.floor((n - 1) / 2), n - 1]);
  const step = Math.ceil(n / 6);
  for (let i = 0; i < n; i += step) idx.add(i);
  return [...idx].sort((a, b) => a - b);
}
function data_range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
const mmdd = (iso: string) => (iso && iso.length >= 10 ? iso.slice(5, 10) : (iso ?? ''));

function PerfChart({ data }: { data: DailyPoint[] }) {
  if (!data.length) return <Empty />;
  const W = 460,
    H = 168,
    P = 24,
    PB = 40; // 하단 패딩(날짜 라벨)
  const maxExec = Math.max(...data.map((d) => d.executions), 1);
  const bw = (W - P * 2) / data.length;
  const plotH = H - P - PB;
  const xy = (i: number, rate: number) =>
    [P + bw * i + bw / 2, H - PB - (rate / 100) * plotH] as const;
  const line = data.map((d, i) => xy(i, d.successRate).join(',')).join(' ');
  const ticks = dateTickIdx(data.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 230 }}>
      {/* Y 그리드 + 라벨 (성공률 0/50/100%) */}
      {[0, 50, 100].map((g) => {
        const y = H - PB - (g / 100) * plotH;
        return (
          <g key={g}>
            <line x1={P} y1={y} x2={W - P} y2={y} stroke="rgba(255,255,255,0.08)" />
            <text x={P - 4} y={y + 3} fontSize={8} fill="#8B9BB4" textAnchor="end">
              {g}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = (d.executions / maxExec) * plotH;
        return (
          <rect
            key={i}
            x={P + bw * i + 2}
            y={H - PB - h}
            width={Math.max(1, bw - 4)}
            height={h}
            fill="#3B6EA5"
            rx={1}
          />
        );
      })}
      <polyline points={line} fill="none" stroke="#34D399" strokeWidth={2} />
      {data.map((d, i) => {
        const [x, y] = xy(i, d.successRate);
        return <circle key={i} cx={x} cy={y} r={2.5} fill="#34D399" />;
      })}
      {/* X축 날짜 틱 */}
      {ticks.map((i) => {
        const [x] = xy(i, 0);
        return (
          <text
            key={`xt${i}`}
            x={x}
            y={H - PB + 14}
            fontSize={8}
            fill="#8B9BB4"
            textAnchor="middle"
          >
            {mmdd(data[i].date)}
          </text>
        );
      })}
      <text x={W - P} y={H - 4} fontSize={8} fill="#8B9BB4" textAnchor="end">
        X=날짜
      </text>
      {/* 범례 */}
      <rect x={P} y={4} width={10} height={10} rx={2} fill="#3B6EA5" />
      <text x={P + 14} y={13} fontSize={9} fill="#7fa9e0">막대 = 실행량(건, 최대 {maxExec})</text>
      <line x1={P + 190} y1={9} x2={P + 208} y2={9} stroke="#34D399" strokeWidth={2} />
      <circle cx={P + 199} cy={9} r={2.5} fill="#34D399" />
      <text x={P + 213} y={13} fontSize={9} fill="#34D399">선·점 = 성공률(%)</text>
    </svg>
  );
}
function QualityChart({ data }: { data: DailyPoint[] }) {
  if (!data.length) return <Empty />;
  const W = 460,
    H = 168,
    P = 24,
    PB = 40;
  const bw = (W - P * 2) / data.length;
  const plotH = H - P - PB;
  const xy = (i: number, score: number) =>
    [P + bw * i + bw / 2, H - PB - (score / 100) * plotH] as const;
  const line = data.map((d, i) => xy(i, d.avgScore).join(',')).join(' ');
  const maxAnom = Math.max(...data.map((d) => d.anomalies), 1);
  const ticks = dateTickIdx(data.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 230 }}>
      {/* Y 그리드 + 라벨 (종합점수 0/50/100) */}
      {[0, 50, 100].map((g) => {
        const y = H - PB - (g / 100) * plotH;
        return (
          <g key={g}>
            <line x1={P} y1={y} x2={W - P} y2={y} stroke="rgba(255,255,255,0.08)" />
            <text x={P - 4} y={y + 3} fontSize={8} fill="#8B9BB4" textAnchor="end">
              {g}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = (d.anomalies / maxAnom) * plotH * 0.5;
        return (
          <rect
            key={i}
            x={P + bw * i + 2}
            y={H - PB - h}
            width={Math.max(1, bw - 4)}
            height={h}
            fill="#9E5B61"
            rx={1}
          />
        );
      })}
      <polyline points={line} fill="none" stroke="#A78BFA" strokeWidth={2} />
      {data.map((d, i) => {
        const [x, y] = xy(i, d.avgScore);
        return <circle key={i} cx={x} cy={y} r={2.5} fill="#A78BFA" />;
      })}
      {/* X축 날짜 틱 */}
      {ticks.map((i) => {
        const [x] = xy(i, 0);
        return (
          <text
            key={`xt${i}`}
            x={x}
            y={H - PB + 14}
            fontSize={8}
            fill="#8B9BB4"
            textAnchor="middle"
          >
            {mmdd(data[i].date)}
          </text>
        );
      })}
      <text x={W - P} y={H - 4} fontSize={8} fill="#8B9BB4" textAnchor="end">
        X=날짜
      </text>
      {/* 범례 */}
      <line x1={P} y1={9} x2={P + 18} y2={9} stroke="#A78BFA" strokeWidth={2} />
      <circle cx={P + 9} cy={9} r={2.5} fill="#A78BFA" />
      <text x={P + 23} y={13} fontSize={9} fill="#A78BFA">선·점 = 종합점수(0~100)</text>
      <rect x={P + 175} y={4} width={10} height={10} rx={2} fill="#9E5B61" />
      <text x={P + 189} y={13} fontSize={9} fill="#cf8a91">막대 = 이상(건, 최대 {maxAnom})</text>
    </svg>
  );
}

// ── APM X-View (제니퍼 스타일 산점도 + 드래그 선택) ──
const APM_VB = { w: 900, h: 280, pl: 48, pr: 16, pt: 16, pb: 28 };
/** 시간 표기는 ms 단일 기준 — 큰 값은 천 단위 콤마 (1239202 → 1,239,202ms) */
const fmtMs = (v: number) => `${Math.round(v).toLocaleString()}ms`;

const APM_PERIODS: { d: number; l: string }[] = [
  { d: 1 / 24, l: '1시간' },
  { d: 6 / 24, l: '6시간' },
  { d: 1, l: '1일' },
  { d: 7, l: '7일' },
  { d: 30, l: '30일' },
];

function ApmXView({
  points,
  loading,
  days,
  onDays,
  onSelect,
}: {
  points: ExecLog[];
  loading: boolean;
  days: number;
  onDays: (d: number) => void;
  onSelect: (sel: ExecLog[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x0: number; y0: number } | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // 선택한 기간(days) 창에 고정 — 오른쪽=지금(now), 왼쪽=now-기간. (1시간/6시간도 그대로)
  const t1 = Date.now();
  const spanDays = days && days > 0 ? days : 1; // 0/음수 방어만, 클램프 없음
  const t0 = t1 - spanDays * 86400000;
  const inWindow = (iso: string) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= t0 && t <= t1;
  };
  // 지연(latencyMs)이 없어도 창 안의 실행은 표시(맨 아래) — 최근 실행이 조용히 사라지지 않게.
  const valid = points.filter((p) => inWindow(p.createdAt));
  const maxLat = Math.max(...valid.map((p) => p.latencyMs ?? 0), 1000);
  const plotW = APM_VB.w - APM_VB.pl - APM_VB.pr;
  const plotH = APM_VB.h - APM_VB.pt - APM_VB.pb;

  // 세로축은 로그 스케일 — 분 단위 이상치가 있어도 ms 단위 점들이 깔리지 않음
  const logMax = Math.log10(maxLat + 1);
  const yOfLat = (lat: number) =>
    APM_VB.pt + (1 - Math.log10(lat + 1) / logMax) * plotH;

  // 가로축 = 선택 기간(왼쪽=과거 … 오른쪽=지금). 우측 상단 기간 버튼과 동일 기준.
  // (이전: 하루 24시간 시각 기준이라 날짜가 무시돼 최근 실행이 왼쪽에 찍히는 문제)
  const xOfTime = (ms: number) => APM_VB.pl + ((ms - t0) / (t1 - t0)) * plotW;
  const xy = (p: ExecLog): [number, number] => {
    const x = xOfTime(new Date(p.createdAt).getTime());
    const y = yOfLat(p.latencyMs ?? 0);
    return [x, y];
  };

  const toVB = (clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const ctm = svg.getScreenCTM();
    if (!ctm) return [0, 0];
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return [p.x, p.y];
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const [x, y] = toVB(e.clientX, e.clientY);
    dragRef.current = { x0: x, y0: y };
    setRect({ x, y, w: 0, h: 0 });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const [x, y] = toVB(e.clientX, e.clientY);
    const { x0, y0 } = dragRef.current;
    setRect({ x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) });
  };
  const finishDrag = () => {
    const d = dragRef.current;
    const r = rect;
    dragRef.current = null;
    setRect(null);
    if (!d || !r) return;
    // 너무 작은 드래그(클릭 수준)는 무시
    if (r.w < 6 && r.h < 6) return;
    const x1 = r.x + r.w,
      y1 = r.y + r.h;
    const sel = valid.filter((p) => {
      const [px, py] = xy(p);
      return px >= r.x && px <= x1 && py >= r.y && py <= y1;
    });
    onSelect(sel);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg mb-6">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Crosshair size={14} className="text-accent" />
          <span className="text-xs font-semibold text-gray-900">🎯 Agent 수행 X-View (APM)</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <div className="flex items-center gap-0.5 mr-1">
            {APM_PERIODS.map((p) => (
              <button
                key={p.l}
                onClick={() => onDays(p.d)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition ${
                  days === p.d ? 'bg-accent text-white' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {p.l}
              </button>
            ))}
          </div>
          <Legend cls="bg-success" t="성공" />
          <Legend cls="bg-danger" t="실패" />
          <Legend cls="bg-warning" t="실행중" />
        </div>
      </div>
      <div className="px-4 pt-2 pb-4">
        <p className="text-[10px] text-muted-dark mb-1">
          세로축=호출 소요시간(ms, 로그 스케일) · 가로축=시간(왼쪽=과거 → 오른쪽=지금, 상단 기간과 별개) ·
          점=개별 수행 · 드래그로 영역 선택 → 상세 · <b>표시 {valid.length}건</b>
        </p>
        {loading ? (
          <Skeleton />
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${APM_VB.w} ${APM_VB.h}`}
            className="w-full select-none"
            style={{ cursor: 'crosshair', background: '#0b1220', maxHeight: 300 }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={finishDrag}
            onMouseLeave={finishDrag}
          >
            {/* Y 그리드(ms) */}
            {[0, 0.25, 0.5, 0.75, 1].map((g) => {
              const y = APM_VB.pt + (1 - g) * plotH;
              return (
                <g key={`y${g}`}>
                  <line
                    x1={APM_VB.pl}
                    y1={y}
                    x2={APM_VB.w - APM_VB.pr}
                    y2={y}
                    stroke="rgba(255,255,255,0.08)"
                  />
                  <text x={6} y={y + 3} fontSize={9} fill="#9aa4b2">
                    {g === 0 ? '0' : fmtMs(Math.pow(10, logMax * g) - 1)}
                  </text>
                </g>
              );
            })}
            {/* X 그리드(선택 기간: 왼쪽=과거 … 오른쪽=지금) */}
            {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
              const ms = t0 + f * (t1 - t0);
              const x = APM_VB.pl + f * plotW;
              const d = new Date(ms);
              const spanDays = (t1 - t0) / 86400000;
              const pad = (n: number) => String(n).padStart(2, '0');
              const label =
                spanDays > 1.5
                  ? `${d.getMonth() + 1}/${d.getDate()}`
                  : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
              return (
                <g key={`x${i}`}>
                  <line
                    x1={x}
                    y1={APM_VB.pt}
                    x2={x}
                    y2={APM_VB.h - APM_VB.pb}
                    stroke="rgba(255,255,255,0.05)"
                  />
                  <text
                    x={x}
                    y={APM_VB.h - 8}
                    fontSize={9}
                    fill="#9aa4b2"
                    textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}
                  >
                    {label}
                  </text>
                </g>
              );
            })}
            {/* 점 = 개별 수행 */}
            {valid.map((p) => {
              const [x, y] = xy(p);
              return (
                <circle
                  key={p.id}
                  cx={x.toFixed(1)}
                  cy={y.toFixed(1)}
                  r={3.4}
                  fill={STATUS_HEX(p.status)}
                  fillOpacity={0.9}
                />
              );
            })}
            {/* 드래그 선택 영역 */}
            {rect && (
              <rect
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                fill="#5B8AB0"
                fillOpacity={0.12}
                stroke="#5B8AB0"
                strokeDasharray="4 3"
              />
            )}
            {/* 빈 기간 — 프레임(X-View)은 유지하고 안내만 */}
            {valid.length === 0 && (
              <text
                x={APM_VB.pl + plotW / 2}
                y={APM_VB.pt + plotH / 2}
                textAnchor="middle"
                fontSize={12}
                fill="#7c8aa0"
              >
                이 기간에 수행이 없습니다 — 기간을 늘려 보세요.
              </text>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

// ── Modals ──
function AgentDetailModal({
  main,
  onClose,
  onOpenBuilder,
}: {
  main: MainAgent;
  onClose: () => void;
  onOpenBuilder: (k: string) => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white border border-gray-200 rounded-lg w-full max-w-3xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${HEALTH_COLOR[main.health]}`} />
            <h2 className="text-sm font-bold text-gray-900">{agentLabel(main)}</h2>
            <span className={`px-2 py-0.5 rounded text-[10px] border ${HEALTH_TEXT[main.health]}`}>
              {HEALTH_LABEL[main.health]}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onOpenBuilder(main.workflowKey)}
              className="flex items-center gap-1 px-2.5 py-1 bg-accent text-white rounded text-[11px] font-semibold hover:bg-accent-dark"
            >
              <ExternalLink size={11} /> 빌더에서 열기
            </button>
            <button onClick={onClose} className="text-muted-dark hover:text-gray-900">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-4 gap-3 mb-4">
            <MiniStat label="실행" v={`${main.executions}회`} />
            <MiniStat label="성공률" v={`${main.successRate}%`} />
            <MiniStat label="평균 점수" v={`${main.avgScore}`} />
            <MiniStat label="이상" v={`${main.anomalyCount}`} danger={main.anomalyCount > 0} />
          </div>
          {main.effectiveness && (
            <div className="mb-4 rounded border border-gray-200 bg-white p-3">
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs font-semibold text-gray-500">효과성</p>
                {main.effectiveness.system && (
                  <span className="text-[10px] text-muted-dark">· {main.effectiveness.system}</span>
                )}
                {main.effectiveness.valueLabel && (
                  <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent text-[10px]">
                    {main.effectiveness.valueLabel}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-4 gap-3">
                <MiniStat
                  label="수작업→AI"
                  v={`${
                    main.effectiveness.manualMinutesPerRun != null
                      ? `${main.effectiveness.manualMinutesPerRun}분`
                      : '—'
                  } → ${
                    main.effectiveness.aiMinutesPerRun != null
                      ? `${main.effectiveness.aiMinutesPerRun}분`
                      : '—'
                  }`}
                />
                <MiniStat
                  label="시간 절감률"
                  v={
                    main.effectiveness.timeSavedPct && main.effectiveness.timeSavedPct > 0
                      ? `${main.effectiveness.timeSavedPct.toFixed(1)}%`
                      : '—'
                  }
                />
                <MiniStat
                  label="절감 시간"
                  v={
                    Number.isFinite(main.effectiveness.timeSavedHours)
                      ? `${main.effectiveness.timeSavedHours}h`
                      : '—'
                  }
                />
                <MiniStat
                  label="순가치"
                  v={
                    main.effectiveness.roi && Number.isFinite(main.effectiveness.roi.netValueUsd)
                      ? `$${Math.round(main.effectiveness.roi.netValueUsd).toLocaleString()}`
                      : '—'
                  }
                />
              </div>
            </div>
          )}
          <p className="text-xs font-semibold text-gray-500 mb-2">
            Sub-Agent (노드별 현황 — 어느 구간이 문제인지)
          </p>
          <div className="overflow-x-auto border border-gray-200 rounded">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-muted-dark bg-white border-b border-gray-200">
                  <th className="text-left px-2 py-1.5">노드(sub)</th>
                  <th className="text-left px-2 py-1.5">유형</th>
                  <th className="text-left px-2 py-1.5">상태</th>
                  <th className="text-right px-2 py-1.5">점수</th>
                  <th className="text-right px-2 py-1.5">이상</th>
                  <th className="text-right px-2 py-1.5">비용</th>
                  <th className="text-right px-2 py-1.5">지연</th>
                  <th className="text-left px-2 py-1.5">보안위험</th>
                </tr>
              </thead>
              <tbody>
                {main.subAgents.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center text-muted-dark py-6">
                      sub-agent(노드) 데이터가 없습니다.
                    </td>
                  </tr>
                ) : (
                  main.subAgents.map((s) => (
                    <tr key={s.stepKey} className="border-b border-gray-200 last:border-0">
                      <td className="px-2 py-1.5 text-gray-900">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full flex-shrink-0 ${HEALTH_COLOR[s.health]}`}
                          />
                          <span className="truncate" title={s.agentName ?? s.stepKey}>
                            {s.agentName ?? s.stepKey}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-muted-dark">{s.nodeType ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${HEALTH_TEXT[s.health]}`}
                        >
                          {HEALTH_LABEL[s.health]}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold text-gray-500">
                        {s.avgScore}
                      </td>
                      <td
                        className={`px-2 py-1.5 text-right ${s.anomalyCount > 0 ? 'text-danger font-semibold' : 'text-gray-500'}`}
                      >
                        {s.anomalyCount}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-dark">
                        ${s.avgCostUsd.toFixed(4)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-dark">
                        {fmtMs(s.avgLatencyMs)}
                      </td>
                      <td className="px-2 py-1.5 text-muted-dark">{s.worstSecurityRisk ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 성과 상세 팝업 (실데이터: overview.effectiveness + eff.agents) ──
function PerfDetailModal({
  eff,
  effSummary,
  onClose,
  onAnalyze,
}: {
  eff: EffDetail | null;
  effSummary: EffectivenessSummary | undefined;
  onClose: () => void;
  onAnalyze: () => void;
}) {
  useEscClose(onClose);
  const agents = eff?.agents ?? [];
  const dash = (v: any) => (v == null || v === 0 ? '—' : v);
  return (
    <ModalShell title="📈 성과 상세" onClose={onClose} wide>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <MiniStat
          label="총 절감 시간"
          v={effSummary ? `${effSummary.totalTimeSavedHours.toLocaleString()}h` : '—'}
        />
        <MiniStat label="ROI" v={effSummary?.roiRatio != null ? `${effSummary.roiRatio}x` : '—'} />
        <MiniStat
          label="순가치"
          v={effSummary ? `$${effSummary.totalNetValueUsd.toLocaleString()}` : '—'}
        />
        <MiniStat
          label="평균 MTTR"
          v={eff?.summary?.avgMttrHours != null ? `${eff.summary.avgMttrHours}h` : '—'}
        />
      </div>
      <p className="text-xs font-semibold text-gray-500 mb-2">Main Agent별 성과 (실측)</p>
      <div className="overflow-x-auto border border-gray-200 rounded">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted-dark bg-white border-b border-gray-200">
              <th className="text-left px-2 py-1.5">에이전트</th>
              <th className="text-right px-2 py-1.5">시간 절감률</th>
              <th className="text-right px-2 py-1.5">절감 시간</th>
              <th className="text-right px-2 py-1.5">MTTD</th>
              <th className="text-right px-2 py-1.5">MTTR</th>
              <th className="text-right px-2 py-1.5">순가치</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-muted-dark py-6">
                  효과성 데이터가 없습니다.
                </td>
              </tr>
            ) : (
              agents.map((a) => (
                <tr key={a.workflowKey} className="border-b border-gray-200 last:border-0">
                  <td className="px-2 py-1.5 text-gray-900">
                    {agentLabel(a)}
                    {a.system && <div className="text-[10px] text-muted-dark">{a.system}</div>}
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-500">
                    {a.timeSavedPct ? `${a.timeSavedPct.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold text-gray-500">
                    {a.timeSavedHours ? `${a.timeSavedHours}h` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted-dark">
                    {a.mttd?.actualMinutes != null ? (
                      <span>
                        {a.mttd.actualMinutes}분
                        <span className="block text-[9px] text-muted-dark">
                          {a.mttd.source === 'signal'
                            ? '실측·signal'
                            : a.mttd.source === 'latency-proxy'
                              ? '실측·latency'
                              : a.mttd.targetPct != null
                                ? `목표 ${a.mttd.targetPct}%`
                                : ''}
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted-dark">
                    {a.mttr?.actualHours != null ? `${a.mttr.actualHours}h` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-500">
                    {a.roi?.netValueUsd != null
                      ? `$${Math.round(a.roi.netValueUsd).toLocaleString()}`
                      : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="text-right mt-4">
        <button
          onClick={onAnalyze}
          className="px-3 py-1.5 bg-accent text-white rounded text-[11px] font-semibold hover:bg-accent-dark"
        >
          분석 페이지에서 더보기 →
        </button>
      </div>
    </ModalShell>
  );
}

// ── 품질 상세 팝업 (실데이터: overview.quality + mainAgents) ──
function QualDetailModal({
  quality,
  mainAgents,
  onClose,
  onAnalyze,
}: {
  quality: Quality | undefined;
  mainAgents: MainAgent[];
  onClose: () => void;
  onAnalyze: () => void;
}) {
  useEscClose(onClose);
  const grades = ['A', 'B', 'C', 'D', 'F'];
  const gradeColor: Record<string, string> = {
    A: 'bg-[#6FAF9A]',
    B: 'bg-[#5B8AB0]',
    C: 'bg-[#C9A45C]',
    D: 'bg-[#C2865A]',
    F: 'bg-[#C77B7B]',
  };
  const sorted = [...mainAgents].sort((a, b) => b.avgScore - a.avgScore);
  const top3 = sorted.slice(0, 3);
  const low3 = [...sorted].reverse().slice(0, 3);
  const maxGrade = Math.max(...grades.map((g) => quality?.gradeDistribution?.[g] ?? 0), 1);
  return (
    <ModalShell title="🎯 품질 상세" onClose={onClose} wide>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <MiniStat label="평균 종합점수" v={quality ? `${quality.avgOverallScore}` : '—'} />
        <MiniStat label="평균 정확도" v={quality ? `${quality.avgAccuracy}%` : '—'} />
        <MiniStat
          label="환각률"
          v={quality ? `${quality.avgHallucinationRate}%` : '—'}
          danger={!!quality && quality.avgHallucinationRate > 0}
        />
        <MiniStat
          label="평가 건수"
          v={quality ? `${quality.evaluatedCount.toLocaleString()}` : '—'}
        />
      </div>
      <p className="text-xs font-semibold text-gray-500 mb-2">등급 분포 (A~F)</p>
      <div className="flex items-end gap-3 mb-4 px-1">
        {grades.map((g) => {
          const n = quality?.gradeDistribution?.[g] ?? 0;
          return (
            <div key={g} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[10px] text-muted-dark">{n}</span>
              <div className="w-full h-20 bg-gray-100 rounded flex items-end overflow-hidden">
                <div
                  className={`w-full ${gradeColor[g]} rounded-t`}
                  style={{ height: `${(n / maxGrade) * 100}%` }}
                />
              </div>
              <span className="text-[10px] font-semibold text-gray-500">{g}</span>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-2">🏆 품질 TOP 3</p>
          <table className="w-full text-xs border border-gray-200 rounded overflow-hidden">
            <tbody>
              {top3.length === 0 ? (
                <tr>
                  <td className="text-center text-muted-dark py-4">데이터 없음</td>
                </tr>
              ) : (
                top3.map((a, i) => (
                  <tr key={a.workflowKey} className="border-b border-gray-200 last:border-0">
                    <td className="px-2 py-1.5 text-muted-dark w-6">{i + 1}</td>
                    <td className="px-2 py-1.5 text-gray-900 truncate" title={agentLabel(a)}>
                      {agentLabel(a)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold text-success">
                      {a.avgScore}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-2">⚠ 품질 미달 3</p>
          <table className="w-full text-xs border border-gray-200 rounded overflow-hidden">
            <tbody>
              {low3.length === 0 ? (
                <tr>
                  <td className="text-center text-muted-dark py-4">데이터 없음</td>
                </tr>
              ) : (
                low3.map((a, i) => (
                  <tr key={a.workflowKey} className="border-b border-gray-200 last:border-0">
                    <td className="px-2 py-1.5 text-muted-dark w-6">{i + 1}</td>
                    <td className="px-2 py-1.5 text-gray-900 truncate" title={agentLabel(a)}>
                      {agentLabel(a)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold text-danger">
                      {a.avgScore}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="text-right mt-4">
        <button
          onClick={onAnalyze}
          className="px-3 py-1.5 bg-accent text-white rounded text-[11px] font-semibold hover:bg-accent-dark"
        >
          분석 페이지에서 더보기 →
        </button>
      </div>
    </ModalShell>
  );
}

// ── APM 선택 상세 팝업 ──
function ApmSelectionModal({
  points,
  nameOf,
  onClose,
}: {
  points: ExecLog[];
  nameOf: (k?: string | null) => string;
  onClose: () => void;
}) {
  useEscClose(onClose);
  const sorted = [...points].sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0)).slice(0, 40);
  const failCount = points.filter((p) => p.status === 'FAILED').length;
  const avgLat = points.length
    ? Math.round(points.reduce((s, p) => s + (p.latencyMs ?? 0), 0) / points.length)
    : 0;
  // 주요 Agent (선택 내 최다)
  const counts: Record<string, number> = {};
  points.forEach((p) => {
    const k = p.workflowKey ?? '—';
    counts[k] = (counts[k] ?? 0) + 1;
  });
  const topAgentKey = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];

  return (
    <ModalShell title={`선택된 Agent 수행 — ${points.length}건`} onClose={onClose} wide>
      {points.length === 0 ? (
        <p className="text-xs text-muted-dark py-6 text-center">
          선택 영역에 수행 점이 없습니다. 점들이 있는 영역을 드래그하세요.
        </p>
      ) : (
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MiniStat label="선택 건수" v={`${points.length}건`} />
            <MiniStat label="평균 소요" v={fmtMs(avgLat)} />
            <MiniStat label="실패 수" v={`${failCount}`} danger={failCount > 0} />
            <MiniStat label="주요 Agent" v={topAgentKey ? nameOf(topAgentKey) : '—'} />
          </div>
          <div className="overflow-x-auto border border-gray-200 rounded">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-muted-dark bg-white border-b border-gray-200">
                  <th className="text-left px-2 py-1.5">시각</th>
                  <th className="text-left px-2 py-1.5">Agent</th>
                  <th className="text-left px-2 py-1.5">상태</th>
                  <th className="text-right px-2 py-1.5">소요</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id} className="border-b border-gray-200 last:border-0">
                    <td className="px-2 py-1.5 text-muted-dark">
                      {new Date(p.createdAt).toLocaleString('ko-KR')}
                    </td>
                    <td
                      className="px-2 py-1.5 text-gray-900 truncate max-w-[160px]"
                      title={p.workflowKey ?? ''}
                    >
                      {nameOf(p.workflowKey)}
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] text-gray-900"
                        style={{ background: STATUS_HEX(p.status) }}
                      >
                        {STATUS_LABEL(p.status)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-gray-500 font-semibold">
                      {p.latencyMs != null ? fmtMs(p.latencyMs) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ── 시스템별 사용 Agent 팝업 (어떤 시스템을 어떤 Agent가 쓰는가) ──
function SystemUsageModal({ eff, onClose }: { eff: EffDetail | null; onClose: () => void }) {
  useEscClose(onClose);
  const agents = eff?.agents ?? [];
  // bySystem이 있으면 사용, 없으면 agents의 distinct system으로 구성
  const systems =
    eff?.bySystem && eff.bySystem.length > 0
      ? eff.bySystem.map((b) => ({
          system: b.system,
          agentCount: b.agentCount,
          executions: b.executions,
        }))
      : [...new Set(agents.map((a) => a.system ?? '미지정'))].map((sys) => {
          const list = agents.filter((a) => (a.system ?? '미지정') === sys);
          return { system: sys, agentCount: list.length, executions: 0 };
        });
  return (
    <ModalShell title="🧩 시스템별 사용 Agent" onClose={onClose} wide>
      {systems.length === 0 ? (
        <p className="text-xs text-muted-dark py-6 text-center">
          시스템/Agent 데이터가 아직 없습니다.
        </p>
      ) : (
        <>
          {/* 시스템별 Agent 분포 도넛 */}
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4 p-3 bg-gray-50 border border-gray-100 rounded-lg">
            <DonutChart
              size={104}
              centerValue={String(agents.length)}
              centerLabel="Agents"
              segments={systems.slice(0, 6).map((sys, i) => ({
                value: sys.agentCount,
                label: sys.system,
                color: ['#4F6BD8', '#6FAF9A', '#C9A45C', '#C77B7B', '#8B7BD8', '#5BA8C4'][i % 6],
              }))}
            />
            <div className="text-[10px] text-muted-dark max-w-[220px]">
              시스템마다 어떤 Agent가 붙어 일하고 있는지, 절감 기여는 어느 정도인지 보여줍니다.
            </div>
          </div>
          <div className="space-y-4">
            {(() => {
              const maxSaved = Math.max(...agents.map((a) => a.timeSavedHours ?? 0), 1);
              return systems.map((sys) => {
                const list = agents.filter((a) => (a.system ?? '미지정') === sys.system);
                return (
                  <div key={sys.system} className="rounded border border-gray-200 bg-white p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-gray-900">{sys.system}</span>
                      <span className="text-[10px] text-muted-dark">
                        Agent {sys.agentCount}개{sys.executions ? ` · ${sys.executions}회` : ''}
                      </span>
                    </div>
                    {list.length === 0 ? (
                      <p className="text-[10px] text-muted-dark">연결된 Agent 없음</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {list.map((a) => (
                          <li
                            key={a.workflowKey}
                            className="flex items-center gap-2 text-[11px] text-gray-500"
                          >
                            <span
                              className="w-[45%] text-gray-900 truncate shrink-0"
                              title={agentLabel(a)}
                            >
                              {agentLabel(a)}
                            </span>
                            <div className="flex-1">
                              <InlineBar
                                pct={((a.timeSavedHours ?? 0) / maxSaved) * 100}
                                color="#6FAF9A"
                              />
                            </div>
                            <span className="text-muted-dark flex-shrink-0 w-16 text-right">
                              {a.timeSavedHours != null
                                ? `${(a.timeSavedHours / mmHours()).toFixed(1)} MM`
                                : '—'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </>
      )}
    </ModalShell>
  );
}

// ── Agent별 절감 효과 팝업 (총 절감 공수 클릭) ──
function SavingsModal({ eff, onClose }: { eff: EffDetail | null; onClose: () => void }) {
  useEscClose(onClose);
  const agents = [...(eff?.agents ?? [])].sort(
    (a, b) => (b.timeSavedHours ?? 0) - (a.timeSavedHours ?? 0),
  );
  const totalMM = agents.reduce((s, a) => s + (a.timeSavedHours ?? 0), 0) / mmHours();
  const totalNet = agents.reduce((s, a) => s + (a.roi?.netValueUsd ?? 0), 0);
  const maxHours = Math.max(...agents.map((a) => a.timeSavedHours ?? 0), 1);
  const top = agents[0];
  return (
    <ModalShell title="🕒 Agent별 절감 효과 — 누가 얼마나 아껴줬나" onClose={onClose} wide>
      {/* 요약 칩 */}
      <div className="flex flex-wrap gap-2 mb-4">
        <StatChip label="총 절감 공수" value={`${totalMM.toFixed(1)} MM`} sub={`Agent ${agents.length}개 합산`} tone="green" />
        <StatChip label="총 순가치" value={`$${Math.round(totalNet).toLocaleString()}`} tone="navy" />
        <StatChip
          label="최고 기여"
          value={top ? `${((top.timeSavedHours ?? 0) / mmHours()).toFixed(1)} MM` : '—'}
          sub={top ? agentLabel(top) : undefined}
          tone="amber"
        />
      </div>
      <div className="overflow-x-auto border border-gray-200 rounded">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted-dark bg-white border-b border-gray-200">
              <th className="text-left px-2 py-1.5">에이전트</th>
              <th className="text-left px-2 py-1.5">시스템</th>
              <th className="text-left px-2 py-1.5 w-[28%]">절감 공수 (상대 비교)</th>
              <th className="text-right px-2 py-1.5">절감률</th>
              <th className="text-right px-2 py-1.5">순가치</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-muted-dark py-6">
                  효과성 데이터가 없습니다.
                </td>
              </tr>
            ) : (
              agents.map((a) => (
                <tr key={a.workflowKey} className="border-b border-gray-200 last:border-0">
                  <td className="px-2 py-1.5 text-gray-900 truncate max-w-[180px]" title={agentLabel(a)}>
                    {agentLabel(a)}
                  </td>
                  <td className="px-2 py-1.5 text-muted-dark">{a.system ?? '미지정'}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-14 text-right font-semibold text-gray-700 shrink-0">
                        {a.timeSavedHours != null
                          ? `${(a.timeSavedHours / mmHours()).toFixed(1)} MM`
                          : '—'}
                      </span>
                      <div className="flex-1">
                        <InlineBar pct={((a.timeSavedHours ?? 0) / maxHours) * 100} color="#6FAF9A" />
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right text-success font-semibold">
                    {a.timeSavedPct ? `${a.timeSavedPct.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-500">
                    {a.roi?.netValueUsd != null
                      ? `$${Math.round(a.roi.netValueUsd).toLocaleString()}`
                      : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ModalShell>
  );
}

// ── Agent별 품질 증감 팝업 (품질 평균 증감 클릭) ──
function QualityDeltaModal({
  mainAgents,
  onClose,
}: {
  mainAgents: MainAgent[];
  onClose: () => void;
}) {
  useEscClose(onClose);
  const sorted = [...mainAgents].sort(
    (a, b) => (b.trend?.quality?.deltaPct ?? -Infinity) - (a.trend?.quality?.deltaPct ?? -Infinity),
  );
  return (
    <ModalShell title="📊 Agent별 품질 증감" onClose={onClose} wide>
      {/* 요약 칩 — 상승/하락/유지 분포 */}
      {(() => {
        const ups = sorted.filter((m) => m.trend?.quality?.direction === 'up').length;
        const downs = sorted.filter((m) => m.trend?.quality?.direction === 'down').length;
        const flats = sorted.length - ups - downs;
        return (
          <div className="flex flex-wrap gap-2 mb-4">
            <StatChip label="품질 상승" value={`▲ ${ups}개`} tone="green" />
            <StatChip label="품질 하락" value={`▼ ${downs}개`} tone="red" />
            <StatChip label="유지·미측정" value={`${flats}개`} tone="gray" />
          </div>
        );
      })()}
      <div className="overflow-x-auto border border-gray-200 rounded">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted-dark bg-white border-b border-gray-200">
              <th className="text-left px-2 py-1.5">에이전트</th>
              <th className="text-right px-2 py-1.5">종합점수</th>
              <th className="text-center px-2 py-1.5 w-[34%]">증감 (◀ 하락 · 상승 ▶)</th>
              <th className="text-right px-2 py-1.5">증감률</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center text-muted-dark py-6">
                  데이터가 없습니다.
                </td>
              </tr>
            ) : (
              (() => {
                const maxAbs = Math.max(
                  ...sorted.map((m) => Math.abs(m.trend?.quality?.deltaPct ?? 0)),
                  0.1,
                );
                return sorted.map((m) => {
                  const t = m.trend?.quality;
                  const dir = t?.direction;
                  const dp = t?.deltaPct;
                  return (
                    <tr key={m.workflowKey} className="border-b border-gray-200 last:border-0">
                      <td className="px-2 py-1.5 text-gray-900 truncate max-w-[180px]" title={agentLabel(m)}>
                        {agentLabel(m)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold text-gray-700">
                        {m.avgScore}
                      </td>
                      <td className="px-2 py-1.5">
                        <DivergeBar pct={dir === 'flat' ? 0 : (dp ?? null)} max={maxAbs} />
                      </td>
                      <td
                        className="px-2 py-1.5 text-right font-semibold"
                        style={{
                          color:
                            !t || dir === 'flat' || dp == null
                              ? '#8B9BB4'
                              : dir === 'up'
                                ? '#6FAF9A'
                                : '#C77B7B',
                        }}
                      >
                        {!t || dp == null
                          ? '—'
                          : `${dir === 'up' ? '▲ ' : dir === 'down' ? '▼ ' : ''}${Math.abs(dp).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                });
              })()
            )}
          </tbody>
        </table>
      </div>
    </ModalShell>
  );
}

// ── Agent 사용 상세 팝업 (활용/미활용 행 클릭) ──
function AgentUsageModal({
  detail,
  onClose,
}: {
  detail: {
    label: string;
    system: string;
    executions: number;
    successRate: number;
    avgScore: number;
    timeSavedHours: number | null;
  };
  onClose: () => void;
}) {
  useEscClose(onClose);
  return (
    <ModalShell title={`📌 Agent 사용 상세 — ${detail.label}`} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-4">
        {/* 성공률 도넛 */}
        <DonutChart
          size={110}
          centerValue={`${detail.successRate}%`}
          centerLabel="성공률"
          segments={[
            { value: detail.successRate, label: '성공', color: detail.successRate >= 90 ? '#6FAF9A' : detail.successRate >= 70 ? '#C9A45C' : '#C77B7B' },
            { value: Math.max(0, 100 - detail.successRate), label: '실패·기타', color: '#EDEFF4' },
          ]}
        />
        <div className="flex-1 min-w-[240px] space-y-2.5">
          <div className="flex flex-wrap gap-2">
            <StatChip label="어디에서 (시스템)" value={detail.system} tone="navy" />
            <StatChip label="얼마나 (수행)" value={`${detail.executions.toLocaleString()}회`} tone="navy" />
            <StatChip
              label="절감 공수"
              value={
                detail.timeSavedHours != null
                  ? `${(detail.timeSavedHours / mmHours()).toFixed(1)} MM`
                  : '—'
              }
              tone="green"
            />
          </div>
          {/* 종합점수 게이지 */}
          <div>
            <div className="flex items-center justify-between text-[10px] text-muted-dark mb-1">
              <span>종합 점수</span>
              <b className="text-gray-900 text-xs">{detail.avgScore} / 100</b>
            </div>
            <InlineBar
              pct={detail.avgScore}
              color={detail.avgScore >= 85 ? '#6FAF9A' : detail.avgScore >= 70 ? '#C9A45C' : '#C77B7B'}
            />
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ── 모달 공용 비주얼 컴포넌트 (상세 팝업 가독성 강화) ──────────────

/** 모달 상단 요약 스탯 칩 */
function StatChip({
  label,
  value,
  sub,
  tone = 'navy',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'navy' | 'green' | 'red' | 'gray' | 'amber';
}) {
  const tones: Record<string, string> = {
    navy: 'text-accent',
    green: 'text-success',
    red: 'text-danger',
    amber: 'text-warning',
    gray: 'text-gray-500',
  };
  return (
    <div className="flex-1 min-w-[110px] bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
      <p className="text-[9px] text-muted-dark">{label}</p>
      <p className={`text-lg font-bold leading-tight ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-[9px] text-muted-dark truncate">{sub}</p>}
    </div>
  );
}

/** 테이블 셀 내 수평 게이지 바 (값/최댓값) */
function InlineBar({ pct, color = '#4F6BD8' }: { pct: number; color?: string }) {
  return (
    <div className="h-1.5 w-full bg-gray-100 rounded overflow-hidden">
      <div
        className="h-full rounded"
        style={{ width: `${Math.max(2, Math.min(100, pct))}%`, backgroundColor: color }}
      />
    </div>
  );
}

/** 0 기준 좌(하락)·우(상승) 다이버징 바 */
function DivergeBar({ pct, max }: { pct: number | null; max: number }) {
  if (pct == null) return <div className="h-1.5 w-full" />;
  const half = Math.min(100, (Math.abs(pct) / Math.max(max, 0.001)) * 100) / 2;
  const up = pct >= 0;
  return (
    <div className="relative h-1.5 w-full bg-gray-100 rounded overflow-hidden">
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-300" />
      <div
        className="absolute top-0 bottom-0 rounded"
        style={{
          left: up ? '50%' : `${50 - half}%`,
          width: `${Math.max(1.5, half)}%`,
          backgroundColor: up ? '#6FAF9A' : '#C77B7B',
        }}
      />
    </div>
  );
}

/** SVG 도넛 차트 — segments: [{value, color, label}] */
function DonutChart({
  segments,
  size = 96,
  centerValue,
  centerLabel,
}: {
  segments: Array<{ value: number; color: string; label: string }>;
  size?: number;
  centerValue: string;
  centerLabel?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#F1F3F7" strokeWidth={12} />
        {segments
          .filter((s) => s.value > 0)
          .map((s, i) => {
            const frac = s.value / total;
            const dash = `${frac * c} ${c}`;
            const offset = -acc * c;
            acc += frac;
            return (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={12}
                strokeDasharray={dash}
                strokeDashoffset={offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                strokeLinecap="butt"
              />
            );
          })}
        <text
          x="50%"
          y={centerLabel ? '46%' : '52%'}
          textAnchor="middle"
          className="fill-gray-900"
          fontSize={size / 6}
          fontWeight={700}
        >
          {centerValue}
        </text>
        {centerLabel && (
          <text x="50%" y="62%" textAnchor="middle" className="fill-gray-400" fontSize={size / 11}>
            {centerLabel}
          </text>
        )}
      </svg>
      <div className="space-y-1">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[10px] text-gray-600">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
            {s.label} <b className="text-gray-900">{s.value.toLocaleString()}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 실행 상태 컬러 뱃지 */
function StatusBadge2({ status }: { status: string }) {
  const map: Record<string, string> = {
    SUCCEEDED: 'bg-success/15 text-success',
    FAILED: 'bg-danger/15 text-danger',
    RUNNING: 'bg-accent/15 text-accent',
    QUEUED: 'bg-gray-100 text-gray-500',
    CANCELLED: 'bg-gray-100 text-gray-400',
  };
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${map[status] ?? 'bg-gray-100 text-gray-500'}`}
    >
      {status}
    </span>
  );
}

// ── Modal shell + ESC hook ──
function useEscClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}
function ModalShell({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className={`bg-white border border-gray-200 rounded-lg w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} max-h-[85vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <h2 className="text-sm font-bold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-muted-dark hover:text-gray-900">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ── Small UI helpers ──
function SummaryStat({
  icon,
  label,
  value,
  sub,
  highlight,
  accent,
  valueClass,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  accent?: 'indigo';
  valueClass?: string;
  onClick?: () => void;
}) {
  const base = highlight
    ? 'bg-danger/10 border-danger/30'
    : accent === 'indigo'
      ? 'bg-accent/10 border-accent/30 hover:border-accent/50'
      : 'bg-white border-gray-200 hover:border-accent/40';
  return (
    <button
      onClick={onClick}
      className={`min-w-0 text-left rounded-lg border px-2.5 py-2 transition hover:shadow-sm ${base}`}
    >
      <div className="flex items-center gap-1 mb-0.5 min-w-0">
        <span className="shrink-0">{icon}</span>
        <span className="text-[10px] text-muted-dark truncate" title={label}>
          {label}
        </span>
      </div>
      <p className={`text-base font-bold leading-tight ${valueClass ?? 'text-gray-900'}`}>{value}</p>
      {sub && (
        <p className="text-[9px] text-muted-dark mt-0.5 truncate" title={sub}>
          {sub}
        </p>
      )}
    </button>
  );
}

function ChartCard({
  title,
  icon,
  onDetail,
  onAnalyze,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  onDetail?: () => void;
  onAnalyze?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs font-semibold text-gray-900">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {onDetail && (
            <button
              onClick={onDetail}
              className="text-[11px] text-accent hover:underline flex items-center gap-0.5"
            >
              상세 <ChevronRight size={12} />
            </button>
          )}
          {onAnalyze && (
            <button
              onClick={onAnalyze}
              className="text-[11px] text-muted-dark hover:text-gray-900 hover:underline flex items-center gap-0.5"
            >
              분석 페이지 →
            </button>
          )}
        </div>
      </div>
      <div className="bg-[#05080f] rounded-b-lg p-4">{children}</div>
    </div>
  );
}

function UtilCard({
  title,
  subtitle,
  icon,
  loading,
  entries,
  emptyText,
  highlightZero,
  onRowClick,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  loading: boolean;
  entries: UtilizationEntry[];
  emptyText: string;
  highlightZero?: boolean;
  onRowClick?: (e: UtilizationEntry) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs font-semibold text-gray-900">{title}</span>
        </div>
        <span className="text-[10px] text-muted-dark">{subtitle}</span>
      </div>
      <div className="p-3">
        {loading ? (
          <Skeleton />
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-dark text-center py-6">{emptyText}</p>
        ) : (
          <ol className="space-y-1.5">
            {entries.map((e, i) => {
              const unused = highlightZero && e.executions === 0;
              return (
                <li key={e.workflowKey}>
                  <button
                    type="button"
                    onClick={() => onRowClick?.(e)}
                    className={`w-full text-left flex items-center gap-2 rounded px-2 py-1.5 transition ${
                      unused ? 'bg-warning/10 hover:bg-warning/20' : 'hover:bg-gray-50'
                    }`}
                  >
                    <span
                      className={`w-5 h-5 flex items-center justify-center text-[10px] font-bold rounded-full flex-shrink-0 ${
                        i === 0
                          ? 'bg-accent text-white'
                          : i === 1
                            ? 'bg-accent/20 text-accent'
                            : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span
                      className="flex-1 text-xs text-gray-900 truncate"
                      title={`${agentLabel(e)} (${e.workflowKey})`}
                    >
                      {agentLabel(e)}
                    </span>
                    {e.executions > 0 && (
                      <span className="text-[10px] text-muted-dark flex-shrink-0">
                        성공 {e.successRate}% · 점수 {e.avgScore}
                      </span>
                    )}
                    <span
                      className={`w-14 text-right text-xs font-bold flex-shrink-0 ${
                        unused ? 'text-warning' : 'text-gray-500'
                      }`}
                    >
                      {unused ? '미사용' : `${e.executions.toLocaleString()}회`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, v, danger }: { label: string; v: string; danger?: boolean }) {
  return (
    <div className="bg-white rounded p-2 text-center">
      <p className="text-[10px] text-muted-dark">{label}</p>
      <p className={`text-sm font-bold ${danger ? 'text-danger' : 'text-gray-900'}`}>{v}</p>
    </div>
  );
}

function Legend({ cls, t }: { cls: string; t: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`w-2 h-2 rounded-full ${cls}`} />
      {t}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-4 bg-gray-100 rounded animate-pulse" />
      ))}
    </div>
  );
}

function Empty() {
  return <p className="text-xs text-muted-dark text-center py-8">표시할 데이터가 없습니다.</p>;
}

// ── History modal ──
type KpiKind = 'total' | 'success' | 'latency' | 'cost' | 'anomaly';

function HistoryModal({
  kind,
  title,
  days,
  onClose,
}: {
  kind: KpiKind;
  title: string;
  days: number;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<ExecLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // 이상 감지는 실패 중심, 그 외는 전체를 받아 지표별로 분석.
        const sf = kind === 'anomaly' ? '?status=FAILED&pageSize=100' : '?pageSize=100';
        const res = await api.get<{ items: ExecLog[] }>(`/executions${sf}&days=${days}`);
        setLogs(Array.isArray(res?.items) ? res.items : []);
      } catch {
        setLogs([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [kind, days]);

  // ── 지표 집계 (표시된 실행 기준) ──
  const ok = logs.filter((l) => l.status === 'SUCCEEDED').length;
  const fail = logs.filter((l) => l.status === 'FAILED').length;
  const etc = logs.length - ok - fail;
  const successRate = logs.length ? Math.round((ok / logs.length) * 100) : 0;
  const lats = logs
    .map((l) => l.latencyMs ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const avgLat = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
  const pctl = (p: number) =>
    lats.length ? lats[Math.min(lats.length - 1, Math.floor((p / 100) * lats.length))] : 0;
  const p50 = pctl(50);
  const p95 = pctl(95);
  const maxLat = lats.length ? lats[lats.length - 1] : 0;
  const totalCost = logs.reduce((s, l) => s + (Number(l.costUsd) || 0), 0);
  const avgCost = logs.length ? totalCost / logs.length : 0;

  // 에이전트(workflowKey)별 집계
  const byAgent: Record<string, { n: number; cost: number; lat: number; latN: number; fail: number }> = {};
  for (const l of logs) {
    const k = l.workflowKey || '—';
    const a = (byAgent[k] ||= { n: 0, cost: 0, lat: 0, latN: 0, fail: 0 });
    a.n++;
    a.cost += Number(l.costUsd) || 0;
    if (l.latencyMs) {
      a.lat += l.latencyMs;
      a.latN++;
    }
    if (l.status === 'FAILED') a.fail++;
  }
  const agents = Object.entries(byAgent).map(([k, v]) => ({
    k,
    ...v,
    avgLat: v.latN ? Math.round(v.lat / v.latN) : 0,
  }));
  type AgentRow = (typeof agents)[number];

  // 표는 지표에 맞는 순서로 정렬
  const sortedLogs = [...logs].sort((a, b) => {
    if (kind === 'latency') return (b.latencyMs ?? 0) - (a.latencyMs ?? 0);
    if (kind === 'cost') return (Number(b.costUsd) || 0) - (Number(a.costUsd) || 0);
    if (kind === 'success' || kind === 'anomaly') {
      const af = a.status === 'FAILED' ? 0 : 1;
      const bf = b.status === 'FAILED' ? 0 : 1;
      if (af !== bf) return af - bf; // 실패 먼저
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const logsPage = usePagination(sortedLogs, 10);

  // 상위 막대(지표별)
  const valOf = (a: AgentRow) =>
    kind === 'cost' ? a.cost : kind === 'latency' ? a.avgLat : kind === 'success' ? a.fail : a.n;
  const topAgents = [...agents]
    .filter((a) => (kind === 'success' ? a.fail > 0 : true))
    .sort((x, y) => valOf(y) - valOf(x))
    .slice(0, 6);
  const barMax = Math.max(1, ...topAgents.map(valOf));
  const barLabel = (a: AgentRow) =>
    kind === 'cost'
      ? `$${a.cost.toFixed(3)}`
      : kind === 'latency'
        ? fmtMs(a.avgLat)
        : kind === 'success'
          ? `${a.fail} 실패`
          : `${a.n}회`;
  const barTitle =
    kind === 'cost'
      ? '에이전트별 비용 TOP'
      : kind === 'latency'
        ? '에이전트별 평균 지연 TOP'
        : kind === 'success'
          ? '실패가 많은 에이전트'
          : '에이전트별 수행 TOP';
  const showBars = kind !== 'anomaly' && topAgents.length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white border border-gray-200 rounded-lg w-full max-w-3xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <h2 className="text-sm font-bold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-muted-dark hover:text-gray-900">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">
          {loading ? (
            <Skeleton />
          ) : logs.length === 0 ? (
            <p className="text-xs text-muted-dark text-center py-8">실행 이력이 없습니다.</p>
          ) : (
            <>
              {/* 지표별 핵심 요약 — 도넛(분포형) + 지표 칩 */}
              <div className="flex flex-wrap items-center gap-3 mb-4 p-3 bg-gray-50 border border-gray-100 rounded-lg">
                {(kind === 'total' || kind === 'success' || kind === 'anomaly') && (
                  <DonutChart
                    size={96}
                    centerValue={kind === 'success' ? `${successRate}%` : String(logs.length)}
                    centerLabel={kind === 'success' ? '성공률' : 'runs'}
                    segments={[
                      { value: ok, label: '성공', color: '#6FAF9A' },
                      { value: fail, label: '실패', color: '#C77B7B' },
                      { value: etc, label: '기타', color: '#C9CFDB' },
                    ]}
                  />
                )}
                <div className="flex flex-wrap gap-2 flex-1 min-w-[240px]">
                  {kind === 'total' && (
                    <>
                      <StatChip label="총 수행" value={`${logs.length.toLocaleString()}건`} tone="navy" />
                      <StatChip label="성공률" value={`${successRate}%`} tone={fail > 0 ? 'amber' : 'green'} />
                      <StatChip label="평균 지연" value={fmtMs(avgLat)} tone="gray" />
                      <StatChip label="합계 비용" value={`$${totalCost.toFixed(3)}`} tone="gray" />
                    </>
                  )}
                  {kind === 'success' && (
                    <>
                      <StatChip label="성공" value={`${ok}건`} tone="green" />
                      <StatChip label="실패" value={`${fail}건`} tone={fail > 0 ? 'red' : 'gray'} />
                      <StatChip label="기타" value={`${etc}건`} tone="gray" />
                      <StatChip label="성공률" value={`${successRate}%`} tone={fail > 0 ? 'amber' : 'green'} />
                    </>
                  )}
                  {kind === 'latency' && (
                    <>
                      <StatChip label="평균" value={fmtMs(avgLat)} tone="navy" />
                      <StatChip label="중앙값(p50)" value={fmtMs(p50)} tone="gray" />
                      <StatChip label="p95" value={fmtMs(p95)} tone="amber" />
                      <StatChip label="최대" value={fmtMs(maxLat)} tone="red" />
                    </>
                  )}
                  {kind === 'cost' && (
                    <>
                      <StatChip label="합계 비용" value={`$${totalCost.toFixed(3)}`} tone="navy" />
                      <StatChip label="건당 평균" value={`$${avgCost.toFixed(4)}`} tone="gray" />
                      <StatChip label="수행" value={`${logs.length}건`} tone="gray" />
                    </>
                  )}
                  {kind === 'anomaly' && (
                    <>
                      <StatChip label="실패·이상" value={`${fail}건`} tone={fail > 0 ? 'red' : 'green'} />
                      <StatChip
                        label="전체 대비"
                        value={`${logs.length ? Math.round((fail / logs.length) * 100) : 0}%`}
                        tone="amber"
                      />
                      <StatChip label="평균 지연" value={fmtMs(avgLat)} tone="gray" />
                    </>
                  )}
                </div>
              </div>

              {/* 에이전트별 막대 — 지표에 맞는 상위 분포 */}
              {showBars && (
                <div className="mb-4">
                  <p className="text-[11px] font-semibold text-gray-700 mb-1.5">{barTitle}</p>
                  <div className="space-y-1.5">
                    {topAgents.map((a) => (
                      <div key={a.k} className="flex items-center gap-2 text-[11px]">
                        <span className="w-40 truncate text-gray-700" title={a.k}>
                          {a.k}
                        </span>
                        <div className="flex-1 h-2 bg-gray-100 rounded">
                          <div
                            className="h-2 rounded bg-accent"
                            style={{ width: `${Math.max(3, Math.round((valOf(a) / barMax) * 100))}%` }}
                          />
                        </div>
                        <span className="w-24 text-right text-gray-600">{barLabel(a)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[11px] font-semibold text-gray-700 mb-1.5">
                {kind === 'latency'
                  ? '느린 실행 순'
                  : kind === 'cost'
                    ? '고비용 실행 순'
                    : kind === 'success' || kind === 'anomaly'
                      ? '실패 우선 · 최근 순'
                      : '최근 실행 순'}
              </p>
              <div className="overflow-x-auto border border-gray-200 rounded">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-muted-dark bg-white border-b border-gray-200">
                    <th className="text-left px-2 py-1.5">실행 ID</th>
                    <th className="text-left px-2 py-1.5">워크플로우</th>
                    <th className="text-left px-2 py-1.5">상태</th>
                    <th className="text-right px-2 py-1.5">비용</th>
                    <th className="text-right px-2 py-1.5">지연</th>
                    <th className="text-right px-2 py-1.5">시각</th>
                  </tr>
                </thead>
                <tbody>
                  {logsPage.pageItems.map((l) => (
                    <tr key={l.id} className="border-b border-gray-200 last:border-0">
                      <td
                        className="px-2 py-1.5 text-muted-dark font-mono truncate max-w-[120px]"
                        title={l.id}
                      >
                        {l.id}
                      </td>
                      <td
                        className="px-2 py-1.5 text-gray-900 truncate max-w-[140px]"
                        title={l.workflowKey ?? ''}
                      >
                        {l.workflowKey ?? '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <StatusBadge2 status={l.status} />
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-dark">
                        {l.costUsd != null ? `$${Number(l.costUsd).toFixed(4)}` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-dark">
                        {l.latencyMs != null ? `${l.latencyMs}ms` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-dark">
                        {new Date(l.createdAt).toLocaleString('ko-KR')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <Pager p={logsPage} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
