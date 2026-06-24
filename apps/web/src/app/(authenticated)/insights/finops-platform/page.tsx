'use client';

/**
 * FinOps (네이티브 통합) — control-plane 데이터를 metis 백엔드 프록시(/finops-gw/*)로 받아
 * metis UI + 자체 SVG 차트로 렌더링. 하위탭별 실데이터 + 그래프.
 */
import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { api } from '@/lib/api-client';
import { RefreshCw, Activity, ShieldCheck, Cpu, Wallet, DollarSign, Lightbulb, ShieldAlert } from 'lucide-react';

type Tab = 'control' | 'policy' | 'dev' | 'ops' | 'finance' | 'gov' | 'insight';
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'control', label: '관제', icon: <Activity size={14} /> },
  { id: 'policy', label: '토큰정책', icon: <ShieldCheck size={14} /> },
  { id: 'dev', label: '개발', icon: <Cpu size={14} /> },
  { id: 'ops', label: '운영', icon: <Wallet size={14} /> },
  { id: 'finance', label: '재무', icon: <DollarSign size={14} /> },
  { id: 'gov', label: '거버넌스', icon: <ShieldAlert size={14} /> },
  { id: 'insight', label: '인사이트', icon: <Lightbulb size={14} /> },
];
const PALETTE = ['#2B6CB0', '#2C7A4B', '#B07D2B', '#B23B3B', '#6B5CA5', '#0E7C86', '#9C6B2E', '#7A7F87'];

const usd = (v: unknown, d = 4) => (typeof v === 'number' ? `$${v.toFixed(d)}` : '—');
const numv = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : '—');
const pctv = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '—');
const f2 = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '—');

function Panel({ title, children, sub }: { title: string; children: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        {sub && <span className="text-[11px] text-gray-400">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border transition disabled:opacity-50 ${
        on ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-gray-100 text-gray-500 border-gray-300'
      }`}
    >
      {on ? 'ON' : 'OFF'}
    </button>
  );
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`text-lg font-bold ${tone ?? 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

/** 도넛 + 범례 */
function Donut({ segments, size = 132, center }: { segments: { label: string; value: number; color?: string }[]; size?: number; center?: string }) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const r = size / 2 - 12, cx = size / 2, cy = size / 2, sw = 16, circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#eef2f7" strokeWidth={sw} />
        {segments.map((s, i) => {
          const frac = (s.value || 0) / total;
          const dash = frac * circ;
          const off = -acc * circ;
          acc += frac;
          return (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color ?? PALETTE[i % PALETTE.length]} strokeWidth={sw}
              strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={off} transform={`rotate(-90 ${cx} ${cy})`} />
          );
        })}
        {center && <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize="16" fontWeight="700" fill="#1f2937">{center}</text>}
      </svg>
      <div className="space-y-1 text-[11px]">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: s.color ?? PALETTE[i % PALETTE.length] }} />
            <span className="text-gray-600">{s.label}</span>
            <span className="text-gray-400">{(((s.value || 0) / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 2-시계열 라인 (비용 vs 절감) */
function TwoLine({ points, height = 170 }: { points: { t: number; a: number; b: number }[]; height?: number }) {
  if (!points.length) return <p className="text-xs text-gray-400 py-10 text-center">시계열 데이터가 아직 없습니다.</p>;
  const W = 640, H = height, pad = 26;
  const xs = points.map((p) => p.t);
  const minx = Math.min(...xs), maxx = Math.max(...xs) || 1;
  const maxy = Math.max(0.0000001, ...points.map((p) => Math.max(p.a, p.b)));
  const X = (t: number) => pad + (maxx === minx ? 0 : (t - minx) / (maxx - minx)) * (W - 2 * pad);
  const Y = (v: number) => H - pad - (v / maxy) * (H - 2 * pad);
  const path = (k: 'a' | 'b') => points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p[k]).toFixed(1)}`).join(' ');
  const area = (k: 'a' | 'b') => `${path(k)} L${X(points[points.length - 1].t).toFixed(1)} ${H - pad} L${X(points[0].t).toFixed(1)} ${H - pad} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: height }}>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#e5e7eb" />
        <path d={area('b')} fill="#2C7A4B" opacity="0.10" />
        <path d={path('b')} fill="none" stroke="#2C7A4B" strokeWidth="2" />
        <path d={path('a')} fill="none" stroke="#B23B3B" strokeWidth="2" />
      </svg>
      <div className="flex gap-4 text-[11px] text-gray-500 mt-1">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block" style={{ background: '#B23B3B' }} /> 비용</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block" style={{ background: '#2C7A4B' }} /> 절감</span>
      </div>
    </div>
  );
}

