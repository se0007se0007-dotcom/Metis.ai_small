'use client';

import { TopNav } from './TopNav';
import { SideNav } from './SideNav';
import { RightInspector } from './RightInspector';
import { useNavigationStore } from '@/stores/navigation';

/**
 * AppShell — the root layout frame matching the prototype:
 * ┌──────────── TopNav (52px, fixed) ─────────────┐
 * │ ┌ SideNav ─┐ ┌── MainViewport ──┐ ┌ Inspector ┐│
 * │ │  240px    │ │     fluid         │ │  320px     ││
 * │ │  fixed    │ │     scrollable    │ │  optional  ││
 * │ └──────────┘ └───────────────────┘ └───────────┘│
 * └──────────────────────────────────────────────────┘
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { rightInspectorOpen, sidebarCollapsed } = useNavigationStore();

  return (
    <>
      <TopNav />
      <div className="flex mt-[52px] min-h-[calc(100vh-52px)]">
        <SideNav />
        <main
          className={`${sidebarCollapsed ? 'ml-16' : 'ml-60'} flex-1 transition-all duration-200 bg-light-bg text-dark ${
            rightInspectorOpen ? 'mr-80' : ''
          }`}
        >
          {children}
        </main>
        <RightInspector />
      </div>
    </>
  );
}
