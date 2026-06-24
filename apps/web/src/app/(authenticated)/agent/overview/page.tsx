'use client';

/**
 * Agent 현황 대시보드 — Agent 실행 영역의 첫 화면(현황 탭).
 * 전체 Agent의 상태·실행 추이·이상·랭킹을 한눈에 보여준다.
 * API: GET /dashboard/overview (KPI·health·mainAgents·timeseries·utilization)
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  Clock,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';

// ── Types (dashboard/overview 부분 사용) ──
interface Kpi {
  totalExecutions: number;
  successRate: number;
  avgLatencyMs: number;
  monthlyCostUsd: number;
  anomalyCount: number;
}
interface Health {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  idle: number;
}
interface DailyPoint {
  date: string;
  executions: number;
  successRate: number;
  anomalies: number;
}
interface MainAgent {
  workflowKey: string;
  name?: string | null;
  code?: string | null;
  executions: number;
  successRate: number;
  avgLatencyMs: number;
  avgScore: number;
  anomalyCount: number;
  health: string;
}
interface Overview {
  kpi: Kpi;
  health: Health;
  mainAgents: MainAgent[];
  timeseries: DailyPoint[];
}

const HEALTH_LABEL: Record<string, string> = {
  healthy: '정상',
  degraded: '주의',
  down: '비정상',
  idle: '유휴',
};
const HEALTH_COLOR: Record<string, string> = {
  healthy: '#6FAF9A',
  degraded: '#C9A45C',
  down: '#C77B7B',
  idle: '#9CA3AF',
};
const fmtMs = (v: number) => `${Math.round(v).toLocaleString()}ms`;
const label = (m: { name?: string | null; code?: string | null; workflowKey: string }) =>
  m.code ? `${m.code} · ${m.name ?? m.workflowKey}` : (m.name ?? m.workflowKey);

export default function AgentOverviewPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<Overview>(`/dashboard/overview?days=${days}`);
      setData(r);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const kpi = data?.kpi;
  const health = data?.health;
  const ts = data?.timeseries ?? [];
  const agents = data?.mainAgents ?? [];

  // 파생 지표
  const maxExec = Math.max(...ts.map((t) => t.executions), 1);
  const anomalyAgents = [...agents]
    .filter((a) => a.anomalyCount > 0)
    .sort((a, b) => b.anomalyCount - a.anomalyCount)
    .slice(0, 5);
  const topUsed = [...agents].sort((a, b) => b.executions - a.executions).slice(0, 6);
  const worstSuccess = [...agents]
    .filter((a) => a.executions > 0)
    .sort((a, b) => a.successRate - b.successRate)
    .slice(0, 5);

  return (
    <div>
      <div className="px-6 pt-4">
        {/* 페이지 도구 행 — 기간 토글 + 새로고침 (헤더/탭은 레이아웃 고정) */}
        <div className="flex items-center justify-end gap-2 mb-3">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2.5 py-1 rounded text-xs font-semibold transition ${days === d ? 'bg-accent text-white shadow-sm' : 'text-muted-dark hover:text-gray-900'}`}
              >
                {d}일
              </button>
            ))}
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 새로고침
          </button>
        </div>

        {/* ── 상단 KPI 5종 ── */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
          <KpiCard
            icon={<Activity size={15} className="text-accent" />}
            label="총 실행"
            value={kpi ? kpi.totalExecutions.toLocaleString() : '—'}
          />
          <KpiCard
            icon={<CheckCircle2 size={15} className="text-success" />}
            label="성공률"
            value={kpi ? `${kpi.successRate}%` : '—'}
            tone={kpi && kpi.successRate < 90 ? 'amber' : 'green'}
          />
          <KpiCard
            icon={<Clock size={15} className="text-warning" />}
            label="평균 속도"
            value={kpi ? fmtMs(kpi.avgLatencyMs) : '—'}
          />
          <KpiCard
            icon={<AlertTriangle size={15} className="text-danger" />}
            label="이상 감지"
            value={kpi ? String(kpi.anomalyCount) : '—'}
            tone={kpi && kpi.anomalyCount > 0 ? 'red' : 'gray'}
          />
          <KpiCard
            icon={<ShieldCheck size={15} className="text-accent" />}
            label="운영 Agent"
            value={health ? String(health.total) : '—'}
            sub={health ? `정상 ${health.healthy} · 주의 ${health.degraded} · 비정상 ${health.down}` : undefined}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          {/* ── 실행 추이 막대 (성공/이상) ── */}
          <div className="lg:col-span-2 bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
                <TrendingUp size={14} className="text-accent" /> 일별 실행 추이 ({days}일)
              </p>
              <div className="flex items-center gap-3 text-[10px] text-gray-500">
                <Legend c="#4F6BD8" t="실행량" />
                <Legend c="#C77B7B" t="이상" />
              </div>
            </div>
            {loading ? (
              <div className="h-40 bg-gray-50 rounded animate-pulse" />
            ) : ts.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-12">실행 데이터가 없습니다.</p>
            ) : (
              <div className="flex items-end gap-0.5 h-40">
                {ts.map((t, i) => {
                  const h = Math.max(2, (t.executions / maxExec) * 150);
                  const anomalyH = t.executions > 0 ? (t.anomalies / t.executions) * h : 0;
                  return (
                    <div
                      key={i}
                      className="flex-1 flex flex-col justify-end group relative"
                      title={`${t.date} · 실행 ${t.executions} · 성공률 ${t.successRate}% · 이상 ${t.anomalies}`}
                    >
                      <div
                        className="w-full rounded-t bg-accent/80 group-hover:bg-accent transition-colors relative"
                        style={{ height: `${h}px` }}
                      >
                        {anomalyH > 0 && (
                          <div
                            className="absolute bottom-0 left-0 right-0 bg-danger rounded-t"
                            style={{ height: `${anomalyH}px` }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex justify-between text-[9px] text-gray-400 mt-1">
              <span>{ts[0]?.date?.slice(5) ?? ''}</span>
              <span>{ts[ts.length - 1]?.date?.slice(5) ?? ''}</span>
            </div>
          </div>

          {/* ── 상태 분포 도넛 ── */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <p className="text-xs font-bold text-gray-900 mb-3">Agent 상태 분포</p>
            {!health ? (
              <div className="h-40 bg-gray-50 rounded animate-pulse" />
            ) : (
              <HealthDonut health={health} />
            )}
          </div>
        </div>

        {/* ── 하단: 이상 Agent / 많이 쓴 Agent / 성공률 낮은 Agent ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <RankCard
            title="⚠ 이상 발생 Agent"
            empty="이상 감지된 Agent가 없습니다."
            rows={anomalyAgents.map((a) => ({
              key: a.workflowKey,
              label: label(a),
              right: `${a.anomalyCount}건`,
              rightTone: 'text-danger',
              onClick: () => router.push(`/agent/operations`),
            }))}
          />
          <RankCard
            title="🔥 많이 사용된 Agent"
            empty="실행 데이터가 없습니다."
            rows={topUsed.map((a) => ({
              key: a.workflowKey,
              label: label(a),
              right: `${a.executions.toLocaleString()}회`,
              rightTone: 'text-gray-700',
              bar: a.executions / (topUsed[0]?.executions || 1),
            }))}
          />
          <RankCard
            title="📉 성공률 낮은 Agent"
            empty="실행 데이터가 없습니다."
            rows={worstSuccess.map((a) => ({
              key: a.workflowKey,
              label: label(a),
              right: `${a.successRate}%`,
              rightTone: a.successRate < 80 ? 'text-danger' : 'text-warning',
            }))}
          />
        </div>
      </div>
    </div>
  );
}

// ── 소 컴포넌트 ──
function KpiCard({
  icon,
  label,
  value,
  sub,
  tone = 'navy',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: 'navy' | 'green' | 'red' | 'amber' | 'gray';
}) {
  const tones: Record<string, string> = {
    navy: 'text-gray-900',
    green: 'text-success',
    red: 'text-danger',
    amber: 'text-warning',
    gray: 'text-gray-500',
  };
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-0.5">
        {icon}
        <span className="text-[10px] text-muted-dark">{label}</span>
      </div>
      <p className={`text-lg font-bold leading-tight ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-[9px] text-muted-dark mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

