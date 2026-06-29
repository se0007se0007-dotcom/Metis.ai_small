'use client';

/**
 * FinOps 정책 실험실 — Patent 3 (정책 인식형 LLM 최적화) 테스트 화면.
 * (이전 위치: /governance/finops-lab → 인사이트 FinOps 허브의 서브탭으로 이동.
 *  기존 URL은 리다이렉트로 유지된다.)
 *
 * 시나리오 1: 같은 프롬프트 2회 → 2번째 cache HIT (절감 확인)
 * 시나리오 2: dataClass=PII/SECRET → DENY_SENSITIVE_DATA (캐시 차단)
 * 시나리오 3: riskScore≥0.7 → DENY_HIGH_RISK (캐시 차단)
 * 시나리오 4: 정책 수정 후 재호출 → policyHash 변경으로 cache MISS
 * 시나리오 5: 라우팅 사유(complexity/risk/budget) 및 감사 로그 확인
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import {
  Coins,
  Send,
  RefreshCw,
  Loader2,
  XCircle,
  Database,
  Route,
  Wallet,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────

interface OptimizeResult {
  cacheHit: boolean;
  routedTier: number;
  routedModel: string;
  savedUsd?: number;
  savedPct?: number;
  responseTimeMs: number;
  policyHash?: string;
  cachePolicyDecision?: { decision: string; cacheAllowed: boolean; reasons: string[] };
  routeReason?: {
    complexity: number;
    risk: number;
    budgetPressure: number;
    allowedTiers: number[];
    adjustments: string[];
  };
  budget?: { dailyLimitUsd: number; usedTodayUsd: number; budgetPressure: number; action: string };
}

interface CacheDecisionLog {
  id: string;
  createdAt: string;
  agentName: string;
  dataClass: string | null;
  riskScore: number | null;
  policyHash: string | null;
  cacheHit: boolean;
  cachePolicyDecision: string | null;
  routedTier: number;
  routedModel: string;
  savedUsd: number | null;
  evidencePackId: string | null;
}

const DATA_CLASSES = ['PUBLIC', 'INTERNAL', 'PII', 'SECRET', 'CUSTOMER_CONFIDENTIAL'];

const DECISION_STYLE: Record<string, string> = {
  ALLOW: 'text-success',
  DENY_SENSITIVE_DATA: 'text-danger',
  DENY_HIGH_RISK: 'text-danger',
  DENY_POLICY_CHANGED: 'text-warning',
  CACHE_DISABLED: 'text-gray-400',
};

export default function FinOpsLabPage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  const [prompt, setPrompt] = useState('SR-1024 티켓의 영향도를 분석하고 요약해줘');
  const [agentName, setAgentName] = useState('finops-lab-agent');
  const [dataClass, setDataClass] = useState('INTERNAL');
  const [riskScore, setRiskScore] = useState(0);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [logs, setLogs] = useState<CacheDecisionLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    try {
      setLogs(await api.get<CacheDecisionLog[]>('/finops/cache/decisions?limit=30'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const optimize = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<OptimizeResult>('/finops/optimize', {
        agentName,
        prompt,
        dataClass,
        riskScore,
        nodeKey: 'finops-lab.test',
      });
      setResult(r);
      await loadLogs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [agentName, prompt, dataClass, riskScore, loadLogs]);

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
        title="FinOps 정책 실험실"
        description="정책 인식형 캐시(policyHash·dataClass·riskScore) + 정책 결합 모델 라우팅 테스트 콘솔"
        actions={
          <button
            onClick={() => void loadLogs()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
          >
            <RefreshCw size={13} /> 새로고침
          </button>
        }
      />

      <div>
        {/* 이용 안내 — 무엇을 확인하는 화면인지 */}
        <div className="mb-4 p-3 bg-accent/5 border border-accent/20 rounded-lg">
          <p className="text-[11px] text-gray-700 mb-2">
            <b className="text-accent">이 화면은</b> LLM 호출 1건이 비용 절감(캐시·모델 라우팅)을
            받기 전에 <b>정책 검사를 통과하는 과정</b>을 직접 실험하는 콘솔입니다. 아래 4가지를
            바꿔가며 실행해 보세요.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[
              ['같은 프롬프트 2회', '두 번째는 캐시 적중 → 비용 0'],
              ['dataClass를 PII/SECRET로', '민감정보는 캐시 재사용 차단'],
              ['riskScore 0.7 이상', '고위험 요청도 캐시 차단'],
              ['정책 수정 후 재호출', '정책이 바뀌면 기존 캐시 전체 무효'],
            ].map(([t, d], i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 px-2 py-1 bg-white border border-gray-200 rounded-full text-[10.5px]"
              >
                <span className="w-4 h-4 rounded-full bg-accent text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                <b className="text-gray-800">{t}</b>
                <span className="text-gray-400">— {d}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 mb-4">
          {/* 요청 폼 */}
          <div className="bg-white border border-gray-200 rounded-lg p-4 self-start">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-900 mb-3">
              <Send size={13} /> LLM 요청 시뮬레이션
            </p>
            <label className="block text-[10px] text-gray-400 mb-1">Agent 이름</label>
            <input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-2 mb-3"
            />
            <label className="block text-[10px] text-gray-400 mb-1">프롬프트</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-2 mb-3 resize-none"
            />
            <label className="block text-[10px] text-gray-400 mb-1">데이터 분류 (dataClass)</label>
            <select
              value={dataClass}
              onChange={(e) => setDataClass(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-2 mb-3 bg-white"
            >
              {DATA_CLASSES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <label className="block text-[10px] text-gray-400 mb-1">
              노드 위험도 (riskScore): <b>{riskScore.toFixed(2)}</b>
              {riskScore >= 0.7 && <span className="text-danger ml-1">— 캐시 차단 구간</span>}
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={riskScore}
              onChange={(e) => setRiskScore(Number(e.target.value))}
              className="w-full mb-4"
            />
            <button
              onClick={() => void optimize()}
              disabled={busy || !prompt.trim()}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold text-white bg-accent rounded-lg disabled:opacity-40 hover:opacity-90 transition"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Coins size={13} />}
              최적화 실행 (3-Gate)
            </button>
          </div>

          {/* 결과 */}
          <div className="space-y-3">
            {error && (
              <div className="flex items-center gap-2 p-2.5 bg-danger/10 border border-danger/20 rounded-lg text-xs text-danger">
                <XCircle size={14} /> {error}
              </div>
            )}
            {result ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <ResultCard
                    label="Cache"
                    value={result.cacheHit ? 'HIT' : 'MISS'}
                    tone={result.cacheHit ? 'text-success' : 'text-gray-600'}
                  />
                  <ResultCard
                    label="캐시 정책 판정"
                    value={result.cachePolicyDecision?.decision ?? '—'}
                    tone={DECISION_STYLE[result.cachePolicyDecision?.decision ?? ''] ?? 'text-gray-600'}
                  />
                  <ResultCard
                    label="라우팅"
                    value={`Tier ${result.routedTier} · ${result.routedModel}`}
                    tone="text-accent"
                  />
                  <ResultCard
                    label="절감"
                    value={`${krw(result.savedUsd ?? 0, { decimals: 2 })} (${(result.savedPct ?? 0).toFixed(0)}%)`}
                    tone="text-success"
                  />
                </div>

                <div className="bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-bold text-gray-900 mb-2">
                      <Database size={12} /> 캐시 판정 사유
                    </p>
                    <ul className="text-[11px] text-gray-600 space-y-0.5">
                      {(result.cachePolicyDecision?.reasons ?? []).map((r, i) => (
                        <li key={i}>· {r}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-[10px] text-gray-400 font-mono truncate">
                      policyHash: {result.policyHash}
                    </p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-bold text-gray-900 mb-2">
                      <Route size={12} /> 라우팅 근거 (decision rationale)
                    </p>
                    {result.routeReason ? (
                      <>
                        <p className="text-[11px] text-gray-600">
                          complexity {result.routeReason.complexity.toFixed(2)} · risk{' '}
                          {result.routeReason.risk.toFixed(2)} · budgetPressure{' '}
                          {result.routeReason.budgetPressure.toFixed(2)}
                        </p>
                        <ul className="text-[11px] text-gray-600 mt-1 space-y-0.5">
                          {result.routeReason.adjustments.map((a, i) => (
                            <li key={i}>· {a}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="text-[11px] text-gray-400">
                        cache HIT — 라우팅 단계 미수행
                      </p>
                    )}
                    {result.budget && (
                      <p className="mt-2 flex items-center gap-1 text-[10px] text-gray-400">
                        <Wallet size={11} /> 오늘 {krw(result.budget.usedTodayUsd, { decimals: 0 })} /{' '}
                        {krw(result.budget.dailyLimitUsd, { decimals: 0 })} (
                        {(result.budget.budgetPressure * 100).toFixed(1)}
                        %) — {result.budget.action}
                      </p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-xs text-gray-400">
                좌측에서 요청을 실행하면 캐시 판정·라우팅 근거가 표시됩니다.
              </div>
            )}
          </div>
        </div>

        {/* 감사 로그 */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2.5 border-b border-gray-200 text-xs font-bold text-gray-900">
            FinOps 감사 로그 (정책 판정 포함, 최근 30건)
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-gray-50">
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="py-2 px-3">시각</th>
                  <th className="py-2 pr-2">Agent</th>
                  <th className="py-2 pr-2">dataClass</th>
                  <th className="py-2 pr-2">risk</th>
                  <th className="py-2 pr-2">캐시 판정</th>
                  <th className="py-2 pr-2">Hit</th>
                  <th className="py-2 pr-2">Tier/모델</th>
                  <th className="py-2 pr-2">policyHash</th>
                  <th className="py-2 pr-2">증거팩</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-6 text-center text-gray-400">
                      로그가 없습니다.
                    </td>
                  </tr>
                )}
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-gray-50">
                    <td className="py-1.5 px-3 text-gray-400 font-mono">
                      {new Date(l.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="py-1.5 pr-2">{l.agentName}</td>
                    <td className="py-1.5 pr-2">{l.dataClass ?? '—'}</td>
                    <td className="py-1.5 pr-2">{l.riskScore ?? '—'}</td>
                    <td
                      className={`py-1.5 pr-2 font-semibold ${DECISION_STYLE[l.cachePolicyDecision ?? ''] ?? 'text-gray-500'}`}
                    >
                      {l.cachePolicyDecision ?? '—'}
                    </td>
                    <td className="py-1.5 pr-2">{l.cacheHit ? '✓' : ''}</td>
                    <td className="py-1.5 pr-2">
                      T{l.routedTier} {l.routedModel}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-gray-400">
                      {l.policyHash ? `${l.policyHash.slice(0, 10)}…` : '—'}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-gray-400">
                      {l.evidencePackId ? `${l.evidencePackId.slice(0, 8)}…` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <p className="text-[9px] text-gray-400 mb-0.5">{label}</p>
      <p className={`text-sm font-bold truncate ${tone}`} title={value}>
        {value}
      </p>
    </div>
  );
}
