'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import {
  ShieldCheck,
  Gauge,
  Wallet,
  Activity,
  Check,
  Mail,
  Lock,
  ArrowRight,
} from 'lucide-react';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    tenantId: string;
  };
}

// Dev-only prefilled credentials — never shipped in production builds.
const IS_DEV = process.env.NODE_ENV !== 'production';
const DEV_EMAIL = 'admin@metis.ai';
const DEV_PASSWORD = 'metis1234';

const FEATURES = [
  {
    icon: ShieldCheck,
    title: '4-게이트 자동 평가',
    desc: '모든 실행을 품질·비용·보안·이상 4축으로 자동 평가하고 등급화합니다.',
  },
  {
    icon: Activity,
    title: '한 화면에서 실행·기록',
    desc: '사내 워크플로우는 물론 외부 전용화면 에이전트까지 metis 안에서 실행·이력화.',
  },
  {
    icon: Wallet,
    title: '실시간 비용·ROI 가시성',
    desc: '모델 단가·토큰을 원장으로 집계해 실행별 비용과 절감 효과를 즉시 확인.',
  },
  {
    icon: Gauge,
    title: '정책·감사·이상탐지',
    desc: '정책·ORB 심사·FDS 이상탐지·감사 로그로 에이전트 행위를 통제합니다.',
  },
];

/**
 * kt ds 브랜드 워드마크 (소형). 공식 로고는 등록상표이므로 브랜드 컬러(레드)에
 * 맞춘 소문자 워드마크로 표현. 공식 자산은 apps/web/public/ktds-logo.svg 로 교체 가능.
 */
function KtdsWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-extrabold lowercase tracking-tight select-none ${className}`}>
      <span style={{ color: '#E50012' }}>kt</span>
      <span className="text-slate-200"> ds</span>
    </span>
  );
}

/**
 * Metis.ai 공식 심볼(자사 상표) — 육각형 안의 올빼미 + 회로 노드.
 * 다크 배경용으로 색을 맞춘 재현본. 원본 자산을 쓰려면
 * apps/web/public/metis-logo.svg 로 교체하면 된다.
 */
function MetisMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" className={className} role="img" aria-label="Metis.ai">
      <defs>
        <linearGradient id="metisHexG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a4068" />
          <stop offset="1" stopColor="#13223a" />
        </linearGradient>
      </defs>
      {/* 육각형 */}
      <polygon
        points="60,8 105,34 105,86 60,112 15,86 15,34"
        fill="url(#metisHexG)"
        stroke="#3c5680"
        strokeWidth="2"
      />
      {/* 내부 외곽선 */}
      <polygon
        points="60,17 97,38 97,82 60,103 23,82 23,38"
        fill="none"
        stroke="#3c5680"
        strokeWidth="1.4"
        opacity="0.65"
      />
      {/* 눈썹(브로우) */}
      <polyline
        points="26,48 43,38 60,48 77,38 94,48"
        fill="none"
        stroke="#93b4d6"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 왼눈 */}
      <circle cx="44" cy="66" r="15" fill="#eaf2fb" stroke="#74c2dd" strokeWidth="3" />
      <circle cx="44" cy="67" r="7.5" fill="#15263f" />
      <circle cx="41" cy="63" r="2.4" fill="#ffffff" />
      {/* 오른눈 */}
      <circle cx="76" cy="66" r="15" fill="#eaf2fb" stroke="#74c2dd" strokeWidth="3" />
      <circle cx="76" cy="67" r="7.5" fill="#15263f" />
      <circle cx="73" cy="63" r="2.4" fill="#ffffff" />
      {/* 부리 */}
      <polygon points="54,79 66,79 60,89" fill="#18b6c4" />
      {/* 회로 노드 */}
      <g stroke="#557aa6" strokeWidth="1.5" fill="none">
        <path d="M60,89 L34,100" />
        <path d="M60,89 L60,106" />
        <path d="M60,89 L86,100" />
      </g>
      <g fill="#7fb6d8" stroke="#13223a" strokeWidth="1">
        <circle cx="34" cy="100" r="3.4" />
        <circle cx="60" cy="106" r="3.4" />
        <circle cx="86" cy="100" r="3.4" />
      </g>
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState(IS_DEV ? DEV_EMAIL : '');
  const [password, setPassword] = useState(IS_DEV ? DEV_PASSWORD : '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.post<LoginResponse>('/auth/login', { email, password });
      // Auth tokens are set by the server as httpOnly cookies (metis_access /
      // metis_refresh). We do NOT persist any JWT in localStorage. Only keep a
      // non-sensitive display value.
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem('userEmail', res.user?.email ?? email);
        } catch {
          // ignore storage failures
        }
      }
      window.location.href = '/home';
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_0.95fr] bg-[#0B1426] text-white">
      {/* ───────────── Left: brand / introduction ───────────── */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden px-12 xl:px-16 py-12">
        {/* decorative gradients */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -left-24 h-96 w-96 rounded-full bg-[#00B4D8]/20 blur-3xl" />
          <div className="absolute top-1/3 -right-24 h-96 w-96 rounded-full bg-[#6C5CE7]/20 blur-3xl" />
          <div className="absolute bottom-0 left-1/4 h-80 w-80 rounded-full bg-[#0EA98A]/15 blur-3xl" />
        </div>

        {/* top: logo + tagline */}
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <MetisMark className="h-12 w-12 shrink-0" />
            <div className="flex flex-col leading-none">
              <span className="text-[26px] font-extrabold tracking-tight">
                Metis<span className="text-[#19B9CE]">.ai</span>
              </span>
              <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                OPS.AI Governance Platform
              </span>
            </div>
          </div>
          <span className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs tracking-wide text-cyan-200">
            <span className="h-1.5 w-1.5 rounded-full bg-[#3AD7F0]" /> 엔터프라이즈 AI 거버넌스 플랫폼
          </span>
        </div>

        {/* middle: headline + features */}
        <div className="relative z-10 max-w-xl">
          <h1 className="text-4xl xl:text-[2.7rem] font-bold leading-tight tracking-tight">
            모든 AI 에이전트를
            <br />
            <span className="bg-gradient-to-r from-[#3AD7F0] via-[#56c8ff] to-[#9b8cff] bg-clip-text text-transparent">
              한 곳에서 운영·관리
            </span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-slate-300">
            등록 → 실행 → 4-게이트(품질·비용·보안·이상) 평가 → 거버넌스 → 대시보드까지.
            <br />
            사내·외부 에이전트를 하나의 통제면에서 안전하게 운영하는 멀티테넌트 SaaS.
          </p>

          <div className="mt-8 grid grid-cols-2 gap-4">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-sm transition hover:border-[#00B4D8]/40 hover:bg-white/[0.07]"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#00B4D8]/15 ring-1 ring-[#00B4D8]/30">
                    <Icon className="h-[18px] w-[18px] text-[#3AD7F0]" />
                  </span>
                  <h3 className="mt-3 text-sm font-semibold text-white">{f.title}</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* bottom: trust strip */}
        <div className="relative z-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-[#0EA98A]" /> 멀티테넌트 격리
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-[#0EA98A]" /> RBAC 6 역할
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-[#0EA98A]" /> 감사 로그 · 정책 통제
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-[#0EA98A]" /> FinOps 비용 가시성
          </span>
        </div>
      </aside>

      {/* ───────────── Right: login card ───────────── */}
      <main className="relative flex items-center justify-center px-6 py-12 sm:px-10">
        {/* subtle bg for the form side */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#0E1A30] to-[#0B1426]" />
        <div className="relative z-10 w-full max-w-md">
          {/* compact brand for small screens */}
          <div className="mb-8 flex flex-col items-center lg:hidden">
            <MetisMark className="h-14 w-14" />
            <h1 className="mt-3 text-2xl font-extrabold tracking-tight">
              Metis<span className="text-[#19B9CE]">.ai</span>
            </h1>
            <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              OPS.AI Governance Platform
            </p>
            <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-slate-400">
              <span className="text-[12px]">by</span> <KtdsWordmark className="text-sm" />
            </p>
          </div>

          <div className="rounded-2xl border border-[#23365C] bg-[#111E36]/90 p-8 shadow-2xl backdrop-blur">
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-white">로그인</h2>
              <p className="mt-1 text-sm text-slate-400">계정 정보로 통제면에 접속하세요.</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-300">이메일</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-500" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-[#2A3A5C] bg-[#0B1426] py-2.5 pl-11 pr-4 text-white placeholder-slate-500 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#00B4D8]"
                    placeholder="admin@metis.ai"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-300">비밀번호</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-500" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-[#2A3A5C] bg-[#0B1426] py-2.5 pl-11 pr-4 text-white placeholder-slate-500 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#00B4D8]"
                    placeholder="비밀번호"
                    required
                  />
                </div>
              </div>

              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-400">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="group flex w-full items-center justify-center gap-2 rounded-lg bg-[#00B4D8] py-2.5 font-semibold text-[#05202b] transition hover:bg-[#22c6e6] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? '로그인 중...' : '로그인'}
                {!loading && (
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                )}
              </button>
            </form>

            {/* Dev credentials hint — development builds only */}
            {IS_DEV && (
              <div className="mt-6 rounded-lg border border-[#2A3A5C]/60 bg-[#0B1426]/60 p-3">
                <p className="text-center text-xs text-slate-500">
                  Dev: admin@metis.ai / metis1234
                </p>
              </div>
            )}
          </div>

          <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-slate-500">
            © {new Date().getFullYear()} Metis.ai · a <KtdsWordmark className="text-xs" /> platform
          </p>
        </div>
      </main>
    </div>
  );
}
