'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  Target,
  CreditCard,
  Shield,
  Wrench,
  Code,
  Bot,
  Beaker,
  Plug,
  Package,
  BookOpen,
  Palette,
  Radio,
  Rocket,
  BarChart3,
  DollarSign,
  AlertTriangle,
  ClipboardList,
  ShieldCheck,
  FileArchive,
  Activity,
  Users,
  Waves,
  Store,
  Monitor,
  FileText,
  Bug,
  RefreshCw,
  CheckCircle,
  Sparkles,
  Zap,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  KeyRound,
  Database,
  Gauge,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useNavigationStore, getInitialSidebarCollapsed } from '@/stores/navigation';

/**
 * Active color per section — matches original prototype
 * .active-home, .active-agent, .active-l4 (governance), .active-l5 (knowledge),
 * .active-flo (orchestration), .active-admin
 */
function getActiveClasses(section: string): string {
  switch (section) {
    case 'home':
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8] border-l-[#00B4D8] font-semibold';
    case 'agent':
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8] border-l-[#00B4D8] font-semibold';
    case 'governance':
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8] border-l-[#00B4D8] font-semibold';
    case 'knowledge':
      return 'bg-[rgba(6,214,160,0.15)] text-[#06D6A0] border-l-[#06D6A0] font-semibold';
    case 'orchestration':
      return 'bg-[rgba(255,183,3,0.08)] text-[#FFB703] border-l-[#FFB703] font-semibold';
    case 'insights':
      return 'bg-[rgba(6,214,160,0.15)] text-[#06D6A0] border-l-[#06D6A0] font-semibold';
    case 'missions':
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8] border-l-[#00B4D8] font-semibold';
    case 'workspaces':
      return 'bg-[rgba(6,214,160,0.15)] text-[#06D6A0] border-l-[#06D6A0] font-semibold';
    case 'release':
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8] border-l-[#00B4D8] font-semibold';
    case 'admin':
      return 'bg-[rgba(160,160,160,0.15)] text-[#a0a0a0] border-l-[#a0a0a0] font-semibold';
    default:
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8] border-l-[#00B4D8] font-semibold';
  }
}

function getBadgeClasses(color?: string): string {
  switch (color) {
    case 'cyan':
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8]';
    case 'green':
      return 'bg-[rgba(6,214,160,0.15)] text-[#06D6A0]';
    case 'red':
      return 'bg-[rgba(239,71,111,0.15)] text-[#EF476F]';
    case 'gold':
      return 'bg-[rgba(255,183,3,0.12)] text-[#FFB703]';
    default:
      return 'bg-[rgba(0,180,216,0.15)] text-[#00B4D8]';
  }
}

/** Solid dot color used to surface a badge when the rail is collapsed (icon-only). */
function getDotColor(color?: string): string {
  switch (color) {
    case 'green':
      return 'bg-[#06D6A0]';
    case 'red':
      return 'bg-[#EF476F]';
    case 'gold':
      return 'bg-[#FFB703]';
    default:
      return 'bg-[#00B4D8]';
  }
}

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  section: string;
  visibleTo: string[];
  badge?: number | string;
  badgeColor?: string;
}

interface NavGroup {
  groupLabel: string;
  items: NavItem[];
}

/**
 * Navigation structure — matches MetisAI_v1.1.html prototype
 *
 * Original sections:
 *   Home → Agent Execution → Governance → 운영지식관리 → Orchestration → 시스템
 *
 * Extended with:
 *   Missions, Workspaces (purpose-oriented), Insights, Release
 */
/**
 * 간소화버전 역할 (3개):
 *   ADMIN    — 관리자 (구 PLATFORM_ADMIN/TENANT_ADMIN)
 *   OPERATOR — 운영·개발 (구 OPERATOR/DEVELOPER)
 *   VIEWER   — 뷰어 (구 VIEWER/AUDITOR, 임원 등 대시보드 열람)
 * 백엔드 enum은 6개를 유지하되 isVisible()에서 3개 그룹으로 매핑한다.
 */
