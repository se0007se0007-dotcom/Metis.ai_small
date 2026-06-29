'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { SummaryStatCard } from '@/components/shared/SummaryStatCard';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import { krw } from '@/lib/opsRef';
import {
  Shield,
  Zap,
  AlertTriangle,
  DollarSign,
  Activity,
  CheckCircle2,
  XCircle,
  BarChart3,
  Play,
  Sparkles,
  Loader2,
  Clock,
  Eye,
  ShieldAlert,
  TrendingUp,
  Target,
  Info,
  Gauge,
  Bug,
  FileWarning,
  Cpu,
  ArrowRight,
  Timer,
  Coins,
  ListChecks,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface AnomalyEvent {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  value: number;
  threshold: number;
  message: string;
}

interface EvaluationResult {
  id: string;
  overallScore: number;
  qualityGrade: string;
  accuracyScore?: number;
  hallucinationRate?: number;
  responseQuality?: number;
  securityScore?: number;
  securityRiskLevel?: string;
  inputThreatCount: number;
  outputLeakageCount: number;
  toolChainRisk: boolean;
  anomalyDetected: boolean;
  anomalyEvents?: AnomalyEvent[];
  executionTimeMs?: number;
  tokensUsed?: number;
  estimatedCostUsd?: number;
  costEfficiency?: number;
  latencyGrade?: string;
  gatesApplied: string[];
  llmJudge?: {
    used: boolean;
    provider?: string;
    model?: string;
    costUsd?: number;
    qualityScore?: number;
  };
  recommendations?: string[];
  createdAt: string;
  agentName?: string;
  nodeType: string;
  stepKey: string;
}

type TabKey = 'overview' | 'quality' | 'security' | 'anomaly' | 'cost';

// ── Mock Data Generator ────────────────────────────────────────────────────

function mockEvaluations(count: number): EvaluationResult[] {
  const agents = ['RAG-Chatbot', 'Code-Analyzer', 'Pentest-Agent', 'Data-Processor', 'Summarizer'];
  const nodeTypes = ['llm_call', 'tool_call', 'retrieval', 'chain', 'agent'];
  const grades = ['A', 'A', 'B', 'B', 'B', 'C', 'C', 'D', 'F'];
  const riskLevels = ['low', 'low', 'low', 'medium', 'medium', 'high', 'critical'];
  const threatTypes = [
    'sql_injection',
    'command_injection',
    'xss',
    'path_traversal',
    'prompt_injection',
  ];

  return Array.from({ length: count }, (_, i) => {
    const overallScore = Math.floor(Math.random() * 78) + 20;
    const securityScore = Math.floor(Math.random() * 60) + 40;
    const anomalyDetected = Math.random() < 0.15;
    const grade = grades[Math.floor(Math.random() * grades.length)];
    const useLlmJudge = Math.random() < 0.3;
    const inputThreatCount = Math.floor(Math.random() * 4);
    const outputLeakageCount = Math.floor(Math.random() * 3);

    const baseGates = ['quality', 'security', 'anomaly', 'cost'].slice(
      0,
      Math.floor(Math.random() * 3) + 2,
    );
    const gatesApplied = useLlmJudge ? [...baseGates, 'llm-judge'] : baseGates;

    return {
      id: `eval-${Date.now()}-${i}`,
      overallScore,
      qualityGrade: grade,
      accuracyScore: +(Math.random() * 0.4 + 0.6).toFixed(2),
      hallucinationRate: +(Math.random() * 0.18).toFixed(3),
      responseQuality: +(Math.random() * 2 + 3).toFixed(1),
      securityScore,
      securityRiskLevel: riskLevels[Math.floor(Math.random() * riskLevels.length)],
      inputThreatCount,
      outputLeakageCount,
      toolChainRisk: Math.random() < 0.1,
      anomalyDetected,
      anomalyEvents: anomalyDetected
        ? [
            {
              type: ['latency_spike', 'token_explosion', 'score_drop', 'cost_spike'][
                Math.floor(Math.random() * 4)
              ],
              severity: (Math.random() < 0.3 ? 'critical' : 'warning') as 'critical' | 'warning',
              value: +(Math.random() * 100 + 50).toFixed(1),
              threshold: 80,
              message: '임계값을 초과한 이상 동작이 감지되었습니다.',
            },
          ]
        : [],
      executionTimeMs: Math.floor(Math.random() * 2500) + 100,
      tokensUsed: Math.floor(Math.random() * 4000) + 500,
      estimatedCostUsd: +(Math.random() * 0.08 + 0.002).toFixed(4),
      costEfficiency: +(Math.random() * 0.5 + 0.5).toFixed(2),
      latencyGrade: ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)],
      gatesApplied,
      recommendations:
        overallScore < 70
          ? ['프롬프트 개선 권장', '컨텍스트 보강 필요', '응답 길이 최적화 검토']
          : [],
      createdAt: new Date(Date.now() - i * 30000).toISOString(),
      agentName: agents[Math.floor(Math.random() * agents.length)],
      nodeType: nodeTypes[Math.floor(Math.random() * nodeTypes.length)],
      stepKey: `step_${Math.floor(Math.random() * 10) + 1}`,
    };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getScoreColor(score: number): string {
  if (score >= 90) return 'text-green-600';
  if (score >= 70) return 'text-blue-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function getScoreBg(score: number): string {
  if (score >= 90) return 'bg-green-50';
  if (score >= 70) return 'bg-blue-50';
  if (score >= 50) return 'bg-amber-50';
  return 'bg-red-50';
}

function getGradeBadge(grade: string): string {
  const map: Record<string, string> = {
    A: 'bg-green-100 text-green-700 border-green-200',
    B: 'bg-blue-100 text-blue-700 border-blue-200',
    C: 'bg-amber-100 text-amber-700 border-amber-200',
    D: 'bg-orange-100 text-orange-700 border-orange-200',
    F: 'bg-red-100 text-red-700 border-red-200',
  };
  return map[grade] || 'bg-gray-100 text-gray-700 border-gray-200';
}

function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

function groupByAgent(evaluations: EvaluationResult[]): Record<string, EvaluationResult[]> {
  const groups: Record<string, EvaluationResult[]> = {};
  evaluations.forEach((ev) => {
    const name = ev.agentName ?? 'Unknown';
    if (!groups[name]) groups[name] = [];
    groups[name].push(ev);
  });
  return groups;
}

// ── SVG Gauge Component ──────────────────────────────────────────────────

function DonutGauge({
  value,
  max = 100,
  size = 80,
  label,
  color,
}: {
  value: number;
  max?: number;
  size?: number;
  label?: string;
  color: string;
}) {
  const radius = (size - 10) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(value / max, 1);
  const offset = circumference * (1 - pct);

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={8}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <span className="text-lg font-bold text-gray-900 -mt-12">
        {typeof value === 'number' ? value.toFixed(1) : value}
      </span>
      {label && <span className="text-[10px] text-gray-500 mt-5">{label}</span>}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export default function EvaluatorPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [evaluations, setEvaluations] = useState<EvaluationResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 팀/테넌트 필터(테넌트 전환은 PLATFORM_ADMIN만)
  const [teamF, setTeamF] = useState('');
  const [tenantF, setTenantF] = useState('');
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [role, setRole] = useState('');
  const isPlatformAdmin = role === 'PLATFORM_ADMIN';

  // Demo state
  const [demoInput, setDemoInput] = useState('');
  const [demoOutput, setDemoOutput] = useState('');
  const [demoContext, setDemoContext] = useState('');
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoResult, setDemoResult] = useState<EvaluationResult | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);

  // ── Data Fetching ──
  const fetchEvaluations = useCallback(async () => {
    try {
      const ftq =
        (teamF ? `&teamId=${encodeURIComponent(teamF)}` : '') +
        (tenantF ? `&tenantId=${encodeURIComponent(tenantF)}` : '');
      const raw = await api.get<any>(`/evaluator/recent?limit=50${ftq}`);
      let items: EvaluationResult[] = [];
      if (raw && Array.isArray(raw.evaluations)) {
        items = raw.evaluations;
      } else if (Array.isArray(raw)) {
        items = raw;
      }
      setEvaluations(items); // 실데이터만 — 없으면 빈 상태로 표시
    } catch {
      setEvaluations([]);
    } finally {
      setLoading(false);
    }
  }, [teamF, tenantF]);

  useEffect(() => {
    fetchEvaluations();
  }, [fetchEvaluations]);

  // 역할 + (PLATFORM_ADMIN이면) 테넌트 목록
  useEffect(() => {
    api
      .get<{ role: string }>('/auth/me')
      .then((r) => {
        if (r?.role) setRole(r.role);
        if (r?.role === 'PLATFORM_ADMIN') {
          api
            .get<{ items: { id: string; name: string }[] }>('/tenants/all')
            .then((res) => setTenants(Array.isArray(res?.items) ? res.items : []))
            .catch(() => setTenants([]));
        }
      })
      .catch(() => {});
  }, []);

  // 팀 목록 — 선택 테넌트 기준
  useEffect(() => {
    const url = tenantF ? `/tenants/by-id/${tenantF}/org` : '/tenants/current/org';
    setTeamF('');
    api
      .get<{ teams: { id: string; name: string }[] }>(url)
      .then((res) => setTeams(Array.isArray(res?.teams) ? res.teams : []))
      .catch(() => setTeams([]));
  }, [tenantF]);

  useEffect(() => {
    if (autoRefresh) {
      refreshTimerRef.current = setInterval(fetchEvaluations, 15000);
    }
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [autoRefresh, fetchEvaluations]);

  // ── Demo Execution ──
  const runDemo = async () => {
    if (!demoInput.trim() || !demoOutput.trim()) return;
    setDemoLoading(true);
    setDemoError(null);
    setDemoResult(null);
    try {
      const result = await api.post<EvaluationResult>('/evaluator/demo', {
        input: demoInput,
        output: demoOutput,
        context: demoContext || undefined,
      });
      setDemoResult(result);
    } catch (e: any) {
      setDemoError(e?.message ?? '평가 실행에 실패했습니다. 잠시 후 다시 시도하세요.');
      setDemoResult(null);
    } finally {
      setDemoLoading(false);
    }
  };

  // ── Summary Stats ──
  const avgOverall =
    evaluations.length > 0
      ? evaluations.reduce((s, e) => s + (e.overallScore ?? 0), 0) / evaluations.length
      : 0;
  const avgSecurity =
    evaluations.length > 0
      ? evaluations.reduce((s, e) => s + (e.securityScore ?? 0), 0) / evaluations.length
      : 0;
  const anomalyCount = evaluations.filter((e) => e.anomalyDetected).length;
  const anomalyRate = evaluations.length > 0 ? (anomalyCount / evaluations.length) * 100 : 0;
  const avgCostEfficiency =
    evaluations.length > 0
      ? evaluations.reduce((s, e) => s + (e.costEfficiency ?? 0), 0) / evaluations.length
      : 0;

  // ── Tab Config ──
  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: '메인 요약', icon: <Activity size={14} /> },
    { key: 'quality', label: '품질 상세', icon: <BarChart3 size={14} /> },
    { key: 'security', label: '보안 상세', icon: <Shield size={14} /> },
    { key: 'anomaly', label: '이상탐지 상세', icon: <AlertTriangle size={14} /> },
    { key: 'cost', label: '비용 상세', icon: <DollarSign size={14} /> },
  ];

  return (
    <div className="space-y-6 p-6">
      <SubTabs items={[{ label: '평가 결과', href: '/insights/evaluator' }, { label: '실행 테스트', href: '/platform/agent-test' }]} />
      <PageHeader
        title="Agent 품질평가/테스트"
        description="Agent Evaluator SDK 기반 7-Gate 실시간 품질 평가·테스트 엔진"
      />

      {/* Tab Navigation */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
        <div className="flex border-b border-gray-200">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-5 py-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 px-4">
            {isPlatformAdmin && (
              <select
                value={tenantF}
                onChange={(e) => setTenantF(e.target.value)}
                title="테넌트 필터 (PLATFORM_ADMIN)"
                className="bg-white border border-gray-200 rounded text-xs text-gray-900 px-2 py-1 min-w-[9rem]"
              >
                <option value="">🏢 내 테넌트</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={teamF}
              onChange={(e) => setTeamF(e.target.value)}
              title="팀 필터"
              className="bg-white border border-gray-200 rounded text-xs text-gray-900 px-2 py-1 min-w-[9rem]"
            >
              <option value="">👥 전체 팀 ({teams.length})</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span
              className={`flex items-center gap-1 text-xs font-medium ${autoRefresh ? 'text-green-600' : 'text-gray-400'}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`}
              />
              {autoRefresh ? 'LIVE' : 'PAUSED'}
            </span>
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              {autoRefresh ? '일시정지' : '재개'}
            </button>
          </div>
        </div>

        <div className="p-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-500 mr-2" />
              <span className="text-sm text-gray-500">평가 데이터 로드 중...</span>
            </div>
          ) : (
            <>
              {activeTab === 'overview' && (
                <OverviewTab
                  evaluations={evaluations}
                  avgOverall={avgOverall}
                  avgSecurity={avgSecurity}
                  anomalyRate={anomalyRate}
                  avgCostEfficiency={avgCostEfficiency}
                  setActiveTab={setActiveTab}
                  demoInput={demoInput}
                  setDemoInput={setDemoInput}
                  demoOutput={demoOutput}
                  setDemoOutput={setDemoOutput}
                  demoContext={demoContext}
                  setDemoContext={setDemoContext}
                  demoLoading={demoLoading}
                  runDemo={runDemo}
                  demoResult={demoResult}
                  demoError={demoError}
                />
              )}
              {activeTab === 'quality' && <QualityTab evaluations={evaluations} />}
              {activeTab === 'security' && <SecurityTab evaluations={evaluations} />}
              {activeTab === 'anomaly' && <AnomalyTab evaluations={evaluations} />}
              {activeTab === 'cost' && <CostTab evaluations={evaluations} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 1 — Overview (메인 요약 대시보드)
// ══════════════════════════════════════════════════════════════════════════

interface OverviewTabProps {
  evaluations: EvaluationResult[];
  avgOverall: number;
  avgSecurity: number;
  anomalyRate: number;
  avgCostEfficiency: number;
  setActiveTab: (tab: TabKey) => void;
  demoInput: string;
  setDemoInput: (v: string) => void;
  demoOutput: string;
  setDemoOutput: (v: string) => void;
  demoContext: string;
  setDemoContext: (v: string) => void;
  demoLoading: boolean;
  runDemo: () => void;
  demoResult: EvaluationResult | null;
  demoError: string | null;
}

function OverviewTab({
  evaluations,
  avgOverall,
  avgSecurity,
  anomalyRate,
  avgCostEfficiency,
  setActiveTab,
  demoInput,
  setDemoInput,
  demoOutput,
  setDemoOutput,
  demoContext,
  setDemoContext,
  demoLoading,
  runDemo,
  demoResult,
  demoError,
}: OverviewTabProps) {
  const anomalyCount = evaluations.filter((e) => e.anomalyDetected).length;

  // Grade distribution
  const gradeCount: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  evaluations.forEach((ev) => {
    if (gradeCount[ev.qualityGrade] !== undefined) gradeCount[ev.qualityGrade]++;
  });

  // Risk distribution
  const riskDist: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  evaluations.forEach((ev) => {
    const lvl = ev.securityRiskLevel ?? 'low';
    if (riskDist[lvl] !== undefined) riskDist[lvl]++;
  });

  // Latency grade distribution
  const latGrades: Record<string, number> = { fast: 0, normal: 0, slow: 0 };
  evaluations.forEach((ev) => {
    const ms = ev.executionTimeMs ?? 500;
    if (ms < 500) latGrades.fast++;
    else if (ms < 1500) latGrades.normal++;
    else latGrades.slow++;
  });

  // Recent anomalies
  const recentAnomalies = evaluations.filter((e) => e.anomalyDetected).slice(0, 2);
  const normalCount = evaluations.length - anomalyCount;

  return (
    <div className="space-y-6">
      {/* Row 1: Summary Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryStatCard
          label="평균 품질 점수"
          value={avgOverall.toFixed(1)}
          icon={<Sparkles size={18} />}
          accentColor="accent"
          change={`${evaluations.length}건 평가 기준`}
          changeType="neutral"
        />
        <SummaryStatCard
          label="보안 점수"
          value={avgSecurity.toFixed(1)}
          icon={<Shield size={18} />}
          accentColor={avgSecurity < 70 ? 'danger' : avgSecurity > 85 ? 'success' : 'warning'}
          change={avgSecurity >= 80 ? '양호' : '주의 필요'}
          changeType={avgSecurity >= 80 ? 'positive' : 'negative'}
        />
        <SummaryStatCard
          label="이상 감지율"
          value={`${anomalyRate.toFixed(1)}%`}
          icon={<AlertTriangle size={18} />}
          accentColor="warning"
          change={`${anomalyCount}건 / ${evaluations.length}건`}
          changeType={anomalyCount === 0 ? 'positive' : 'negative'}
        />
        <SummaryStatCard
          label="비용 효율"
          value={`${(avgCostEfficiency * 100).toFixed(0)}%`}
          icon={<DollarSign size={18} />}
          accentColor="success"
          change={avgCostEfficiency >= 0.8 ? '효율적' : '개선 권장'}
          changeType={avgCostEfficiency >= 0.8 ? 'positive' : 'negative'}
        />
      </div>

      {/* Row 2: 4-column mini dashboards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* 품질 요약 */}
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
          <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <BarChart3 size={14} className="text-blue-600" /> 품질 요약
          </h4>
          <div className="flex justify-center mb-3">
            <DonutGauge
              value={avgOverall}
              color={avgOverall >= 70 ? '#2563eb' : avgOverall >= 50 ? '#d97706' : '#dc2626'}
              label="평균 점수"
            />
          </div>
          <div className="space-y-1.5 mb-3">
            {(['A', 'B', 'C', 'D', 'F'] as const).map((g) => {
              const cnt = gradeCount[g] ?? 0;
              const pct = evaluations.length > 0 ? (cnt / evaluations.length) * 100 : 0;
              const colors: Record<string, string> = {
                A: 'bg-green-500',
                B: 'bg-blue-500',
                C: 'bg-amber-500',
                D: 'bg-orange-500',
                F: 'bg-red-500',
              };
              return (
                <div key={g} className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-600 w-4">{g}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${colors[g]} rounded-full transition-all duration-500`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 w-6 text-right">{cnt}</span>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setActiveTab('quality')}
            className="w-full text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center justify-center gap-1 py-1.5 rounded hover:bg-blue-50 transition-colors"
          >
            상세 보기 <ArrowRight size={12} />
          </button>
        </div>

        {/* 보안 요약 */}
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
          <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <Shield size={14} className="text-red-600" /> 보안 요약
          </h4>
          <div className="flex justify-center mb-3">
            <DonutGauge
              value={avgSecurity}
              color={avgSecurity >= 80 ? '#16a34a' : avgSecurity >= 60 ? '#d97706' : '#dc2626'}
              label="보안 점수"
            />
          </div>
          <div className="space-y-1.5 mb-3">
            {[
              { key: 'low', label: 'Low', color: 'bg-green-500' },
              { key: 'medium', label: 'Medium', color: 'bg-amber-500' },
              { key: 'high', label: 'High', color: 'bg-orange-500' },
              { key: 'critical', label: 'Critical', color: 'bg-red-500' },
            ].map((r) => {
              const cnt = riskDist[r.key] ?? 0;
              const pct = evaluations.length > 0 ? (cnt / evaluations.length) * 100 : 0;
              return (
                <div key={r.key} className="flex items-center gap-2">
                  <span className="text-[10px] font-medium text-gray-600 w-12">{r.label}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${r.color} rounded-full transition-all duration-500`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 w-6 text-right">{cnt}</span>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setActiveTab('security')}
            className="w-full text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center justify-center gap-1 py-1.5 rounded hover:bg-blue-50 transition-colors"
          >
            상세 보기 <ArrowRight size={12} />
          </button>
        </div>

        {/* 이상탐지 요약 */}
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
          <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-600" /> 이상탐지 요약
          </h4>
          <div className="flex items-center justify-center gap-4 mb-3">
            <div className="text-center">
              <p className="text-2xl font-bold text-red-600">{anomalyCount}</p>
              <p className="text-[10px] text-gray-500">이상</p>
            </div>
            <div className="text-gray-300 text-lg">/</div>
            <div className="text-center">
              <p className="text-2xl font-bold text-green-600">{normalCount}</p>
              <p className="text-[10px] text-gray-500">정상</p>
            </div>
          </div>
          {recentAnomalies.length > 0 ? (
            <div className="space-y-1.5 mb-3">
              {recentAnomalies.map((ev) => (
                <div key={ev.id} className="bg-red-50 border border-red-100 rounded p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                    <span className="text-[10px] font-medium text-red-700 truncate">
                      {ev.agentName}
                    </span>
                    <span className="text-[10px] text-gray-400 ml-auto">
                      {formatTimestamp(ev.createdAt)}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-600 mt-0.5 truncate">
                    {ev.anomalyEvents?.[0]?.type ?? 'anomaly'}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400 text-center mb-3 py-3">최근 이상 이벤트 없음</p>
          )}
          <button
            onClick={() => setActiveTab('anomaly')}
            className="w-full text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center justify-center gap-1 py-1.5 rounded hover:bg-blue-50 transition-colors"
          >
            상세 보기 <ArrowRight size={12} />
          </button>
        </div>

        {/* 비용 요약 */}
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
          <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <DollarSign size={14} className="text-green-600" /> 비용 요약
          </h4>
          <div className="flex justify-center mb-3">
            <DonutGauge
              value={avgCostEfficiency * 100}
              color={
                avgCostEfficiency >= 0.8
                  ? '#16a34a'
                  : avgCostEfficiency >= 0.6
                    ? '#d97706'
                    : '#dc2626'
              }
              label="평균 효율"
            />
          </div>
          <div className="space-y-1.5 mb-3">
            {[
              { key: 'fast', label: 'Fast', color: 'bg-green-500' },
              { key: 'normal', label: 'Normal', color: 'bg-blue-500' },
              { key: 'slow', label: 'Slow', color: 'bg-amber-500' },
            ].map((l) => {
              const cnt = latGrades[l.key] ?? 0;
              const pct = evaluations.length > 0 ? (cnt / evaluations.length) * 100 : 0;
              return (
                <div key={l.key} className="flex items-center gap-2">
                  <span className="text-[10px] font-medium text-gray-600 w-12">{l.label}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${l.color} rounded-full transition-all duration-500`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 w-6 text-right">{cnt}</span>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setActiveTab('cost')}
            className="w-full text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center justify-center gap-1 py-1.5 rounded hover:bg-blue-50 transition-colors"
          >
            상세 보기 <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {/* Row 3: Recent evaluations table */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <Clock size={14} className="text-gray-600" /> 최근 평가 결과 (최근 10건)
        </h4>
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <th className="text-left px-3 py-2.5 font-semibold">시간</th>
                <th className="text-left px-3 py-2.5 font-semibold">Agent</th>
                <th className="text-center px-3 py-2.5 font-semibold">종합점수</th>
                <th className="text-center px-3 py-2.5 font-semibold">등급</th>
                <th className="text-center px-3 py-2.5 font-semibold">보안</th>
                <th className="text-center px-3 py-2.5 font-semibold">이상</th>
                <th className="text-center px-3 py-2.5 font-semibold">비용효율</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.slice(0, 10).map((ev) => (
                <tr
                  key={ev.id}
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <td className="px-3 py-2.5 text-xs text-gray-500 font-mono whitespace-nowrap">
                    {formatTimestamp(ev.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 text-xs font-medium text-gray-900">
                    {ev.agentName ?? '---'}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`text-xs font-bold ${getScoreColor(ev.overallScore)}`}>
                      {ev.overallScore}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span
                      className={`inline-flex items-center justify-center w-7 h-6 rounded text-xs font-bold border ${getGradeBadge(ev.qualityGrade)}`}
                    >
                      {ev.qualityGrade}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`text-xs font-bold ${getScoreColor(ev.securityScore ?? 0)}`}>
                      {ev.securityScore ?? 0}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {ev.anomalyDetected ? (
                      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">
                        <AlertTriangle size={10} /> 탐지
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">
                        <CheckCircle2 size={10} /> 정상
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span
                      className={`text-xs font-bold ${getScoreColor(Math.round((ev.costEfficiency ?? 0) * 100))}`}
                    >
                      {((ev.costEfficiency ?? 0) * 100).toFixed(0)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Demo Section */}
      <DemoSection
        demoInput={demoInput}
        setDemoInput={setDemoInput}
        demoOutput={demoOutput}
        setDemoOutput={setDemoOutput}
        demoContext={demoContext}
        setDemoContext={setDemoContext}
        demoLoading={demoLoading}
        runDemo={runDemo}
        demoResult={demoResult}
        demoError={demoError}
      />
    </div>
  );
}

// ── Demo Section ────────────────────────────────────────────────────────

function DemoSection({
  demoInput,
  setDemoInput,
  demoOutput,
  setDemoOutput,
  demoContext,
  setDemoContext,
  demoLoading,
  runDemo,
  demoResult,
  demoError,
}: {
  demoInput: string;
  setDemoInput: (v: string) => void;
  demoOutput: string;
  setDemoOutput: (v: string) => void;
  demoContext: string;
  setDemoContext: (v: string) => void;
  demoLoading: boolean;
  runDemo: () => void;
  demoResult: EvaluationResult | null;
  demoError: string | null;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-2">
        <Play size={16} className="text-blue-600" />
        <h3 className="text-sm font-semibold text-gray-900">평가 데모</h3>
        <span className="text-xs text-gray-500 ml-1">
          Agent 응답에 대한 실시간 품질 평가를 직접 테스트합니다
        </span>
      </div>
      <div className="p-5">
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <label className="text-xs font-semibold text-gray-700 mb-1.5 block">
              입력 프롬프트
            </label>
            <textarea
              value={demoInput}
              onChange={(e) => setDemoInput(e.target.value)}
              rows={5}
              placeholder="Agent에게 보낸 프롬프트를 입력하세요..."
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none bg-gray-50"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-700 mb-1.5 block">Agent 응답</label>
            <textarea
              value={demoOutput}
              onChange={(e) => setDemoOutput(e.target.value)}
              rows={5}
              placeholder="Agent가 생성한 응답을 입력하세요..."
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none bg-gray-50"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-700 mb-1.5 block">
              컨텍스트 <span className="text-gray-400 font-normal">(선택)</span>
            </label>
            <textarea
              value={demoContext}
              onChange={(e) => setDemoContext(e.target.value)}
              rows={5}
              placeholder="참조 문서나 ground truth 정보를 입력하세요..."
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none bg-gray-50"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={runDemo}
            disabled={demoLoading || !demoInput.trim() || !demoOutput.trim()}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            {demoLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" /> 평가 중...
              </>
            ) : (
              <>
                <Zap size={16} /> 평가 실행
              </>
            )}
          </button>
          {demoError && (
            <span className="flex items-center gap-1.5 text-xs text-red-600">
              <XCircle size={14} />
              {demoError}
            </span>
          )}
        </div>
        {demoResult && <DemoResultPanel result={demoResult} />}
      </div>
    </div>
  );
}

// ── Demo Result Panel ───────────────────────────────────────────────────

function DemoResultPanel({ result }: { result: EvaluationResult }) {
  const gates = [
    {
      key: 'quality',
      label: '품질 평가',
      icon: <BarChart3 size={16} />,
      score: result.overallScore,
      detail: `등급: ${result.qualityGrade} | 정확도: ${((result.accuracyScore ?? 0) * 100).toFixed(0)}% | 환각률: ${((result.hallucinationRate ?? 0) * 100).toFixed(1)}%`,
      color: getScoreColor(result.overallScore),
      bg: getScoreBg(result.overallScore),
    },
    {
      key: 'security',
      label: '보안 평가',
      icon: <Shield size={16} />,
      score: result.securityScore ?? 0,
      detail: `위험: ${result.securityRiskLevel ?? 'low'} | 입력위협: ${result.inputThreatCount} | 출력유출: ${result.outputLeakageCount}`,
      color: getScoreColor(result.securityScore ?? 0),
      bg: getScoreBg(result.securityScore ?? 0),
    },
    {
      key: 'anomaly',
      label: '이상 탐지',
      icon: <AlertTriangle size={16} />,
      score: result.anomalyDetected ? 30 : 95,
      detail: result.anomalyDetected
        ? `이상 감지됨 (${result.anomalyEvents?.length ?? 0}건)`
        : '이상 없음 - 정상 범위',
      color: result.anomalyDetected ? 'text-red-600' : 'text-green-600',
      bg: result.anomalyDetected ? 'bg-red-50' : 'bg-green-50',
    },
    {
      key: 'cost',
      label: '비용 효율',
      icon: <DollarSign size={16} />,
      score: Math.round((result.costEfficiency ?? 0) * 100),
      detail: `비용: ${krw(result.estimatedCostUsd ?? 0, { decimals: 2 })} | 토큰: ${result.tokensUsed ?? 0} | 지연: ${result.executionTimeMs ?? 0}ms`,
      color: getScoreColor(Math.round((result.costEfficiency ?? 0) * 100)),
      bg: getScoreBg(Math.round((result.costEfficiency ?? 0) * 100)),
    },
  ];

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-blue-600" />
          <h4 className="text-sm font-semibold text-gray-900">평가 결과</h4>
          {result.gatesApplied?.includes('llm-judge') && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded border border-purple-200">
              LLM Judge
            </span>
          )}
          <span className="text-[9px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">
            {result.gatesApplied?.includes('llm-judge')
              ? 'Layer 0+1 하이브리드'
              : 'Layer 0 통계 기반'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-lg font-bold ${getScoreColor(result.overallScore)}`}>
            {result.overallScore}점
          </span>
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded border ${getGradeBadge(result.qualityGrade)}`}
          >
            {result.qualityGrade}
          </span>
        </div>
      </div>
      {/* 품질 게이트 LLM 심판(Claude/OpenAI) 실제 호출 여부 — 매 평가마다 확인 */}
      <div
        className={`mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-[11px] ${
          result.llmJudge?.used
            ? 'bg-purple-50 border-purple-200 text-purple-800'
            : 'bg-gray-50 border-gray-200 text-gray-500'
        }`}
      >
        <span className="font-semibold">
          {result.llmJudge?.used ? '✓ LLM 심판 사용됨' : '○ LLM 심판 미사용 (통계 폴백)'}
        </span>
        {result.llmJudge?.used && (
          <>
            <span>
              제공자: <b>{result.llmJudge.provider ?? '-'}</b>
            </span>
            <span>
              모델: <b>{result.llmJudge.model ?? '-'}</b>
            </span>
            <span>
              심판 비용: <b>{krw(result.llmJudge.costUsd ?? 0, { decimals: 2 })}</b>
            </span>
            {typeof result.llmJudge.qualityScore === 'number' && (
              <span>
                LLM 품질판정: <b>{result.llmJudge.qualityScore}점</b>
              </span>
            )}
          </>
        )}
        <span className="ml-auto text-[10px] opacity-70">
          보안·비용·이상 게이트는 LLM 비호출(규칙 기반)
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {gates.map((gate) => (
          <div key={gate.key} className={`${gate.bg} border border-gray-200 rounded-lg p-4`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={gate.color}>{gate.icon}</span>
                <span className="text-xs font-semibold text-gray-800">{gate.label}</span>
              </div>
              <span className={`text-lg font-bold ${gate.color}`}>{gate.score}</span>
            </div>
            <p className="text-[11px] text-gray-600">{gate.detail}</p>
            <div className="mt-2 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${gate.score >= 90 ? 'bg-green-500' : gate.score >= 70 ? 'bg-blue-500' : gate.score >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
                style={{ width: `${gate.score}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {result.recommendations && result.recommendations.length > 0 && (
        <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Info size={14} className="text-blue-600" />
            <span className="text-xs font-semibold text-blue-800">개선 권장 사항</span>
          </div>
          <ul className="space-y-1">
            {result.recommendations.map((rec, i) => (
              <li key={i} className="text-xs text-blue-700 flex items-start gap-1.5">
                <span className="text-blue-400 mt-0.5">-</span>
                {rec}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 2 — Quality Detail (품질 상세)
// ══════════════════════════════════════════════════════════════════════════

function QualityTab({ evaluations }: { evaluations: EvaluationResult[] }) {
  // Phase 5.2: 이력 행 클릭 시 해당 건의 Gate 상세를 펼쳐서 표시
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const evalsPage = usePagination(evaluations, 10);

  if (evaluations.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 size={40} className="text-gray-300" />}
        message="품질 분석 데이터가 없습니다."
      />
    );
  }

  // Section 1: Grade distribution
  const gradeCount: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  evaluations.forEach((ev) => {
    if (gradeCount[ev.qualityGrade] !== undefined) gradeCount[ev.qualityGrade]++;
  });
  const maxGrade = Math.max(...Object.values(gradeCount), 1);

  // Section 2: Hallucination distribution
  const halLow = evaluations.filter((e) => (e.hallucinationRate ?? 0) < 0.05).length;
  const halMed = evaluations.filter(
    (e) => (e.hallucinationRate ?? 0) >= 0.05 && (e.hallucinationRate ?? 0) < 0.1,
  ).length;
  const halHigh = evaluations.filter((e) => (e.hallucinationRate ?? 0) >= 0.1).length;
  const halMax = Math.max(halLow, halMed, halHigh, 1);

  // Section 3: Agent-level quality
  const agentGroups = groupByAgent(evaluations);

  // Section 4: LLM Judge usage
  const llmJudgeCount = evaluations.filter((e) =>
    (e.gatesApplied ?? []).includes('llm-judge'),
  ).length;
  const layer0Only = evaluations.length - llmJudgeCount;

  return (
    <div className="space-y-6">
      {/* Section 1: 등급 분포 */}
      <SectionHeader
        icon={<TrendingUp size={16} className="text-purple-600" />}
        title="등급 분포"
      />
      <div className="space-y-2">
        {(['A', 'B', 'C', 'D', 'F'] as const).map((g) => {
          const cnt = gradeCount[g] ?? 0;
          const pct = (cnt / maxGrade) * 100;
          const colors: Record<string, string> = {
            A: 'bg-green-500',
            B: 'bg-blue-500',
            C: 'bg-amber-500',
            D: 'bg-orange-500',
            F: 'bg-red-500',
          };
          return (
            <div key={g} className="flex items-center gap-3">
              <span
                className={`inline-flex items-center justify-center w-7 h-6 rounded text-xs font-bold border ${getGradeBadge(g)}`}
              >
                {g}
              </span>
              <div className="flex-1 h-7 bg-gray-100 rounded-md overflow-hidden">
                <div
                  className={`h-full ${colors[g]} rounded-md transition-all duration-500 flex items-center`}
                  style={{ width: `${pct}%`, minWidth: cnt > 0 ? '24px' : '0' }}
                >
                  {cnt > 0 && <span className="text-[10px] text-gray-900 font-bold px-2">{cnt}</span>}
                </div>
              </div>
              <span className="text-xs text-gray-400 w-10 text-right">
                {evaluations.length > 0 ? ((cnt / evaluations.length) * 100).toFixed(0) : 0}%
              </span>
            </div>
          );
        })}
      </div>

      {/* Section 2: 환각률 분포 */}
      <SectionHeader icon={<Eye size={16} className="text-amber-600" />} title="환각률 분포" />
      <div className="grid grid-cols-3 gap-4">
        {[
          {
            label: '낮음 (<5%)',
            count: halLow,
            color: 'bg-green-500',
            bg: 'bg-green-50',
            border: 'border-green-200',
            text: 'text-green-700',
          },
          {
            label: '중간 (5-10%)',
            count: halMed,
            color: 'bg-amber-500',
            bg: 'bg-amber-50',
            border: 'border-amber-200',
            text: 'text-amber-700',
          },
          {
            label: '높음 (>10%)',
            count: halHigh,
            color: 'bg-red-500',
            bg: 'bg-red-50',
            border: 'border-red-200',
            text: 'text-red-700',
          },
        ].map((h) => (
          <div key={h.label} className={`${h.bg} border ${h.border} rounded-lg p-4 text-center`}>
            <p className={`text-2xl font-bold ${h.text}`}>{h.count}</p>
            <p className={`text-xs ${h.text} mt-1`}>{h.label}</p>
            <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full ${h.color} rounded-full`}
                style={{ width: `${(h.count / halMax) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Section 3: Agent별 평균 품질 */}
      <SectionHeader icon={<Cpu size={16} className="text-blue-600" />} title="Agent별 평균 품질" />
      <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
              <th className="text-left px-3 py-2.5 font-semibold">Agent</th>
              <th className="text-center px-3 py-2.5 font-semibold">건수</th>
              <th className="text-center px-3 py-2.5 font-semibold">평균 종합점수</th>
              <th className="text-center px-3 py-2.5 font-semibold">평균 정확도</th>
              <th className="text-center px-3 py-2.5 font-semibold">평균 환각률</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(agentGroups).map(([name, items]) => {
              const avgScore = items.reduce((s, e) => s + e.overallScore, 0) / items.length;
              const avgAcc = items.reduce((s, e) => s + (e.accuracyScore ?? 0), 0) / items.length;
              const avgHal =
                items.reduce((s, e) => s + (e.hallucinationRate ?? 0), 0) / items.length;
              return (
                <tr
                  key={name}
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <td className="px-3 py-2.5 text-xs font-medium text-gray-900">{name}</td>
                  <td className="px-3 py-2.5 text-xs text-gray-600 text-center">{items.length}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`text-xs font-bold ${getScoreColor(avgScore)}`}>
                      {avgScore.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-600 text-center">
                    {(avgAcc * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-600 text-center">
                    {(avgHal * 100).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Section 4: LLM Judge 활용 */}
      <SectionHeader
        icon={<Sparkles size={16} className="text-purple-600" />}
        title="LLM Judge 활용"
      />
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-purple-700">{llmJudgeCount}</p>
          <p className="text-xs text-purple-600 mt-1">LLM Judge (Layer 0+1)</p>
          <div className="mt-2 h-2 bg-purple-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full"
              style={{
                width: `${evaluations.length > 0 ? (llmJudgeCount / evaluations.length) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-gray-700">{layer0Only}</p>
          <p className="text-xs text-gray-600 mt-1">Layer 0 Only (통계 기반)</p>
          <div className="mt-2 h-2 bg-gray-300 rounded-full overflow-hidden">
            <div
              className="h-full bg-gray-500 rounded-full"
              style={{
                width: `${evaluations.length > 0 ? (layer0Only / evaluations.length) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Section 5: 최근 평가 상세 */}
      <SectionHeader
        icon={<ListChecks size={16} className="text-gray-600" />}
        title="최근 평가 상세"
      />
      <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
              <th className="text-left px-3 py-2.5 font-semibold">시간</th>
              <th className="text-left px-3 py-2.5 font-semibold">Agent</th>
              <th className="text-center px-3 py-2.5 font-semibold">점수</th>
              <th className="text-center px-3 py-2.5 font-semibold">등급</th>
              <th className="text-center px-3 py-2.5 font-semibold">정확도</th>
              <th className="text-center px-3 py-2.5 font-semibold">환각률</th>
              <th className="text-center px-3 py-2.5 font-semibold">응답품질</th>
              <th className="text-center px-3 py-2.5 font-semibold">Judge</th>
            </tr>
          </thead>
          <tbody>
            {evalsPage.pageItems.map((ev) => {
              const isOpen = expandedId === ev.id;
              return (
                <Fragment key={ev.id}>
                  <tr
                    onClick={() => setExpandedId(isOpen ? null : ev.id)}
                    className={`border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer ${isOpen ? 'bg-blue-50/40' : ''}`}
                  >
                    <td className="px-3 py-2 text-xs text-gray-500 font-mono whitespace-nowrap">
                      <span className="inline-block w-3 text-gray-400">{isOpen ? '▾' : '▸'}</span>{' '}
                      {formatTimestamp(ev.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-xs font-medium text-gray-900">
                      {ev.agentName ?? '---'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-xs font-bold ${getScoreColor(ev.overallScore)}`}>
                        {ev.overallScore}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`inline-flex items-center justify-center w-6 h-5 rounded text-[10px] font-bold border ${getGradeBadge(ev.qualityGrade)}`}
                      >
                        {ev.qualityGrade}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 text-center">
                      {((ev.accuracyScore ?? 0) * 100).toFixed(0)}%
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 text-center">
                      {((ev.hallucinationRate ?? 0) * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 text-center">
                      {ev.responseQuality ?? '---'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {(ev.gatesApplied ?? []).includes('llm-judge') ? (
                        <span className="text-[9px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded font-semibold">
                          LLM
                        </span>
                      ) : (
                        <span className="text-[9px] text-gray-400">L0</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <td colSpan={8} className="px-4 py-3">
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                          {/* 품질 Gate */}
                          <div className="bg-white border border-gray-200 rounded p-3">
                            <p className="font-semibold text-blue-600 mb-1.5">품질 Gate</p>
                            <p className="text-gray-600">
                              등급 <b>{ev.qualityGrade}</b>
                            </p>
                            <p className="text-gray-600">
                              정확도 {((ev.accuracyScore ?? 0) * 100).toFixed(0)}%
                            </p>
                            <p className="text-gray-600">
                              환각률 {((ev.hallucinationRate ?? 0) * 100).toFixed(1)}%
                            </p>
                            <p className="text-gray-600">
                              응답품질 {ev.responseQuality ?? '---'}/5
                            </p>
                          </div>
                          {/* 보안 Gate */}
                          <div className="bg-white border border-gray-200 rounded p-3">
                            <p className="font-semibold text-red-600 mb-1.5">보안 Gate</p>
                            <p className="text-gray-600">점수 {ev.securityScore ?? '---'}</p>
                            <p className="text-gray-600">
                              위험도 <b>{ev.securityRiskLevel ?? 'low'}</b>
                            </p>
                            <p className="text-gray-600">입력위협 {ev.inputThreatCount}건</p>
                            <p className="text-gray-600">출력유출 {ev.outputLeakageCount}건</p>
                          </div>
                          {/* 비용 Gate */}
                          <div className="bg-white border border-gray-200 rounded p-3">
                            <p className="font-semibold text-emerald-600 mb-1.5">비용 Gate</p>
                            <p className="text-gray-600">
                              비용 {krw(ev.estimatedCostUsd ?? 0, { decimals: 2 })}
                            </p>
                            <p className="text-gray-600">
                              효율 {((ev.costEfficiency ?? 0) * 100).toFixed(0)}%
                            </p>
                            <p className="text-gray-600">지연 {ev.latencyGrade ?? '---'}</p>
                            <p className="text-gray-600">토큰 {ev.tokensUsed ?? 0}</p>
                          </div>
                          {/* 이상탐지 Gate */}
                          <div className="bg-white border border-gray-200 rounded p-3">
                            <p className="font-semibold text-violet-600 mb-1.5">이상탐지 Gate</p>
                            <p className="text-gray-600">
                              감지 {ev.anomalyDetected ? '예' : '아니오'}
                            </p>
                            <p className="text-gray-600">
                              이벤트 {(ev.anomalyEvents ?? []).length}건
                            </p>
                            <p className="text-gray-600 mt-1">
                              적용 Gate: {(ev.gatesApplied ?? []).join(', ') || '---'}
                            </p>
                          </div>
                        </div>
                        {Array.isArray(ev.recommendations) && ev.recommendations.length > 0 && (
                          <div className="mt-3 bg-white border border-gray-200 rounded p-3">
                            <p className="font-semibold text-gray-700 mb-1 text-xs">권고</p>
                            <ul className="space-y-0.5">
                              {ev.recommendations.map((r, i) => (
                                <li
                                  key={i}
                                  className="text-xs text-gray-600 flex items-start gap-1.5"
                                >
                                  <span className="text-gray-400 mt-0.5">-</span>
                                  {r}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <Pager p={evalsPage} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 3 — Security Detail (보안 상세)
// ══════════════════════════════════════════════════════════════════════════

function SecurityTab({ evaluations }: { evaluations: EvaluationResult[] }) {
  if (evaluations.length === 0) {
    return (
      <EmptyState
        icon={<Shield size={40} className="text-gray-300" />}
        message="보안 평가 데이터가 없습니다."
      />
    );
  }

  // Section 1: Risk level distribution
  const riskDist: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  evaluations.forEach((ev) => {
    const lvl = ev.securityRiskLevel ?? 'low';
    if (riskDist[lvl] !== undefined) riskDist[lvl]++;
  });

  // Section 2: Threat type analysis (simulated breakdown from inputThreatCount)
  const threatTypes = [
    'SQL Injection',
    'Command Injection',
    'XSS',
    'Path Traversal',
    'Prompt Injection',
  ];
  const totalInputThreats = evaluations.reduce((s, e) => s + e.inputThreatCount, 0);
  const threatBreakdown = threatTypes.map((name, idx) => {
    const ratio = [0.25, 0.15, 0.2, 0.1, 0.3][idx];
    return { name, count: Math.round(totalInputThreats * ratio) };
  });
  const maxThreat = Math.max(...threatBreakdown.map((t) => t.count), 1);

  // Section 3: Output leakage
  const totalLeakage = evaluations.reduce((s, e) => s + e.outputLeakageCount, 0);
  const leakageTypes = [
    { name: 'PII 노출', count: Math.round(totalLeakage * 0.4), severity: 'high' },
    { name: '내부 정보 유출', count: Math.round(totalLeakage * 0.3), severity: 'medium' },
    { name: '프롬프트 유출', count: Math.round(totalLeakage * 0.3), severity: 'low' },
  ];

  // Section 4: Last 20 security scores
  const last20 = evaluations.slice(0, 20);
  const maxSecScore = 100;

  // Section 5: Risky items
  const riskyItems = evaluations.filter((e) => e.securityRiskLevel !== 'low');
  const riskyPage = usePagination(riskyItems, 10);

  return (
    <div className="space-y-6">
      {/* Section 1: 리스크 레벨 분포 */}
      <SectionHeader
        icon={<ShieldAlert size={16} className="text-red-600" />}
        title="리스크 레벨 분포"
      />
      <div className="grid grid-cols-4 gap-4">
        {[
          {
            key: 'critical',
            label: 'Critical',
            bg: 'bg-red-50',
            border: 'border-red-200',
            text: 'text-red-700',
            icon: <XCircle size={20} className="text-red-600" />,
          },
          {
            key: 'high',
            label: 'High',
            bg: 'bg-orange-50',
            border: 'border-orange-200',
            text: 'text-orange-700',
            icon: <AlertTriangle size={20} className="text-orange-600" />,
          },
          {
            key: 'medium',
            label: 'Medium',
            bg: 'bg-amber-50',
            border: 'border-amber-200',
            text: 'text-amber-700',
            icon: <Info size={20} className="text-amber-600" />,
          },
          {
            key: 'low',
            label: 'Low',
            bg: 'bg-green-50',
            border: 'border-green-200',
            text: 'text-green-700',
            icon: <CheckCircle2 size={20} className="text-green-600" />,
          },
        ].map((r) => (
          <div key={r.key} className={`${r.bg} border ${r.border} rounded-lg p-4 text-center`}>
            <div className="flex justify-center mb-2">{r.icon}</div>
            <p className={`text-2xl font-bold ${r.text}`}>{riskDist[r.key] ?? 0}</p>
            <p className={`text-xs ${r.text} font-semibold mt-1`}>{r.label}</p>
          </div>
        ))}
      </div>

      {/* Section 2: 위협 유형 분석 */}
      <SectionHeader icon={<Bug size={16} className="text-orange-600" />} title="위협 유형 분석" />
      <div className="space-y-2">
        {threatBreakdown.map((t) => (
          <div key={t.name} className="flex items-center gap-3">
            <span className="text-xs text-gray-700 w-32 font-medium">{t.name}</span>
            <div className="flex-1 h-6 bg-gray-100 rounded-md overflow-hidden">
              <div
                className="h-full bg-red-500 rounded-md transition-all duration-500 flex items-center"
                style={{
                  width: `${(t.count / maxThreat) * 100}%`,
                  minWidth: t.count > 0 ? '20px' : '0',
                }}
              >
                {t.count > 0 && (
                  <span className="text-[10px] text-gray-900 font-bold px-2">{t.count}</span>
                )}
              </div>
            </div>
            <span className="text-xs text-gray-400 w-8 text-right">{t.count}</span>
          </div>
        ))}
      </div>

      {/* Section 3: 출력 유출 분석 */}
      <SectionHeader icon={<Eye size={16} className="text-amber-600" />} title="출력 유출 분석" />
      <div className="grid grid-cols-3 gap-4">
        {leakageTypes.map((lt) => {
          const severityColor =
            lt.severity === 'high'
              ? 'text-red-700 bg-red-50 border-red-200'
              : lt.severity === 'medium'
                ? 'text-amber-700 bg-amber-50 border-amber-200'
                : 'text-green-700 bg-green-50 border-green-200';
          return (
            <div key={lt.name} className={`border rounded-lg p-4 text-center ${severityColor}`}>
              <p className="text-2xl font-bold">{lt.count}</p>
              <p className="text-xs font-medium mt-1">{lt.name}</p>
              <span className="text-[10px] uppercase font-semibold mt-1 inline-block">
                {lt.severity}
              </span>
            </div>
          );
        })}
      </div>

      {/* Section 4: 보안 점수 추이 */}
      <SectionHeader
        icon={<TrendingUp size={16} className="text-blue-600" />}
        title="보안 점수 추이 (최근 20건)"
      />
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-end gap-1 h-32">
          {last20.map((ev, idx) => {
            const score = ev.securityScore ?? 0;
            const h = (score / maxSecScore) * 100;
            const color =
              score >= 80 ? 'bg-green-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500';
            return (
              <div
                key={idx}
                className="flex-1 flex flex-col items-center justify-end h-full"
                title={`${score}점`}
              >
                <div
                  className={`w-full ${color} rounded-t transition-all duration-300`}
                  style={{ height: `${h}%`, minHeight: '2px' }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-gray-400">최신</span>
          <span className="text-[10px] text-gray-400">이전</span>
        </div>
      </div>

      {/* Section 5: 위험 평가 상세 */}
      <SectionHeader
        icon={<FileWarning size={16} className="text-red-600" />}
        title="위험 평가 상세 (리스크 != low)"
      />
      {riskyItems.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-8">
          위험 수준이 low 이상인 평가가 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <th className="text-left px-3 py-2.5 font-semibold">시간</th>
                <th className="text-left px-3 py-2.5 font-semibold">Agent</th>
                <th className="text-center px-3 py-2.5 font-semibold">보안점수</th>
                <th className="text-center px-3 py-2.5 font-semibold">리스크</th>
                <th className="text-center px-3 py-2.5 font-semibold">입력위협</th>
                <th className="text-center px-3 py-2.5 font-semibold">출력유출</th>
                <th className="text-center px-3 py-2.5 font-semibold">도구체인</th>
              </tr>
            </thead>
            <tbody>
              {riskyPage.pageItems.map((ev) => {
                const riskColors: Record<string, string> = {
                  critical: 'bg-red-100 text-red-700',
                  high: 'bg-orange-100 text-orange-700',
                  medium: 'bg-amber-100 text-amber-700',
                };
                return (
                  <tr
                    key={ev.id}
                    className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-3 py-2 text-xs text-gray-500 font-mono">
                      {formatTimestamp(ev.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-xs font-medium text-gray-900">
                      {ev.agentName ?? '---'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-xs font-bold ${getScoreColor(ev.securityScore ?? 0)}`}>
                        {ev.securityScore ?? 0}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${riskColors[ev.securityRiskLevel ?? ''] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {ev.securityRiskLevel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 text-center">
                      {ev.inputThreatCount}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 text-center">
                      {ev.outputLeakageCount}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {ev.toolChainRisk ? (
                        <span className="text-red-600 text-xs font-bold">YES</span>
                      ) : (
                        <span className="text-gray-400 text-xs">---</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pager p={riskyPage} />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 4 — Anomaly Detail (이상탐지 상세)
// ══════════════════════════════════════════════════════════════════════════

function AnomalyTab({ evaluations }: { evaluations: EvaluationResult[] }) {
  const [streamingStats, setStreamingStats] = useState<any>(null);
  const [streamingError, setStreamingError] = useState(false);

  useEffect(() => {
    api
      .get<any>('/evaluator/streaming')
      .then((data) => setStreamingStats(data))
      .catch(() => setStreamingError(true));
  }, []);

  const anomalyItems = evaluations.filter((e) => e.anomalyDetected);
  const normalCount = evaluations.length - anomalyItems.length;
  const anomalyPct = evaluations.length > 0 ? (anomalyItems.length / evaluations.length) * 100 : 0;

  const anomalyTypeLabels: Record<string, string> = {
    latency_spike: '지연 급등',
    token_explosion: '토큰 폭발',
    score_drop: '점수 급락',
    cost_spike: '비용 급등',
  };

  // Agent anomaly rates
  const agentGroups = groupByAgent(evaluations);

  return (
    <div className="space-y-6">
      {/* Section 1: 이상 감지 현황 */}
      <SectionHeader
        icon={<Activity size={16} className="text-red-600" />}
        title="이상 감지 현황"
      />
      <div className="bg-white border border-gray-200 rounded-lg p-6 flex items-center gap-8">
        <div className="flex-shrink-0">
          <svg width={120} height={120} className="-rotate-90">
            <circle cx={60} cy={60} r={50} fill="none" stroke="#dcfce7" strokeWidth={14} />
            <circle
              cx={60}
              cy={60}
              r={50}
              fill="none"
              stroke="#ef4444"
              strokeWidth={14}
              strokeDasharray={2 * Math.PI * 50}
              strokeDashoffset={2 * Math.PI * 50 * (1 - anomalyPct / 100)}
              strokeLinecap="round"
              className="transition-all duration-700"
            />
          </svg>
          <div className="text-center -mt-[78px]">
            <p className="text-lg font-bold text-gray-900">{anomalyPct.toFixed(1)}%</p>
            <p className="text-[10px] text-gray-500">이상률</p>
          </div>
          <div className="mt-10" />
        </div>
        <div className="flex-1 grid grid-cols-2 gap-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-red-700">{anomalyItems.length}</p>
            <p className="text-xs text-red-600 font-medium mt-1">이상 감지</p>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-green-700">{normalCount}</p>
            <p className="text-xs text-green-600 font-medium mt-1">정상</p>
          </div>
        </div>
      </div>

      {/* Section 2: 이상 이벤트 목록 */}
      <SectionHeader
        icon={<AlertTriangle size={16} className="text-amber-600" />}
        title="이상 이벤트 목록"
      />
      {anomalyItems.length === 0 ? (
        <div className="text-center py-8">
          <CheckCircle2 size={32} className="mx-auto text-green-400 mb-2" />
          <p className="text-xs text-gray-500">이상 탐지 이벤트가 없습니다.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {anomalyItems.map((ev) =>
            (ev.anomalyEvents ?? []).map((anomaly, aIdx) => (
              <div
                key={`${ev.id}-${aIdx}`}
                className={`rounded-lg border p-4 ${anomaly.severity === 'critical' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${anomaly.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'}`}
                    />
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-xs font-bold uppercase ${anomaly.severity === 'critical' ? 'text-red-700' : 'text-amber-700'}`}
                        >
                          {anomaly.severity}
                        </span>
                        <span className="text-xs text-gray-600 font-medium">
                          {anomalyTypeLabels[anomaly.type] ?? anomaly.type}
                        </span>
                        <span className="text-[10px] text-gray-400">{ev.agentName}</span>
                      </div>
                      <p className="text-xs text-gray-700">{anomaly.message}</p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-4">
                    <div className="flex items-center gap-2">
                      <div>
                        <p className="text-[10px] text-gray-500">값</p>
                        <p
                          className={`text-sm font-bold ${anomaly.severity === 'critical' ? 'text-red-700' : 'text-amber-700'}`}
                        >
                          {anomaly.value}
                        </p>
                      </div>
                      <div className="text-gray-300 text-xs">/</div>
                      <div>
                        <p className="text-[10px] text-gray-500">임계값</p>
                        <p className="text-sm font-bold text-gray-600">{anomaly.threshold}</p>
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1">
                      {formatTimestamp(ev.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            )),
          )}
        </div>
      )}

      {/* Section 3: 실시간 윈도우 통계 */}
      <SectionHeader
        icon={<Gauge size={16} className="text-blue-600" />}
        title="실시간 윈도우 통계"
      />
      {streamingError || !streamingStats ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <Loader2 size={20} className="animate-spin text-blue-400 mx-auto mb-2" />
          <p className="text-xs text-gray-500">스트리밍 데이터 수집 중...</p>
          <p className="text-[10px] text-gray-400 mt-1">
            Agent 실행 시 실시간 윈도우 통계가 표시됩니다
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {['1m', '5m', '1h'].map((window) => {
            const stats = streamingStats[window] ?? {};
            return (
              <div key={window} className="bg-white border border-gray-200 rounded-lg p-4">
                <h5 className="text-xs font-semibold text-gray-900 mb-3">{window} Window</h5>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-[10px] text-gray-500">TCR</span>
                    <span className="text-xs font-bold text-gray-900">{stats.tcr ?? '---'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[10px] text-gray-500">P95 Latency</span>
                    <span className="text-xs font-bold text-gray-900">{stats.p95 ?? '---'}ms</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[10px] text-gray-500">Error Rate</span>
                    <span className="text-xs font-bold text-gray-900">
                      {stats.errorRate ?? '---'}%
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Section 4: Agent별 이상 발생률 */}
      <SectionHeader
        icon={<Cpu size={16} className="text-gray-600" />}
        title="Agent별 이상 발생률"
      />
      <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
              <th className="text-left px-3 py-2.5 font-semibold">Agent</th>
              <th className="text-center px-3 py-2.5 font-semibold">총 평가</th>
              <th className="text-center px-3 py-2.5 font-semibold">이상 건수</th>
              <th className="text-center px-3 py-2.5 font-semibold">이상률</th>
              <th className="px-3 py-2.5 font-semibold">분포</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(agentGroups).map(([name, items]) => {
              const anom = items.filter((e) => e.anomalyDetected).length;
              const rate = items.length > 0 ? (anom / items.length) * 100 : 0;
              return (
                <tr
                  key={name}
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <td className="px-3 py-2.5 text-xs font-medium text-gray-900">{name}</td>
                  <td className="px-3 py-2.5 text-xs text-gray-600 text-center">{items.length}</td>
                  <td className="px-3 py-2.5 text-xs text-center">
                    <span className={anom > 0 ? 'text-red-600 font-bold' : 'text-gray-400'}>
                      {anom}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-center">
                    <span
                      className={`font-bold ${rate > 20 ? 'text-red-600' : rate > 0 ? 'text-amber-600' : 'text-green-600'}`}
                    >
                      {rate.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="h-3 bg-gray-100 rounded-full overflow-hidden w-24">
                      <div
                        className={`h-full rounded-full ${rate > 20 ? 'bg-red-500' : rate > 0 ? 'bg-amber-500' : 'bg-green-500'}`}
                        style={{ width: `${rate}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 5 — Cost Detail (비용 상세)
// ══════════════════════════════════════════════════════════════════════════

function CostTab({ evaluations }: { evaluations: EvaluationResult[] }) {
  if (evaluations.length === 0) {
    return (
      <EmptyState
        icon={<DollarSign size={40} className="text-gray-300" />}
        message="비용 분석 데이터가 없습니다."
      />
    );
  }

  const avgEfficiency =
    evaluations.reduce((s, e) => s + (e.costEfficiency ?? 0), 0) / evaluations.length;
  const totalCost = evaluations.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
  const avgTokens = evaluations.reduce((s, e) => s + (e.tokensUsed ?? 0), 0) / evaluations.length;

  // Latency grades
  const latDist: Record<string, { count: number; label: string; color: string }> = {
    fast: { count: 0, label: 'Fast (<500ms)', color: 'bg-green-500' },
    normal: { count: 0, label: 'Normal (500-1500ms)', color: 'bg-blue-500' },
    slow: { count: 0, label: 'Slow (1500-2500ms)', color: 'bg-amber-500' },
    critical: { count: 0, label: 'Critical (>2500ms)', color: 'bg-red-500' },
  };
  evaluations.forEach((ev) => {
    const ms = ev.executionTimeMs ?? 500;
    if (ms < 500) latDist.fast.count++;
    else if (ms < 1500) latDist.normal.count++;
    else if (ms < 2500) latDist.slow.count++;
    else latDist.critical.count++;
  });
  const maxLat = Math.max(...Object.values(latDist).map((d) => d.count), 1);

  // Agent cost analysis
  const agentGroups = groupByAgent(evaluations);

  // Last 20 cost efficiency
  const last20 = evaluations.slice(0, 20);

  // Aggregated recommendations
  const allRecs = evaluations.flatMap((e) => e.recommendations ?? []);
  const recCounts: Record<string, number> = {};
  allRecs.forEach((r) => {
    recCounts[r] = (recCounts[r] ?? 0) + 1;
  });
  const sortedRecs = Object.entries(recCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Section 1: 비용 효율 개요 */}
      <SectionHeader icon={<Coins size={16} className="text-green-600" />} title="비용 효율 개요" />
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <p className="text-3xl font-bold text-blue-600">{(avgEfficiency * 100).toFixed(1)}%</p>
          <p className="text-xs text-gray-500 mt-1">평균 효율</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <p className="text-3xl font-bold text-amber-600">{krw(totalCost, { decimals: 0 })}</p>
          <p className="text-xs text-gray-500 mt-1">총 추정 비용</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <p className="text-3xl font-bold text-purple-600">{avgTokens.toFixed(0)}</p>
          <p className="text-xs text-gray-500 mt-1">평균 토큰 사용</p>
        </div>
      </div>

      {/* Section 2: 지연시간 등급 분포 */}
      <SectionHeader
        icon={<Timer size={16} className="text-blue-600" />}
        title="지연시간 등급 분포"
      />
      <div className="space-y-2">
        {Object.entries(latDist).map(([key, data]) => (
          <div key={key} className="flex items-center gap-3">
            <span className="text-xs text-gray-700 w-40 font-medium">{data.label}</span>
            <div className="flex-1 h-7 bg-gray-100 rounded-md overflow-hidden">
              <div
                className={`h-full ${data.color} rounded-md transition-all duration-500 flex items-center`}
                style={{
                  width: `${(data.count / maxLat) * 100}%`,
                  minWidth: data.count > 0 ? '24px' : '0',
                }}
              >
                {data.count > 0 && (
                  <span className="text-[10px] text-gray-900 font-bold px-2">{data.count}</span>
                )}
              </div>
            </div>
            <span className="text-xs text-gray-400 w-8 text-right">{data.count}</span>
          </div>
        ))}
      </div>

      {/* Section 3: Agent별 비용 분석 */}
      <SectionHeader icon={<Cpu size={16} className="text-gray-600" />} title="Agent별 비용 분석" />
      <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
              <th className="text-left px-3 py-2.5 font-semibold">Agent</th>
              <th className="text-center px-3 py-2.5 font-semibold">평균 비용</th>
              <th className="text-center px-3 py-2.5 font-semibold">평균 토큰</th>
              <th className="text-center px-3 py-2.5 font-semibold">평균 지연(ms)</th>
              <th className="text-center px-3 py-2.5 font-semibold">평균 효율</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(groupByAgent(evaluations)).map(([name, items]) => {
              const aCost = items.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0) / items.length;
              const aTokens = items.reduce((s, e) => s + (e.tokensUsed ?? 0), 0) / items.length;
              const aLatency =
                items.reduce((s, e) => s + (e.executionTimeMs ?? 0), 0) / items.length;
              const aEff = items.reduce((s, e) => s + (e.costEfficiency ?? 0), 0) / items.length;
              return (
                <tr
                  key={name}
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <td className="px-3 py-2.5 text-xs font-medium text-gray-900">{name}</td>
                  <td className="px-3 py-2.5 text-xs text-gray-600 text-center">
                    {krw(aCost, { decimals: 2 })}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-600 text-center">
                    {aTokens.toFixed(0)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-600 text-center">
                    {aLatency.toFixed(0)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className="text-xs font-bold text-blue-600">
                      {(aEff * 100).toFixed(1)}%
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Shared small components ──────────────────────────────────────────────────
function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <h3 className="text-sm font-bold text-gray-900">{title}</h3>
    </div>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-3">{icon}</div>
      <p className="text-sm text-gray-400">{message}</p>
    </div>
  );
}