/** 다중 라인 (각 시리즈 0~1 정규화된 v 사용) */
function MultiLine({ series, height = 180 }: { series: { name: string; color: string; pts: { t: number; v: number }[] }[]; height?: number }) {
  const all = series.flatMap((s) => s.pts);
  if (!all.length) return <p className="text-xs text-gray-400 py-10 text-center">시계열 데이터가 아직 없습니다.</p>;
  const W = 640, H = height, pad = 26;
  const xs = all.map((p) => p.t);
  const minx = Math.min(...xs), maxx = Math.max(...xs) || 1;
  const X = (t: number) => pad + (maxx === minx ? 0 : (t - minx) / (maxx - minx)) * (W - 2 * pad);
  const Y = (v: number) => H - pad - Math.max(0, Math.min(1, v)) * (H - 2 * pad);
  const path = (pts: { t: number; v: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: height }}>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#e5e7eb" />
        {series.map((s, i) => <path key={i} d={path(s.pts)} fill="none" stroke={s.color} strokeWidth="2" />)}
      </svg>
      <div className="flex gap-4 text-[11px] text-gray-500 mt-1">
        {series.map((s, i) => (
          <span key={i} className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block" style={{ background: s.color }} /> {s.name}</span>
        ))}
      </div>
    </div>
  );
}

