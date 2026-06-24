'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plug } from 'lucide-react';
import { useNavigationStore, TopNavItem } from '@/stores/navigation';
import { api, logout } from '@/lib/api-client';
import { IngestConnectModal } from './IngestConnectModal';

const TOP_LINKS: { id: TopNavItem; label: string; href: string }[] = [
  { id: 'dashboard', label: '대시보드', href: '/home' },
];

export function TopNav() {
  const { activeTopNav, setActiveTopNav } = useNavigationStore();
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);
  const [showAthene, setShowAthene] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const router = useRouter();

  // 간소화 3역할 매핑 — 관리자만 연동 설정 노출
  const isAdmin = ['ADMIN', 'PLATFORM_ADMIN', 'TENANT_ADMIN'].includes(user?.role ?? '');

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await api.get<{ email: string; role: string }>('/auth/me');
        if (response) {
          setUser({ email: response.email ?? '', role: response.role ?? '' });
        }
      } catch (error) {
        const defaultEmail =
          typeof window !== 'undefined' ? localStorage.getItem('userEmail') || 'User' : 'User';
        setUser({ email: defaultEmail, role: 'OPERATOR' });
      }
    };
    fetchUser();
  }, []);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-dark border-b border-white/[0.08] flex items-center justify-between px-6 h-[52px]">
      {/* Logo */}
      <div className="flex items-center gap-6">
        <button
          onClick={() => router.push('/home')}
          className="font-extrabold text-lg text-accent tracking-tight hover:opacity-80 transition cursor-pointer"
        >
          Metis.AI
          <span className="text-white/60 font-normal text-[13px] ml-3">AgentOps Governance</span>
        </button>

        {/* Top navigation links */}
        <div className="flex gap-1 ml-6">
          {TOP_LINKS.map((link) => (
            <button
              key={link.id}
              onClick={() => {
                setActiveTopNav(link.id);
                router.push(link.href);
              }}
              className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-all border border-transparent
                ${
                  activeTopNav === link.id
                    ? 'bg-accent/15 border-accent/30 text-accent font-semibold'
                    : 'text-muted hover:bg-white/[0.08] hover:text-white'
                }`}
            >
              {link.label}
            </button>
          ))}
        </div>
      </div>

      {/* Right side: 연동 설정 + Athene shortcut + user info */}
      <div className="text-xs text-muted flex items-center gap-3">
        {isAdmin && (
          <button
            onClick={() => setShowConnect(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-white/80 border border-white/15 hover:bg-white/[0.08] hover:text-white transition-all"
            title="실제 Agent 연동 설정 (Ingest 키 발급·연결)"
          >
            <Plug size={14} /> 연동 설정
          </button>
        )}
        <button
          onClick={() => setShowAthene(true)}
          className="px-3 py-1.5 rounded-md text-[13px] font-medium text-accent border border-accent/30 bg-accent/10 hover:bg-accent/20 transition-all"
          title="Athene 개발 Agent 스튜디오 (외부 연결)"
        >
          Athene 바로가기 ↗
        </button>
        <span className="px-2 py-1 bg-accent/10 text-accent rounded text-[10px] font-semibold">
          {user?.role ?? 'Loading...'}
        </span>
        <span>{user?.email ?? 'Loading...'}</span>
        <button
          onClick={() => {
            void logout('/login');
          }}
          className="px-3 py-1.5 rounded-md text-[13px] font-medium text-white/70 border border-white/15 hover:bg-white/[0.08] hover:text-white transition-all"
          title="로그아웃"
        >
          로그아웃
        </button>
      </div>

      {/* Athene coming-soon popup */}
      {showAthene && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4"
          onClick={() => setShowAthene(false)}
        >
          <div
            className="bg-white rounded-lg w-full max-w-md p-6 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-3xl mb-3">🚀</div>
            <h2 className="text-base font-bold text-gray-900">Athene 개발 Agent 스튜디오</h2>
            <p className="text-sm text-gray-600 mt-2">
              Athene는 별도의 개발 Agent 스튜디오로 연결되는 기능입니다.
              <br />
              현재는 준비 중이며, 향후 제공될 예정입니다.
            </p>
            <button
              onClick={() => setShowAthene(false)}
              className="mt-5 px-4 py-2 bg-blue-600 text-white rounded text-sm font-semibold hover:bg-blue-700"
            >
              확인
            </button>
          </div>
        </div>
      )}

      {showConnect && <IngestConnectModal onClose={() => setShowConnect(false)} />}
    </nav>
  );
}
