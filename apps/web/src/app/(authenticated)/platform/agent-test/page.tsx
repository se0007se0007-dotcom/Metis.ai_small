'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import {
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Shield,
  DollarSign,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Zap,
  Bot,
  Cpu,
  RefreshCw,
  ListChecks,
  Eye,
  Clock,
  Activity,
  Wrench,
  Code,
  Sparkles,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface AgentDefinition {
  key: string;
  name: string;
  category: 'operations' | 'development' | 'utility';
  version: string;
  status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
  description?: string;
  capabilitiesJson: string[];
  kernelConfigJson: { subAgents: string[] };
}

interface AnomalyEvent {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  value: number;
  threshold: number;
  message: string;
}

interface GateResult {
  quality: {
    score: number;
    accuracy: number;
    hallucinationRate: number;
    grade: string;
    llmJudgeUsed: boolean;
    responseQuality: number;
  };
  security: {
    score: number;
    riskLevel: string;
    inputThreats: number;
    outputLeakage: number;
    toolChainRisk: boolean;
    details: string;
  };
  anomaly: {
    detected: boolean;
    events: AnomalyEvent[];
  };
  cost: {
    efficiency: number;
    latencyGrade: string;
    tokensUsed: number;
    estimatedCostUsd: number;
    executionTimeMs: number;
  };
}

interface SimulationResult {
  id?: string;
  agentKey: string;
  agentName: string;
  executionSessionId?: string;
  overallScore: number;
  grade: string;
  // API returns nested evaluation or flat gates — handle both
  evaluation?: any;
  gates?: any;
  subAgentsUsed: string[];
  input: string;
  output: string;
  context?: string;
  executionTimeMs?: number;
  tokensUsed?: number;
  model?: string;
  source?: string;
  note?: string;
  timestamp: string;
}

interface HistoryEntry {
  index: number;
  agentName: string;
  scenario: string;
  timestamp: string;
  overallScore: number;
  qualityScore: number;
  securityScore: number;
  input?: string;
  output?: string;
  anomalyDetected: boolean;
  costEfficiency: number;
  grade: string;
}

type ExecutionStep = 1 | 2 | 3 | 4 | 5 | 6;

// ── Mock Data ──────────────────────────────────────────────────────────────

const MOCK_AGENTS: AgentDefinition[] = [
  // ── 운영 Agent (7건) — PPT Ops.AI 14개 Main Agent 기준 ──
  {
    key: 'OPS-001',
    name: '테스트 자동화 Agent',
    category: 'operations',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '회귀 테스트 자동 실행, 커버리지 분석, 성능 테스트 리포트 생성',
    capabilitiesJson: ['regression-test', 'coverage-analysis', 'performance-test'],
    kernelConfigJson: { subAgents: ['회귀테스트', '성능테스트'] },
  },
  {
    key: 'OPS-002',
    name: '서비스 모니터링 Agent',
    category: 'operations',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '웹서비스 점검, 이상탐지, 로그분석, 서류검증 — 6종 Sub Agent',
    capabilitiesJson: [
      'monitoring',
      'log-analysis',
      'alert-detection',
      'health-check',
      'anomaly-detection',
      'document-verify',
    ],
    kernelConfigJson: {
      subAgents: ['웹점검', '이상탐지', '로그분석', 'KOS통합', 'B-OS/B-MON', '서류검증'],
    },
  },
  {
    key: 'OPS-003',
    name: '캠페인 모니터링 Agent',
    category: 'operations',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '캠페인 성과 모니터링, 사전점검, 성과 리포트 자동 생성',
    capabilitiesJson: ['campaign-monitor', 'pre-check', 'report-gen'],
    kernelConfigJson: { subAgents: ['성과분석'] },
  },
  {
    key: 'OPS-004',
    name: '변경 영향도 Agent',
    category: 'operations',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '시스템 변경 시 영향 받는 서비스 분석, 위험도 판단, 롤백 플랜',
    capabilitiesJson: ['impact-analysis', 'risk-assessment', 'rollback-plan'],
    kernelConfigJson: { subAgents: ['영향도분석'] },
  },
  {
    key: 'OPS-005',
    name: '이벤트 대응 Agent',
    category: 'operations',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '장애 이벤트 자동 분류, 원인 분석, 대응 방안 제시',
    capabilitiesJson: ['event-classification', 'root-cause', 'response-plan'],
    kernelConfigJson: { subAgents: ['이벤트분류'] },
  },
  {
    key: 'OPS-006',
    name: '지식 자산화 Agent',
    category: 'operations',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '운영 지식 수집, 구조화, 검색 인덱싱 — 3종 Sub Agent',
    capabilitiesJson: ['knowledge-collect', 'structuring', 'search-index'],
    kernelConfigJson: { subAgents: ['지식수집', '구조화', '인덱싱'] },
  },
  {
    key: 'OPS-007',
    name: '품질가디언 Agent',
    category: 'operations',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '코드 품질 점검, 보안 취약점 스캔, 장애 대응 품질 분석',
    capabilitiesJson: ['quality-check', 'vulnerability-scan', 'incident-quality'],
    kernelConfigJson: { subAgents: ['품질점검'] },
  },
  // ── 개발 Agent (4건) ──
  {
    key: 'DEV-001',
    name: 'Spec Agent',
    category: 'development',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '요구사항 분석, 사용자 스토리 생성, 인수 기준 정의',
    capabilitiesJson: ['requirement-analysis', 'user-story', 'acceptance-criteria'],
    kernelConfigJson: { subAgents: ['요구사항분석'] },
  },
  {
    key: 'DEV-002',
    name: '영향도 분석 Agent',
    category: 'development',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '코드 변경 시 영향 범위 분석, 의존성 그래프 추출',
    capabilitiesJson: ['code-impact', 'dependency-graph', 'affected-files'],
    kernelConfigJson: { subAgents: ['코드분석', '의존성추적'] },
  },
  {
    key: 'DEV-003',
    name: 'Dev Agent',
    category: 'development',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '코드 구현, 리팩토링, 최적화 — 5종 Sub Agent',
    capabilitiesJson: ['code-gen', 'refactoring', 'optimization', 'review', 'debug'],
    kernelConfigJson: { subAgents: ['코드생성', '리팩토링', '최적화', '리뷰', '디버깅'] },
  },
  {
    key: 'DEV-004',
    name: 'Test Agent',
    category: 'development',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '단위/통합 테스트 자동 생성, 테스트 커버리지 분석',
    capabilitiesJson: ['unit-test', 'integration-test', 'coverage', 'mock-gen'],
    kernelConfigJson: { subAgents: ['단위테스트', '통합테스트', '커버리지', 'Mock생성'] },
  },
  // ── 고도화 Agent (3건) ──
  {
    key: 'EXT-001',
    name: 'QueryBuddy',
    category: 'utility',
    version: '1.0.0',
    status: 'ACTIVE',
    description: '자연어 → SQL 자동 변환, 쿼리 최적화, 실행 시간 추정',
    capabilitiesJson: ['nl2sql', 'query-optimize', 'execution-plan'],
    kernelConfigJson: { subAgents: ['SQL변환'] },
  },
  {
    key: 'EXT-002',
    name: 'SR Routing Agent',
    category: 'utility',
    version: '1.0.0',
    status: 'ACTIVE',
    description: 'SR(Service Request) 자동 분류 및 최적 팀 할당',
    capabilitiesJson: ['sr-classify', 'team-routing', 'sla-engine'],
    kernelConfigJson: { subAgents: ['분류기', 'SLA엔진'] },
  },
  {
    key: 'EXT-003',
    name: 'SR 영향도 분석 Agent',
    category: 'utility',
    version: '1.0.0',
    status: 'ACTIVE',
    description: 'SR 작업의 시스템 영향도 분석, 타임라인 추정',
    capabilitiesJson: ['system-impact', 'timeline-estimate', 'risk-assess'],
    kernelConfigJson: { subAgents: ['시스템매퍼', '타임라인추정'] },
  },
];

