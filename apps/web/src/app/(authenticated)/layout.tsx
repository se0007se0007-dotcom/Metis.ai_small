'use client';

import { AppShell } from '@/components/shell/AppShell';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <AppShell>{children}</AppShell>
    </ErrorBoundary>
  );
}
