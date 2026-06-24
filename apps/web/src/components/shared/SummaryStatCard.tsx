'use client';

interface SummaryStatCardProps {
  label: string;
  value: string | number;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  icon?: React.ReactNode;
  accentColor?: 'accent' | 'success' | 'warning' | 'danger' | 'purple' | 'gold';
}

const BORDER_MAP: Record<string, string> = {
  accent: 'border-l-accent',
  success: 'border-l-success',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
  purple: 'border-l-purple',
  gold: 'border-l-gold',
};

const VALUE_COLOR_MAP: Record<string, string> = {
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  purple: 'text-purple',
  gold: 'text-gold',
};

export function SummaryStatCard({
  label,
  value,
  change,
  changeType = 'neutral',
  icon,
  accentColor,
}: SummaryStatCardProps) {
  const changeColor =
    changeType === 'positive'
      ? 'text-success'
      : changeType === 'negative'
        ? 'text-danger'
        : 'text-muted-dark';

  const borderClass = accentColor ? `border-l-4 ${BORDER_MAP[accentColor] ?? ''}` : '';
  const valueColor = accentColor ? (VALUE_COLOR_MAP[accentColor] ?? 'text-dark') : 'text-dark';

  return (
    <div
      className={`bg-card rounded-lg border border-border shadow-sm ${borderClass} p-4 flex flex-col gap-2`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-dark font-medium uppercase tracking-wide">{label}</span>
        {icon && <span className="text-muted-dark">{icon}</span>}
      </div>
      <div className={`text-2xl font-extrabold ${valueColor}`}>{value}</div>
      {change && <span className={`text-xs font-medium ${changeColor}`}>{change}</span>}
    </div>
  );
}
