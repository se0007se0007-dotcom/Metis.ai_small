'use client';

import { ReactNode, useState } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

export interface TabConfig {
  id: string;
  label: string;
  content: ReactNode;
}

interface DetailPanelProps {
  title: string;
  onClose?: () => void;
  metadata?: Record<string, unknown>;
  jsonData?: Record<string, unknown>;
  tabs?: TabConfig[];
  children?: ReactNode;
}

export function DetailPanel({
  title,
  onClose,
  metadata,
  jsonData,
  tabs,
  children,
}: DetailPanelProps) {
  const [activeTabId, setActiveTabId] = useState(tabs?.[0]?.id ?? 'details');

  // Render JSON with syntax highlighting
  const renderJson = (obj: unknown): string => {
    return JSON.stringify(obj, null, 2);
  };

  return (
    <div className="flex flex-col h-full bg-light-bg border-l border-border">
      {/* Title Bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-dark">{title}</h3>
        {onClose && (
          <button
            onClick={onClose}
            className="text-muted-dark hover:text-dark transition-colors p-1"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Tab Navigation */}
      {tabs && tabs.length > 0 && (
        <div className="flex border-b border-border bg-table-header">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={clsx(
                'px-4 py-2 text-xs font-medium border-b-2 transition-colors',
                activeTabId === tab.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-dark hover:text-dark',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto">
        {/* Tabs Content */}
        {tabs && tabs.length > 0 ? (
          tabs.find((t) => t.id === activeTabId)?.content
        ) : (
          <div className="p-4 space-y-6">
            {/* Metadata Section */}
            {metadata && Object.keys(metadata).length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-dark uppercase tracking-wide mb-3">
                  Metadata
                </h4>
                <div className="space-y-2">
                  {Object.entries(metadata).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-4">
                      <span className="text-xs text-muted-dark font-mono">{key}</span>
                      <span className="text-xs text-dark font-mono truncate">
                        {typeof value === 'string' ? value : JSON.stringify(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* JSON Section */}
            {jsonData && Object.keys(jsonData).length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-dark uppercase tracking-wide mb-3">
                  Details
                </h4>
                <pre className="bg-table-alt border border-border rounded p-3 text-[11px] text-dark font-mono overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                  {renderJson(jsonData)}
                </pre>
              </div>
            )}

            {/* Custom Children */}
            {children && <div>{children}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
