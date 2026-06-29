'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import {
  Zap,
  Play,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Clock,
  Layers,
  DollarSign,
  Gauge,
  ArrowRight,
  Loader2,
  Sparkles,
  Trash2,
  ToggleLeft,
  ToggleRight,
  ShieldCheck,
  Settings2,
  Save,
} from 'lucide-react';

// ── Types ──

interface OptimizeResponse {
  cacheHit: boolean;
  cachedResponse: string | null;
  routedTier: number;
  routedModel: string;
  originalModel: string;
  estimatedCostReduction: number;
  optimizationApplied: string[];
  responseTimeMs: number;
  savedUsd?: number;
  savedPct?: number;
  estimatedTokens?: number;
  cacheSimilarity?: number;
}

// Shape returned by GET /finops/token-logs
interface TokenLog {
  id: string;
  agentName: string;
  promptText?: string | null;
  cacheHit: boolean;
  routedTier: number;
  routedModel: string;
  savedUsd?: number;
  optimizedCostUsd?: number;
  originalCostUsd?: number;
  responseTimeMs?: number;
  createdAt: string;
}

interface TokenLogsResponse {
  logs: TokenLog[];
  total: number;
  limit: number;
  offset: number;
}

interface AgentConfig {
  agentName: string;
  cacheEnabled: boolean;
  routerEnabled: boolean;
  packerEnabled: boolean;
  allowedTiers: number[];
  dailyLimitUsd: number;
  namespace: string;
}

interface RunRecord {
  id: number;
  timestamp: Date;
  agentName: string;
  prompt: string;
  config: { cache: boolean; router: boolean; packer: boolean; tiers: number[] };
  result: OptimizeResponse;
}

// ── Presets ──
const PRESET_PROMPTS = [
  {
    label: '간단한 분류',
    prompt: '다음 이메일이 스팸인지 아닌지 분류해줘: "신년 할인 세일 50% 지금 바로 클릭!"',
    description: 'Tier 1 라우팅 예상 (단순 분류)',
  },
  {
    label: '코드 분석',
    prompt:
      'Python으로 작성된 다음 함수의 보안 취약점을 분석하고, SQL injection 가능성을 검토해줘:\ndef get_user(name): return db.execute(f"SELECT * FROM users WHERE name={name}")',
    description: 'Tier 2-3 라우팅 예상 (코드+보안)',
  },
  {
    label: '복잡한 추론',
    prompt:
      '다음 분기 매출 예측 모델을 설계해줘. 지난 3년간 월별 매출 데이터, 계절성, 외부 경제 지표(금리, 환율, 소비자물가지수)를 반영하고, ARIMA와 Prophet 모델을 비교 분석해줘. 코드로 보여줘.',
    description: 'Tier 3 라우팅 예상 (복잡한 분석+코드)',
  },
  {
    label: '단순 번역',
    prompt: 'Translate to English: "오늘 회의는 3시에 시작합니다"',
    description: 'Tier 1 라우팅 + 높은 캐시 적중률',
  },
];

const AGENT_OPTIONS = [
  'RAG-Chatbot',
  'Code-Analyzer',
  'Data-Processor',
  'Risk-Analyzer',
  'Summarizer',
  'Translator',
];

