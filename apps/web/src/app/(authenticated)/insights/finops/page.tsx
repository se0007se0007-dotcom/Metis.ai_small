'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import {
  RefreshCw, DollarSign, TrendingUp, TrendingDown, Sparkles, Settings2, Gauge, AlertCircle,
  Zap, BarChart3, Clock, Layers, CheckCircle2, XCircle, Loader2,
} from 'lucide-react';

// ── Types (백엔드 DTO와 정렬) ──

interface FinOpsStats {
  totalRequests: number;
  cacheHitRate: number;
  estimatedDailyCostUsd: number;
  estimatedSavingsUsd: number;
  avgResponseTimeMs: number;
  requestsByTier: { tier1: number; tier2: number; tier3: number };
  topAgents: Array<{
    agentName: string;
    requestCount: number;
    cacheHitRate: number;
    savedUsd: number;
  }>;
  hourlyTrend: Array<{
    hour: string;
    requests: number;
    cacheHits: number;
    avgCostUsd: number;
  }>;
}

interface CostForecast {
  currentMonthActual: number;
  projectedMonthTotal: number;
  previousMonthTotal: number;
  monthOverMonthPct: number;
  daysElapsed: number;
  totalDays: number;
  confidence: number;
  method: string;
}

interface SimulationResult {
  baselineMonthlyCost: number;
  simulatedMonthlyCost: number;
  savings: number;
  savingsPct: number;
  breakdown: { cache: number; tier: number; skill: number };
}

interface Recommendation {
  id: string;
  title: string;
  description: string;
  estimatedSavingsMonthly: number;
  category: 'tier' | 'cache' | 'skill';
  actionable: boolean;
  autoApplyAvailable: boolean;
}

interface TokenLog {
  id: string;
  agentName: string;
  totalTokens: number;
  cacheHit: boolean;
  routedTier: number;
  routedModel: string;
  optimizedCostUsd: number;
  savedUsd: number;
  responseTimeMs: number;
  createdAt: string;
}

interface TokenLogsResponse {
  logs: TokenLog[];
  total: number;
  limit: number;
  offset: number;
}

// ── Page Component ──