const ALL = ['ADMIN', 'OPERATOR', 'VIEWER'];
const ADMIN_OP = ['ADMIN', 'OPERATOR'];
const ADMIN_ONLY = ['ADMIN'];

const navigationGroups: NavGroup[] = [
  // ── Home ──
  {
    groupLabel: 'Home',
    items: [
      {
        id: 'home',
        label: '대시보드',
        href: '/home',
        icon: <Home size={18} />,
        section: 'home',
        visibleTo: ALL,
      },
    ],
  },
  // ── Agent Execution ──
  {
    groupLabel: 'Agent Execution',
    items: [
      {
        id: 'agent-ops',
        label: 'Agent 실행',
        href: '/agent/overview',
        icon: <Wrench size={18} />,
        section: 'agent',
        visibleTo: ADMIN_OP,
        badge: 18,
        badgeColor: 'cyan',
      },
    ],
  },
  // ── Governance ──
  {
    groupLabel: 'Governance',
    items: [
      {
        id: 'gov-policy',
        label: '정책',
        href: '/governance/policies',
        icon: <ShieldCheck size={18} />,
        section: 'governance',
        visibleTo: ADMIN_ONLY,
        badge: 7,
        badgeColor: 'cyan',
      },
      {
        id: 'gov-effectiveness',
        label: '성과·KPI',
        href: '/governance/effectiveness',
        icon: <Target size={18} />,
        section: 'governance',
        visibleTo: ALL,
      },
      {
        id: 'gov-review',
        label: '심사·승격',
        href: '/governance/orb-governance',
        icon: <ClipboardList size={18} />,
        section: 'governance',
        badge: 'NEW',
        badgeColor: 'gold',
        visibleTo: ADMIN_OP,
      },
      {
        id: 'gov-runtime',
        label: '런타임 거버넌스',
        href: '/governance/runtime',
        icon: <Activity size={18} />,
        section: 'governance',
        visibleTo: ADMIN_OP,
      },
    ],
  },
  // ── 운영지식관리 ──
  {
    groupLabel: '운영지식관리',
    items: [
      {
        id: 'knowledge-registry',
        label: '지식 자산',
        href: '/knowledge/registry',
        icon: <BookOpen size={18} />,
        section: 'knowledge',
        visibleTo: ADMIN_OP,
        badge: '2,456',
        badgeColor: 'green',
      },
      {
        id: 'knowledge-pattern',
        label: 'Agent 오류 패턴 관리',
        href: '/knowledge/patterns',
        icon: <Bug size={18} />,
        section: 'knowledge',
        visibleTo: ADMIN_OP,
        badge: 14,
        badgeColor: 'red',
      },
    ],
  },
  // ── Orchestration ──
  {
    groupLabel: 'Orchestration',
    items: [
      {
        id: 'flo-builder',
        label: '워크플로우 빌더',
        href: '/orchestration/builder',
        icon: <Waves size={18} />,
        section: 'orchestration',
        visibleTo: ADMIN_OP,
        badge: 'NEW',
        badgeColor: 'gold',
      },
      {
        id: 'flo-market',
        label: '템플릿 마켓',
        href: '/orchestration/market',
        icon: <Store size={18} />,
        section: 'orchestration',
        visibleTo: ADMIN_OP,
      },
      {
        id: 'flo-connectors',
        label: '커넥터 관리',
        href: '/orchestration/connectors',
        icon: <Plug size={18} />,
        section: 'orchestration',
        visibleTo: ADMIN_OP,
      },
    ],
  },
  // ── Insights ──
  {
    groupLabel: 'Insights',
    items: [
      {
        id: 'insights-finops',
        label: 'FinOps',
        href: '/insights/finops-platform',
        icon: <DollarSign size={18} />,
        section: 'insights',
        visibleTo: ADMIN_OP,
      },
      {
        id: 'insights-evaluator',
        label: 'Agent 품질평가/테스트',
        href: '/insights/evaluator',
        icon: <ShieldCheck size={18} />,
        section: 'insights',
        badge: 'NEW',
        badgeColor: 'cyan',
        visibleTo: ADMIN_OP,
      },
      {
        id: 'insights-anomalies',
        label: '리스크/이상',
        href: '/insights/anomalies',
        icon: <AlertTriangle size={18} />,
        section: 'insights',
        visibleTo: ADMIN_OP,
      },
    ],
  },
  // ── 기준정보 (마스터 데이터) ──
  {
    groupLabel: '기준정보',
    items: [
      {
        id: 'master-agents',
        label: 'Agent 기준정보',
        href: '/admin/master/agents',
        icon: <Bot size={18} />,
        section: 'admin',
        visibleTo: ADMIN_ONLY,
      },
      {
        id: 'master-models',
        label: '모델 단가',
        href: '/admin/master/models',
        icon: <Sparkles size={18} />,
        section: 'admin',
        visibleTo: ADMIN_ONLY,
      },
      {
        id: 'master-tenants',
        label: '테넌트·팀',
        href: '/admin/master/tenants',
        icon: <Database size={18} />,
        section: 'admin',
        visibleTo: ADMIN_ONLY,
      },
      {
        id: 'master-ops-reference',
        label: '운영 기준값',
        href: '/admin/master/ops-reference',
        icon: <Gauge size={18} />,
        section: 'admin',
        visibleTo: ADMIN_ONLY,
      },
    ],
  },
  // ── 시스템 ──
  {
    groupLabel: '시스템',
    items: [
      {
        id: 'admin-users',
        label: '사용자 관리',
        href: '/admin/users',
        icon: <Users size={18} />,
        section: 'admin',
        visibleTo: ADMIN_ONLY,
      },
      {
        id: 'admin-ingest-keys',
        label: 'Ingest 키 현황',
        href: '/admin/ingest-keys',
        icon: <KeyRound size={18} />,
        section: 'admin',
        visibleTo: ADMIN_ONLY,
      },
    ],
  },
];

