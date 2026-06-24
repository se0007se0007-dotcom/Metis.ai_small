'use client';

/**
 * Governance > 정책 관리 > 평가 Gate 설정 (Phase 1)
 *
 * 4-Gate 평가 엔진의 가중치/임계값을 코드 수정 없이 조정한다.
 * 백엔드: GET/PUT /governance/evaluation-policy, POST .../reset
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { api } from '@/lib/api-client';
import { RefreshCw, RotateCcw, Save, AlertCircle, CheckCircle2 } from 'lucide-react';

// ── Types (백엔드 ResolvedEvaluationPolicy와 정렬) ──

interface EvaluationPolicy {
  id: string | null;
  name: string;
  agentGroup: string | null;

  qualityWeight: number;
  qualityHardGateMin: number;
  llmJudgeEnabled: boolean;
  llmJudgeModel: string;
  llmJudgeBudgetPerDay: number;

  securityWeight: number;
  securityCriticalCap: number;
  securityHighCap: number;
  piiScanEnabled: boolean;
  promptInjectionEnabled: boolean;

  anomalyWeight: number;
  zScoreThreshold: number;
  iqrFactor: number;

  costWeight: number;
  dailyBudgetUsd: number;
  latencySlowMs: number;
  latencyCriticalMs: number;

  canaryQualityMin: number;
  canarySecurityMin: number;

  orbPassThreshold: number;
  orbConditionalMin: number;

  isActive: boolean;
}

const AGENT_GROUPS = [
  { key: 'default', label: '기본 (Tenant Default)' },
  { key: '운영', label: '운영' },
  { key: '개발', label: '개발' },
  { key: '고도화', label: '고도화' },
];

// ── Page Component ──

export default function EvaluationPolicyPage() {
  const [group, setGroup] = useState('default');
  const [policy, setPolicy] = useState<EvaluationPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const fetchPolicy = useCallback(async (name: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ policy: EvaluationPolicy }>(
        `/governance/evaluation-policy?name=${encodeURIComponent(name)}`,
      );
      setPolicy(data.policy);
    } catch (err: any) {
      setError(err?.message ?? '정책을 불러오지 못했습니다');
      setPolicy(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicy(group);
  }, [group, fetchPolicy]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const update = <K extends keyof EvaluationPolicy>(key: K, value: EvaluationPolicy[K]) => {
    setPolicy((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleSave = async () => {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      // Send only DTO-allowed fields. The backend ValidationPipe uses
      // forbidNonWhitelisted: true, so including read-only fields like `id`
      // causes a 400. Strip them by picking only editable fields.
      const { id, ...editable } = policy;
      const body = {
        ...editable,
        name: group,
        agentGroup: group === 'default' ? null : group,
      };
      const data = await api.put<{ policy: EvaluationPolicy }>(
        '/governance/evaluation-policy',
        body,
      );
      setPolicy(data.policy);
      showToast('정책이 저장되었습니다. (5분 내 평가 엔진에 반영)');
    } catch (err: any) {
      setError(err?.message ?? '저장에 실패했습니다');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await api.post<{ policy: EvaluationPolicy }>(
        `/governance/evaluation-policy/reset?name=${encodeURIComponent(group)}`,
      );
      setPolicy(data.policy);
      showToast('기본값으로 복원되었습니다.');
    } catch (err: any) {
      setError(err?.message ?? '복원에 실패했습니다');
    } finally {
      setSaving(false);
    }
  };

  const weightSum = policy
    ? policy.qualityWeight + policy.securityWeight + policy.costWeight + policy.anomalyWeight
    : 0;
  const weightOk = Math.abs(weightSum - 1) < 0.001;

  return (
    <div className="p-6">
      <SubTabs items={[{ label: '정책코드', href: '/governance/policies' }, { label: '평가 Gate', href: '/governance/evaluation-policy' }, { label: '정책 제안', href: '/governance/policy-suggestions' }]} />
      <PageHeader
        title="평가 Gate 설정"
        description="4-Gate 평가 엔진의 가중치·임계값을 조정합니다. 저장하면 코드 수정 없이 즉시(5분 캐시) 반영됩니다."
        actions={
          <div className="flex items-center gap-2">
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className="px-3 py-1.5 bg-white border border-gray-200 rounded text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
            >
              {AGENT_GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => fetchPolicy(group)}
              className="p-1.5 text-gray-500 hover:text-gray-900 transition"
              title="새로고침"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={handleReset}
              disabled={saving || !policy}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded text-xs font-semibold text-gray-600 hover:text-gray-900 disabled:opacity-50 transition"
            >
              <RotateCcw size={13} />
              기본값 복원
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !policy || !weightOk}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-gray-50 rounded text-xs font-semibold hover:bg-blue-600/90 disabled:opacity-50 transition"
              title={!weightOk ? '가중치 합계가 1.0이어야 저장할 수 있습니다' : ''}
            >
              <Save size={13} />
              저장
            </button>
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2 bg-green-100 border border-green-200 rounded text-xs text-green-700">
          <CheckCircle2 size={14} />
          {toast}
        </div>
      )}

      {loading || !policy ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* 가중치 요약 */}
          <div
            className={`flex items-center justify-between p-3 rounded-lg border text-xs ${
              weightOk
                ? 'bg-blue-50 border-blue-200 text-blue-700'
                : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}
          >
            <span className="font-semibold">Gate 가중치 합계</span>
            <span className="font-mono">
              {weightSum.toFixed(2)} / 1.00 {weightOk ? '✓' : '— 합계가 1.00이어야 저장 가능'}
            </span>
          </div>

          {/* 품질 Gate */}
          <GateCard title="품질 Gate (Quality)" accent="text-blue-600">
            <NumberField
              label="가중치 (0–1)"
              value={policy.qualityWeight}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) => update('qualityWeight', v)}
            />
            <NumberField
              label="Hard Gate 최소 점수"
              hint="이 점수 미만이면 종합 최대 40점"
              value={policy.qualityHardGateMin}
              step={1}
              min={0}
              max={100}
              onChange={(v) => update('qualityHardGateMin', v)}
            />
            <ToggleField
              label="LLM Judge 사용"
              value={policy.llmJudgeEnabled}
              onChange={(v) => update('llmJudgeEnabled', v)}
            />
            <TextField
              label="LLM Judge 모델"
              value={policy.llmJudgeModel}
              onChange={(v) => update('llmJudgeModel', v)}
            />
            <NumberField
              label="LLM Judge 일일 예산 ($)"
              value={policy.llmJudgeBudgetPerDay}
              step={0.1}
              min={0}
              onChange={(v) => update('llmJudgeBudgetPerDay', v)}
            />
          </GateCard>

          {/* 보안 Gate */}
          <GateCard title="보안 Gate (Security)" accent="text-red-600">
            <NumberField
              label="가중치 (0–1)"
              value={policy.securityWeight}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) => update('securityWeight', v)}
            />
            <NumberField
              label="Critical 상한 (cap)"
              hint="critical 위험 시 종합 점수 상한"
              value={policy.securityCriticalCap}
              step={1}
              min={0}
              max={100}
              onChange={(v) => update('securityCriticalCap', v)}
            />
            <NumberField
              label="High 상한 (cap)"
              value={policy.securityHighCap}
              step={1}
              min={0}
              max={100}
              onChange={(v) => update('securityHighCap', v)}
            />
            <ToggleField
              label="PII 스캔"
              value={policy.piiScanEnabled}
              onChange={(v) => update('piiScanEnabled', v)}
            />
            <ToggleField
              label="프롬프트 인젝션 탐지"
              value={policy.promptInjectionEnabled}
              onChange={(v) => update('promptInjectionEnabled', v)}
            />
          </GateCard>

          {/* 이상탐지 Gate */}
          <GateCard title="이상탐지 Gate (Anomaly)" accent="text-amber-600">
            <NumberField
              label="가중치 (0–1)"
              value={policy.anomalyWeight}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) => update('anomalyWeight', v)}
            />
            <NumberField
              label="Z-Score 임계값"
              value={policy.zScoreThreshold}
              step={0.1}
              min={0}
              onChange={(v) => update('zScoreThreshold', v)}
            />
            <NumberField
              label="IQR 계수"
              value={policy.iqrFactor}
              step={0.1}
              min={0}
              onChange={(v) => update('iqrFactor', v)}
            />
          </GateCard>

          {/* 비용 Gate */}
          <GateCard title="비용 Gate (Cost)" accent="text-green-600">
            <NumberField
              label="가중치 (0–1)"
              value={policy.costWeight}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) => update('costWeight', v)}
            />
            <NumberField
              label="일일 예산 ($)"
              value={policy.dailyBudgetUsd}
              step={1}
              min={0}
              onChange={(v) => update('dailyBudgetUsd', v)}
            />
            <NumberField
              label="Slow 지연 (ms)"
              value={policy.latencySlowMs}
              step={100}
              min={0}
              onChange={(v) => update('latencySlowMs', v)}
            />
            <NumberField
              label="Critical 지연 (ms)"
              value={policy.latencyCriticalMs}
              step={100}
              min={0}
              onChange={(v) => update('latencyCriticalMs', v)}
            />
          </GateCard>

          {/* 연동 임계값 */}
          <GateCard title="Canary · ORB 연동" accent="text-purple-600">
            <NumberField
              label="Canary 품질 최소"
              value={policy.canaryQualityMin}
              step={1}
              min={0}
              max={100}
              onChange={(v) => update('canaryQualityMin', v)}
            />
            <NumberField
              label="Canary 보안 최소"
              value={policy.canarySecurityMin}
              step={1}
              min={0}
              max={100}
              onChange={(v) => update('canarySecurityMin', v)}
            />
            <NumberField
              label="ORB 통과 임계값"
              value={policy.orbPassThreshold}
              step={1}
              min={0}
              max={100}
              onChange={(v) => update('orbPassThreshold', v)}
            />
            <NumberField
              label="ORB 조건부 최소"
              value={policy.orbConditionalMin}
              step={1}
              min={0}
              max={100}
              onChange={(v) => update('orbConditionalMin', v)}
            />
          </GateCard>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──

function GateCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200">
        <span className={`text-xs font-semibold ${accent}`}>{title}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4">{children}</div>
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  step,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step ?? 1}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
      />
      {hint && <p className="mt-1 text-[10px] text-gray-400">{hint}</p>}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 font-mono focus:outline-none focus:ring-1 focus:ring-blue-200"
      />
    </div>
  );
}

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col">
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <label className="flex items-center gap-2 cursor-pointer mt-1">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded"
        />
        <span className="text-xs text-gray-900">{value ? '사용' : '미사용'}</span>
      </label>
    </div>
  );
}
