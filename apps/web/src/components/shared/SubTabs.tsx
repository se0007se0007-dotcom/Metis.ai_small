'use client';

/**
 * SubTabs — lightweight sub-navigation for consolidated menus.
 * One sidebar entry shows the group; the merged sibling screens are reached via
 * these tabs (no functionality removed, just fewer top-level menu items).
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface SubTab {
  label: string;
  href: string;
}

export function SubTabs({ items }: { items: SubTab[] }) {
  const pathname = usePathname();
  return (
    <div className="px-6 pt-3">
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        {items.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + '/');
          return (
            <Link
              key={t.href}
              href={t.href}
              className={
                active
                  ? 'px-3.5 py-2 text-sm font-semibold text-blue-700 border-b-2 border-blue-600 -mb-px'
                  : 'px-3.5 py-2 text-sm text-gray-500 hover:text-gray-800 border-b-2 border-transparent -mb-px'
              }
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