export function SideNav() {
  const pathname = usePathname();
  const [userRole, setUserRole] = useState('OPERATOR');
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  const collapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useNavigationStore((s) => s.setSidebarCollapsed);
  const toggleSidebarCollapsed = useNavigationStore((s) => s.toggleSidebarCollapsed);

  // Groups the user has explicitly collapsed (accordion). Default: all expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Hydrate the persisted rail state on the client (prevents SSR/CSR mismatch).
  useEffect(() => {
    setSidebarCollapsed(getInitialSidebarCollapsed());
  }, [setSidebarCollapsed]);

  useEffect(() => {
    const fetchUserRole = async () => {
      try {
        const response = await api.get<{ role: string }>('/auth/me');
        if (response?.role) {
          setUserRole(response.role);
        }
      } catch {
        setUserRole('OPERATOR');
      }
    };
    fetchUserRole();
  }, []);

  // Real left-nav badge counts (replaces hardcoded numbers).
  useEffect(() => {
    api
      .get<Record<string, number>>('/dashboard/nav-counts')
      .then((c) => setCounts(c ? { ...c, agentTotal: (c.agentOps ?? 0) + (c.agentDev ?? 0) + (c.agentQa ?? 0) + (c.agentUtil ?? 0) } : null))
      .catch(() => setCounts(null));
  }, []);

  // nav item id → count key. Items NOT listed here keep their static (string) badge.
  const COUNT_KEY: Record<string, string> = {
    'agent-ops': 'agentTotal',
    'agent-dev': 'agentDev',
    'agent-qa': 'agentQa',
    'agent-util': 'agentUtil',
    'gov-log': 'auditLogs',
    'gov-policy': 'policies',
    'knowledge-registry': 'knowledgeArtifacts',
    'knowledge-pattern': 'errorPatterns',
  };
  const fmtCount = (n: number) => (n >= 1000 ? n.toLocaleString() : String(n));

  // 백엔드 6역할 → 간소화 3그룹 매핑
  const ROLE_GROUP: Record<string, string> = {
    PLATFORM_ADMIN: 'ADMIN',
    TENANT_ADMIN: 'ADMIN',
    ADMIN: 'ADMIN',
    OPERATOR: 'OPERATOR',
    DEVELOPER: 'OPERATOR',
    VIEWER: 'VIEWER',
    AUDITOR: 'VIEWER',
  };
  function isVisible(visibleTo: string[]): boolean {
    const group = ROLE_GROUP[userRole] ?? 'OPERATOR';
    return visibleTo.includes(group);
  }

  const isActiveHref = (href: string) => pathname === href || pathname.startsWith(href + '/');
  const toggleGroup = (g: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [g]: !prev[g] }));

  return (
    <aside
      className={`${
        collapsed ? 'w-16 min-w-[64px]' : 'w-60 min-w-[240px]'
      } bg-sidebar border-r border-white/[0.06] py-3 fixed top-[52px] bottom-0 left-0 overflow-y-auto overflow-x-hidden flex flex-col transition-[width] duration-200`}
    >
      {/* Rail collapse toggle */}
      <div className={`flex ${collapsed ? 'justify-center' : 'justify-end'} px-3 pb-1`}>
        <button
          onClick={toggleSidebarCollapsed}
          title={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
          aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
          className="p-1.5 rounded text-[#9ca3af] hover:bg-white/[0.06] hover:text-white transition"
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </div>

      {navigationGroups.map((group) => {
        const visibleItems = group.items.filter((item) => isVisible(item.visibleTo));
        if (visibleItems.length === 0) return null;

        // 시스템 section gets pushed to bottom
        const isSystem = group.groupLabel === '시스템';
        const groupHasActive = visibleItems.some((it) => isActiveHref(it.href));
        // Collapsed rail: always show icons. Expanded: open unless user collapsed it
        // (the group containing the active route is always kept open).
        const groupOpen = collapsed
          ? true
          : groupHasActive || !collapsedGroups[group.groupLabel];

        return (
          <div key={group.groupLabel} className={isSystem ? 'mt-auto' : ''}>
            {collapsed ? (
              <div className="mx-3 my-1.5 border-t border-white/[0.06]" />
            ) : (
              <button
                onClick={() => toggleGroup(group.groupLabel)}
                className="w-full flex items-center justify-between text-[10px] font-bold text-[#6b7280] uppercase tracking-[1.5px] px-5 pt-3 pb-2 mt-2 hover:text-[#9ca3af] transition"
              >
                <span className="truncate">{group.groupLabel}</span>
                {groupOpen ? (
                  <ChevronDown size={12} className={groupHasActive ? 'opacity-30' : ''} />
                ) : (
                  <ChevronRight size={12} />
                )}
              </button>
            )}

            {groupOpen &&
              visibleItems.map((item) => {
                const isActive = isActiveHref(item.href);
                const activeClasses = isActive ? getActiveClasses(item.section) : '';
                const badgeClasses = item.badgeColor ? getBadgeClasses(item.badgeColor) : '';
                // Real count overrides the hardcoded numeric badge; string badges (NEW/LIVE/...) stay.
                const countKey = COUNT_KEY[item.id];
                const displayBadge =
                  countKey && counts
                    ? fmtCount(counts[countKey] ?? 0)
                    : countKey
                      ? null
                      : item.badge;
                const hasBadge = displayBadge !== undefined && displayBadge !== null;

                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={`relative flex items-center ${
                      collapsed ? 'justify-center px-0' : 'gap-2.5 px-5'
                    } py-2.5 text-[13px] font-medium border-l-[3px] border-l-transparent transition-all
                      ${
                        isActive
                          ? activeClasses
                          : 'text-[#9ca3af] hover:bg-white/[0.03] hover:text-white'
                      }`}
                  >
                    <span className="text-base">{item.icon}</span>
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {!collapsed && hasBadge && (
                      <span
                        className={`ml-auto text-[10px] px-2 py-1 rounded-full font-semibold ${badgeClasses}`}
                      >
                        {displayBadge}
                      </span>
                    )}
                    {collapsed && hasBadge && (
                      <span
                        className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${getDotColor(
                          item.badgeColor,
                        )}`}
                      />
                    )}
                  </Link>
                );
              })}
          </div>
        );
      })}
    </aside>
  );
}
