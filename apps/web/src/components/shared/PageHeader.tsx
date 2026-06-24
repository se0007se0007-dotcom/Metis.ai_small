'use client';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** 'dark' for pages with a dark background (e.g. home) so the title stays visible. */
  tone?: 'light' | 'dark';
}

export function PageHeader({ title, description, actions, tone = 'light' }: PageHeaderProps) {
  const titleCls = tone === 'dark' ? 'text-white' : 'text-dark';
  const descCls = tone === 'dark' ? 'text-gray-300' : 'text-muted-dark';
  return (
    <div className="flex items-start justify-between mb-6 pt-4 px-6">
      <div>
        <h1 className={`text-2xl font-extrabold ${titleCls}`}>{title}</h1>
        {description && <p className={`text-sm mt-1 ${descCls}`}>{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