const CATEGORY_CONFIG: Record<
  string,
  {
    label: string;
    labelEn: string;
    color: string;
    bgColor: string;
    borderColor: string;
    icon: React.ReactNode;
  }
> = {
  operations: {
    label: '운영 Agent',
    labelEn: 'Operations',
    color: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    icon: <Wrench size={14} className="text-blue-600" />,
  },
  development: {
    label: '개발 Agent',
    labelEn: 'Development',
    color: 'text-purple-700',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    icon: <Code size={14} className="text-purple-600" />,
  },
  utility: {
    label: '고도화 Agent',
    labelEn: 'Utility',
    color: 'text-green-700',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    icon: <Sparkles size={14} className="text-green-600" />,
  },
};

// ── Transform API response to frontend gates structure ──

function normalizeSimResult(raw: any): SimulationResult {
  const eval_ = raw.evaluation || {};
  const q = eval_.quality || {};
  const s = eval_.security || {};
  const a = eval_.anomaly || {};
  const c = eval_.cost || {};
  const gatesApplied = eval_.gatesApplied || raw.gatesApplied || [];
  const overallScore = Math.round(eval_.overallScore ?? raw.overallScore ?? 0);
  const grade =
    overallScore >= 90
      ? 'A'
      : overallScore >= 80
        ? 'B'
        : overallScore >= 70
          ? 'C'
          : overallScore >= 60
            ? 'D'
            : 'F';

  // Normalize accuracy: ensure 0-100 scale (Layer 0 returns 0-1, LLM Judge returns 0-100)
  let accuracy = q.accuracyScore ?? 0;
  if (accuracy > 0 && accuracy <= 1) accuracy = Math.round(accuracy * 100);

  // Quality score: use completionScore if valid, otherwise derive from overall
  let qualityScore = q.completionScore ?? 0;
  if (qualityScore <= 0) qualityScore = overallScore;

  return {
    ...raw,
    overallScore,
    grade,
    gates: {
      quality: {
        score: qualityScore,
        accuracy,
        hallucinationRate: q.hallucinationRate ?? 0,
        grade: q.qualityGrade ?? grade,
        responseQuality: q.responseQuality ?? 0,
        llmJudgeUsed: gatesApplied.includes('llm-judge'),
      },
      security: {
        score: s.securityScore ?? 100,
        riskLevel: s.securityRiskLevel ?? 'low',
        inputThreats: s.inputThreatCount ?? 0,
        outputLeakage: s.outputLeakageCount ?? 0,
        toolChainRisk: s.toolChainRisk ?? false,
        details: '',
      },
      anomaly: {
        detected: a.anomalyDetected ?? false,
        events: a.events ?? [],
      },
      cost: {
        efficiency: c.costEfficiency ?? 1,
        latencyGrade: c.latencyGrade ?? 'fast',
        tokensUsed: raw.tokensUsed ?? c.tokenEfficiency ?? 0,
        estimatedCostUsd: c.costUsd ?? 0,
        executionTimeMs: raw.executionTimeMs ?? 0,
      },
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getScoreColor(score: number): string {
  if (score >= 90) return 'text-green-600';
  if (score >= 70) return 'text-blue-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function getScoreStrokeColor(score: number): string {
  if (score >= 90) return '#16a34a';
  if (score >= 70) return '#2563eb';
  if (score >= 50) return '#d97706';
  return '#dc2626';
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

function generateMockSimulation(agent: AgentDefinition, customInput?: string): SimulationResult {
  const overallScore = Math.floor(Math.random() * 40) + 58;
  const grades = ['A', 'A', 'B', 'B', 'B', 'C', 'D'];
  const grade =
    overallScore >= 90
      ? 'A'
      : overallScore >= 75
        ? 'B'
        : overallScore >= 60
          ? 'C'
          : overallScore >= 45
            ? 'D'
            : 'F';
  const anomalyDetected = Math.random() < 0.12;

  const usedSubAgents = agent.kernelConfigJson.subAgents.filter(() => Math.random() > 0.3);

  return {
    id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentKey: agent.key,
    agentName: agent.name,
    overallScore,
    grade,
    gates: {
      quality: {
        score: Math.floor(Math.random() * 35) + 63,
        accuracy: +(Math.random() * 0.3 + 0.68).toFixed(3),
        hallucinationRate: +(Math.random() * 0.12).toFixed(3),
        grade,
        llmJudgeUsed: Math.random() < 0.35,
        responseQuality: +(Math.random() * 2 + 3).toFixed(1),
      },
      security: {
        score: Math.floor(Math.random() * 30) + 68,
        riskLevel: ['low', 'low', 'low', 'medium', 'medium', 'high'][Math.floor(Math.random() * 6)],
        inputThreats: Math.floor(Math.random() * 3),
        outputLeakage: Math.floor(Math.random() * 2),
        toolChainRisk: Math.random() < 0.08,
        details:
          Math.random() < 0.3
            ? 'Prompt injection pattern detected in input'
            : 'No threats detected',
      },
      anomaly: {
        detected: anomalyDetected,
        events: anomalyDetected
          ? [
              {
                type: ['latency_spike', 'token_explosion', 'score_drop', 'cost_spike'][
                  Math.floor(Math.random() * 4)
                ],
                severity: (Math.random() < 0.3 ? 'critical' : 'warning') as 'critical' | 'warning',
                value: +(Math.random() * 80 + 40).toFixed(1),
                threshold: 80,
                message: '임계값을 초과한 이상 동작이 감지되었습니다.',
              },
            ]
          : [],
      },
      cost: {
        efficiency: +(Math.random() * 0.4 + 0.55).toFixed(3),
        latencyGrade: ['A', 'B', 'B', 'C', 'D'][Math.floor(Math.random() * 5)],
        tokensUsed: Math.floor(Math.random() * 3500) + 800,
        estimatedCostUsd: +(Math.random() * 0.06 + 0.003).toFixed(4),
        executionTimeMs: Math.floor(Math.random() * 2200) + 200,
      },
    },
    subAgentsUsed: usedSubAgents.length > 0 ? usedSubAgents : [agent.kernelConfigJson.subAgents[0]],
    input:
      customInput ||
      `[${agent.name}] 시뮬레이션 테스트 입력 - ${new Date().toLocaleTimeString('ko-KR')}`,
    output: `[${agent.name}] 시뮬레이션 완료. ${agent.capabilitiesJson.slice(0, 3).join(', ')} 기능을 기반으로 분석을 수행했습니다. 결과 요약: 정상 동작 확인, 모든 점검 항목 통과.`,
    context:
      Math.random() < 0.5
        ? `운영 지식 베이스에서 ${Math.floor(Math.random() * 5) + 1}건의 관련 문서를 참조하였습니다.`
        : undefined,
    timestamp: new Date().toISOString(),
  };
}

// ── Score Gauge SVG Component ──────────────────────────────────────────────

function ScoreGauge({
  value,
  size = 100,
  label,
}: {
  value: number;
  size?: number;
  label?: string;
}) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(value / 100, 1);
  const offset = circumference * (1 - pct);
  const color = getScoreStrokeColor(value);

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={10}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <span
        className={`text-2xl font-bold -mt-[${Math.floor(size / 2 + 8)}px] ${getScoreColor(value)}`}
        style={{ marginTop: -(size / 2 + 8) }}
      >
        {value}
      </span>
      {label && <span className="text-[10px] text-gray-500 mt-6">{label}</span>}
    </div>
  );
}

// ── Execution Progress Component ───────────────────────────────────────────

const STEPS: { step: ExecutionStep; label: string }[] = [
  { step: 1, label: 'Agent 실행 중...' },
  { step: 2, label: '품질 평가 (Layer 0 + LLM Judge)' },
  { step: 3, label: '보안 검사' },
  { step: 4, label: '이상 탐지' },
  { step: 5, label: '비용 분석' },
  { step: 6, label: '결과 저장' },
];

function ExecutionProgress({
  currentStep,
  total,
  current,
}: {
  currentStep: ExecutionStep;
  total?: number;
  current?: number;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-8">
      <div className="flex items-center gap-3 mb-6">
        <Loader2 size={24} className="animate-spin text-blue-600" />
        <div>
          <h3 className="text-sm font-semibold text-gray-900">시뮬레이션 실행 중</h3>
          {total && total > 1 && (
            <p className="text-xs text-gray-500 mt-0.5">
              {current}/{total} 진행 중
            </p>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {STEPS.map(({ step, label }) => {
          const isActive = step === currentStep;
          const isComplete = step < currentStep;
          return (
            <div key={step} className="flex items-center gap-3">
              <div
                className={`flex items-center justify-center w-7 h-7 rounded-full border-2 text-xs font-bold transition-all ${
                  isComplete
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : isActive
                      ? 'border-blue-600 text-blue-600 animate-pulse'
                      : 'border-gray-200 text-gray-400'
                }`}
              >
                {isComplete ? <CheckCircle2 size={14} /> : step}
              </div>
              <span
                className={`text-sm transition-colors ${
                  isComplete
                    ? 'text-gray-500 line-through'
                    : isActive
                      ? 'text-blue-700 font-semibold'
                      : 'text-gray-400'
                }`}
              >
                {label}
              </span>
              {isActive && <Loader2 size={14} className="animate-spin text-blue-500 ml-auto" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Gate Result Card Component ─────────────────────────────────────────────

function GateCard({
  title,
  icon,
  borderColor,
  score,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  borderColor: string;
  score: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`bg-white border rounded-lg shadow-sm overflow-hidden border-l-4 ${borderColor}`}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {icon}
            <span className="text-sm font-semibold text-gray-900">{title}</span>
          </div>
          <span className={`text-xl font-bold ${getScoreColor(score)}`}>{score}</span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-3">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              score >= 90
                ? 'bg-green-500'
                : score >= 70
                  ? 'bg-blue-500'
                  : score >= 50
                    ? 'bg-amber-500'
                    : 'bg-red-500'
            }`}
            style={{ width: `${score}%` }}
          />
        </div>
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}

function GateDetail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium">{value}</span>
    </div>
  );
}

// ── Main Page Component ────────────────────────────────────────────────────

export default function AgentTestPage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<AgentDefinition | null>(null);

  // Execution state
  const [executing, setExecuting] = useState(false);
  const [executionStep, setExecutionStep] = useState<ExecutionStep>(1);
  const [executionTotal, setExecutionTotal] = useState(1);
  const [executionCurrent, setExecutionCurrent] = useState(1);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const historyPage = usePagination(history, 10);
  const historyCounterRef = useRef(0);

  // Input state
  const [customInput, setCustomInput] = useState('');
  const [targetSystem, setTargetSystem] = useState('');
  const [ioExpanded, setIoExpanded] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // ── Fetch Agents ──
  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{
        agentDefinitions?: AgentDefinition[];
        items?: AgentDefinition[];
      }>('/capabilities/agents');
      const items = data?.agentDefinitions || data?.items;
      setAgents(items && items.length > 0 ? items : MOCK_AGENTS);
    } catch {
      setAgents(MOCK_AGENTS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // ── Simulate Execution ──
  const simulateSteps = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      let step = 1;
      setExecutionStep(1);
      const interval = setInterval(
        () => {
          step++;
          if (step > 6) {
            clearInterval(interval);
            resolve();
          } else {
            setExecutionStep(step as ExecutionStep);
          }
        },
        400 + Math.random() * 300,
      );
    });
  }, []);

  const runSingleSimulation = useCallback(
    async (
      agent: AgentDefinition,
      input?: string,
      variation?: string,
    ): Promise<SimulationResult> => {
      try {
        const body: Record<string, string> = {};
        if (input) body.input = input;
        if (targetSystem) body.targetSystem = targetSystem;
        if (variation) body.variation = variation;
        const raw = await api.post<any>(`/capabilities/agents/${agent.key}/simulate`, body);
        const norm = normalizeSimResult(raw);
        return { ...norm, source: raw?.source ?? 'simulated', note: raw?.note };
      } catch (e: any) {
        // 실패 시 가짜 결과 대신 '실패' 라벨 결과를 반환 (오해 방지)
        return {
          agentKey: agent.key,
          agentName: agent.name,
          overallScore: 0,
          grade: '실패',
          subAgentsUsed: [],
          input: input ?? '',
          output: '(시뮬레이션 호출 실패)',
          gates: {
            quality: { score: 0, accuracy: 0, hallucinationRate: 0, grade: '실패', responseQuality: 0, llmJudgeUsed: false },
            security: { score: 0, riskLevel: 'low' },
            cost: { executionTimeMs: 0, tokensUsed: 0 },
          },
          source: 'error',
          note: e?.message ?? '시뮬레이션 API 호출에 실패했습니다.',
          timestamp: new Date().toISOString(),
        } as SimulationResult;
      }
    },
    [targetSystem],
  );

  const addToHistory = useCallback((sim: SimulationResult, scenarioLabel?: string) => {
    historyCounterRef.current += 1;

    // API returns nested `evaluation` object — extract scores safely
    const eval_ = sim.evaluation || {};
    const quality = eval_.quality || {};
    const security = eval_.security || {};
    const anomaly = eval_.anomaly || {};
    const cost = eval_.cost || {};

    const overallScore = eval_.overallScore ?? sim.overallScore ?? 0;

    // Quality score: use completionScore (0-100) if available,
    // otherwise convert accuracyScore from 0-1 to 0-100 scale
    let qualityScore = 0;
    if (typeof quality.completionScore === 'number' && quality.completionScore > 0) {
      qualityScore = quality.completionScore;
    } else if (typeof quality.accuracyScore === 'number') {
      qualityScore =
        quality.accuracyScore <= 1
          ? Math.round(quality.accuracyScore * 100) // Convert 0-1 → 0-100
          : quality.accuracyScore; // Already 0-100
    }
    // Fallback: use overall score as quality proxy
    if (qualityScore === 0 && overallScore > 0) qualityScore = overallScore;

    const securityScore = security.securityScore ?? 100;
    const anomalyDetected = anomaly.anomalyDetected ?? false;
    const costEfficiency = cost.costEfficiency ?? (cost.costEfficiency === 0 ? 0 : 1);

    // Grade from overall score
    const grade =
      overallScore >= 90
        ? 'A'
        : overallScore >= 80
          ? 'B'
          : overallScore >= 70
            ? 'C'
            : overallScore >= 60
              ? 'D'
              : 'F';

    const entry: HistoryEntry = {
      index: historyCounterRef.current,
      agentName: sim.agentName,
      scenario: scenarioLabel || '정상',
      timestamp: new Date(sim.timestamp).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      overallScore,
      qualityScore,
      securityScore,
      anomalyDetected,
      costEfficiency,
      grade,
      input: sim.input,
      output: sim.output,
    };
    setHistory((prev) => [entry, ...prev]);
  }, []);

  const handleSingleRun = useCallback(async () => {
    if (!selectedAgent || executing) return;
    setExecuting(true);
    setResult(null);
    setExecutionTotal(1);
    setExecutionCurrent(1);

    await simulateSteps();
    const sim = await runSingleSimulation(selectedAgent, customInput || undefined);

    setResult(sim);
    addToHistory(sim, '정상');
    setExecuting(false);
  }, [selectedAgent, executing, customInput, simulateSteps, runSingleSimulation, addToHistory]);

  const handleBatchRun = useCallback(async () => {
    if (!selectedAgent || executing) return;
    setExecuting(true);
    setResult(null);
    setExecutionTotal(5);

    // Batch run: mix 5 scenarios to test evaluator's ability to differentiate
    const scenarios: Array<{ variation: string; label: string }> = [
      { variation: 'good', label: '✅ 정상' },
      { variation: 'good', label: '✅ 정상' },
      { variation: 'hallucination', label: '🔴 환각' },
      { variation: 'security', label: '🔴 보안유출' },
      { variation: 'poor', label: '🔴 저품질' },
    ];
    for (let i = 0; i < 5; i++) {
      setExecutionCurrent(i + 1);
      await simulateSteps();
      const sim = await runSingleSimulation(
        selectedAgent,
        customInput || undefined,
        scenarios[i].variation,
      );
      addToHistory(sim, scenarios[i].label);
      if (i === 4) setResult(sim);
    }

    setExecuting(false);
  }, [selectedAgent, executing, customInput, simulateSteps, runSingleSimulation, addToHistory]);

  const handleAllAgentsRun = useCallback(async () => {
    if (executing) return;
    setExecuting(true);
    setResult(null);
    setExecutionTotal(agents.length);

    for (let i = 0; i < agents.length; i++) {
      setExecutionCurrent(i + 1);
      setSelectedAgent(agents[i]);
      await simulateSteps();
      const sim = await runSingleSimulation(agents[i]);
      addToHistory(sim, '정상');
      if (i === agents.length - 1) setResult(sim);
    }

    setExecuting(false);
  }, [agents, executing, simulateSteps, runSingleSimulation, addToHistory]);

  // ── Group agents by category ──
  const grouped: Record<string, AgentDefinition[]> = {
    operations: [],
    development: [],
    utility: [],
  };
  agents.forEach((a) => {
    if (grouped[a.category]) grouped[a.category].push(a);
    else grouped[a.category] = [a];
  });

  // ── History averages ──
  const historyAvg =
    history.length > 0
      ? {
          overall: (history.reduce((s, h) => s + h.overallScore, 0) / history.length).toFixed(1),
          quality: (history.reduce((s, h) => s + h.qualityScore, 0) / history.length).toFixed(1),
          security: (history.reduce((s, h) => s + h.securityScore, 0) / history.length).toFixed(1),
          cost: (
            (history.reduce((s, h) => s + h.costEfficiency, 0) / history.length) *
            100
          ).toFixed(0),
        }
      : null;

  return (
    <div className="space-y-0 min-h-screen bg-gray-50">
      <SubTabs items={[{ label: '평가 결과', href: '/insights/evaluator' }, { label: '실행 테스트', href: '/platform/agent-test' }]} />
      <PageHeader
        title="Agent 실행 테스트"
        description="등록된 14개 Agent 시뮬레이션 실행 및 4-Gate 평가 결과 확인"
        actions={
          <button
            onClick={fetchAgents}
            className="p-2 text-gray-500 hover:text-gray-700 transition rounded-lg hover:bg-gray-100"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        }
      />

      <div className="px-6 pb-6">
        <div className="flex gap-5">
          {/* ── Left Panel (40%) ── */}
          <div className="w-[40%] flex-shrink-0 space-y-4">
            {/* Agent List */}
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
                <Bot size={16} className="text-blue-600" />
                <h3 className="text-sm font-semibold text-gray-900">Agent 목록</h3>
                <span className="ml-auto text-xs text-gray-400 font-medium">
                  {agents.length}개 등록
                </span>
              </div>
              <div className="p-3 max-h-[420px] overflow-y-auto space-y-4">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={20} className="animate-spin text-blue-500 mr-2" />
                    <span className="text-sm text-gray-500">Agent 목록 로드 중...</span>
                  </div>
                ) : (
                  Object.entries(grouped).map(([category, categoryAgents]) => {
                    if (categoryAgents.length === 0) return null;
                    const config = CATEGORY_CONFIG[category];
                    return (
                      <div key={category}>
                        <div className="flex items-center gap-1.5 mb-2 px-1">
                          {config.icon}
                          <span className={`text-xs font-semibold ${config.color}`}>
                            {config.label}
                          </span>
                          <span className="text-[10px] text-gray-400 ml-1">
                            ({categoryAgents.length})
                          </span>
                        </div>
                        <div className="space-y-1.5">
                          {categoryAgents.map((agent) => {
                            const isSelected = selectedAgent?.key === agent.key;
                            return (
                              <button
                                key={agent.key}
                                onClick={() => setSelectedAgent(agent)}
                                disabled={executing}
                                className={`w-full text-left p-3 rounded-lg border transition-all ${
                                  isSelected
                                    ? 'border-blue-500 bg-blue-50/50 shadow-md ring-1 ring-blue-200'
                                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                                } ${executing ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                              >
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs font-semibold text-gray-900">
                                    {agent.name}
                                  </span>
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${config.bgColor} ${config.color} ${config.borderColor}`}
                                  >
                                    {config.labelEn}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-gray-500">
                                  <span className="font-mono">v{agent.version}</span>
                                  <span
                                    className={`px-1.5 py-0.5 rounded-full font-semibold ${
                                      agent.status === 'ACTIVE'
                                        ? 'bg-green-100 text-green-700'
                                        : 'bg-gray-100 text-gray-500'
                                    }`}
                                  >
                                    {agent.status}
                                  </span>
                                  <span className="ml-auto flex items-center gap-1">
                                    <Cpu size={10} />
                                    Sub: {agent.kernelConfigJson.subAgents.length}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Agent Detail & Controls */}
            {selectedAgent && (
              <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
                  <Activity size={16} className="text-blue-600" />
                  <h3 className="text-sm font-semibold text-gray-900">{selectedAgent.name}</h3>
                </div>
                <div className="p-4 space-y-4">
                  {/* Description */}
                  {selectedAgent.description && (
                    <p className="text-xs text-gray-600 leading-relaxed">
                      {selectedAgent.description}
                    </p>
                  )}

                  {/* Sub Agents */}
                  <div>
                    <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5 block">
                      Sub Agents
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedAgent.kernelConfigJson.subAgents.map((sa) => (
                        <span
                          key={sa}
                          className="text-[10px] px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full font-medium"
                        >
                          {sa}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Capabilities */}
                  <div>
                    <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5 block">
                      Capabilities
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedAgent.capabilitiesJson.map((cap) => (
                        <span
                          key={cap}
                          className="text-[10px] px-2 py-1 bg-gray-100 text-gray-600 border border-gray-200 rounded-full font-mono"
                        >
                          {cap}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Input fields */}
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-semibold text-gray-700 mb-1 block">
                        시나리오 입력 <span className="text-gray-400 font-normal">(선택)</span>
                      </label>
                      <textarea
                        value={customInput}
                        onChange={(e) => setCustomInput(e.target.value)}
                        placeholder="커스텀 시나리오를 입력하세요..."
                        rows={2}
                        disabled={executing}
                        className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none bg-gray-50 disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-gray-700 mb-1 block">
                        대상 시스템 <span className="text-gray-400 font-normal">(선택)</span>
                      </label>
                      <input
                        type="text"
                        value={targetSystem}
                        onChange={(e) => setTargetSystem(e.target.value)}
                        placeholder="e.g., KOS, B-OS, B-MON"
                        disabled={executing}
                        className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-gray-50 disabled:opacity-50"
                      />
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={handleSingleRun}
                      disabled={executing}
                      className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                    >
                      <Play size={15} /> 단건 실행
                    </button>
                    <div className="flex gap-2">
                      <button
                        onClick={handleBatchRun}
                        disabled={executing}
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold border border-blue-300 text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ListChecks size={14} /> 연속 실행 (5건)
                      </button>
                      <button
                        onClick={handleAllAgentsRun}
                        disabled={executing}
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold border border-purple-300 text-purple-700 bg-purple-50 rounded-lg hover:bg-purple-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Zap size={14} /> 전체 Agent 실행
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Right Panel (60%) ── */}
          <div className="flex-1 space-y-4">
            {/* Execution Progress or Results */}
            {executing ? (
              <ExecutionProgress
                currentStep={executionStep}
                total={executionTotal}
                current={executionCurrent}
              />
            ) : result ? (
              <>
                {/* Result Header */}
                <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-5">
                  <div className="flex items-center gap-6">
                    <ScoreGauge value={result.overallScore} size={90} />
                    <div className="flex-1 mt-4">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-bold text-gray-900">{result.agentName}</h3>
                        <span
                          className={`text-sm font-bold px-2.5 py-0.5 rounded border ${getGradeBadge(result.grade)}`}
                        >
                          {result.grade}
                        </span>
                        {result.gates.quality.llmJudgeUsed && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded border border-purple-200">
                            LLM Judge
                          </span>
                        )}
                        {(result as any).source === 'error' ? (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 bg-rose-100 text-rose-700 rounded border border-rose-200">실행 실패</span>
                        ) : (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded border border-amber-200" title={(result as any).note || ''}>🧪 시뮬레이션</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">
                        종합 점수{' '}
                        <span className={`font-bold ${getScoreColor(result.overallScore)}`}>
                          {result.overallScore}점
                        </span>{' '}
                        / 실행 시간 {result.gates.cost.executionTimeMs}ms / 토큰{' '}
                        {result.gates.cost.tokensUsed.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 4-Gate Results Grid */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Quality Gate */}
                  <GateCard
                    title="품질 Gate"
                    icon={<BarChart3 size={16} className="text-blue-600" />}
                    borderColor="border-l-blue-500"
                    score={result.gates.quality.score}
                  >
                    <GateDetail
                      label="정확도 (Accuracy)"
                      value={`${(result.gates.quality.accuracy * 100).toFixed(1)}%`}
                    />
                    <GateDetail
                      label="환각률 (Hallucination)"
                      value={
                        <span
                          className={
                            result.gates.quality.hallucinationRate > 0.08
                              ? 'text-red-600'
                              : 'text-green-600'
                          }
                        >
                          {(result.gates.quality.hallucinationRate * 100).toFixed(1)}%
                        </span>
                      }
                    />
                    <GateDetail
                      label="품질 등급"
                      value={
                        <span
                          className={`text-xs font-bold px-1.5 py-0.5 rounded border ${getGradeBadge(result.gates.quality.grade)}`}
                        >
                          {result.gates.quality.grade}
                        </span>
                      }
                    />
                    <GateDetail
                      label="응답 품질"
                      value={`${result.gates.quality.responseQuality}/5.0`}
                    />
                    <GateDetail
                      label="LLM Judge"
                      value={
                        result.gates.quality.llmJudgeUsed ? (
                          <span className="text-purple-600 font-semibold">사용</span>
                        ) : (
                          <span className="text-gray-400">미사용</span>
                        )
                      }
                    />
                  </GateCard>

                  {/* Security Gate */}
                  <GateCard
                    title="보안 Gate"
                    icon={<Shield size={16} className="text-red-600" />}
                    borderColor="border-l-red-500"
                    score={result.gates.security.score}
                  >
                    <GateDetail
                      label="위험 수준"
                      value={
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                            result.gates.security.riskLevel === 'critical'
                              ? 'bg-red-100 text-red-700'
                              : result.gates.security.riskLevel === 'high'
                                ? 'bg-orange-100 text-orange-700'
                                : result.gates.security.riskLevel === 'medium'
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-green-100 text-green-700'
                          }`}
                        >
                          {result.gates.security.riskLevel.toUpperCase()}
                        </span>
                      }
                    />
                    <GateDetail
                      label="입력 위협 탐지"
                      value={
                        <span
                          className={
                            result.gates.security.inputThreats > 0
                              ? 'text-red-600 font-semibold'
                              : ''
                          }
                        >
                          {result.gates.security.inputThreats}건
                        </span>
                      }
                    />
                    <GateDetail
                      label="출력 유출 탐지"
                      value={
                        <span
                          className={
                            result.gates.security.outputLeakage > 0
                              ? 'text-red-600 font-semibold'
                              : ''
                          }
                        >
                          {result.gates.security.outputLeakage}건
                        </span>
                      }
                    />
                    <GateDetail
                      label="도구체인 위험"
                      value={
                        result.gates.security.toolChainRisk ? (
                          <span className="text-red-600 font-semibold">탐지됨</span>
                        ) : (
                          <span className="text-green-600">안전</span>
                        )
                      }
                    />
                    <GateDetail
                      label="상세"
                      value={
                        <span className="text-[10px] text-gray-500 truncate max-w-[180px] inline-block">
                          {result.gates.security.details}
                        </span>
                      }
                    />
                  </GateCard>

                  {/* Anomaly Gate */}
                  <GateCard
                    title="이상탐지 Gate"
                    icon={<AlertTriangle size={16} className="text-amber-600" />}
                    borderColor="border-l-amber-500"
                    score={result.gates.anomaly.detected ? 30 : 95}
                  >
                    <GateDetail
                      label="탐지 결과"
                      value={
                        result.gates.anomaly.detected ? (
                          <span className="flex items-center gap-1 text-red-600 font-semibold">
                            <XCircle size={12} /> 이상 감지
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-green-600 font-semibold">
                            <CheckCircle2 size={12} /> 정상
                          </span>
                        )
                      }
                    />
                    {result.gates.anomaly.detected && result.gates.anomaly.events.length > 0 && (
                      <>
                        {result.gates.anomaly.events.map((evt: any, idx: number) => (
                          <div
                            key={idx}
                            className={`text-[10px] p-2 rounded border mt-1 ${
                              evt.severity === 'critical'
                                ? 'bg-red-50 border-red-200 text-red-700'
                                : 'bg-amber-50 border-amber-200 text-amber-700'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="font-bold uppercase">{evt.severity}</span>
                              <span className="font-mono">{evt.type}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>{evt.message}</span>
                              <span className="font-semibold">
                                {evt.value} / {evt.threshold}
                              </span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                    {!result.gates.anomaly.detected && (
                      <GateDetail label="이벤트" value="이상 이벤트 없음" />
                    )}
                  </GateCard>

                  {/* Cost Gate */}
                  <GateCard
                    title="비용 Gate"
                    icon={<DollarSign size={16} className="text-green-600" />}
                    borderColor="border-l-green-500"
                    score={Math.round(result.gates.cost.efficiency * 100)}
                  >
                    <GateDetail
                      label="비용 효율"
                      value={`${(result.gates.cost.efficiency * 100).toFixed(0)}%`}
                    />
                    <GateDetail
                      label="지연 등급"
                      value={
                        <span
                          className={`text-xs font-bold px-1.5 py-0.5 rounded border ${getGradeBadge(result.gates.cost.latencyGrade)}`}
                        >
                          {result.gates.cost.latencyGrade}
                        </span>
                      }
                    />
                    <GateDetail
                      label="토큰 사용량"
                      value={result.gates.cost.tokensUsed.toLocaleString()}
                    />
                    <GateDetail
                      label="예상 비용"
                      value={krw(result.gates.cost.estimatedCostUsd, { decimals: 2 })}
                    />
                    <GateDetail
                      label="실행 시간"
                      value={`${result.gates.cost.executionTimeMs.toLocaleString()}ms`}
                    />
                  </GateCard>
                </div>

                {/* Input/Output Comparison (Collapsible) */}
                <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
                  <button
                    onClick={() => setIoExpanded(!ioExpanded)}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Eye size={16} className="text-gray-600" />
                      <span className="text-sm font-semibold text-gray-900">입출력 비교</span>
                    </div>
                    {ioExpanded ? (
                      <ChevronUp size={16} className="text-gray-400" />
                    ) : (
                      <ChevronDown size={16} className="text-gray-400" />
                    )}
                  </button>
                  {ioExpanded && (
                    <div className="px-4 pb-4 space-y-3">
                      <div>
                        <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1 block">
                          Input Prompt
                        </label>
                        <div className="bg-gray-100 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 font-mono whitespace-pre-wrap">
                          {result.input}
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1 block">
                          Agent Output
                        </label>
                        <div className="bg-white border border-gray-200 rounded-lg p-3 text-xs text-gray-900 whitespace-pre-wrap">
                          {result.output}
                        </div>
                      </div>
                      {result.context && (
                        <div>
                          <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1 block">
                            Context
                          </label>
                          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 whitespace-pre-wrap">
                            {result.context}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Sub Agents Used */}
                <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Cpu size={16} className="text-gray-600" />
                    <span className="text-sm font-semibold text-gray-900">
                      Sub Agents 실행 경로
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {result.subAgentsUsed.map((sa, idx) => (
                      <span
                        key={sa}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full font-medium"
                      >
                        <span className="w-4 h-4 bg-blue-600 text-white rounded-full text-[9px] flex items-center justify-center font-bold">
                          {idx + 1}
                        </span>
                        {sa}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              /* Empty state */
              <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-16 text-center">
                <Bot size={48} className="mx-auto text-gray-300 mb-4" />
                <h3 className="text-sm font-semibold text-gray-500 mb-1">
                  Agent를 선택하고 실행 테스트를 시작하세요
                </h3>
                <p className="text-xs text-gray-400">
                  좌측 패널에서 Agent를 선택한 후 "단건 실행" 또는 "전체 Agent 실행"을 클릭합니다.
                </p>
              </div>
            )}

            {/* Execution History Table */}
            {history.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
                  <Clock size={16} className="text-gray-600" />
                  <h3 className="text-sm font-semibold text-gray-900">실행 이력</h3>
                  <span className="ml-auto text-xs text-gray-400">{history.length}건</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                        <th className="text-center px-2 py-2.5 font-semibold w-10">#</th>
                        <th className="text-left px-2 py-2.5 font-semibold">Agent</th>
                        <th className="text-center px-2 py-2.5 font-semibold">시나리오</th>
                        <th className="text-center px-2 py-2.5 font-semibold">시간</th>
                        <th className="text-center px-2 py-2.5 font-semibold">종합</th>
                        <th className="text-center px-2 py-2.5 font-semibold">품질</th>
                        <th className="text-center px-2 py-2.5 font-semibold">보안</th>
                        <th className="text-center px-2 py-2.5 font-semibold">이상</th>
                        <th className="text-center px-2 py-2.5 font-semibold">비용</th>
                        <th className="text-center px-2 py-2.5 font-semibold">등급</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyPage.pageItems.map((h) => (
                        <React.Fragment key={h.index}>
                          <tr
                            className="border-b border-gray-100 hover:bg-gray-50 transition-colors text-xs cursor-pointer"
                            onClick={() => setExpandedRow(expandedRow === h.index ? null : h.index)}
                          >
                            <td className="text-center px-2 py-2 text-gray-400 font-mono">
                              {h.index}
                            </td>
                            <td className="px-2 py-2 font-medium text-gray-900 whitespace-nowrap max-w-[140px] truncate">
                              {h.agentName}
                            </td>
                            <td className="text-center px-2 py-2 whitespace-nowrap">
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                                  h.scenario.includes('정상')
                                    ? 'bg-green-100 text-green-700'
                                    : h.scenario.includes('환각')
                                      ? 'bg-red-100 text-red-700'
                                      : h.scenario.includes('보안')
                                        ? 'bg-orange-100 text-orange-700'
                                        : h.scenario.includes('저품질')
                                          ? 'bg-amber-100 text-amber-700'
                                          : 'bg-gray-100 text-gray-700'
                                }`}
                              >
                                {h.scenario}
                              </span>
                            </td>
                            <td className="text-center px-2 py-2 text-gray-500 font-mono whitespace-nowrap">
                              {h.timestamp}
                            </td>
                            <td className="text-center px-2 py-2">
                              <span className={`font-bold ${getScoreColor(h.overallScore)}`}>
                                {h.overallScore}
                              </span>
                            </td>
                            <td className="text-center px-2 py-2">
                              <span className={`font-bold ${getScoreColor(h.qualityScore)}`}>
                                {h.qualityScore}
                              </span>
                            </td>
                            <td className="text-center px-2 py-2">
                              <span className={`font-bold ${getScoreColor(h.securityScore)}`}>
                                {h.securityScore}
                              </span>
                            </td>
                            <td className="text-center px-2 py-2">
                              {h.anomalyDetected ? (
                                <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">
                                  <AlertTriangle size={9} /> 탐지
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">
                                  <CheckCircle2 size={9} /> 정상
                                </span>
                              )}
                            </td>
                            <td className="text-center px-2 py-2">
                              <span
                                className={`font-bold ${getScoreColor(Math.round(h.costEfficiency * 100))}`}
                              >
                                {(h.costEfficiency * 100).toFixed(0)}%
                              </span>
                            </td>
                            <td className="text-center px-2 py-2">
                              <span
                                className={`inline-flex items-center justify-center w-6 h-5 rounded text-[10px] font-bold border ${getGradeBadge(h.grade)}`}
                              >
                                {h.grade}
                              </span>
                            </td>
                          </tr>
                          {expandedRow === h.index && h.input && (
                            <tr key={`${h.index}-detail`}>
                              <td
                                colSpan={10}
                                className="px-4 py-3 bg-gray-50 border-b border-gray-200"
                              >
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <p className="text-[10px] font-semibold text-gray-500 uppercase mb-1">
                                      입력 (Input)
                                    </p>
                                    <div className="bg-white border border-gray-200 rounded p-2 text-xs text-gray-800 whitespace-pre-wrap max-h-32 overflow-y-auto font-mono">
                                      {h.input}
                                    </div>
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-semibold text-gray-500 uppercase mb-1">
                                      출력 (Output)
                                    </p>
                                    <div className="bg-white border border-gray-200 rounded p-2 text-xs text-gray-800 whitespace-pre-wrap max-h-32 overflow-y-auto font-mono">
                                      {h.output}
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                    {historyAvg && (
                      <tfoot>
                        <tr className="bg-gray-50 border-t-2 border-gray-200 text-xs font-semibold">
                          <td className="text-center px-2 py-2.5 text-gray-500" colSpan={3}>
                            평균 ({history.length}건)
                          </td>
                          <td className="text-center px-2 py-2.5">
                            <span
                              className={`font-bold ${getScoreColor(parseFloat(historyAvg.overall))}`}
                            >
                              {historyAvg.overall}
                            </span>
                          </td>
                          <td className="text-center px-2 py-2.5">
                            <span
                              className={`font-bold ${getScoreColor(parseFloat(historyAvg.quality))}`}
                            >
                              {historyAvg.quality}
                            </span>
                          </td>
                          <td className="text-center px-2 py-2.5">
                            <span
                              className={`font-bold ${getScoreColor(parseFloat(historyAvg.security))}`}
                            >
                              {historyAvg.security}
                            </span>
                          </td>
                          <td className="text-center px-2 py-2.5 text-gray-500">-</td>
                          <td className="text-center px-2 py-2.5">
                            <span
                              className={`font-bold ${getScoreColor(parseInt(historyAvg.cost))}`}
                            >
                              {historyAvg.cost}%
                            </span>
                          </td>
                          <td className="text-center px-2 py-2.5 text-gray-500">-</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                  <Pager p={historyPage} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
