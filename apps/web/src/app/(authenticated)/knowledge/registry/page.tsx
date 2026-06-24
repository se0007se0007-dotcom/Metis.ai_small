'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { api } from '@/lib/api-client';
import {
  Search,
  BookOpen,
  Trash2,
  RefreshCw,
  Plus,
  Pencil,
  Archive,
  CheckCircle2,
  ShieldCheck,
  AlertCircle,
  X,
  TrendingUp,
  Globe,
  Target,
} from 'lucide-react';

// ── Types ──

interface KnowledgeArtifact {
  id: string;
  key: string;
  title: string;
  category: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' | 'DEPRECATED';
  source: 'MANUAL' | 'AUTO_ERROR' | 'EVALUATION' | 'IMPORTED';
  priority: number;
  content: string | null;
  tags: string[];
  scopeJson: {
    global?: boolean;
    workflowKeys?: string[];
    categories?: string[];
    capabilityKeys?: string[];
  } | null;
  usageCount: number;
  lastUsedAt: string | null;
  linkedPolicyKey: string | null;
  version: string;
  updatedAt: string;
}

interface ArtifactForm {
  title: string;
  category: string;
  content: string;
  tags: string;
  priority: number;
  status: KnowledgeArtifact['status'];
  source: KnowledgeArtifact['source'];
  scopeGlobal: boolean;
  scopeWorkflowKeys: string;
  scopeCategories: string;
}

const CATEGORIES = ['SECURITY', 'QUALITY', 'RUNBOOK', 'ERROR_PATTERN', 'COST', 'GENERAL'];
const STATUSES: KnowledgeArtifact['status'][] = ['DRAFT', 'ACTIVE', 'ARCHIVED', 'DEPRECATED'];
const SOURCES: KnowledgeArtifact['source'][] = ['MANUAL', 'AUTO_ERROR', 'EVALUATION', 'IMPORTED'];

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: '수동',
  AUTO_ERROR: '자동수집',
  EVALUATION: '평가',
  IMPORTED: '가져옴',
};

const SOURCE_STYLE: Record<string, string> = {
  MANUAL: 'bg-blue-100 text-blue-600',
  AUTO_ERROR: 'bg-amber-100 text-amber-600',
  EVALUATION: 'bg-purple-light text-purple',
  IMPORTED: 'bg-gray-100 text-gray-500',
};

const EMPTY_FORM: ArtifactForm = {
  title: '',
  category: 'RUNBOOK',
  content: '',
  tags: '',
  priority: 0,
  status: 'ACTIVE',
  source: 'MANUAL',
  scopeGlobal: true,
  scopeWorkflowKeys: '',
  scopeCategories: '',
};

function scopeSummary(scope: KnowledgeArtifact['scopeJson']): string {
  if (!scope) return '전역';
  if (scope.global) return '전역';
  const parts: string[] = [];
  if (scope.workflowKeys?.length) parts.push(`워크플로우 ${scope.workflowKeys.length}`);
  if (scope.categories?.length) parts.push(`카테고리 ${scope.categories.length}`);
  if (scope.capabilityKeys?.length) parts.push(`기능 ${scope.capabilityKeys.length}`);
  return parts.length ? parts.join(' · ') : '전역';
}

// ══════════════════════════════════════════════════════════════════
//  Page
// ══════════════════════════════════════════════════════════════════

