'use client';

interface StatCardProps {
  label: string;
  value: number | string;
  color?: 'accent' | 'success' | 'warning' | 'danger' | 'dark';
}

const BORDER_COLORS: Record<string, string> = {
  accent: 'border-l-accent',
  success: 'border-l-success',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
  dark: 'border-l-dark',
};

const TEXT_COLORS: Record<string, string> = {
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  dark: 'text-dark',
};

export function StatCard({ label, value, color = 'dark' }: StatCardProps) {
  return (
    <div
      className={`bg-card rounded-lg border border-border border-l-4 ${BORDER_COLORS[color] ?? 'border-l-dark'} p-4 shadow-sm`}
    >
      <p className="text-[10px] text-muted-dark uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-extrabold ${TEXT_COLORS[color] ?? 'text-dark'}`}>{value}</p>
    </div>
  );
}
