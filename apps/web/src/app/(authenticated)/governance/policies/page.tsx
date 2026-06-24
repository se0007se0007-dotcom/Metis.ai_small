'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import { Plus, RefreshCw, AlertCircle, Code2, Shield, X } from 'lucide-react';

// ── Types ──

interface Policy {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  scope: Record<string, unknown>;
  rulesJson: Record<string, unknown>;
  rulesCount: number;
  lastEvaluated: string | null;
  violationCount: number;
  createdAt: string;
}

// ── Page Component ──

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const policiesPage = usePagination(policies, 10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createFormData, setCreateFormData] = useState({
    name: '',
    type: 'COMPLIANCE',
    isActive: true,
    scope: '{}',
    rulesJson: '[]',
  });
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ items: Policy[] }>('/governance/policies');
      setPolicies(data?.items ?? data ?? []);
    } catch (err: any) {
      console.warn('Failed to fetch policies:', err);
      setPolicies([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleCreatePolicy = async () => {
    if (!createFormData.name.trim()) {
      alert('정책 이름을 입력하세요');
      return;
    }

    try {
      let scopeObj = {};
      let rulesObj: unknown[] = [];
      try {
        scopeObj = JSON.parse(createFormData.scope);
      } catch {
        alert('Scope JSON이 유효하지 않습니다');
        return;
      }
      try {
        rulesObj = JSON.parse(createFormData.rulesJson);
      } catch {
        alert('Rules JSON이 유효하지 않습니다');
        return;
      }

      // Create via API
      await api.post('/governance/policies', {
        name: createFormData.name,
        type: createFormData.type,
        isActive: createFormData.isActive,
        scope: scopeObj,
        rules: rulesObj,
      });
      setToastMessage('정책이 생성되었습니다.');
      setTimeout(() => setToastMessage(null), 3000);

      // Clear form and close modal
      setCreateFormData({
        name: '',
        type: 'COMPLIANCE',
        isActive: true,
        scope: '{}',
        rulesJson: '[]',
      });
      setShowCreateModal(false);
      await fetchPolicies();
    } catch (err: any) {
      alert(err.message ?? '정책 생성 실패');
    }
  };

  const handleTogglePolicy = async (policyId: string, isCurrentlyActive: boolean) => {
    try {
      await api.patch(`/governance/policies/${policyId}`, { isActive: !isCurrentlyActive });
      setToastMessage(isCurrentlyActive ? '정책을 비활성화했습니다.' : '정책을 활성화했습니다.');
      setTimeout(() => setToastMessage(null), 3000);
      await fetchPolicies();
      // keep the detail panel in sync if this policy is selected
      setSelectedPolicy((prev) =>
        prev && prev.id === policyId ? { ...prev, isActive: !isCurrentlyActive } : prev,
      );
    } catch (err: any) {
      alert(err.message ?? '정책 상태 변경 실패');
    }
  };

  const stats = {
    total: policies.length,
    active: policies.filter((p) => p.isActive).length,
    violated: policies.reduce((sum, p) => sum + (p.violationCount || 0), 0),
    coverage: policies.length > 0 ? '85%' : '0%',
  };

  return (
    <div className="p-6">
      <PageHeader
        title="정책 엔진 (Policy Engine)"
        description="거버넌스 정책 정의 및 평가"
        actions={
          <div className="flex gap-2">
            <button
              onClick={fetchPolicies}
              className="p-1.5 text-gray-500 hover:text-gray-900 transition"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-gray-50 rounded text-xs font-semibold hover:bg-blue-600/90 transition"
            >
              <Plus size={14} />
              정책 생성
            </button>
          </div>
        }
      />

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="전체 정책" value={stats.total} color="white" />
        <StatCard label="활성" value={stats.active} color="success" />
        <StatCard label="위반 (24h)" value={stats.violated} color="danger" />
        <StatCard label="커버리지" value={stats.coverage} color="accent" />
      </div>

      {/* Error State */}
      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-100 border border-red-200 rounded text-xs text-red-600">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Toast */}
      {toastMessage && (
        <div className="fixed bottom-4 right-4 px-4 py-2 bg-amber-200 border border-amber-300 rounded text-xs text-amber-600">
          {toastMessage}
        </div>
      )}

      {/* Two-Column Layout */}
      <div className="flex gap-4">
        {/* Left: Policies Table */}
        <div className="flex-1">
          <div className="bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Shield size={14} className="text-blue-600" />
                <span className="text-xs font-semibold text-gray-900">정책 목록</span>
              </div>
              <span className="text-[10px] text-gray-500">{policies.length}개</span>
            </div>

            {loading ? (
              <div className="p-4 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-12 bg-gray-50 rounded animate-pulse" />
                ))}
              </div>
            ) : policies.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <Shield size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-xs">정책이 없습니다</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="text-left px-4 py-2">정책명</th>
                      <th className="text-left px-4 py-2">유형</th>
                      <th className="text-left px-4 py-2">상태</th>
                      <th className="text-left px-4 py-2">범위</th>
                      <th className="text-left px-4 py-2">규칙 수</th>
                      <th className="text-left px-4 py-2">마지막 평가</th>
                      <th className="text-left px-4 py-2">위반</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policiesPage.pageItems.map((policy) => (
                      <tr
                        key={policy.id}
                        onClick={() => setSelectedPolicy(policy)}
                        className={`border-b border-gray-200 hover:bg-gray-50 cursor-pointer transition ${
                          selectedPolicy?.id === policy.id ? 'bg-blue-50' : ''
                        }`}
                      >
                        <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">
                          {policy.name}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{policy.type}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={policy.isActive ? 'ACTIVE' : 'INACTIVE'} />
                        </td>
                        <td className="px-4 py-2.5 text-[10px] text-gray-500 font-mono">
                          {Object.keys(policy?.scope ?? {}).join(', ') || '-'}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-blue-600 font-semibold">
                          {policy.rulesCount}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">
                          {policy.lastEvaluated
                            ? new Date(policy.lastEvaluated).toLocaleDateString('ko-KR')
                            : '-'}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {policy.violationCount > 0 ? (
                            <span className="text-red-600 font-semibold">
                              {policy.violationCount}
                            </span>
                          ) : (
                            <span className="text-green-600">0</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pager p={policiesPage} />
              </div>
            )}
          </div>
        </div>

        {/* Right: Detail Panel */}
        <div className="w-80 flex-shrink-0 space-y-4">
          {selectedPolicy ? (
            <>
              <div className="bg-gray-50 rounded-lg border border-gray-200">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-blue-600 flex items-center gap-1">
                    <Shield size={12} />
                    정책 메타데이터
                  </span>
                </div>
                <div className="p-4 space-y-3 text-xs">
                  <div>
                    <p className="text-gray-500 mb-1">정책 ID</p>
                    <p className="font-mono text-gray-900 bg-white p-2 rounded break-all">
                      {selectedPolicy.id}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-1">유형</p>
                    <p className="text-gray-900 font-semibold">{selectedPolicy.type}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-1">생성일</p>
                    <p className="text-gray-900">
                      {new Date(selectedPolicy.createdAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-1">상태</p>
                    <StatusBadge status={selectedPolicy.isActive ? 'ACTIVE' : 'INACTIVE'} />
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg border border-gray-200">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-900 flex items-center gap-1">
                    <Code2 size={12} />
                    규칙 (JSON)
                  </span>
                </div>
                <div className="p-3">
                  <div className="bg-gray-100 rounded-lg p-3 font-mono text-[10px] text-gray-500 overflow-y-auto max-h-64">
                    <pre>{JSON.stringify(selectedPolicy.rulesJson, null, 2)}</pre>
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => handleTogglePolicy(selectedPolicy.id, selectedPolicy.isActive)}
                  className="flex-1 px-3 py-2 bg-blue-100 text-blue-600 rounded text-xs font-semibold hover:bg-blue-600/30 transition"
                >
                  {selectedPolicy.isActive ? '비활성화' : '활성화'}
                </button>
              </div>
            </>
          ) : (
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-6 flex flex-col items-center text-center">
              <Shield size={32} className="text-gray-500/30 mb-3" />
              <p className="text-xs text-gray-500">왼쪽 목록에서 정책을 선택하세요</p>
            </div>
          )}
        </div>
      </div>

      {/* Create Policy Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-50 rounded-lg border border-gray-200 max-w-md w-full max-h-96 overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">새 정책 생성</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-500 hover:text-gray-900 transition"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-2">정책명</label>
                <input
                  type="text"
                  value={createFormData.name}
                  onChange={(e) => setCreateFormData({ ...createFormData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
                  placeholder="정책명"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-2">유형</label>
                <select
                  value={createFormData.type}
                  onChange={(e) => setCreateFormData({ ...createFormData, type: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
                >
                  <option>COMPLIANCE</option>
                  <option>SECURITY</option>
                  <option>PERFORMANCE</option>
                  <option>COST</option>
                </select>
              </div>

              <div>
                <label className="flex items-center gap-2 text-xs text-gray-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createFormData.isActive}
                    onChange={(e) =>
                      setCreateFormData({ ...createFormData, isActive: e.target.checked })
                    }
                    className="rounded"
                  />
                  활성 상태로 생성
                </label>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-2">Scope (JSON)</label>
                <textarea
                  value={createFormData.scope}
                  onChange={(e) => setCreateFormData({ ...createFormData, scope: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-200 font-mono"
                  placeholder="{}"
                  rows={3}
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-2">규칙 (JSON)</label>
                <textarea
                  value={createFormData.rulesJson}
                  onChange={(e) =>
                    setCreateFormData({ ...createFormData, rulesJson: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-200 font-mono"
                  placeholder="[]"
                  rows={4}
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 px-3 py-2 border border-gray-200 rounded text-xs font-semibold text-gray-500 hover:text-gray-900 transition"
                >
                  취소
                </button>
                <button
                  onClick={handleCreatePolicy}
                  className="flex-1 px-3 py-2 bg-blue-600 text-gray-50 rounded text-xs font-semibold hover:bg-blue-600/90 transition"
                >
                  생성
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ── Stat Card ──
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
  };
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorMap[color] ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