export default function FinOpsPage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  const [tab, setTab] = useState<'current' | 'predict' | 'recommend' | 'logs'>('current');
  const [stats, setStats] = useState<FinOpsStats | null>(null);
  const [forecast, setForecast] = useState<CostForecast | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [tokenLogs, setTokenLogs] = useState<TokenLog[]>([]);
  const tokenLogsPage = usePagination(tokenLogs, 10);
  const [tokenLogTotal, setTokenLogTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // What-If Simulator State
  const [cacheTTLMultiplier, setCacheTTLMultiplier] = useState(1.0);
  const [tierDowngrade, setTierDowngrade] = useState(0);
  const [skillBudgetMultiplier, setSkillBudgetMultiplier] = useState(1.0);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);

  // Recommendation apply state
  const [applyingRecId, setApplyingRecId] = useState<string | null>(null);
  const [appliedRecs, setAppliedRecs] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsData, forecastData, recsData, logsData] = await Promise.all([
        api.get<FinOpsStats>('/finops/stats').catch(() => null),
        api.get<CostForecast>('/finops/predict/monthly').catch(() => null),
        api.get<Recommendation[]>('/finops/recommendations').catch(() => []),
        api.get<TokenLogsResponse>('/finops/token-logs?pageSize=50').catch(() => null),
      ]);

      setStats(statsData);
      setForecast(forecastData);
      setRecommendations(Array.isArray(recsData) ? recsData : []);
      if (logsData && logsData.logs) {
        setTokenLogs(logsData.logs);
        setTokenLogTotal(logsData.total);
      }
    } catch (err: any) {
      setError(err.message ?? 'FinOps 데이터를 불러오는 데 실패했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── What-If Simulation (백엔드 연동) ──
  const runSimulation = async () => {
    setSimulating(true);
    try {
      const result = await api.post<SimulationResult>('/finops/simulate', {
        cacheTTLMultiplier: cacheTTLMultiplier > 1 ? cacheTTLMultiplier : undefined,
        tierDowngrade: tierDowngrade > 0 ? tierDowngrade : undefined,
        skillTokenBudgetMultiplier: skillBudgetMultiplier !== 1 ? skillBudgetMultiplier : undefined,
      });
      setSimResult(result);
    } catch {
      setSimResult(null);
    } finally {
      setSimulating(false);
    }
  };

  // ── Apply Recommendation (백엔드 연동) ──
  const applyRecommendation = async (recId: string) => {
    setApplyingRecId(recId);
    try {
      const result = await api.post<{ applied: boolean; message: string }>(
        `/finops/recommendations/${recId}/apply`,
        {},
      );
      if (result.applied) {
        setAppliedRecs((prev) => new Set(prev).add(recId));
      }
    } catch {
      // failed
    } finally {
      setApplyingRecId(null);
    }
  };

  // Derived values for display
  const monthCost = forecast?.currentMonthActual ?? 0;
  const prevMonthCost = forecast?.previousMonthTotal ?? 0;
  const momPct = forecast?.monthOverMonthPct ?? 0;
  const cacheHitRate = stats?.cacheHitRate ?? 0;
  const dailySavings = stats?.estimatedSavingsUsd ?? 0;

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
        title="FinOps 인사이트"
        description="비용 분석 · 예측 · 최적화 추천 — 3-Gate Token Optimization Engine"
        actions={
          <button
            onClick={fetchData}
            className="p-1.5 text-muted-dark hover:text-dark transition"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        }
      />

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {(['current', 'predict', 'recommend', 'logs'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-semibold border-b-2 transition ${
              tab === t
                ? 'text-accent border-accent'
                : 'text-muted-dark border-transparent hover:text-dark'
            }`}
          >
            {t === 'current' && '📊 현황'}
            {t === 'predict' && '🔮 예측/시뮬레이션'}
            {t === 'recommend' && '💡 추천'}
            {t === 'logs' && '📋 토큰 로그'}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════ */}
      {/* Tab: 현황 (Current) */}
      {/* ════════════════════════════════════════════ */}
      {tab === 'current' && (
        <div className="space-y-6">
          {/* Summary Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={DollarSign}
              label="이번달 비용"
              value={krw(monthCost, { decimals: 0 })}
              sub={`전월: ${krw(prevMonthCost, { decimals: 0 })}`}
              color="accent"
            />
            <StatCard
              icon={momPct > 0 ? TrendingUp : TrendingDown}
              label="전월 대비"
              value={`${momPct > 0 ? '+' : ''}${momPct.toFixed(1)}%`}
              sub={forecast ? `예측: ${krw(forecast.projectedMonthTotal, { decimals: 0 })}` : ''}
              color={momPct > 0 ? 'danger' : 'success'}
            />
            <StatCard
              icon={Gauge}
              label="캐시 Hit률"
              value={`${cacheHitRate.toFixed(1)}%`}
              sub={`오늘 요청: ${stats?.totalRequests ?? 0}건`}
              color="warning"
            />
            <StatCard
              icon={Zap}
              label="오늘 절감액"
              value={krw(dailySavings, { decimals: 0 })}
              sub={`응답시간: ${stats?.avgResponseTimeMs ?? 0}ms`}
              color="success"
            />
          </div>

          {/* Tier Distribution */}
          {stats && stats.totalRequests > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
              <p className="text-xs font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Layers size={14} className="text-accent" />
                Tier 분포 (오늘)
              </p>
              <div className="flex gap-4">
                {[
                  { label: 'Tier 1 (경량)', count: stats.requestsByTier.tier1, color: 'bg-green-500' },
                  { label: 'Tier 2 (표준)', count: stats.requestsByTier.tier2, color: 'bg-accent' },
                  { label: 'Tier 3 (고급)', count: stats.requestsByTier.tier3, color: 'bg-orange-500' },
                ].map((tier) => {
                  const pct = stats.totalRequests > 0 ? (tier.count / stats.totalRequests) * 100 : 0;
                  return (
                    <div key={tier.label} className="flex-1">
                      <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
                        <span>{tier.label}</span>
                        <span className="font-mono">{tier.count}건 ({pct.toFixed(0)}%)</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full ${tier.color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Top Agents Table */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <span className="text-xs font-semibold text-gray-900">Agent별 사용 현황 (Top 10)</span>
              <span className="text-[10px] text-gray-500">{stats?.topAgents?.length ?? 0}개</span>
            </div>

            {loading ? (
              <div className="p-4 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            ) : !stats?.topAgents?.length ? (
              <div className="p-8 text-center text-gray-500">
                <Gauge size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-xs">비용 데이터가 없습니다</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="text-left px-4 py-2">Agent</th>
                      <th className="text-right px-4 py-2">요청수</th>
                      <th className="text-right px-4 py-2">캐시 Hit률</th>
                      <th className="text-right px-4 py-2">절감액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.topAgents.map((agent) => (
                      <tr
                        key={agent.agentName}
                        className="border-b border-gray-200 hover:bg-gray-50 transition"
                      >
                        <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">
                          {agent.agentName}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right text-gray-500 font-mono">
                          {agent.requestCount.toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right">
                          <span className={agent.cacheHitRate > 50 ? 'text-success' : 'text-warning'}>
                            {agent.cacheHitRate.toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right text-success font-semibold">
                          {krw(agent.savedUsd, { decimals: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Hourly Trend */}
          {stats && (stats.hourlyTrend?.length ?? 0) > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
              <p className="text-xs font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Clock size={14} className="text-accent" />
                시간별 추이 (최근 6시간)
              </p>
              <div className="flex items-end gap-2 h-28">
                {stats.hourlyTrend.map((h, i) => {
                  const maxReq = Math.max(...stats.hourlyTrend.map((x) => x.requests), 1);
                  const height = (h.requests / maxReq) * 100;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center">
                      <div className="w-full flex flex-col items-center flex-1 justify-end">
                        <p className="text-[10px] text-accent font-mono mb-1">
                          {h.requests}
                        </p>
                        <div
                          className="w-full bg-accent/40 rounded-t"
                          style={{ height: `${Math.max(height, 4)}%` }}
                        />
                      </div>
                      <p className="text-[9px] text-gray-500 mt-1.5">
                        {h.hour.slice(-2)}시
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════ */}
      {/* Tab: 예측/시뮬레이션 (Predict) */}
      {/* ════════════════════════════════════════════ */}
      {tab === 'predict' && (
        <div className="space-y-6">
          {/* Cost Forecast */}
          {forecast && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                icon={DollarSign}
                label="이번달 실제"
                value={krw(forecast.currentMonthActual, { decimals: 0 })}
                sub={`${forecast.daysElapsed}/${forecast.totalDays}일 경과`}
                color="accent"
              />
              <StatCard
                icon={BarChart3}
                label="월말 예측"
                value={krw(forecast.projectedMonthTotal, { decimals: 0 })}
                sub={`신뢰도: ${(forecast.confidence * 100).toFixed(0)}%`}
                color="warning"
              />
              <StatCard
                icon={momPct > 0 ? TrendingUp : TrendingDown}
                label="전월 대비"
                value={`${momPct > 0 ? '+' : ''}${momPct.toFixed(1)}%`}
                sub={`전월: ${krw(forecast.previousMonthTotal, { decimals: 0 })}`}
                color={momPct > 0 ? 'danger' : 'success'}
              />
              <StatCard
                icon={Gauge}
                label="예측 방식"
                value={forecast.method.replace('_', ' ')}
                sub="일별 평균 × 잔여일"
                color="white"
              />
            </div>
          )}

          {/* What-If Simulator */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="flex items-center gap-2 mb-4">
              <Settings2 size={14} className="text-accent" />
              <span className="text-xs font-semibold text-gray-900">What-If 시뮬레이터</span>
              <span className="text-[10px] text-gray-500 ml-auto">백엔드 /finops/simulate 연동</span>
            </div>

            <div className="grid grid-cols-3 gap-6 mb-4">
              {/* Cache TTL Multiplier */}
              <div>
                <label className="text-[11px] text-gray-500 font-semibold mb-2 block">
                  캐시 TTL 배수
                </label>
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={cacheTTLMultiplier}
                  onChange={(e) => setCacheTTLMultiplier(Number(e.target.value))}
                  className="w-full accent-accent"
                />
                <p className="text-[11px] text-accent font-semibold mt-2">
                  {cacheTTLMultiplier}x
                </p>
              </div>

              {/* Tier Downgrade */}
              <div>
                <label className="text-[11px] text-gray-500 font-semibold mb-2 block">
                  Tier 다운그레이드 수
                </label>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={tierDowngrade}
                  onChange={(e) => setTierDowngrade(Number(e.target.value))}
                  className="w-full accent-accent"
                />
                <p className="text-[11px] text-accent font-semibold mt-2">
                  {tierDowngrade}개 Agent
                </p>
              </div>

              {/* Skill Budget Multiplier */}
              <div>
                <label className="text-[11px] text-gray-500 font-semibold mb-2 block">
                  Skill 예산 배수
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={3}
                  step={0.1}
                  value={skillBudgetMultiplier}
                  onChange={(e) => setSkillBudgetMultiplier(Number(e.target.value))}
                  className="w-full accent-accent"
                />
                <p className="text-[11px] text-accent font-semibold mt-2">
                  {skillBudgetMultiplier.toFixed(1)}x
                </p>
              </div>
            </div>

            <button
              onClick={runSimulation}
              disabled={simulating}
              className="w-full py-2 text-xs font-semibold bg-accent/20 text-accent rounded hover:bg-accent/30 transition disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {simulating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  시뮬레이션 실행 중...
                </>
              ) : (
                <>
                  <Zap size={14} />
                  시뮬레이션 실행
                </>
              )}
            </button>
          </div>

          {/* Simulation Results */}
          {simResult && (
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">기준 월 비용</p>
                <p className="text-2xl font-bold text-gray-900">{krw(simResult.baselineMonthlyCost, { decimals: 0 })}</p>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 mt-3">시뮬레이션 비용</p>
                <p className="text-2xl font-bold text-accent">{krw(simResult.simulatedMonthlyCost, { decimals: 0 })}</p>
              </div>

              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">절감 기대액</p>
                <p className={`text-3xl font-bold ${simResult.savings > 0 ? 'text-success' : 'text-danger'}`}>
                  {krw(Math.abs(simResult.savings), { decimals: 0 })}
                </p>
                <p className="text-[11px] text-gray-500 mt-1">
                  {simResult.savingsPct > 0 ? `${simResult.savingsPct.toFixed(1)}% 절감` : `${Math.abs(simResult.savingsPct).toFixed(1)}% 증가`}
                </p>
                <div className="mt-3 space-y-1">
                  <BreakdownRow label="캐시 최적화" value={simResult.breakdown.cache} />
                  <BreakdownRow label="Tier 다운그레이드" value={simResult.breakdown.tier} />
                  <BreakdownRow label="Skill 예산 조정" value={simResult.breakdown.skill} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════ */}
      {/* Tab: 추천 (Recommend) */}
      {/* ════════════════════════════════════════════ */}
      {tab === 'recommend' && (
        <div className="space-y-3">
          {loading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-20 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : recommendations.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center">
              <Sparkles size={32} className="mx-auto mb-3 text-gray-500/30" />
              <p className="text-xs text-gray-500">현재 추천할 최적화가 없습니다</p>
              <p className="text-[10px] text-gray-500 mt-1">30일간 토큰 사용 로그가 축적되면 자동으로 추천이 생성됩니다.</p>
            </div>
          ) : (
            recommendations.map((rec) => (
              <div
                key={rec.id}
                className={`bg-white rounded-lg border p-4 transition ${
                  appliedRecs.has(rec.id)
                    ? 'border-success/30 opacity-70'
                    : 'border-gray-200 shadow-sm hover:border-accent/20'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                        rec.category === 'tier' ? 'bg-purple-500/20 text-purple-400' :
                        rec.category === 'cache' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-orange-500/20 text-orange-400'
                      }`}>
                        {rec.category.toUpperCase()}
                      </span>
                      {rec.autoApplyAvailable && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/20 text-success font-semibold">
                          자동 적용 가능
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-semibold text-gray-900">{rec.title}</p>
                    <p className="text-[11px] text-gray-500 mt-1">{rec.description}</p>
                  </div>
                  <div className="text-right ml-4">
                    <p className="text-sm font-bold text-success">
                      {krw(rec.estimatedSavingsMonthly, { decimals: 0 })}
                    </p>
                    <p className="text-[10px] text-gray-500">월 절감 추정</p>
                  </div>
                </div>

                <div className="flex gap-2 mt-3">
                  {appliedRecs.has(rec.id) ? (
                    <div className="flex-1 px-3 py-1.5 text-xs font-semibold bg-success/20 text-success rounded flex items-center justify-center gap-1">
                      <CheckCircle2 size={12} />
                      적용 완료
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => applyRecommendation(rec.id)}
                        disabled={applyingRecId === rec.id}
                        className="flex-1 px-3 py-1.5 text-xs font-semibold bg-accent/20 text-accent rounded hover:bg-accent/30 transition disabled:opacity-50 flex items-center justify-center gap-1"
                      >
                        {applyingRecId === rec.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={12} />
                        )}
                        적용
                      </button>
                      <button className="flex-1 px-3 py-1.5 text-xs font-semibold border border-gray-200 text-gray-500 rounded hover:border-gray-200 transition flex items-center justify-center gap-1">
                        <XCircle size={12} />
                        무시
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════ */}
      {/* Tab: 토큰 로그 (Logs) */}
      {/* ════════════════════════════════════════════ */}
      {tab === 'logs' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-900">토큰 최적화 로그</span>
            <span className="text-[10px] text-gray-500">
              {tokenLogs.length} / {tokenLogTotal}건
            </span>
          </div>

          {loading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : tokenLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <AlertCircle size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-xs">토큰 로그가 없습니다</p>
              <p className="text-[10px] mt-1">
                워크플로우에서 AI 노드를 실행하면 FinOps 3-Gate 파이프라인을 통해 자동 기록됩니다.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                    <th className="text-left px-4 py-2">시간</th>
                    <th className="text-left px-4 py-2">Agent</th>
                    <th className="text-center px-4 py-2">캐시</th>
                    <th className="text-center px-4 py-2">Tier</th>
                    <th className="text-left px-4 py-2">모델</th>
                    <th className="text-right px-4 py-2">토큰</th>
                    <th className="text-right px-4 py-2">비용</th>
                    <th className="text-right px-4 py-2">절감</th>
                    <th className="text-right px-4 py-2">응답(ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenLogsPage.pageItems.map((log) => (
                    <tr
                      key={log.id}
                      className="border-b border-gray-200 hover:bg-gray-50 transition"
                    >
                      <td className="px-4 py-2 text-[11px] text-gray-500 font-mono">
                        {new Date(log.createdAt).toLocaleString('ko-KR', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-900 font-medium">
                        {log.agentName}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {log.cacheHit ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/20 text-success font-semibold">HIT</span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-semibold">MISS</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          log.routedTier === 1 ? 'bg-green-500/20 text-green-400' :
                          log.routedTier === 2 ? 'bg-accent/20 text-accent' :
                          'bg-orange-500/20 text-orange-400'
                        }`}>
                          T{log.routedTier}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[11px] text-gray-500 font-mono truncate max-w-[120px]">
                        {log.routedModel}
                      </td>
                      <td className="px-4 py-2 text-xs text-right text-gray-500 font-mono">
                        {log.totalTokens.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-xs text-right text-accent font-semibold">
                        {krw(log.optimizedCostUsd, { decimals: 2 })}
                      </td>
                      <td className="px-4 py-2 text-xs text-right text-success font-semibold">
                        {krw(log.savedUsd, { decimals: 2 })}
                      </td>
                      <td className="px-4 py-2 text-xs text-right text-gray-500 font-mono">
                        {log.responseTimeMs}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager p={tokenLogsPage} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-Components ──

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    white: 'text-gray-900',
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className={colorMap[color] ?? 'text-gray-900'} />
        <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
      </div>
      <p className={`text-xl font-bold ${colorMap[color] ?? 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-gray-500">{label}</span>
      <span className={value < 0 ? 'text-success font-semibold' : value > 0 ? 'text-danger font-semibold' : 'text-gray-500'}>
        {value < 0
          ? `-${krw(Math.abs(value), { decimals: 0 })}`
          : value > 0
            ? `+${krw(value, { decimals: 0 })}`
            : krw(0, { decimals: 0 })}
      </span>
    </div>
  );
}
