'use client';

import { X } from 'lucide-react';
import { useNavigationStore } from '@/stores/navigation';

export function RightInspector() {
  const { rightInspectorOpen, rightInspectorContent, closeRightInspector } = useNavigationStore();

  if (!rightInspectorOpen) return null;

  return (
    <aside className="w-80 min-w-[320px] bg-sidebar border-l border-white/[0.06] fixed top-[52px] bottom-0 right-0 overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">상세 정보</h3>
        <button
          onClick={closeRightInspector}
          className="text-muted hover:text-white transition-colors"
        >
          <X size={16} />
        </button>
      </div>
      <div className="text-xs text-muted">
        {rightInspectorContent ? (
          <pre className="whitespace-pre-wrap font-mono text-[11px]">
            {JSON.stringify(rightInspectorContent, null, 2)}
          </pre>
        ) : (
          <p>항목을 선택하면 상세 정보가 표시됩니다.</p>
        )}
      </div>
    </aside>
  );
}
