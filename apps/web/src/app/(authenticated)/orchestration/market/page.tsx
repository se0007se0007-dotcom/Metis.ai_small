'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  STARTER_PACKS,
  WORKFLOW_TEMPLATES,
  CONNECTOR_REGISTRY,
  analyzeConnectorGaps,
  StarterPack,
  WorkflowTemplate,
} from '@/lib/starter-workflows';
import {
  listWorkflows,
  deleteWorkflow,
  createWorkflow,
  generateWorkflowKey,
  type WorkflowSummary,
  type WorkflowListResult,
} from '@/lib/workflow-api';

// ── localStorage helpers ──

/** Safely read & parse stored workflows; returns [] on missing/corrupt data. */
function readStoredWorkflows(): any[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = window.localStorage.getItem('metis_flo_workflows');
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Types ──

type Tab = '내 워크플로우' | 'Starter Packs';

// ── Node emoji mapping (for display) ──

const NODE_EMOJIS: Record<string, string> = {
  schedule: '⏱️',
  webhook: '🪝',
  'web-search': '🔍',
  'ai-processing': '🤖',
  'email-send': '📧',
  'git-deploy': '🔀',
  'slack-message': '💬',
  'api-call': '🔌',
  condition: '🔄',
  notification: '🔔',
  jira: '🎯',
  'log-monitor': '📊',
  'data-storage': '💾',
  'file-operation': '📁',
  'data-transform': '🔧',
  'wait-approval': '⏸️',
  pentest: '🛡️',
  // Legacy market names
  Schedule: '⏱️',
  Webhook: '🪝',
  WebSearch: '🔍',
  'AI Summary': '🤖',
  Email: '📧',
  Git: '🔀',
  'AI Processing': '💡',
  Slack: '💬',
  'API Call': '🔌',
  Condition: '🔄',
  Notification: '🔔',
  Jira: '🎯',
  'Log Monitor': '📊',
  PagerDuty: '🚨',
  'Data Storage': '💾',
  'File Operation': '📁',
};

// ── Status config ──

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '초안', color: 'bg-yellow-100 text-yellow-700' },
  PUBLISHED: { label: '배포됨', color: 'bg-green-100 text-green-700' },
  ARCHIVED: { label: '보관됨', color: 'bg-gray-100 text-gray-700' },
  // Legacy statuses
  활성: { label: '활성', color: 'bg-green-100 text-green-700' },
  비활성: { label: '비활성', color: 'bg-gray-100 text-gray-700' },
  초안: { label: '초안', color: 'bg-yellow-100 text-yellow-700' },
};

// ── Helper: Convert template → server workflow create input ──

function templateToCreateInput(template: WorkflowTemplate) {
  return {
    key: generateWorkflowKey(template.name),
    name: template.name,
    description: template.description,
    tags: [template.category],
    nodes: template.nodes.map((n, idx) => ({
      nodeKey: n.id,
      uiType: n.type.toLowerCase().replace(/\s+/g, '-'),
      name: n.name || n.type,
      executionOrder: idx + 1,
      config: n.settings || {},
    })),
    edges: [],
  };
}

// ── Page Component ──

