'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';

export type AgentMessageKind =
  | 'REQUEST'
  | 'RESPONSE'
  | 'EVENT'
  | 'HANDOFF'
  | 'HUMAN_INTERVENTION'
  | 'SYSTEM';

export interface Message {
  id: string;
  kind: AgentMessageKind;
  fromAgent: string;
  toAgent?: string | null;
  subject?: string | null;
  payload: unknown;
  naturalSummary?: string | null;
  correlationId: string;
  createdAt: string;
}

interface AgentTimelineProps {
  messages: Message[];
  onIntervene?: (decision: string) => void;
  loading?: boolean;
}

function getKindColor(kind: AgentMessageKind): {
  dot: string;
  line: string;
  bg: string;
  border: string;
  text: string;
} {
  switch (kind) {
    case 'REQUEST':
      return {
        dot: 'bg-blue-500',
        line: 'bg-blue-200',
        bg: 'bg-blue-50',
        border: 'border-blue-200',
        text: 'text-blue-900',
      };
    case 'RESPONSE':
      return {
        dot: 'bg-green-500',
        line: 'bg-green-200',
        bg: 'bg-green-50',
        border: 'border-green-200',
        text: 'text-green-900',
      };
    case 'EVENT':
      return {
        dot: 'bg-purple-500',
        line: 'bg-purple-200',
        bg: 'bg-purple-50',
        border: 'border-purple-200',
        text: 'text-purple-900',
      };
    case 'HANDOFF':
      return {
        dot: 'bg-amber-500',
        line: 'bg-amber-200',
        bg: 'bg-amber-50',
        border: 'border-amber-200',
        text: 'text-amber-900',
      };
    case 'HUMAN_INTERVENTION':
      return {
        dot: 'bg-red-500',
        line: 'bg-red-200',
        bg: 'bg-red-50',
        border: 'border-red-200',
        text: 'text-red-900',
      };
    case 'SYSTEM':
      return {
        dot: 'bg-gray-500',
        line: 'bg-gray-200',
        bg: 'bg-gray-50',
        border: 'border-gray-200',
        text: 'text-gray-900',
      };
    default:
      return {
        dot: 'bg-slate-500',
        line: 'bg-slate-200',
        bg: 'bg-slate-50',
        border: 'border-slate-200',
        text: 'text-slate-900',
      };
  }
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '방금 전';
    if (minutes < 60) return `${minutes}분 전`;
    if (hours < 24) return `${hours}시간 전`;
    if (days < 7) return `${days}일 전`;
    return date.toLocaleDateString('ko-KR');
  } catch {
    return '—';
  }
}

function InterventionPanel({
  message,
  onIntervene,
}: {
  message: Message;
  onIntervene?: (decision: string) => void;
}) {
  const [inputValue, setInputValue] = useState('');

  const handleApprove = () => {
    onIntervene?.('APPROVED');
    setInputValue('');
  };

  const handleReject = () => {
    onIntervene?.('REJECTED');
    setInputValue('');
  };

  const handleRequestModification = () => {
    if (inputValue.trim()) {
      onIntervene?.(`MODIFICATION_REQUESTED:${inputValue}`);
      setInputValue('');
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-lg bg-red-50 p-4 border border-red-200">
      <p className="text-sm font-semibold text-red-900">인간 개입 필요</p>
      <div className="space-y-3">
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            className="flex items-center gap-1 rounded-md bg-green-500 px-3 py-2 text-sm font-medium text-white hover:bg-green-600 transition-colors"
          >
            <CheckCircle2 className="h-4 w-4" />
            승인
          </button>
          <button
            onClick={handleReject}
            className="flex items-center gap-1 rounded-md bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600 transition-colors"
          >
            <XCircle className="h-4 w-4" />
            거부
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="수정 요청사항을 입력하세요..."
            className="flex-1 rounded-md border border-red-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && inputValue.trim()) {
                handleRequestModification();
              }
            }}
          />
          <button
            onClick={handleRequestModification}
            disabled={!inputValue.trim()}
            className="rounded-md bg-amber-500 px-3 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            수정 요청
          </button>
        </div>
      </div>
    </div>
  );
}

export const AgentTimeline: React.FC<AgentTimelineProps> = ({
  messages,
  onIntervene,
  loading = false,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    const newSet = new Set(expandedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedIds(newSet);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-500 mx-auto mb-2"></div>
          <p className="text-sm text-slate-600">메시지 로드 중...</p>
        </div>
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-600">아직 메시지가 없습니다</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {messages.map((message, index) => {
        const color = getKindColor(message.kind);
        const isExpanded = expandedIds.has(message.id);
        const isLastMessage = index === messages.length - 1;

        return (
          <div key={message.id} className="relative">
            {/* Timeline connector line */}
            {!isLastMessage && (
              <div className={`absolute left-6 top-14 w-1 h-16 ${color.line}`} aria-hidden="true" />
            )}

            {/* Message card */}
            <div className="relative pl-16 pb-8">
              {/* Timeline dot */}
              <div
                className={`absolute left-0 top-2 h-4 w-4 rounded-full ${color.dot} ring-4 ring-white`}
              />

              {/* Card content */}
              <div className={`rounded-lg border ${color.border} ${color.bg} p-4`}>
                {/* Header: Kind + From → To */}
                <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-semibold ${color.text}`}>{message.kind}</span>
                    {message.subject && (
                      <span className="text-xs text-slate-600">{message.subject}</span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {formatRelativeTime(message.createdAt)}
                  </span>
                </div>

                {/* Agent chips */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <div className="inline-flex items-center gap-1">
                    <span className="inline-block rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-800">
                      {message.fromAgent}
                    </span>
                  </div>
                  {message.toAgent && (
                    <>
                      <span className="text-slate-400">→</span>
                      <div className="inline-flex items-center gap-1">
                        <span className="inline-block rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-800">
                          {message.toAgent}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                {/* Natural summary */}
                {message.naturalSummary && (
                  <p className="mb-3 text-sm leading-relaxed text-slate-800">
                    {message.naturalSummary}
                  </p>
                )}

                {/* Expandable payload */}
                <button
                  onClick={() => toggleExpanded(message.id)}
                  className="flex w-full items-center justify-between rounded-md bg-white bg-opacity-50 px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-opacity-75 transition-colors"
                >
                  <span>원본 페이로드</span>
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>

                {isExpanded && (
                  <div className="mt-3 rounded-md bg-white bg-opacity-70 p-3">
                    <pre className="overflow-x-auto text-xs font-mono text-slate-700 whitespace-pre-wrap break-words">
                      {JSON.stringify(message.payload, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Correlation ID */}
                <div className="mt-2 text-xs text-slate-500">
                  <span className="font-mono">
                    correlationId: {message.correlationId.slice(0, 12)}...
                  </span>
                </div>

                {/* Human intervention prompt */}
                {message.kind === 'HUMAN_INTERVENTION' && (
                  <InterventionPanel message={message} onIntervene={onIntervene} />
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
