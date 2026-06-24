'use client';

import { create } from 'zustand';

interface TenantState {
  tenantId: string | null;
  tenantSlug: string | null;
  tenantName: string | null;
  setTenant: (tenant: { id: string; slug: string; name: string }) => void;
  clear: () => void;
}

export const useTenantStore = create<TenantState>((set) => ({
  tenantId: null,
  tenantSlug: null,
  tenantName: null,
  setTenant: (tenant) =>
    set({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
    }),
  clear: () => set({ tenantId: null, tenantSlug: null, tenantName: null }),
}));