export default function MarketPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>('내 워크플로우');

  // Server workflow state
  const [serverData, setServerData] = useState<WorkflowListResult | null>(null);
  const [serverLoading, setServerLoading] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [page, setPage] = useState(1);

  // Legacy localStorage state (merged with server data)
  const [localWorkflows, setLocalWorkflows] = useState<any[]>([]);

  // UI state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Starter Packs states
  const [expandedPackId, setExpandedPackId] = useState<string | null>(null);
  const [installModalPackId, setInstallModalPackId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // ── Fetch server workflows ──
  const fetchServerWorkflows = useCallback(async () => {
    setServerLoading(true);
    setServerError(null);
    try {
      const result = await listWorkflows({
        search: searchQuery || undefined,
        status: statusFilter || undefined,
        page,
        limit: 30,
        sortBy: 'updatedAt',
        sortOrder: 'desc',
      });
      setServerData(result);
    } catch (err: any) {
      setServerError(err.message);
      // Load from localStorage as fallback (guard against corrupted JSON)
      setLocalWorkflows(readStoredWorkflows());
    } finally {
      setServerLoading(false);
    }
  }, [searchQuery, statusFilter, page]);

  useEffect(() => {
    if (activeTab === '내 워크플로우') {
      fetchServerWorkflows();
    }
  }, [fetchServerWorkflows, activeTab]);

  // Also load localStorage workflows for backward compatibility
  useEffect(() => {
    setLocalWorkflows(readStoredWorkflows());
  }, []);

  // Debounced search
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // ── Combined workflows (server + local legacy) ──
  const allWorkflows: Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    nodeCount: number;
    tags: string[];
    updatedAt: string;
    createdAt: string;
    source: 'server' | 'local';
    nodes?: any[];
    version?: number;
  }> = [];

  // Add server workflows
  if (serverData) {
    for (const wf of serverData.items) {
      allWorkflows.push({
        id: wf.id,
        name: wf.name,
        description: wf.description || '',
        status: wf.status,
        nodeCount: wf.nodeCount,
        tags: wf.tags,
        updatedAt: wf.updatedAt,
        createdAt: wf.createdAt,
        source: 'server',
        version: wf.version,
      });
    }
  }

  // Add local-only workflows (always merge, not just on server error)
  for (const lw of localWorkflows) {
    if (!allWorkflows.find((w) => w.id === lw.id)) {
      allWorkflows.push({
        id: lw.id,
        name: lw.name,
        description: lw.description || '',
        status: lw.status || '초안',
        nodeCount: lw.nodes?.length || 0,
        tags: [],
        updatedAt: lw.lastModified || lw.createdAt,
        createdAt: lw.createdAt,
        source: 'local',
        nodes: lw.nodes,
      });
    }
  }

  // Stats
  const totalCount = serverData?.total || allWorkflows.length;
  const activeCount = allWorkflows.filter(
    (w) => w.status === 'PUBLISHED' || w.status === '활성',
  ).length;

  // ── Actions ──

  const handleCreateNew = () => {
    router.push('/orchestration/builder');
  };

  const handleEdit = (wf: (typeof allWorkflows)[0]) => {
    if (wf.source === 'server') {
      router.push(`/orchestration/builder?wfId=${wf.id}`);
    } else {
      // Legacy localStorage flow
      const localWf = localWorkflows.find((l) => l.id === wf.id);
      if (localWf) {
        localStorage.setItem('metis_builder_load_workflow', JSON.stringify(localWf));
        router.push(`/orchestration/builder?id=${wf.id}`);
      }
    }
  };

  const handleDelete = async (wf: (typeof allWorkflows)[0]) => {
    if (wf.source === 'server') {
      setActionLoading(wf.id);
      try {
        await deleteWorkflow(wf.id);
        await fetchServerWorkflows();
      } catch (err: any) {
        alert(`삭제 실패: ${err.message}`);
      } finally {
        setActionLoading(null);
      }
    } else {
      const updated = localWorkflows.filter((l) => l.id !== wf.id);
      setLocalWorkflows(updated);
      localStorage.setItem('metis_flo_workflows', JSON.stringify(updated));
    }
    setDeleteConfirm(null);
  };

  const handleInstallPack = async (packId: string) => {
    const pack = STARTER_PACKS.find((p) => p.id === packId);
    if (!pack) return;

    const templates = WORKFLOW_TEMPLATES.filter((t) => pack.workflowIds.includes(t.id));
    let installedCount = 0;

    for (const template of templates) {
      try {
        await createWorkflow(templateToCreateInput(template));
        installedCount++;
      } catch (err: any) {
        // If server fails, save to localStorage as fallback
        console.warn(`Server install failed for ${template.name}:`, err);
        const newWf = {
          id: `wf-installed-${template.id}-${Date.now()}`,
          name: template.name,
          description: template.description,
          nodes: template.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            emoji: n.icon,
            name: n.name || n.type,
            settings: n.settings || {},
          })),
          status: '초안',
          category: template.category,
          createdAt: new Date().toISOString().split('T')[0],
          lastModified: new Date().toISOString().split('T')[0],
        };
        const stored = JSON.parse(localStorage.getItem('metis_flo_workflows') || '[]');
        stored.unshift(newWf);
        localStorage.setItem('metis_flo_workflows', JSON.stringify(stored));
        setLocalWorkflows(stored);
        installedCount++;
      }
    }

    setInstallModalPackId(null);
    setSuccessMessage(`${pack.name}이(가) 설치되었습니다. (${installedCount}개 워크플로우)`);
    setTimeout(() => setSuccessMessage(null), 4000);

    // Refresh server list
    await fetchServerWorkflows();
  };

  const handleInstallSingleWorkflow = async (templateId: string) => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;

    try {
      const created = await createWorkflow(templateToCreateInput(template));
      setSuccessMessage(`${template.name}이(가) 설치되었습니다.`);
      // Navigate to builder with the new workflow
      router.push(`/orchestration/builder?wfId=${created.id}`);
    } catch (err: any) {
      // Fallback to localStorage
      console.warn('Server install failed:', err);
      const newWf = {
        id: `wf-installed-${template.id}-${Date.now()}`,
        name: template.name,
        description: template.description,
        nodes: template.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          emoji: n.icon,
          name: n.name,
          settings: n.settings || {},
        })),
        status: '초안',
        category: template.category,
        createdAt: new Date().toISOString().split('T')[0],
        lastModified: new Date().toISOString().split('T')[0],
      };
      const stored = JSON.parse(localStorage.getItem('metis_flo_workflows') || '[]');
      stored.unshift(newWf);
      localStorage.setItem('metis_flo_workflows', JSON.stringify(stored));
      setLocalWorkflows(stored);
      setSuccessMessage(`${template.name}이(가) 설치되었습니다. (로컬)`);
    }
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  const formatTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '방금 전';
    if (mins < 60) return `${mins}분 전`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}일 전`;
    return new Date(dateStr).toLocaleDateString('ko-KR');
  };

  const getPackTemplates = (pack: StarterPack): WorkflowTemplate[] => {
    return WORKFLOW_TEMPLATES.filter((t) => pack.workflowIds.includes(t.id));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader
        title="Flo 마켓 — Agent(워크플로우)"
        description="여기서 만든 워크플로우가 곧 Agent입니다. 승인·카테고리 태그가 붙으면 운영/개발 Agent 실행에 노출됩니다."
        actions={
          <button
            onClick={handleCreateNew}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition"
          >
            <span>➕</span>새 워크플로우
          </button>
        }
      />

      <div className="px-6 pb-8">
        {/* Success Message */}
        {successMessage && (
          <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            ✅ {successMessage}
          </div>
        )}

        {/* Tab Navigation — Starter Packs 제거(의미 적음). 내 워크플로우(Agent)만 노출. */}
        <div className="mb-6 flex gap-2 border-b border-gray-200">
          {(['내 워크플로우'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                setSearchInput('');
                setSearchQuery('');
                setStatusFilter('');
                setExpandedId(null);
                setExpandedPackId(null);
              }}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* ═══════════════════════════════════════════ */}
        {/* TAB: 내 워크플로우 (Server-backed) */}
        {/* ═══════════════════════════════════════════ */}
        {activeTab === '내 워크플로우' && (
          <>
            {/* Stats Row */}
            <div className="grid grid-cols-3 gap-4 mb-8">
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-xs text-gray-600 mb-1">전체 워크플로우</p>
                <p className="text-2xl font-bold text-gray-900">{totalCount}</p>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-xs text-gray-600 mb-1">배포됨</p>
                <p className="text-2xl font-bold text-green-600">{activeCount}</p>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-xs text-gray-600 mb-1">데이터 소스</p>
                <p className="text-sm font-semibold text-gray-900">
                  {serverError ? '🔴 로컬 (오프라인)' : '🟢 서버'}
                </p>
              </div>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <input
                    type="text"
                    placeholder="워크플로우명 또는 설명 검색..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setPage(1);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">상태: 전체</option>
                  <option value="DRAFT">초안</option>
                  <option value="PUBLISHED">배포됨</option>
                  <option value="ARCHIVED">보관됨</option>
                </select>
              </div>
            </div>

            {/* Error Banner */}
            {serverError && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                ⚠️ 서버 연결 실패 — 로컬 저장된 워크플로우를 표시합니다.
                <button onClick={fetchServerWorkflows} className="ml-2 underline">
                  재시도
                </button>
              </div>
            )}

            {/* Loading */}
            {serverLoading ? (
              <div className="flex items-center justify-center py-16 text-gray-400">
                <div className="animate-spin mr-2">⏳</div> 불러오는 중...
              </div>
            ) : allWorkflows.length === 0 ? (
              /* Empty State */
              <div className="flex flex-col items-center justify-center py-16 bg-white rounded-lg border border-gray-200">
                <div className="text-5xl mb-4">🌊</div>
                <p className="text-gray-600 text-sm mb-2">워크플로우가 없습니다</p>
                <p className="text-gray-500 text-xs mb-4">
                  빌더에서 새 워크플로우를 만들거나 Starter Pack을 설치해보세요
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={handleCreateNew}
                    className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition"
                  >
                    + 새 워크플로우
                  </button>
                  <button
                    onClick={() => setActiveTab('Starter Packs')}
                    className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-100 transition"
                  >
                    Starter Packs 보기
                  </button>
                </div>
              </div>
            ) : (
              /* Workflow Grid */
              <>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  {allWorkflows.map((wf) => {
                    const statusCfg = STATUS_CONFIG[wf.status] || STATUS_CONFIG.DRAFT;
                    const isExpanded = expandedId === wf.id;
                    const isDeleting = actionLoading === wf.id;

                    return (
                      <div
                        key={wf.id}
                        className="bg-white rounded-lg border border-gray-200 overflow-hidden hover:shadow-md transition"
                      >
                        {/* Card Header */}
                        <div
                          className="p-4 border-b border-gray-200 cursor-pointer hover:bg-gray-50"
                          onClick={() => handleEdit(wf)}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <h3 className="flex-1 text-sm font-semibold text-gray-900 truncate">
                              {wf.name}
                            </h3>
                            <div className="flex items-center gap-1 ml-2">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${statusCfg.color}`}
                              >
                                {statusCfg.label}
                              </span>
                              {wf.source === 'local' && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-orange-50 text-orange-600">
                                  로컬
                                </span>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-gray-600 line-clamp-2">{wf.description}</p>
                        </div>

                        {/* Meta */}
                        <div className="px-4 py-2.5 border-b border-gray-200 flex items-center gap-3 text-[11px] text-gray-500">
                          <span>🧩 {wf.nodeCount}개 노드</span>
                          {wf.version && <span>v{wf.version}</span>}
                          <span>{formatTimeAgo(wf.updatedAt)}</span>
                        </div>

                        {/* Tags */}
                        {wf.tags.length > 0 && (
                          <div className="px-4 py-2 border-b border-gray-200 flex flex-wrap gap-1">
                            {wf.tags.slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Actions */}
                        <div className="px-4 py-3 flex items-center gap-2">
                          <button
                            onClick={() => handleEdit(wf)}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 transition"
                          >
                            ✏️ 편집
                          </button>
                          <button
                            onClick={() => {
                              // 바로 실행: navigate to builder with wfId + autoRun flag
                              if (wf.source === 'server') {
                                router.push(`/orchestration/builder?wfId=${wf.id}&autoRun=true`);
                              } else {
                                const localWf = localWorkflows.find((l) => l.id === wf.id);
                                if (localWf) {
                                  localStorage.setItem(
                                    'metis_builder_load_workflow',
                                    JSON.stringify(localWf),
                                  );
                                  router.push(`/orchestration/builder?id=${wf.id}&autoRun=true`);
                                }
                              }
                            }}
                            className="px-3 py-2 bg-green-600 text-white text-xs font-medium rounded hover:bg-green-700 transition"
                          >
                            ▶ 실행
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedId(isExpanded ? null : wf.id);
                            }}
                            className="px-3 py-2 text-gray-600 text-xs border border-gray-300 rounded hover:bg-gray-100 transition"
                            title="노드 상세 보기"
                          >
                            {isExpanded ? '▲' : '▼'}
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(wf.id)}
                            disabled={isDeleting}
                            className="px-3 py-2 text-red-600 text-xs border border-red-300 rounded hover:bg-red-50 transition disabled:opacity-50"
                          >
                            🗑️
                          </button>
                        </div>

                        {/* Expanded: Node details */}
                        {isExpanded && (
                          <div className="px-4 py-3 bg-gray-50 border-t border-gray-200">
                            <p className="text-[10px] text-gray-500 font-semibold mb-2 uppercase tracking-wide">
                              워크플로우 노드
                            </p>
                            {wf.nodeCount > 0 ? (
                              <div className="space-y-1.5">
                                {/* For server workflows, show node count summary */}
                                {wf.source === 'server' ? (
                                  <div className="text-xs text-gray-600">
                                    <p>🧩 {wf.nodeCount}개 노드 구성</p>
                                    <p className="text-gray-400 mt-1">
                                      편집 버튼을 눌러 노드 상세를 확인하세요
                                    </p>
                                  </div>
                                ) : (
                                  /* For local workflows, show actual nodes */
                                  (wf.nodes || []).map((n: any, idx: number) => (
                                    <div
                                      key={idx}
                                      className="flex items-center gap-2 text-xs text-gray-600"
                                    >
                                      <span className="w-5 h-5 flex items-center justify-center bg-blue-100 text-blue-600 rounded text-[10px] font-bold">
                                        {idx + 1}
                                      </span>
                                      <span>{NODE_EMOJIS[n.type] || '📌'}</span>
                                      <span className="font-medium">{n.name || n.type}</span>
                                    </div>
                                  ))
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-gray-400">노드 정보 없음</p>
                            )}
                            <div className="mt-3 flex gap-2">
                              <button
                                onClick={() => {
                                  if (wf.source === 'server') {
                                    router.push(
                                      `/orchestration/builder?wfId=${wf.id}&autoRun=true`,
                                    );
                                  } else {
                                    const localWf = localWorkflows.find((l) => l.id === wf.id);
                                    if (localWf) {
                                      localStorage.setItem(
                                        'metis_builder_load_workflow',
                                        JSON.stringify(localWf),
                                      );
                                      router.push(
                                        `/orchestration/builder?id=${wf.id}&autoRun=true`,
                                      );
                                    }
                                  }
                                }}
                                className="px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded hover:bg-green-700 transition"
                              >
                                ▶ 전체 실행
                              </button>
                              <button
                                onClick={() => handleEdit(wf)}
                                className="px-3 py-1.5 border border-blue-300 text-blue-600 text-xs font-medium rounded hover:bg-blue-50 transition"
                              >
                                🔧 편집 열기
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Delete Confirmation */}
                        {deleteConfirm === wf.id && (
                          <div className="px-4 py-3 bg-red-50 border-t border-red-200 flex items-center gap-2">
                            <span className="text-xs text-red-700 flex-1">
                              정말 삭제하시겠습니까?
                            </span>
                            <button
                              onClick={() => handleDelete(wf)}
                              className="px-3 py-1 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-700 transition"
                            >
                              확인
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-3 py-1 bg-gray-300 text-gray-700 text-xs font-medium rounded hover:bg-gray-400 transition"
                            >
                              취소
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {serverData && serverData.totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-6">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                    >
                      ← 이전
                    </button>
                    <span className="text-sm text-gray-500">
                      {page} / {serverData.totalPages} ({serverData.total}개)
                    </span>
                    <button
                      onClick={() => setPage((p) => Math.min(serverData!.totalPages, p + 1))}
                      disabled={page >= serverData.totalPages}
                      className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                    >
                      다음 →
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ═══════════════════════════════════════════ */}
        {/* TAB: Starter Packs */}
        {/* ═══════════════════════════════════════════ */}
        {activeTab === 'Starter Packs' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {STARTER_PACKS.map((pack) => {
              const templates = getPackTemplates(pack);
              const gapAnalysis = templates.map((t) => analyzeConnectorGaps(t));
              const totalAvailable = new Set(
                gapAnalysis.flatMap((g) => g.available.map((c) => c.key)),
              ).size;
              const totalPlaceholder = new Set(
                gapAnalysis.flatMap((g) => g.placeholder.map((c) => c.key)),
              ).size;
              const isExpanded = expandedPackId === pack.id;

              return (
                <div
                  key={pack.id}
                  className="bg-white rounded-lg border border-gray-200 overflow-hidden hover:shadow-md transition"
                >
                  {/* Pack Header */}
                  <div
                    onClick={() => setExpandedPackId(isExpanded ? null : pack.id)}
                    className="p-4 border-b border-gray-200 cursor-pointer hover:bg-gray-50 transition"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className="text-3xl">{pack.icon}</span>
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-gray-900">{pack.name}</h3>
                          <p className="text-xs text-gray-600 line-clamp-1">{pack.description}</p>
                        </div>
                      </div>
                      <span className="text-[10px] font-medium text-gray-500 whitespace-nowrap ml-2">
                        v{pack.version}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-3 text-xs text-gray-600">
                      <div className="flex items-center gap-1">
                        <span>📋</span>
                        <span>{templates.length}개 워크플로우</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span>✅</span>
                        <span>{totalAvailable}개 커넥터</span>
                      </div>
                      {totalPlaceholder > 0 && (
                        <div className="flex items-center gap-1">
                          <span>⚠️</span>
                          <span>{totalPlaceholder}개 준비중</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 space-y-4">
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 mb-2">
                          포함된 워크플로우
                        </h4>
                        <div className="space-y-2">
                          {templates.map((template) => (
                            <div
                              key={template.id}
                              className="p-2 bg-white rounded border border-gray-200"
                            >
                              <div className="flex items-start justify-between mb-1">
                                <p className="text-xs font-medium text-gray-900">{template.name}</p>
                                <button
                                  onClick={() => handleInstallSingleWorkflow(template.id)}
                                  className="px-2 py-1 text-[10px] font-semibold bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition"
                                >
                                  설치 → 편집
                                </button>
                              </div>
                              <p className="text-[11px] text-gray-600 line-clamp-1">
                                {template.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Connector Status */}
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 mb-2">필요 커넥터</h4>
                        <div className="space-y-1">
                          {Array.from(
                            new Set(
                              gapAnalysis.flatMap((g) => [
                                ...g.available.map((c) => c.key),
                                ...g.placeholder.map((c) => c.key),
                              ]),
                            ),
                          ).map((connectorKey) => {
                            const connector = CONNECTOR_REGISTRY.find(
                              (c) => c.key === connectorKey,
                            );
                            if (!connector) return null;
                            const isAvailable = connector.status === 'available';
                            return (
                              <div
                                key={connectorKey}
                                className="flex items-center gap-2 text-[11px]"
                              >
                                <span>{isAvailable ? '✅' : '⚠️'}</span>
                                <span className={isAvailable ? 'text-green-700' : 'text-amber-700'}>
                                  {connector.name}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Business Outcomes */}
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 mb-2">비즈니스 효과</h4>
                        <ul className="space-y-1">
                          {templates.map((template) => (
                            <li key={template.id} className="text-[11px] text-gray-600 flex gap-2">
                              <span className="text-[10px]">•</span>
                              <span className="line-clamp-1">{template.businessOutcome}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}

                  {/* Footer Actions */}
                  <div className="px-4 py-3 border-t border-gray-200 flex gap-2">
                    <button
                      onClick={() => setInstallModalPackId(pack.id)}
                      className="flex-1 px-3 py-2 bg-green-600 text-white text-xs font-semibold rounded hover:bg-green-700 transition flex items-center justify-center gap-1"
                    >
                      <span>⬇️</span>
                      전체 설치
                    </button>
                    <button
                      onClick={() => setExpandedPackId(isExpanded ? null : pack.id)}
                      className="px-3 py-2 text-gray-600 text-xs border border-gray-300 rounded hover:bg-gray-100 transition"
                    >
                      {isExpanded ? '닫기' : '상세'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════ */}
      {/* Install Pack Modal */}
      {/* ═══════════════════════════════════════════ */}
      {installModalPackId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg max-w-md w-full mx-4 overflow-hidden">
            {(() => {
              const pack = STARTER_PACKS.find((p) => p.id === installModalPackId);
              if (!pack) return null;
              const templates = getPackTemplates(pack);

              return (
                <>
                  <div className="p-6 border-b border-gray-200">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-2xl">{pack.icon}</span>
                      <h2 className="text-lg font-semibold text-gray-900">{pack.name} 설치</h2>
                    </div>
                    <p className="text-sm text-gray-600">다음 워크플로우가 서버에 저장됩니다:</p>
                  </div>

                  <div className="px-6 py-4 max-h-64 overflow-y-auto space-y-3 border-b border-gray-200">
                    {templates.map((template) => (
                      <div
                        key={template.id}
                        className="flex items-start gap-3 p-3 bg-gray-50 rounded"
                      >
                        <span className="text-xl">{template.nodes[0]?.icon || '📋'}</span>
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900">{template.name}</p>
                          <p className="text-xs text-gray-600 line-clamp-2">
                            {template.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="px-6 py-4 flex gap-3">
                    <button
                      onClick={() => setInstallModalPackId(null)}
                      className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded hover:bg-gray-100 transition"
                    >
                      취소
                    </button>
                    <button
                      onClick={() => handleInstallPack(pack.id)}
                      className="flex-1 px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded hover:bg-green-700 transition"
                    >
                      설치
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
