'use client';

/**
 * 운영 기준값 (기준정보) — 관리자 전용.
 *
 * 대시보드의 ROI/공수/health/등급 계산에 쓰이는 기준값을 조직(테넌트) 단위로 관리한다.
 * 백엔드: GET/PUT /tenants/current/ops-reference  (저장 즉시 대시보드 집계에 반영)
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import {
  Gauge,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  X,
  DollarSign,
  Clock,
  ShieldCheck,
  Award,
  RotateCcw,
} from 'lucide-react';

interface OpsRef {
  hourlyRateUsd: number;
  workingHoursPerMonth: number;
  usdToKrw: number;
  healthDownScore: number;
  healthDownFailRate: number;
  healthDownAnomalyRate: number;
  healthDegradedScore: number;
  healthDegradedFailRate: number;
  healthDegradedAnomalyRate: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  gradeD: number;
}

const DEFAULTS: OpsRef = {
  hourlyRateUsd: 50,
  workingHoursPerMonth: 160,
  usdToKrw: 1380,
  healthDownScore: 50,
  healthDownFailRate: 0.3,
  healthDownAnomalyRate: 0.4,
  healthDegradedScore: 75,
  healthDegradedFailRate: 0.1,
  healthDegradedAnomalyRate: 0.15,
  gradeA: 90,
  gradeB: 80,
  gradeC: 70,
  gradeD: 60,
};

export default function OpsReferencePage() {
  const [form, setForm] = useState<OpsRef>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<OpsRef>('/tenants/current/ops-reference');
      setForm({ ...DEFAULTS, ...(res ?? {}) });
    } catch (e: any) {
      setError(e?.message ?? '운영 기준값을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const set = (k: keyof OpsRef, v: string) => setForm((p) => ({ ...p, [k]: v === '' ? 0 : Number(v) }));

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.put<OpsRef>('/tenants/current/ops-reference', form);
      setForm({ ...DEFAULTS, ...(res ?? {}) });
      setNotice({ type: 'ok', text: '저장 완료 — 대시보드 집계에 즉시 반영됩니다.' });
    } catch (e: any) {
      setNotice({ type: 'err', text: `저장 실패: ${e?.message ?? '알 수 없는 오류'}` });
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = () => {
    setForm(DEFAULTS);
    setNotice({ type: 'ok', text: '기본값으로 되돌렸습니다(저장해야 반영).' });
  };

  return (
    <div className="p-6 bg-gray-50 min-h-full text-gray-900">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Gauge size={20} className="text-blue-600" /> 운영 기준값
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            대시보드의 <b>ROI·절감 공수·Health(정상/주의/비정상)·품질 등급</b> 계산에 쓰이는 기준값입니다.
            조직(테넌트) 단위로 적용되며, 저장 즉시 대시보드 집계에 반영됩니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={resetDefaults} className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-900" title="기본값으로">
            <RotateCcw size={13} /> 기본값
          </button>
          <button onClick={fetchData} className="p-1.5 text-gray-500 hover:text-gray-900" title="새로고침">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 my-3 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      {notice && (
        <div
          className={`flex items-center gap-2 p-2.5 my-3 rounded text-xs border ${
            notice.type === 'ok' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-600'
          }`}
        >
          {notice.type === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100">
            <X size={13} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3 mt-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-white border border-gray-200 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-4 mt-4 max-w-3xl">
          {/* 효과성(ROI) */}
          <Section icon={<DollarSign size={14} className="text-emerald-600" />} title="효과성 (ROI·공수)" desc="총 절감 공수 / ROI / 순가치 계산 기준">
            <Field label="인건비 시급 (USD/시간)" hint="Agent별 개별값이 없을 때 적용되는 기본 시급">
              <NumInput value={form.hourlyRateUsd} step="1" onChange={(v) => set('hourlyRateUsd', v)} suffix="$/h" />
            </Field>
            <Field label="월 근무시간 (시간/MM)" hint="절감시간 → 맨먼스(MM) 환산 분모">
              <NumInput value={form.workingHoursPerMonth} step="1" onChange={(v) => set('workingHoursPerMonth', v)} suffix="h" />
            </Field>
            <Field label="환율 (원/달러)" hint="모든 비용(USD) 표시를 원화로 환산하는 기준 환율">
              <NumInput value={form.usdToKrw} step="10" onChange={(v) => set('usdToKrw', v)} suffix="₩/$" />
            </Field>
          </Section>

          {/* Health 임계값 */}
          <Section icon={<ShieldCheck size={14} className="text-amber-600" />} title="Health 분류 임계값" desc="Agent 신호등(정상/주의/비정상) 판정 기준. 하나라도 해당하면 그 상태로 분류">
            <div className="col-span-2">
              <p className="text-[11px] font-semibold text-red-600 mb-1.5">🔴 비정상(down) — 아래 중 하나라도</p>
              <div className="grid grid-cols-3 gap-3">
                <Field label="품질점수 미만"><NumInput value={form.healthDownScore} onChange={(v) => set('healthDownScore', v)} suffix="점" /></Field>
                <Field label="실패율 초과"><NumInput value={form.healthDownFailRate} step="0.01" onChange={(v) => set('healthDownFailRate', v)} suffix="비율" /></Field>
                <Field label="이상률 초과"><NumInput value={form.healthDownAnomalyRate} step="0.01" onChange={(v) => set('healthDownAnomalyRate', v)} suffix="비율" /></Field>
              </div>
            </div>
            <div className="col-span-2 mt-2">
              <p className="text-[11px] font-semibold text-amber-600 mb-1.5">🟡 주의(degraded) — 아래 중 하나라도</p>
              <div className="grid grid-cols-3 gap-3">
                <Field label="품질점수 미만"><NumInput value={form.healthDegradedScore} onChange={(v) => set('healthDegradedScore', v)} suffix="점" /></Field>
                <Field label="실패율 초과"><NumInput value={form.healthDegradedFailRate} step="0.01" onChange={(v) => set('healthDegradedFailRate', v)} suffix="비율" /></Field>
                <Field label="이상률 초과"><NumInput value={form.healthDegradedAnomalyRate} step="0.01" onChange={(v) => set('healthDegradedAnomalyRate', v)} suffix="비율" /></Field>
              </div>
            </div>
            <p className="col-span-2 text-[10px] text-gray-400 mt-1">※ 실패율·이상률은 0~1 비율(예: 0.3 = 30%).</p>
          </Section>

          {/* 등급 컷오프 */}
          <Section icon={<Award size={14} className="text-violet-600" />} title="품질 등급 컷오프" desc="종합점수 → A/B/C/D/F 등급 (해당 점수 이상)">
            <Field label="A 등급 (이상)"><NumInput value={form.gradeA} onChange={(v) => set('gradeA', v)} suffix="점" /></Field>
            <Field label="B 등급 (이상)"><NumInput value={form.gradeB} onChange={(v) => set('gradeB', v)} suffix="점" /></Field>
            <Field label="C 등급 (이상)"><NumInput value={form.gradeC} onChange={(v) => set('gradeC', v)} suffix="점" /></Field>
            <Field label="D 등급 (이상)"><NumInput value={form.gradeD} onChange={(v) => set('gradeD', v)} suffix="점" /></Field>
            <p className="col-span-2 text-[10px] text-gray-400">※ 미만은 F. 예: A=90이면 90점 이상 A.</p>
          </Section>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? '저장 중...' : '저장'}
            </button>
            <span className="text-[11px] text-gray-400">저장 시 대시보드·Agent 기준정보의 health/등급/ROI에 즉시 반영됩니다.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  desc,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      {desc && <p className="text-[11px] text-gray-400 mb-3">{desc}</p>}
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-gray-600 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function NumInput({
  value,
  onChange,
  step,
  suffix,
}: {
  value: number;
  onChange: (v: string) => void;
  step?: string;
  suffix?: string;
}) {
  return (
    <div className="relative">
      <input
        type="number"
        step={step ?? '1'}
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 pr-10"
      />
      {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">{suffix}</span>}
    </div>
  );
}
