'use client';

import { create } from 'zustand';

export type TopNavItem = 'dashboard';

export interface NavSection {
  label: string;
  items: NavItem[];
}

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  href: string;
  badge?: number;
  badgeColor?: 'cyan' | 'green' | 'red';
  section: 'home' | 'agent' | 'governance' | 'knowledge' | 'orchestration' | 'release' | 'admin';
}

interface NavigationState {
  activeTopNav: TopNavItem;
  activeSideNav: string;
  rightInspectorOpen: boolean;
  rightInspectorContent: any;
  /** Sidebar collapsed to an icon-only rail (persisted to localStorage). */
  sidebarCollapsed: boolean;
  setActiveTopNav: (item: TopNavItem) => void;
  setActiveSideNav: (id: string) => void;
  toggleRightInspector: () => void;
  openRightInspector: (content: any) => void;
  closeRightInspector: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebarCollapsed: () => void;
}

const SIDEBAR_KEY = 'metis.sidebarCollapsed';

/** Read the persisted collapse flag without throwing during SSR. */
function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

function persistSidebarCollapsed(v: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0');
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

export const useNavigationStore = create<NavigationState>((set) => ({
  activeTopNav: 'dashboard',
  activeSideNav: 'home-dashboard',
  rightInspectorOpen: false,
  rightInspectorContent: null,
  // Default false on the server; hydrated from localStorage on the client (see SideNav).
  sidebarCollapsed: false,
  setActiveTopNav: (item) => set({ activeTopNav: item }),
  setActiveSideNav: (id) => set({ activeSideNav: id }),
  toggleRightInspector: () => set((s) => ({ rightInspectorOpen: !s.rightInspectorOpen })),
  openRightInspector: (content) =>
    set({ rightInspectorOpen: true, rightInspectorContent: content }),
  closeRightInspector: () => set({ rightInspectorOpen: false, rightInspectorContent: null }),
  setSidebarCollapsed: (v) => {
    persistSidebarCollapsed(v);
    set({ sidebarCollapsed: v });
  },
  toggleSidebarCollapsed: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      persistSidebarCollapsed(next);
      return { sidebarCollapsed: next };
    }),
}));

/** Hydrate the persisted collapse flag on the client. Call once from a client component. */
export function getInitialSidebarCollapsed(): boolean {
  return readSidebarCollapsed();
}

/** Sidebar navigation structure — matches prototype HTML exactly */
export const NAVIGATION: NavSection[] = [
  {
    label: 'HOME',
    items: [
      {
        id: 'home-dashboard',
        label: '🏠 대시보드',
        icon: '🏠',
        href: '/home',
        section: 'home',
      },
    ],
  },
  {
    label: 'AGENT',
    items: [
      {
        id: 'agent-ops',
        label: '🔧 운영 Agent',
        icon: '🔧',
        href: '/agent/operations',
        section: 'agent',
        badgeColor: 'cyan',
      },
      {
        id: 'agent-dev',
        label: '💻 개발 Agent',
        icon: '💻',
        href: '/agent/development',
        section: 'agent',
        badgeColor: 'cyan',
      },
      {
        id: 'agent-qa',
        label: '🧪 QA Agent',
        icon: '🧪',
        href: '/agent/qa',
        section: 'agent',
        badgeColor: 'green',
      },
      {
        id: 'agent-util',
        label: '🛠️ 유틸리티 Agent',
        icon: '🛠️',
        href: '/agent/utility',
        section: 'agent',
        badgeColor: 'cyan',
      },
    ],
  },
  {
    label: 'GOVERNANCE (L4)',
    items: [
      {
        id: 'log',
        label: '📋 감사 로그',
        icon: '📋',
        href: '/governance/audit',
        section: 'governance',
        badgeColor: 'cyan',
      },
      {
        id: 'policy',
        label: '🛡️ 정책 관리',
        icon: '🛡️',
        href: '/governance/policies',
        section: 'governance',
      },
      {
        id: 'evidence',
        label: '📦 증적 패키지',
        icon: '📦',
        href: '/governance/evidence',
        section: 'governance',
      },
      {
        id: 'kpi',
        label: '📊 KPI 대시보드',
        icon: '📊',
        href: '/governance/kpi',
        section: 'governance',
      },
    ],
  },
  {
    label: '운영지식관리',
    items: [
      {
        id: 'registry',
        label: '📚 지식 레지스트리',
        icon: '📚',
        href: '/knowledge/registry',
        section: 'knowledge',
      },
      {
        id: 'artifact',
        label: '📄 아티팩트',
        icon: '📄',
        href: '/knowledge/artifacts',
        section: 'knowledge',
      },
      {
        id: 'pattern',
        label: '⚠️ 오류 패턴',
        icon: '⚠️',
        href: '/knowledge/patterns',
        section: 'knowledge',
        badgeColor: 'red',
      },
      {
        id: 'pipeline',
        label: '🔄 지식 파이프라인',
        icon: '🔄',
        href: '/knowledge/pipeline',
        section: 'knowledge',
      },
    ],
  },
  {
    label: 'ORCHESTRATION (L5)',
    items: [
      {
        id: 'flo-builder',
        label: '🎨 Metis.flo Builder',
        icon: '🎨',
        href: '/orchestration/builder',
        section: 'orchestration',
      },
      {
        id: 'flo-market',
        label: '🏪 Flo 마켓',
        icon: '🏪',
        href: '/orchestration/market',
        section: 'orchestration',
      },
      {
        id: 'flo-monitor',
        label: '📡 실행 모니터',
        icon: '📡',
        href: '/orchestration/monitor',
        section: 'orchestration',
      },
      {
        id: 'flo-connector',
        label: '🔌 커넥터',
        icon: '🔌',
        href: '/orchestration/connectors',
        section: 'orchestration',
      },
    ],
  },
  {
    label: 'RELEASE ENGINEERING',
    items: [
      {
        id: 'release-replay',
        label: '🔄 Replay Testing',
        icon: '🔄',
        href: '/release/replay',
        section: 'release',
      },
      {
        id: 'release-shadow',
        label: '👥 Shadow Execution',
        icon: '👥',
        href: '/release/shadow',
        section: 'release',
      },
      {
        id: 'release-canary',
        label: '🐤 Canary Deployment',
        icon: '🐤',
        href: '/release/canary',
        section: 'release',
      },
      {
        id: 'release-promotions',
        label: '📜 Version History',
        icon: '📜',
        href: '/release/promotions',
        section: 'release',
      },
    ],
  },
  {
    label: '시스템',
    items: [
      {
        id: 'usermgmt',
        label: '👤 사용자 관리',
        icon: '👤',
        href: '/admin/users',
        section: 'admin',
      },
    ],
  },
];