export default function RegistryPage() {
  const [tab, setTab] = useState<'registry' | 'utilization'>('registry');

  return (
    <div className="p-6">
      <SubTabs items={[{ label: '지식 등록·관리', href: '/knowledge/registry' }, { label: '활용도', href: '/knowledge/artifacts' }]} />
      <PageHeader
        title="운영 지식 레지스트리"
        description="에이전트에 주입되는 운영 지식 자산을 등록·관리하고 활용도를 추적합니다"
      />

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-200">
        <button
          onClick={() => setTab('registry')}
          className={`px-4 py-2 text-xs font-semibold border-b-2 transition ${
            tab === 'registry'
              ? 'border-accent text-accent'
              : 'border-transparent text-gray-500 hover:text-gray-900'
          }`}
        >
          <BookOpen size={13} className="inline mr-1.5 -mt-0.5" />
          지식 목록
        </button>
        <button
          onClick={() => setTab('utilization')}
          className={`px-4 py-2 text-xs font-semibold border-b-2 transition ${
            tab === 'utilization'
              ? 'border-accent text-accent'
              : 'border-transparent text-gray-500 hover:text-gray-900'
          }`}
        >
          <TrendingUp size={13} className="inline mr-1.5 -mt-0.5" />
          활용도
        </button>
      </div>

      {tab === 'registry' ? <RegistryTab /> : <UtilizationTab />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
//  Registry Tab
// ══════════════════════════════════════════════════════════════════

function RegistryTab() {
  const [artifacts, setArtifacts] = useState<KnowledgeArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeArtifact | null>(null);
  const [form, setForm] = useState<ArtifactForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchArtifacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (categoryFilter) params.set('category', categoryFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      if (search) params.set('q', search);
      const qs = params.toString();
      const data = await api.get<{ items: KnowledgeArtifact[] }>(
        `/knowledge/artifacts${qs ? `?${qs}` : ''}`,
      );
      setArtifacts(Array.isArray(data?.items) ? data.items : []);
    } catch (err: any) {
      setError(err?.message ?? '지식 목록을 불러오지 못했습니다');
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, statusFilter, sourceFilter, search]);

  useEffect(() => {
    fetchArtifacts();
  }, [fetchArtifacts]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(a: KnowledgeArtifact) {
    setEditing(a);
    setForm({
      title: a.title,
      category: a.category,
      content: a.content ?? '',
      tags: (a.tags ?? []).join(', '),
      priority: a.priority ?? 0,
      status: a.status,
      source: a.source,
      scopeGlobal: a.scopeJson?.global ?? !a.scopeJson,
      scopeWorkflowKeys: (a.scopeJson?.workflowKeys ?? []).join(', '),
      scopeCategories: (a.scopeJson?.categories ?? []).join(', '),
    });
    setModalOpen(true);
  }

  function buildPayload() {
    const tags = form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const scopeJson = form.scopeGlobal
      ? { global: true }
      : {
          global: false,
          workflowKeys: form.scopeWorkflowKeys
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          categories: form.scopeCategories
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        };
    return {
      title: form.title.trim(),
      category: form.category,
      content: form.content,
      tags,
      scopeJson,
      source: form.source,
      priority: Number(form.priority) || 0,
      status: form.status,
    };
  }

  async function handleSave() {
    if (!form.title.trim()) {
      showToast('제목을 입력하세요');
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      if (editing) {
        await api.put(`/knowledge/artifacts/${editing.id}`, payload);
        showToast('지식이 수정되었습니다');
      } else {
        await api.post('/knowledge/artifacts', payload);
        showToast('지식이 등록되었습니다');
      }
      setModalOpen(false);
      fetchArtifacts();
    } catch (err: any) {
      showToast(err?.message ?? '저장 실패');
    } finally {
      setSaving(false);
    }
  }

  async function handleStatus(a: KnowledgeArtifact, status: KnowledgeArtifact['status']) {
    try {
      await api.patch(`/knowledge/artifacts/${a.id}/status`, { status });
      fetchArtifacts();
    } catch (err: any) {
      showToast(err?.message ?? '상태 변경 실패');
    }
  }

  async function handleDelete(a: KnowledgeArtifact) {
    if (!confirm(`"${a.title}" 지식을 삭제하시겠습니까?`)) return;
    try {
      await api.delete(`/knowledge/artifacts/${a.id}`);
      fetchArtifacts();
    } catch (err: any) {
      showToast(err?.message ?? '삭제 실패');
    }
  }

  async function handlePromote(a: KnowledgeArtifact) {
    if (!confirm(`"${a.title}" 지식을 정책으로 등록하시겠습니까?`)) return;
    try {
      const res = await api.post<{ policy: { key?: string; name?: string } }>(
        `/knowledge/artifacts/${a.id}/promote-policy`,
      );
      showToast(`정책으로 등록됨: ${res?.policy?.key ?? res?.policy?.name ?? '완료'}`);
      fetchArtifacts();
    } catch (err: any) {
      showToast(err?.message ?? '정책 등록 실패');
    }
  }

  // 검토 대기: 자동수집(오류/평가) DRAFT — 사람이 승인해야 프롬프트 주입 대상이 됨
  const isPendingReview = (a: KnowledgeArtifact) =>
    a.status === 'DRAFT' && (a.source === 'AUTO_ERROR' || a.source === 'EVALUATION');
  const pendingReview = artifacts.filter(isPendingReview);
  const visibleArtifacts = reviewOnly ? pendingReview : artifacts;

  const stats = {
    total: artifacts.length,
    active: artifacts.filter((a) => a.status === 'ACTIVE').length,
    auto: artifacts.filter((a) => a.source === 'AUTO_ERROR').length,
    promoted: artifacts.filter((a) => a.linkedPolicyKey).length,
  };

  return (
    <>
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 bg-gray-900 text-gray-900 rounded-lg shadow-lg text-xs">
          <CheckCircle2 size={14} className="text-green-400" />
          {toast}
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="총 지식" value={stats.total} color="white" />
        <StatCard label="활성 (ACTIVE)" value={stats.active} color="success" />
        <StatCard label="자동수집 (오류패턴)" value={stats.auto} color="warning" />
        <StatCard label="정책으로 승격" value={stats.promoted} color="accent" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="제목/내용 검색..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-accent/50"
          />
        </div>
        <FilterSelect
          value={categoryFilter}
          onChange={setCategoryFilter}
          allLabel="전체 카테고리"
          options={CATEGORIES}
        />
        <FilterSelect
          value={statusFilter}
          onChange={setStatusFilter}
          allLabel="전체 상태"
          options={STATUSES}
        />
        <FilterSelect
          value={sourceFilter}
          onChange={setSourceFilter}
          allLabel="전체 소스"
          options={SOURCES}
          labelMap={SOURCE_LABEL}
        />
        <button
          onClick={() => setReviewOnly((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border transition ${
            reviewOnly
              ? 'bg-amber-500 text-white border-amber-500'
              : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
          }`}
          title="자동수집(오류/평가) DRAFT 지식 — 승인해야 에이전트 프롬프트에 주입됩니다"
        >
          검토 대기 {pendingReview.length}
        </button>
        <button
          onClick={fetchArtifacts}
          className="p-1.5 text-gray-500 hover:text-gray-900 transition"
          title="새로고침"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={openCreate}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded text-xs font-semibold hover:bg-accent/90 transition"
        >
          <Plus size={14} />
          지식 등록
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !error && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-gray-50 rounded-lg border border-gray-200 p-4 animate-pulse">
              <div className="h-4 bg-white rounded w-1/3 mb-2" />
              <div className="h-3 bg-white rounded w-1/2" />
            </div>
          ))}
        </div>
      )}

      {/* List */}
      {!loading && !error && (
        <>
          {visibleArtifacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              <BookOpen size={40} className="mb-3 opacity-30" />
              <p className="text-sm">
                {reviewOnly ? '검토 대기 중인 지식이 없습니다' : '등록된 지식이 없습니다'}
              </p>
              <p className="text-xs mt-1">
                {reviewOnly
                  ? '자동수집된 DRAFT 지식이 생기면 여기에 표시됩니다'
                  : '상단의 "지식 등록" 버튼으로 운영 지식을 추가하세요'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleArtifacts.map((a) => (
                <div
                  key={a.id}
                  className="px-4 py-3 bg-gray-50 rounded-lg border border-gray-200 hover:border-gray-300 transition"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-sm font-semibold text-gray-900 truncate">
                          {a.title}
                        </span>
                        <StatusBadge status={a.status} />
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            SOURCE_STYLE[a.source] ?? 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {SOURCE_LABEL[a.source] ?? a.source}
                        </span>
                        {a.linkedPolicyKey && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 bg-purple-light text-purple rounded text-[10px] font-semibold">
                            <ShieldCheck size={10} />
                            정책 {a.linkedPolicyKey}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-gray-500 flex-wrap">
                        <span className="px-1.5 py-0.5 bg-white rounded border border-gray-200">
                          {a.category}
                        </span>
                        <span>우선순위 {a.priority}</span>
                        <span className="flex items-center gap-1">
                          {a.scopeJson?.global ?? !a.scopeJson ? (
                            <Globe size={10} />
                          ) : (
                            <Target size={10} />
                          )}
                          {scopeSummary(a.scopeJson)}
                        </span>
                        <span className="text-accent font-semibold">활용 {a.usageCount}회</span>
                        <span>
                          {a.lastUsedAt
                            ? `최근 사용 ${new Date(a.lastUsedAt).toLocaleDateString('ko-KR')}`
                            : '미사용'}
                        </span>
                        {a.tags?.length > 0 && (
                          <span className="truncate">#{a.tags.join(' #')}</span>
                        )}
                      </div>
                      {a.content && (
                        <p className="mt-1.5 text-[11px] text-gray-500 line-clamp-2">
                          {a.content}
                        </p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isPendingReview(a) && (
                        <button
                          onClick={() => handleStatus(a, 'ACTIVE')}
                          className="flex items-center gap-1 px-2.5 py-1 bg-green-600 text-white rounded text-[11px] font-semibold hover:bg-green-700 transition"
                          title="승인 — ACTIVE로 전환되어 에이전트 프롬프트 주입 대상이 됩니다"
                        >
                          <CheckCircle2 size={11} />
                          승인
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(a)}
                        className="p-1.5 text-gray-500 hover:text-accent transition"
                        title="편집"
                      >
                        <Pencil size={13} />
                      </button>
                      {a.status === 'ACTIVE' ? (
                        <button
                          onClick={() => handleStatus(a, 'ARCHIVED')}
                          className="p-1.5 text-gray-500 hover:text-amber-600 transition"
                          title="보관"
                        >
                          <Archive size={13} />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStatus(a, 'ACTIVE')}
                          className="p-1.5 text-gray-500 hover:text-green-600 transition"
                          title="활성화"
                        >
                          <CheckCircle2 size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => handlePromote(a)}
                        disabled={!!a.linkedPolicyKey}
                        className="p-1.5 text-gray-500 hover:text-purple transition disabled:opacity-30 disabled:cursor-not-allowed"
                        title={a.linkedPolicyKey ? '이미 정책으로 등록됨' : '정책으로 등록'}
                      >
                        <ShieldCheck size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(a)}
                        className="p-1.5 text-gray-500 hover:text-red-600 transition"
                        title="삭제"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">
                {editing ? '지식 편집' : '지식 등록'}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                className="text-gray-500 hover:text-gray-900"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <Field label="제목">
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="metis-input"
                  placeholder="예: 배포 타임아웃 대응 런북"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="카테고리">
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="metis-input"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="소스">
                  <select
                    value={form.source}
                    onChange={(e) =>
                      setForm({ ...form, source: e.target.value as KnowledgeArtifact['source'] })
                    }
                    className="metis-input"
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {SOURCE_LABEL[s] ?? s}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="내용 (에이전트에 주입되는 지식 본문)">
                <textarea
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  rows={5}
                  className="metis-input resize-y"
                  placeholder="운영 지식 본문을 입력하세요 (Markdown 가능)"
                />
              </Field>

              <Field label="태그 (쉼표로 구분)">
                <input
                  type="text"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  className="metis-input"
                  placeholder="배포, 타임아웃, 롤백"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="우선순위">
                  <input
                    type="number"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                    className="metis-input"
                  />
                </Field>
                <Field label="상태">
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value as KnowledgeArtifact['status'] })
                    }
                    className="metis-input"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="적용 범위 (Scope)">
                <label className="flex items-center gap-2 text-xs text-gray-900 mb-2">
                  <input
                    type="checkbox"
                    checked={form.scopeGlobal}
                    onChange={(e) => setForm({ ...form, scopeGlobal: e.target.checked })}
                  />
                  전역 (모든 에이전트에 적용)
                </label>
                {!form.scopeGlobal && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={form.scopeWorkflowKeys}
                      onChange={(e) => setForm({ ...form, scopeWorkflowKeys: e.target.value })}
                      className="metis-input"
                      placeholder="워크플로우 키 (쉼표): ops-event-response, dev-coding-agent"
                    />
                    <input
                      type="text"
                      value={form.scopeCategories}
                      onChange={(e) => setForm({ ...form, scopeCategories: e.target.value })}
                      className="metis-input"
                      placeholder="카테고리 (쉼표): operations, development"
                    />
                  </div>
                )}
              </Field>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200">
              <button
                onClick={() => setModalOpen(false)}
                className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-900 transition"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-1.5 bg-accent text-white rounded text-xs font-semibold hover:bg-accent/90 transition disabled:opacity-50"
              >
                {saving ? '저장 중...' : editing ? '수정' : '등록'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        :global(.metis-input) {
          width: 100%;
          padding: 0.375rem 0.625rem;
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 0.375rem;
          font-size: 0.75rem;
          color: #111827;
        }
        :global(.metis-input:focus) {
          outline: none;
          box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.5);
        }
      `}</style>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════
//  Utilization Tab
// ══════════════════════════════════════════════════════════════════

interface UtilRow {
  id: string;
  title: string;
  category: string;
  usageCount: number;
  lastUsedAt: string | null;
}

interface Utilization {
  mostUsed: UtilRow[];
  unused: UtilRow[];
  byAgent?: { agentName: string; count: number }[];
  totals?: { totalActive: number; totalUsedInWindow: number; windowDays: number };
  totalActive?: number;
  totalUsedInWindow?: number;
}

function UtilizationTab() {
  const [data, setData] = useState<Utilization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  const fetchUtil = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Utilization>(`/knowledge/utilization?days=${days}`);
      setData(res);
    } catch (err: any) {
      setError(err?.message ?? '활용도 데이터를 불러오지 못했습니다');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchUtil();
  }, [fetchUtil]);

  const totalActive = data?.totals?.totalActive ?? data?.totalActive ?? 0;
  const totalUsed = data?.totals?.totalUsedInWindow ?? data?.totalUsedInWindow ?? 0;
  const unusedCount = data?.unused?.length ?? 0;
  const maxUsage = Math.max(1, ...(data?.mostUsed ?? []).map((m) => m.usageCount));

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500">
          어떤 지식이 얼마나 활용되고, 어떤 지식이 사용되지 않는지 추적합니다.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-2 py-1 bg-gray-50 border border-gray-200 rounded text-xs text-gray-900"
          >
            <option value={7}>최근 7일</option>
            <option value={30}>최근 30일</option>
            <option value={90}>최근 90일</option>
          </select>
          <button
            onClick={fetchUtil}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition"
            title="새로고침"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="활성 지식" value={totalActive} color="white" />
        <StatCard label={`최근 ${days}일 사용 지식`} value={totalUsed} color="success" />
        <StatCard label="미활용 지식" value={unusedCount} color="danger" />
        <StatCard
          label="활용률"
          value={totalActive > 0 ? `${Math.round((totalUsed / totalActive) * 100)}%` : '0%'}
          color="accent"
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-64 bg-gray-50 rounded-lg border border-gray-200 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {/* Most used */}
          <div className="bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
              <TrendingUp size={14} className="text-green-600" />
              <span className="text-xs font-semibold text-gray-900">
                많이 쓰이는 지식 (Top {data?.mostUsed?.length ?? 0})
              </span>
            </div>
            <div className="p-3 space-y-2">
              {(data?.mostUsed?.length ?? 0) === 0 ? (
                <p className="text-xs text-gray-500 py-6 text-center">활용된 지식이 없습니다</p>
              ) : (
                data!.mostUsed.map((m, idx) => (
                  <div key={m.id} className="p-2.5 bg-white rounded border border-gray-200">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-900 truncate">
                        <span className="text-gray-500 mr-1.5">#{idx + 1}</span>
                        {m.title}
                      </span>
                      <span className="text-xs font-bold text-green-600 flex-shrink-0">
                        {m.usageCount}회
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${(m.usageCount / maxUsage) * 100}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500">
                      <span>{m.category}</span>
                      <span>
                        {m.lastUsedAt
                          ? new Date(m.lastUsedAt).toLocaleDateString('ko-KR')
                          : '-'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Unused */}
          <div className="bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
              <AlertCircle size={14} className="text-red-600" />
              <span className="text-xs font-semibold text-gray-900">
                미활용 지식 ({data?.unused?.length ?? 0}) — 정리 후보
              </span>
            </div>
            <div className="p-3 space-y-2 max-h-[420px] overflow-y-auto">
              {(data?.unused?.length ?? 0) === 0 ? (
                <p className="text-xs text-gray-500 py-6 text-center">
                  모든 활성 지식이 활용되고 있습니다
                </p>
              ) : (
                data!.unused.map((u) => (
                  <div
                    key={u.id}
                    className="p-2.5 bg-red-50 rounded border border-red-200 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-900 truncate">{u.title}</p>
                      <p className="text-[10px] text-gray-500">{u.category}</p>
                    </div>
                    <span className="text-[10px] text-red-600 font-semibold flex-shrink-0">
                      {u.usageCount === 0
                        ? '0회'
                        : `오래됨 (${u.usageCount}회)`}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* By agent */}
      {!loading && data?.byAgent && data.byAgent.length > 0 && (
        <div className="mt-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-900">에이전트별 지식 활용</span>
          </div>
          <div className="p-3 grid grid-cols-2 md:grid-cols-3 gap-2">
            {data.byAgent.map((b) => (
              <div
                key={b.agentName}
                className="flex items-center justify-between p-2 bg-white rounded border border-gray-200"
              >
                <span className="text-xs text-gray-900 truncate">{b.agentName}</span>
                <span className="text-xs font-semibold text-accent flex-shrink-0">
                  {b.count}회
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ── Shared UI ──

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  labelMap,
}: {
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: string[];
  labelMap?: Record<string, string>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-accent/50"
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {labelMap?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    accent: 'text-blue-600',
    success: 'text-green-600',
    warning: 'text-amber-600',
    danger: 'text-red-600',
    white: 'text-gray-900',
    purple: 'text-purple-400',
  };

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorMap[color] ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