export default function FinOpsDemoPage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  const [agentName, setAgentName] = useState('RAG-Chatbot');
  const [prompt, setPrompt] = useState('');
  const [requestedModel, setRequestedModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<OptimizeResponse | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const runCounter = useRef(0);

  // ── Agent Config State ──
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);

  // ── Load Agent Config ──
  const loadAgentConfig = useCallback(async (name: string) => {
    setConfigLoading(true);
    try {
      const agents = await api.get<AgentConfig[]>('/finops/agents');
      const found = (agents || []).find((a) => a.agentName === name);
      if (found) {
        setAgentConfig({
          agentName: found.agentName,
          cacheEnabled: found.cacheEnabled ?? true,
          routerEnabled: found.routerEnabled ?? true,
          packerEnabled: found.packerEnabled ?? true,
          allowedTiers: found.allowedTiers ?? [1, 2, 3],
          dailyLimitUsd: found.dailyLimitUsd ?? 10,
          namespace: found.namespace ?? 'default',
        });
      } else {
        setAgentConfig({
          agentName: name,
          cacheEnabled: true,
          routerEnabled: true,
          packerEnabled: true,
          allowedTiers: [1, 2, 3],
          dailyLimitUsd: 10,
          namespace: 'default',
        });
      }
      setConfigDirty(false);
    } catch {
      setAgentConfig(null);
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgentConfig(agentName);
  }, [agentName, loadAgentConfig]);

  // ── Load persisted history from backend token-logs (survives navigation) ──
  const loadHistory = useCallback(
    async (name: string) => {
      try {
        const res = await api.get<TokenLogsResponse>(
          `/finops/token-logs?agentName=${encodeURIComponent(name)}&page=1&pageSize=20`,
        );
        const logs = res?.logs ?? [];
        const records: RunRecord[] = logs.map((log, idx) => {
          // Strip the internal [DEMO:hash] marker that optimize() stores
          const rawPrompt = (log.promptText ?? '').replace(/^\[DEMO:[^\]]*\]\s*/, '');
          const baseline = log.originalCostUsd ?? 0;
          const saved = log.savedUsd ?? 0;
          const savedPct = log.cacheHit ? 100 : baseline > 0 ? (saved / baseline) * 100 : 0;
          return {
            id: -(idx + 1), // negative ids → never collide with live runCounter
            timestamp: new Date(log.createdAt),
            agentName: log.agentName,
            prompt: rawPrompt.length > 50 ? rawPrompt.slice(0, 50) + '...' : rawPrompt || '(이력)',
            config: {
              cache: agentConfig?.cacheEnabled ?? true,
              router: agentConfig?.routerEnabled ?? true,
              packer: agentConfig?.packerEnabled ?? true,
              tiers: agentConfig?.allowedTiers ?? [1, 2, 3],
            },
            result: {
              cacheHit: log.cacheHit,
              cachedResponse: null,
              routedTier: log.routedTier,
              routedModel: log.routedModel,
              originalModel: '',
              estimatedCostReduction: Math.round(savedPct),
              optimizationApplied: [],
              responseTimeMs: log.responseTimeMs ?? 0,
              savedUsd: saved,
              savedPct,
            },
          };
        });
        setHistory(records);
      } catch {
        // ignore — history is best-effort
      }
    },
    [agentConfig],
  );

  useEffect(() => {
    loadHistory(agentName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);

  // ── Save Agent Config ──
  const saveAgentConfig = async () => {
    if (!agentConfig) return;
    setConfigSaving(true);
    try {
      await api.put(`/finops/agents/${agentConfig.agentName}`, {
        cacheEnabled: agentConfig.cacheEnabled,
        routerEnabled: agentConfig.routerEnabled,
        packerEnabled: agentConfig.packerEnabled,
        allowedTiers: agentConfig.allowedTiers,
        dailyLimitUsd: agentConfig.dailyLimitUsd,
        namespace: agentConfig.namespace,
      });
      setConfigDirty(false);
    } catch {
      // save failed
    } finally {
      setConfigSaving(false);
    }
  };

  // ── Toggle helpers ──
  const toggleGate = (gate: 'cacheEnabled' | 'routerEnabled' | 'packerEnabled') => {
    if (!agentConfig) return;
    setAgentConfig({ ...agentConfig, [gate]: !agentConfig[gate] });
    setConfigDirty(true);
  };

  const toggleTier = (tier: number) => {
    if (!agentConfig) return;
    const tiers = agentConfig.allowedTiers.includes(tier)
      ? agentConfig.allowedTiers.filter((t) => t !== tier)
      : [...agentConfig.allowedTiers, tier].sort();
    if (tiers.length === 0) return; // At least one tier must remain
    setAgentConfig({ ...agentConfig, allowedTiers: tiers });
    setConfigDirty(true);
  };

  // ── Run Optimization ──
  const runOptimize = async (overridePrompt?: string) => {
    const targetPrompt = overridePrompt ?? prompt;
    if (!targetPrompt.trim()) return;

    // Save config first if dirty
    if (configDirty) await saveAgentConfig();

    setLoading(true);
    setError(null);
    setLastResult(null);

    try {
      const result = await api.post<OptimizeResponse>('/finops/optimize', {
        agentName,
        prompt: targetPrompt,
        requestedModel: requestedModel || undefined,
      });

      setLastResult(result);
      runCounter.current += 1;
      setHistory((prev) => [
        {
          id: runCounter.current,
          timestamp: new Date(),
          agentName,
          prompt: targetPrompt.length > 50 ? targetPrompt.slice(0, 50) + '...' : targetPrompt,
          config: {
            cache: agentConfig?.cacheEnabled ?? true,
            router: agentConfig?.routerEnabled ?? true,
            packer: agentConfig?.packerEnabled ?? true,
            tiers: agentConfig?.allowedTiers ?? [1, 2, 3],
          },
          result,
        },
        ...prev,
      ]);
    } catch (err: any) {
      setError(err.message ?? 'API 호출 실패');
    } finally {
      setLoading(false);
    }
  };

  // ── Stats ──
  const totalRuns = history.length;
  const cacheHits = history.filter((r) => r.result.cacheHit).length;
  const avgReduction =
    totalRuns > 0
      ? history.reduce((sum, r) => sum + r.result.estimatedCostReduction, 0) / totalRuns
      : 0;

  return (
    <div className="p-6">
      <SubTabs
        items={[
          { label: 'FinOps', href: '/insights/finops' },
          { label: '3-Gate 데모', href: '/insights/finops-demo' },
          { label: '정책 실험실', href: '/insights/finops-lab' },
        ]}
      />
      <PageHeader
        title="FinOps 3-Gate 데모"
        description="Agent별 Gate 설정을 변경하면서 3-Gate 토큰 최적화 파이프라인을 실시간 테스트합니다"
      />

      {/* Pipeline Diagram */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 mb-6">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">3-Gate Pipeline Flow</p>
        <div className="flex items-center gap-2 justify-center flex-wrap">
          <PipelineStep icon="📝" label="프롬프트" />
          <ArrowRight size={16} className="text-gray-500" />
          <PipelineStep
            icon="🔍"
            label="Gate 1: 캐시"
            enabled={agentConfig?.cacheEnabled}
            active={lastResult?.optimizationApplied?.includes('SEMANTIC_CACHE')}
          />
          <ArrowRight size={16} className="text-gray-500" />
          <PipelineStep
            icon="🔀"
            label="Gate 2: 라우터"
            enabled={agentConfig?.routerEnabled}
            active={lastResult?.optimizationApplied?.includes('MODEL_ROUTER')}
          />
          <ArrowRight size={16} className="text-gray-500" />
          <PipelineStep
            icon="📦"
            label="Gate 3: 패커"
            enabled={agentConfig?.packerEnabled}
            active={lastResult?.optimizationApplied?.includes('SKILL_PACKER')}
          />
          <ArrowRight size={16} className="text-gray-500" />
          <PipelineStep icon="✅" label="결과" />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 mb-6">
        {/* ════════════════════════════════════════════ */}
        {/* Left: Agent Config Panel (4 cols) */}
        {/* ════════════════════════════════════════════ */}
        <div className="col-span-4 space-y-4">
          {/* Agent Selector */}
          <div>
            <label className="text-[11px] text-muted-dark font-semibold mb-1.5 block">
              Agent 선택
            </label>
            <select
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-white border border-gray-200 rounded text-gray-900 focus:outline-none focus:border-accent"
            >
              {AGENT_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          {/* Agent Gate Config */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Settings2 size={14} className="text-accent" />
                <span className="text-xs font-semibold text-gray-900">Agent Gate 설정</span>
              </div>
              {configDirty && (
                <button
                  onClick={saveAgentConfig}
                  disabled={configSaving}
                  className="text-[10px] px-2 py-1 bg-accent/20 text-accent rounded hover:bg-accent/30 transition flex items-center gap-1"
                >
                  {configSaving ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <Save size={10} />
                  )}
                  저장
                </button>
              )}
            </div>

            {configLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            ) : agentConfig ? (
              <div className="space-y-3">
                {/* Gate 1: Cache Toggle */}
                <GateToggle
                  label="Gate 1: 시맨틱 캐시"
                  description="동일/유사 프롬프트 재사용 → 70% 절감"
                  enabled={agentConfig.cacheEnabled}
                  onToggle={() => toggleGate('cacheEnabled')}
                  color="green"
                />

                {/* Gate 2: Router Toggle */}
                <GateToggle
                  label="Gate 2: 모델 라우터"
                  description="복잡도 기반 최적 Tier/모델 자동 선택"
                  enabled={agentConfig.routerEnabled}
                  onToggle={() => toggleGate('routerEnabled')}
                  color="cyan"
                />

                {/* Gate 3: Packer Toggle */}
                <GateToggle
                  label="Gate 3: 스킬 패커"
                  description="프롬프트 압축 및 토큰 최적화"
                  enabled={agentConfig.packerEnabled}
                  onToggle={() => toggleGate('packerEnabled')}
                  color="gold"
                />

                {/* Allowed Tiers */}
                <div className="pt-2 border-t border-gray-200">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">허용 Tier</p>
                  <div className="flex gap-2">
                    {[1, 2, 3].map((tier) => {
                      const isAllowed = agentConfig.allowedTiers.includes(tier);
                      return (
                        <button
                          key={tier}
                          onClick={() => toggleTier(tier)}
                          className={`flex-1 py-1.5 text-xs font-bold rounded transition ${
                            isAllowed
                              ? tier === 1
                                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                : tier === 2
                                  ? 'bg-accent/20 text-accent border border-accent/30'
                                  : 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                              : 'bg-gray-50 text-gray-500/60 border border-gray-200 line-through'
                          }`}
                        >
                          Tier {tier}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Daily Limit */}
                <div className="pt-2 border-t border-gray-200">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">일일 한도</p>
                    <span className="text-xs font-bold text-accent">
                      ${agentConfig.dailyLimitUsd}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-500">네임스페이스: {agentConfig.namespace}</p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500">설정을 불러올 수 없습니다</p>
            )}
          </div>

          {/* Presets */}
          <div>
            <label className="text-[11px] text-muted-dark font-semibold mb-1.5 block">
              프리셋 프롬프트
            </label>
            <div className="space-y-1.5">
              {PRESET_PROMPTS.map((preset, i) => (
                <button
                  key={i}
                  onClick={() => setPrompt(preset.prompt)}
                  className="w-full text-left p-2 bg-white border border-gray-200 rounded hover:border-accent/20 transition group"
                >
                  <p className="text-[11px] font-semibold text-gray-900 group-hover:text-accent transition">
                    {preset.label}
                  </p>
                  <p className="text-[10px] text-gray-500">{preset.description}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ════════════════════════════════════════════ */}
        {/* Right: Prompt Input + Results (8 cols) */}
        {/* ════════════════════════════════════════════ */}
        <div className="col-span-8 space-y-4">
          {/* Prompt Input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] text-muted-dark font-semibold">프롬프트</label>
              <input
                type="text"
                value={requestedModel}
                onChange={(e) => setRequestedModel(e.target.value)}
                placeholder="모델 지정 (비워두면 자동)"
                className="px-2 py-1 text-[10px] bg-white border border-gray-200 rounded text-gray-900 placeholder-white/20 focus:outline-none focus:border-accent w-48"
              />
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="AI에게 보낼 프롬프트를 입력하세요. 같은 프롬프트를 두 번 보내면 캐시 Hit를 확인할 수 있습니다."
              className="w-full px-3 py-2 text-xs bg-white border border-gray-200 rounded text-gray-900 placeholder-white/20 focus:outline-none focus:border-accent resize-none font-mono"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={() => runOptimize()}
              disabled={loading || !prompt.trim()}
              className="flex-1 py-2.5 text-xs font-semibold bg-accent/20 text-accent rounded hover:bg-accent/30 transition disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> 실행 중...
                </>
              ) : (
                <>
                  <Play size={14} /> 3-Gate 파이프라인 실행
                </>
              )}
            </button>
            <button
              onClick={() => runOptimize()}
              disabled={loading || !prompt.trim()}
              className="px-4 py-2.5 text-xs font-semibold border border-accent/30 text-accent rounded hover:bg-accent/10 transition disabled:opacity-40 flex items-center gap-2"
              title="같은 프롬프트 재전송 → 캐시 Hit 테스트"
            >
              <RotateCcw size={14} /> 재전송 (캐시)
            </button>
            <button
              onClick={() => {
                setHistory([]);
                setLastResult(null);
              }}
              className="px-3 py-2.5 text-xs text-muted-dark border border-gray-200 rounded hover:border-gray-200/50 transition"
            >
              <Trash2 size={14} />
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
              <XCircle size={14} /> {error}
            </div>
          )}

          {/* ═══ Result Panel ═══ */}
          {lastResult && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={16} className="text-accent" />
                <span className="text-sm font-semibold text-gray-900">최적화 결과</span>
                <span className="text-[10px] text-gray-500 ml-auto">
                  {lastResult.responseTimeMs}ms
                </span>
              </div>

              <div className="grid grid-cols-4 gap-3 mb-4">
                {/* Cache */}
                <ResultCard
                  label="Gate 1: 캐시"
                  enabled={agentConfig?.cacheEnabled ?? true}
                  value={lastResult.cacheHit ? 'HIT ✓' : 'MISS'}
                  valueColor={lastResult.cacheHit ? 'success' : 'muted'}
                  sub={
                    lastResult.cacheHit
                      ? `의미 유사도 ${((lastResult.cacheSimilarity ?? 1) * 100).toFixed(1)}% → 100% 절감`
                      : agentConfig?.cacheEnabled
                        ? lastResult.cacheSimilarity && lastResult.cacheSimilarity > 0
                          ? `최고 유사도 ${(lastResult.cacheSimilarity * 100).toFixed(1)}% (임계값 미달) → 캐시 저장됨`
                          : '새 프롬프트 → 캐시 저장됨'
                        : 'Gate OFF — 캐시 미사용'
                  }
                />

                {/* Tier */}
                <ResultCard
                  label="Gate 2: 라우팅"
                  enabled={agentConfig?.routerEnabled ?? true}
                  value={`Tier ${lastResult.routedTier}`}
                  valueColor="accent"
                  sub={
                    agentConfig?.routerEnabled
                      ? `허용: [${agentConfig?.allowedTiers?.join(', ')}]`
                      : 'Gate OFF — 기본 Tier 사용'
                  }
                />

                {/* Model */}
                <ResultCard
                  label="선택 모델"
                  value={lastResult.routedModel || '-'}
                  valueColor="white"
                  sub={
                    lastResult.originalModel && lastResult.originalModel !== lastResult.routedModel
                      ? `원래: ${lastResult.originalModel}`
                      : '자동 선택'
                  }
                  small
                />

                {/* Cost */}
                <ResultCard
                  label="비용 절감"
                  value={
                    lastResult.cacheHit
                      ? '100%'
                      : `${Math.round(lastResult.savedPct ?? lastResult.estimatedCostReduction)}%`
                  }
                  valueColor={
                    (lastResult.savedPct ?? lastResult.estimatedCostReduction) > 50
                      ? 'success'
                      : (lastResult.savedPct ?? lastResult.estimatedCostReduction) > 20
                        ? 'accent'
                        : 'muted'
                  }
                  sub={
                    (lastResult.savedUsd ?? 0) > 0
                      ? `${lastResult.cacheHit ? 'T2 회피 ' : '절감 '}${krw(lastResult.savedUsd ?? 0, { decimals: 2 })}`
                      : `적용: ${lastResult.optimizationApplied.length}개 Gate`
                  }
                />
              </div>

              {/* Applied Gates */}
              <div className="bg-black/20 rounded p-3">
                <p className="text-[10px] text-gray-500 uppercase mb-2">적용된 최적화</p>
                <div className="flex gap-2 flex-wrap">
                  {['SEMANTIC_CACHE', 'MODEL_ROUTER', 'SKILL_PACKER'].map((gate) => {
                    const applied = lastResult.optimizationApplied.includes(gate);
                    const gateEnabled =
                      gate === 'SEMANTIC_CACHE'
                        ? agentConfig?.cacheEnabled
                        : gate === 'MODEL_ROUTER'
                          ? agentConfig?.routerEnabled
                          : agentConfig?.packerEnabled;

                    return (
                      <span
                        key={gate}
                        className={`text-[10px] px-2 py-1 rounded font-semibold ${
                          applied
                            ? 'bg-success/20 text-success'
                            : gateEnabled
                              ? 'bg-gray-100 text-gray-500'
                              : 'bg-danger/10 text-danger/50 line-through'
                        }`}
                      >
                        {gate === 'SEMANTIC_CACHE' && '🔍 캐시'}
                        {gate === 'MODEL_ROUTER' && '🔀 라우터'}
                        {gate === 'SKILL_PACKER' && '📦 패커'}
                        {applied ? ' ✓' : gateEnabled ? '' : ' OFF'}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ═══ Session Stats ═══ */}
          {totalRuns > 0 && (
            <div className="grid grid-cols-4 gap-3">
              <MiniStat label="총 실행" value={`${totalRuns}회`} icon={Play} />
              <MiniStat
                label="캐시 Hit"
                value={`${cacheHits}회 (${totalRuns > 0 ? ((cacheHits / totalRuns) * 100).toFixed(0) : 0}%)`}
                icon={CheckCircle2}
                color="success"
              />
              <MiniStat
                label="평균 절감"
                value={`${avgReduction.toFixed(0)}%`}
                icon={DollarSign}
                color="accent"
              />
              <MiniStat label="캐시 Miss" value={`${totalRuns - cacheHits}회`} icon={XCircle} />
            </div>
          )}

          {/* ═══ History Table ═══ */}
          {history.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-900">실행 이력 비교</span>
                <span className="text-[10px] text-gray-500">{history.length}건</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Agent</th>
                      <th className="text-left px-3 py-2">프롬프트</th>
                      <th className="text-center px-3 py-2">Gate설정</th>
                      <th className="text-center px-3 py-2">캐시</th>
                      <th className="text-center px-3 py-2">Tier</th>
                      <th className="text-left px-3 py-2">모델</th>
                      <th className="text-right px-3 py-2">절감</th>
                      <th className="text-right px-3 py-2">ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((run) => (
                      <tr
                        key={run.id}
                        className="border-b border-gray-200 hover:bg-gray-50 transition"
                      >
                        <td className="px-3 py-2 text-[11px] text-gray-500 font-mono">{run.id}</td>
                        <td className="px-3 py-2 text-[11px] text-gray-900 font-medium">
                          {run.agentName}
                        </td>
                        <td className="px-3 py-2 text-[10px] text-gray-500 max-w-[140px] truncate">
                          {run.prompt}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex gap-0.5 justify-center">
                            <GateBadge label="C" enabled={run.config.cache} />
                            <GateBadge label="R" enabled={run.config.router} />
                            <GateBadge label="P" enabled={run.config.packer} />
                            <span className="text-[8px] text-gray-500 ml-0.5">
                              [{run.config.tiers.join('')}]
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          {run.result.cacheHit ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/20 text-success font-bold">
                              HIT
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-bold">
                              MISS
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              run.result.routedTier === 1
                                ? 'bg-green-500/20 text-green-400'
                                : run.result.routedTier === 2
                                  ? 'bg-accent/20 text-accent'
                                  : 'bg-orange-500/20 text-orange-400'
                            }`}
                          >
                            T{run.result.routedTier}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[10px] text-gray-500 font-mono truncate max-w-[100px]">
                          {run.result.routedModel}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="text-xs font-semibold text-success">
                            {run.result.cacheHit
                              ? '100%'
                              : `${Math.round(run.result.savedPct ?? run.result.estimatedCostReduction)}%`}
                          </div>
                          {(run.result.savedUsd ?? 0) > 0 && (
                            <div className="text-[9px] text-gray-500 font-mono">
                              {run.result.cacheHit ? 'T2 회피 ' : ''}$
                              {(run.result.savedUsd ?? 0).toFixed(4)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-right text-gray-500 font-mono">
                          {run.result.responseTimeMs}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Guide */}
          {history.length === 0 && !lastResult && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 text-center">
              <Zap size={40} className="mx-auto mb-3 text-accent/30" />
              <p className="text-sm font-semibold text-gray-900 mb-3">
                Agent별 3-Gate 최적화 비교 테스트
              </p>
              <div className="text-xs text-gray-500 space-y-2 max-w-xl mx-auto text-left">
                <p>
                  <strong className="text-accent">테스트 1: 캐시 효과 확인</strong> — 같은
                  프롬프트를 2번 보내세요. 첫 번째는 MISS, 두 번째는 HIT(70% 절감)
                </p>
                <p>
                  <strong className="text-accent">테스트 2: Gate 토글 비교</strong> — 왼쪽에서
                  캐시를 OFF하고 같은 프롬프트를 보내면 HIT 대신 MISS가 됩니다
                </p>
                <p>
                  <strong className="text-accent">테스트 3: Tier 제한 비교</strong> —
                  Translator(Tier 1만)와 Code-Analyzer(Tier 2-3)에 동일 프롬프트를 보내고 라우팅
                  차이를 비교하세요
                </p>
                <p>
                  <strong className="text-accent">테스트 4: 패커 효과</strong> — 패커를 ON/OFF하면서
                  프롬프트 최적화 적용 여부 차이를 확인하세요
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub Components ──

function PipelineStep({
  icon,
  label,
  enabled,
  active,
}: {
  icon: string;
  label: string;
  enabled?: boolean;
  active?: boolean;
}) {
  const style =
    enabled === false
      ? 'border-danger/30 bg-danger/5 opacity-50'
      : active
        ? 'border-success bg-success/10'
        : 'border-gray-200 bg-white';

  return (
    <div className={`px-3 py-2 rounded-lg border ${style} text-center min-w-[90px] transition-all`}>
      <span className="text-sm">{icon}</span>
      <p className="text-[9px] text-gray-500 mt-0.5 whitespace-nowrap">{label}</p>
      {enabled === false && <p className="text-[8px] text-danger font-bold">OFF</p>}
    </div>
  );
}

function GateToggle({
  label,
  description,
  enabled,
  onToggle,
  color,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    green: 'text-success',
    cyan: 'text-accent',
    gold: 'text-warning',
  };

  return (
    <div className="flex items-start gap-3">
      <button onClick={onToggle} className="mt-0.5 shrink-0">
        {enabled ? (
          <ToggleRight size={24} className={colorMap[color] ?? 'text-accent'} />
        ) : (
          <ToggleLeft size={24} className="text-gray-500/60" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <p
          className={`text-[11px] font-semibold ${enabled ? 'text-gray-900' : 'text-gray-500/60 line-through'}`}
        >
          {label}
        </p>
        <p className="text-[10px] text-gray-500">{description}</p>
      </div>
    </div>
  );
}

function ResultCard({
  label,
  value,
  valueColor,
  sub,
  enabled,
  small,
}: {
  label: string;
  value: string;
  valueColor: string;
  sub: string;
  enabled?: boolean;
  small?: boolean;
}) {
  const colors: Record<string, string> = {
    success: 'text-success',
    accent: 'text-accent',
    muted: 'text-gray-500',
    white: 'text-gray-900',
  };
  return (
    <div
      className={`rounded-lg border p-3 ${enabled === false ? 'border-danger/20 bg-danger/5' : 'border-gray-200 bg-gray-50'}`}
    >
      <p className="text-[10px] text-gray-500 uppercase mb-1">{label}</p>
      <p
        className={`${small ? 'text-xs' : 'text-lg'} font-bold ${colors[valueColor] ?? 'text-gray-900'} truncate`}
      >
        {value}
      </p>
      <p className="text-[10px] text-gray-500 mt-1 truncate">{sub}</p>
    </div>
  );
}

function GateBadge({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <span
      className={`text-[8px] w-4 h-4 flex items-center justify-center rounded font-bold ${
        enabled ? 'bg-success/20 text-success' : 'bg-danger/15 text-danger/50'
      }`}
    >
      {label}
    </span>
  );
}

function MiniStat({
  label,
  value,
  icon: Icon,
  color = 'white',
}: {
  label: string;
  value: string;
  icon: any;
  color?: string;
}) {
  const colors: Record<string, string> = {
    accent: 'text-accent',
    success: 'text-success',
    white: 'text-gray-900',
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={12} className={colors[color]} />
        <span className="text-[10px] text-gray-500 uppercase">{label}</span>
      </div>
      <p className={`text-sm font-bold ${colors[color]}`}>{value}</p>
    </div>
  );
}