function Legend({ c, t }: { c: string; t: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: c }} /> {t}
    </span>
  );
}

function HealthDonut({ health }: { health: Health }) {
  const segs = [
    { k: 'healthy', v: health.healthy },
    { k: 'degraded', v: health.degraded },
    { k: 'down', v: health.down },
    { k: 'idle', v: health.idle },
  ].filter((s) => s.v > 0);
  const total = segs.reduce((s, x) => s + x.v, 0) || 1;
  const size = 132;
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#F1F3F7" strokeWidth={16} />
        {segs.map((s, i) => {
          const frac = s.v / total;
          const dash = `${frac * c} ${c}`;
          const off = -acc * c;
          acc += frac;
          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={HEALTH_COLOR[s.k]}
              strokeWidth={16}
              strokeDasharray={dash}
              strokeDashoffset={off}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
        })}
        <text x="50%" y="47%" textAnchor="middle" fontSize={26} fontWeight={700} className="fill-gray-900">
          {health.total}
        </text>
        <text x="50%" y="60%" textAnchor="middle" fontSize={10} className="fill-gray-400">
          Agents
        </text>
      </svg>
      <div className="space-y-1.5">
        {(['healthy', 'degraded', 'down', 'idle'] as const).map((k) => (
          <div key={k} className="flex items-center gap-2 text-[11px]">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: HEALTH_COLOR[k] }} />
            <span className="text-gray-600 w-12">{HEALTH_LABEL[k]}</span>
            <b className="text-gray-900">{health[k]}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankCard({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{
    key: string;
    label: string;
    right: string;
    rightTone: string;
    bar?: number;
    onClick?: () => void;
  }>;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2.5 border-b border-gray-100 text-xs font-bold text-gray-900">
        {title}
      </div>
      <div className="p-2">
        {rows.length === 0 ? (
          <p className="text-[11px] text-gray-400 text-center py-5">{empty}</p>
        ) : (
          <ul className="space-y-0.5">
            {rows.map((r) => (
              <li
                key={r.key}
                onClick={r.onClick}
                className={`flex items-center gap-2 px-1.5 py-1.5 rounded text-[11px] ${r.onClick ? 'cursor-pointer hover:bg-gray-50' : ''}`}
              >
                <span className="flex-1 min-w-0 text-gray-800 truncate" title={r.label}>
                  {r.label}
                </span>
                {r.bar != null && (
                  <div className="w-16 h-1.5 bg-gray-100 rounded overflow-hidden shrink-0">
                    <div
                      className="h-full bg-accent/70 rounded"
                      style={{ width: `${Math.max(4, r.bar * 100)}%` }}
                    />
                  </div>
                )}
                <span className={`shrink-0 font-semibold ${r.rightTone}`}>{r.right}</span>
                {r.onClick && <ChevronRight size={12} className="text-gray-300 shrink-0" />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