/** 가로 막대 (값 포맷 지정) */
function Bars({ items, fmt }: { items: { label: string; value: number; color?: string }[]; fmt: (v: number) => string }) {
  if (!items.length) return <p className="text-xs text-gray-400 py-6 text-center">데이터가 없습니다.</p>;
  const max = Math.max(1e-9, ...items.map((i) => i.value));
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 text-[11px]">
          <span className="w-32 truncate text-gray-600">{it.label}</span>
          <div className="flex-1 bg-gray-100 rounded h-3.5 overflow-hidden">
            <div className="h-full rounded" style={{ width: `${(it.value / max) * 100}%`, background: it.color ?? PALETTE[i % PALETTE.length] }} />
          </div>
          <span className="w-20 text-right text-gray-700 tabular-nums">{fmt(it.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Tbl({ cols, rows }: { cols: { h: string; r: (x: any) => React.ReactNode }[]; rows: any[] }) {
  if (!rows?.length) return <p className="text-xs text-gray-400 py-6 text-center">데이터가 없습니다.</p>;
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-lg">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200 text-[10px] text-gray-500">
            {cols.map((c, i) => <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{c.h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-gray-50 hover:bg-gray-50">
              {cols.map((c, ci) => <td key={ci} className="px-3 py-2 whitespace-nowrap text-gray-700">{c.r(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FinOpsNativePage() {
  const [tab, setTab] = useState<Tab>('control');
  const [d, setD] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    setErr(null);
    const get = (p: string) => api.get<any>(`/finops-gw/${p}`).catch(() => null);
    try {
      let r: Record<string, any> = {};
      if (t === 'control') r = { ov: await get('overview'), sv: await get('savings?hours=24'), recent: await get('runs/recent?limit=12') };
      else if (t === 'policy') r = { agents: await get('agents'), prices: await get('model_prices') };
      else if (t === 'dev') r = { stats: await get('run_stats?hours=24') };
      else if (t === 'ops') r = { budgets: await get('budgets'), gpu: await get('gpu?minutes=30') };
      else if (t === 'finance') r = { sb: await get('showback?hours=24'), qc: await get('quality_cost?hours=24'), sv: await get('savings?hours=24'), ov: await get('overview') };
      else if (t === 'gov') r = { gov: await get('governance?hours=24') };
      else if (t === 'insight') r = { ins: await get('insights') };
      setD(r);
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? '불러오기 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  // 정책 설정 (에이전트 토글 / 모델 강등대상 변경) → control-plane 에 반영 후 재조회
  const [busy, setBusy] = useState(false);
  const apply = useCallback(async (path: string, body: any) => {
    setBusy(true);
    try {
      await api.post(`/finops-gw/${path}`, body);
      await load(tab);
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? '설정 변경 실패');
    } finally {
      setBusy(false);
    }
  }, [load, tab]);

  // 데모 실행: 테스트 에이전트(코드리뷰)를 게이트웨이 경유로 1회 실행 → 품질·비용·절감이 원장에 기록되어 대시보드에 반영
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoRes, setDemoRes] = useState<any>(null);
  const runDemo = useCallback(async () => {
    setDemoBusy(true);
    setErr(null);
    const sample = [
      'def transfer(accounts, src, dst, amount):',
      '    # TODO: validate inputs',
      '    accounts[src] -= amount',
      '    accounts[dst] += amount',
      '    return accounts',
    ].join('\n');
    try {
      const res = await api.post<any>('/finops-gw/qa/test', { filename: 'demo.py', code: sample });
      setDemoRes(res);
      await load(tab);
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? '데모 실행 실패 — 테스트 에이전트(:8600) 기동 여부를 확인하세요.');
    } finally {
      setDemoBusy(false);
    }
  }, [load, tab]);

  useEffect(() => { void load(tab); }, [tab, load]);

  const ov = d.ov, sv = d.sv, gov = d.gov;
  const series = (sv?.series ?? []).map((x: any) => ({ t: x.bucket, a: x.cost ?? 0, b: x.savings ?? 0 }));
  const agentRows = d.agents?.rows ?? [];
  const cacheOn = agentRows.filter((a: any) => a.semantic_cache).length;
  const dgOn = agentRows.filter((a: any) => a.downgrade_enabled).length;

  return (
    <div className="pb-10">
      <PageHeader
        title="FinOps (예산·절감 통합)"
        description="모든 LLM 호출이 FinOps 게이트웨이를 경유 — 실시간 예산 통제·캐시·라우팅으로 실제 절감. 현황을 metis 안에서 바로 확인."
        actions={
          <button onClick={() => void load(tab)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:border-accent/40 transition">
            <RefreshCw size={13} /> 새로고침
          </button>
        }
      />

      <div className="px-6">
        <div className="flex flex-wrap gap-1 border-b border-gray-200">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={tab === t.id
                ? 'flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-blue-700 border-b-2 border-blue-600 -mb-px'
                : 'flex items-center gap-1.5 px-3.5 py-2 text-sm text-gray-500 hover:text-gray-800 border-b-2 border-transparent -mb-px'}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pt-4 space-y-4">
        {err && <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-700">{err} — FinOps 컨테이너(:8500)가 기동/빌드 중일 수 있습니다.</div>}
        {loading && <p className="text-xs text-gray-400">불러오는 중…</p>}

        {tab === 'control' && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card label="오늘 비용" value={usd(ov?.today_cost, 2)} />
              <Card label="오늘 절감액" value={usd(ov?.today_savings, 2)} tone="text-emerald-600" sub={`캐시 히트율 ${pctv(sv?.cache_hit_rate)}`} />
              <Card label="오늘 호출" value={numv(ov?.today_calls)} sub={`${numv(ov?.today_tokens)} 토큰`} />
              <Card label="분당 소진" value={usd(ov?.burn_per_min, 5)} sub={`활성 run ${numv(ov?.active_runs)}`} />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2"><Panel title="비용 vs 절감 추이 (24h)"><TwoLine points={series} /></Panel></div>
              <Panel title="절감 구성 (메커니즘별)">
                <Donut center={usd(ov?.today_savings, 2)} segments={(sv?.by_kind ?? []).map((x: any, i: number) => ({ label: x.savings_kind, value: x.s, color: PALETTE[i % PALETTE.length] }))} />
              </Panel>
            </div>
            <Panel title="최근 실행">
              <Tbl
                cols={[
                  { h: 'Agent', r: (x) => x.agent },
                  { h: '상태', r: (x) => x.status },
                  { h: '비용', r: (x) => usd(x.total_cost) },
                  { h: '토큰', r: (x) => numv(x.total_tokens) },
                  { h: '품질', r: (x) => f2(x.quality_score) },
                ]}
                rows={d.recent?.rows ?? []}
              />
            </Panel>
          </>
        )}

        {tab === 'policy' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Panel title="시맨틱 캐시 적용"><Donut center={`${cacheOn}/${agentRows.length}`} segments={[{ label: 'ON', value: cacheOn, color: '#2C7A4B' }, { label: 'OFF', value: agentRows.length - cacheOn, color: '#cbd5e1' }]} /></Panel>
              <Panel title="라우팅 강등 활성"><Donut center={`${dgOn}/${agentRows.length}`} segments={[{ label: 'ON', value: dgOn, color: '#2B6CB0' }, { label: 'OFF', value: agentRows.length - dgOn, color: '#cbd5e1' }]} /></Panel>
            </div>
            <Panel title="에이전트 정책 설정" sub="클릭/선택으로 즉시 적용 (control-plane 반영)">
              <p className="text-[11px] text-gray-400 mb-2">시맨틱 캐시·라우팅 강등·복잡도 라우팅은 클릭 토글, 강등 대상 모델은 드롭다운으로 변경됩니다.</p>
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200 text-[10px] text-gray-500">
                      {['Agent', '시맨틱 캐시', '라우팅 강등', '복잡도 라우팅', '주 모델', '강등 대상', '품질 게이트', '24h 품질'].map((h, i) => (
                        <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {agentRows.length === 0 && (
                      <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">에이전트가 없습니다.</td></tr>
                    )}
                    {agentRows.map((a: any, i: number) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="px-3 py-2 font-semibold text-gray-900 whitespace-nowrap">{a.agent}</td>
                        <td className="px-3 py-2"><Toggle on={!!a.semantic_cache} disabled={busy} onClick={() => apply('agents/update', { agent: a.agent, semantic_cache: !a.semantic_cache })} /></td>
                        <td className="px-3 py-2"><Toggle on={!!a.downgrade_enabled} disabled={busy} onClick={() => apply('agents/update', { agent: a.agent, downgrade_enabled: !a.downgrade_enabled })} /></td>
                        <td className="px-3 py-2"><Toggle on={!!a.complexity_routing} disabled={busy} onClick={() => apply('agents/update', { agent: a.agent, complexity_routing: !a.complexity_routing })} /></td>
                        <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{a.primary_model ?? '—'}</td>
                        <td className="px-3 py-2">
                          {a.primary_model ? (
                            <select
                              value={a.downgrade_target ?? ''}
                              disabled={busy}
                              onChange={(e) => apply('model_prices/update', { model: a.primary_model, downgrade_to: e.target.value || null })}
                              className="px-2 py-1 border border-gray-300 rounded text-xs bg-white text-gray-900"
                            >
                              <option value="">없음</option>
                              {(d.prices?.rows ?? [])
                                .filter((p: any) => p.model !== a.primary_model)
                                .map((p: any, pi: number) => (
                                  <option key={pi} value={p.model}>{p.model}{p.tier ? ` (${p.tier})` : ''}</option>
                                ))}
                            </select>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${a.gate?.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : a.gate?.status === 'rejected' ? 'bg-rose-50 text-rose-700' : a.gate ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                            {a.gate?.status === 'approved' ? '승인' : a.gate?.status === 'rejected' ? '보류(품질미달)' : a.gate ? '카나리 수집중' : '대상없음'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-700">{f2(a.avg_quality_24h)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}

        {tab === 'dev' && (
          <>
            <Panel title="핵심 동작 데모 — 게이트웨이 경유 실행" sub="코드리뷰 에이전트를 1회 실행: 품질 게이트 통과 + 캐시/라우팅으로 비용 절감이 원장에 기록되어 모든 탭·대시보드에 반영됩니다.">
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={() => void runDemo()} disabled={demoBusy}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                  {demoBusy ? '실행 중…' : '데모 실행'}
                </button>
                <span className="text-[11px] text-gray-400">실제 LLM 호출이 게이트웨이(:8400)를 경유합니다. 동일 입력 재실행 시 시맨틱 캐시로 비용이 0에 수렴.</span>
              </div>
              {demoRes && (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card label="이번 실행 비용" value={usd(demoRes.cost_usd, 5)} />
                  <Card label="소요(초)" value={typeof demoRes.elapsed_s === 'number' ? demoRes.elapsed_s.toFixed(1) : '—'} />
                  <Card label="모드" value={demoRes.mode ?? '—'} sub={demoRes.language ?? ''} />
                  <Card label="run_id" value={String(demoRes.run_id ?? '—').slice(0, 8)} sub="원장 기록됨" />
                </div>
              )}
            </Panel>
            <Panel title="Agent별 p99 run 비용 (롱테일 점검)">
              <Bars items={(d.stats?.rows ?? []).slice(0, 12).map((x: any) => ({ label: x.agent, value: x.p99 ?? 0 }))} fmt={(v) => usd(v)} />
            </Panel>
            <Panel title="run 비용·품질 통계">
              <Tbl
                cols={[
                  { h: 'Agent', r: (x) => x.agent },
                  { h: 'run수', r: (x) => numv(x.runs) },
                  { h: 'p50', r: (x) => usd(x.p50) },
                  { h: 'p95', r: (x) => usd(x.p95) },
                  { h: 'p99', r: (x) => usd(x.p99) },
                  { h: '성공률', r: (x) => pctv(x.pass_rate) },
                  { h: 'cost-of-pass', r: (x) => usd(x.cost_of_pass) },
                  { h: '차단', r: (x) => numv(x.killed) },
                ]}
                rows={d.stats?.rows ?? []}
              />
            </Panel>
          </>
        )}

        {tab === 'ops' && (
          <>
            <Panel title="예산 소진율">
              <Bars items={(d.budgets?.rows ?? []).map((x: any) => ({ label: `${x.scope_type}:${x.scope_id}`, value: x.daily_usd ? Math.min(1, (x.spent || 0) / x.daily_usd) : 0, color: x.daily_usd && x.spent / x.daily_usd > 0.8 ? '#B23B3B' : '#2C7A4B' }))} fmt={(v) => pctv(v)} />
            </Panel>
            <Panel title={`GPU 사용률 · 유휴비용 ${usd(d.gpu?.idle_cost_per_hour, 2)}/h`}>
              <Bars items={(d.gpu?.latest ?? []).map((x: any) => ({ label: x.node, value: x.gpu_util ?? 0, color: '#2B6CB0' }))} fmt={(v) => pctv(v)} />
            </Panel>
          </>
        )}

        {tab === 'finance' && (() => {
          const qc = d.qc?.rows ?? [];
          const maxc = Math.max(1e-9, ...qc.map((x: any) => x.c || 0));
          const qSeries = { name: '품질(유지)', color: '#2C7A4B', pts: qc.map((x: any) => ({ t: x.bucket, v: x.q ?? 0 })) };
          const cSeries = { name: '비용(정규화·절감추세)', color: '#B23B3B', pts: qc.map((x: any) => ({ t: x.bucket, v: (x.c || 0) / maxc })) };
          const avgQ = qc.length ? qc.reduce((a: number, x: any) => a + (x.q || 0), 0) / qc.length : null;
          const savings = (d.sv?.by_kind ?? []).reduce((a: number, x: any) => a + (x.s || 0), 0);
          const todayCost = d.ov?.today_cost || 0;
          const rate = savings + todayCost > 0 ? savings / (savings + todayCost) : null;
          return (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Card label="평균 품질 (유지)" value={f2(avgQ)} tone="text-emerald-600" sub="높게 유지될수록 좋음" />
                <Card label="절감액 (24h)" value={usd(savings)} tone="text-emerald-600" sub={`캐시 히트율 ${pctv(d.sv?.cache_hit_rate)}`} />
                <Card label="실제 비용 (오늘)" value={usd(todayCost, 2)} />
                <Card label="절감률" value={pctv(rate)} tone="text-emerald-600" sub="미적용 가정 대비" />
              </div>
              <Panel title="품질 vs 비용 — 품질 유지하며 비용 절감되는가" sub="품질(녹색) 유지 + 비용(빨강) 하락 = FinOps 핵심">
                <MultiLine series={[qSeries, cSeries]} />
              </Panel>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Panel title="테넌트별 비용 비중" sub={`총 ${usd(d.sb?.total)}`}>
                  <Donut center={usd(d.sb?.total, 1)} segments={(d.sb?.rows ?? []).map((x: any, i: number) => ({ label: x.tenant, value: x.cost, color: PALETTE[i % PALETTE.length] }))} />
                </Panel>
                <Panel title="테넌트 쇼백">
                  <Tbl
                    cols={[
                      { h: '테넌트', r: (x) => x.tenant },
                      { h: '비용', r: (x) => usd(x.cost) },
                      { h: '절감', r: (x) => usd(x.savings) },
                      { h: '비중', r: (x) => pctv(x.share) },
                      { h: '호출', r: (x) => numv(x.calls) },
                    ]}
                    rows={d.sb?.rows ?? []}
                  />
                </Panel>
              </div>
            </>
          );
        })()}

        {tab === 'gov' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Panel title="정책 준수율">
                <Donut center={pctv(gov?.compliance)} segments={[{ label: '준수', value: gov?.compliance ?? 0, color: '#2C7A4B' }, { label: '위반', value: 1 - (gov?.compliance ?? 0), color: '#B23B3B' }]} />
              </Panel>
              <Card label="캐시 정책 차단" value={`${numv(gov?.denied)}건`} sub="민감/고위험" />
              <Card label="민감 캐시 누출" value={`${numv(gov?.sensitive_leaks)}건`} tone={gov?.sensitive_leaks > 0 ? 'text-rose-600' : 'text-emerald-600'} sub={`리스크 강등 방어 ${numv(gov?.escalations)}건`} />
            </div>
            <Panel title="데이터 등급 분포">
              <Tbl cols={[{ h: '등급', r: (x) => x.d ?? '—' }, { h: '건수', r: (x) => numv(x.n) }, { h: '비용', r: (x) => usd(x.c) }]} rows={gov?.by_class ?? []} />
            </Panel>
          </>
        )}

        {tab === 'insight' && (
          <div className="space-y-2">
            {(d.ins?.rows ?? []).map((it: any, i: number) => (
              <div key={i} className={`p-3 rounded-lg border text-xs ${it.severity === 'critical' ? 'bg-rose-50 border-rose-200' : it.severity === 'warning' ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className="font-bold text-gray-900 mb-0.5">{it.icon} {it.title}</div>
                <div className="text-gray-600 leading-relaxed">{it.body}</div>
              </div>
            ))}
            {!loading && !(d.ins?.rows ?? []).length && <p className="text-xs text-gray-400 py-6 text-center">인사이트가 없습니다.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
