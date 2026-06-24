'use client';

import { ReactNode } from 'react';
import { CheckCircle2, XCircle, Clock, AlertCircle, Circle } from 'lucide-react';
import clsx from 'clsx';

export type TimelineEventStatus = 'success' | 'failed' | 'running' | 'pending' | 'warning';

export interface TimelineEvent {
  id: string;
  timestamp: string;
  status: TimelineEventStatus;
  title: string;
  detail?: string;
  duration?: number; // in milliseconds
}

interface TimelineProps {
  events: TimelineEvent[];
  isLoading?: boolean;
}

function getStatusIcon(status: TimelineEventStatus, size: number = 20): ReactNode {
  const iconProps = { size, strokeWidth: 2 };

  switch (status) {
    case 'success':
      return <CheckCircle2 {...iconProps} className="text-success flex-shrink-0" />;
    case 'failed':
      return <XCircle {...iconProps} className="text-danger flex-shrink-0" />;
    case 'running':
      return <Clock {...iconProps} className="text-accent animate-spin flex-shrink-0" />;
    case 'warning':
      return <AlertCircle {...iconProps} className="text-warning flex-shrink-0" />;
    case 'pending':
    default:
      return <Circle {...iconProps} className="text-muted-dark flex-shrink-0" />;
  }
}

function getStatusColor(status: TimelineEventStatus): string {
  switch (status) {
    case 'success':
      return 'bg-success-light/30 border-success/40';
    case 'failed':
      return 'bg-danger-light/30 border-danger/40';
    case 'running':
      return 'bg-blue-100/30 border-accent/40';
    case 'warning':
      return 'bg-warning-light/30 border-warning/40';
    case 'pending':
    default:
      return 'bg-table-alt border-border';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function Timeline({ events, isLoading = false }: TimelineProps) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 bg-table-alt rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 border border-border rounded-lg bg-table-alt">
        <p className="text-sm text-muted-dark">No events to display</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event, index) => (
        <div key={event.id} className="flex gap-4">
          {/* Left: Timestamp & Icon */}
          <div className="flex flex-col items-center gap-2 pt-1">
            <div className="text-right">
              <span className="text-xs text-muted-dark font-mono">
                {formatTimestamp(event.timestamp)}
              </span>
            </div>
            <div className="mt-1">{getStatusIcon(event.status)}</div>
            {/* Vertical Line */}
            {index < events.length - 1 && <div className="h-6 w-0.5 bg-border" />}
          </div>

          {/* Right: Event Content */}
          <div className={clsx('flex-1 rounded-lg border p-3 mt-0', getStatusColor(event.status))}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h4 className="text-sm font-medium text-dark">{event.title}</h4>
                {event.detail && (
                  <p className="text-xs text-muted-dark mt-1 truncate">{event.detail}</p>
                )}
              </div>
              {event.duration !== undefined && (
                <span className="text-xs text-muted-dark whitespace-nowrap">
                  {formatDuration(event.duration)}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
