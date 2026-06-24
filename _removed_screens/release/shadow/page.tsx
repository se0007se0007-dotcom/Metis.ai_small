'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { api } from '@/lib/api-client';
import {
  Copy,
  Plus,
  AlertCircle,
  RefreshCw,
  X,
  ToggleLeft,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

// ── Types ──

interface ShadowConfig {
  id: string;
  name: string;
  description?: string;
  controlVersionId: string;
  candidateVersionId: string;
  samplingRate: number;
  active: boolean;
  pairCount: number;
  createdAt: string;
}

interface ShadowMetrics {
  configId: string;
  matchRate: number;
  regressionRate: number;
  avgLatencyDelta: number;
  verdictCounts: Record<string, number>;
}

interface ShadowPair {
  id: string;
  configId: string;
  verdict: string;
  controlLatencyMs: number;
  candidateLatencyMs: number;
  createdAt: string;
  controlOutput?: string;
  shadowOutput?: string;
  diffSummary?: string;
  policyViolations?: number;
  blockedConnectorCalls?: number;
}

interface ShadowStats {
  activeConfigs: number;
  totalPairs: number;
  matchRate: number;
  regressionRate: number;
}

// ── Page ──

export default function ShadowPage() {
  const [configs, setConfigs] = useState<ShadowConfig[]>([]);
  const [stats, setStats] = useState<ShadowStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<ShadowConfig | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<ShadowMetrics | null>(null);
  const [selectedPairs, setSelectedPairs] = useState<ShadowPair[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedPairId, setExpandedPairId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configsData, statsData] = await Promise.all([
        api.get<{ items: ShadowConfig[] }>('/release/shadow/configs'),
        api.get<ShadowStats>('/release/shadow/stats'),
      ]);
      setConfigs(configsData?.items ?? []);
      setStats(statsData ?? null);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSelectConfig = async (config: ShadowConfig) => {
    setSelectedConfig(config);
    setExpandedPairId(null);
    try {
      const [metricsData, pairsData] = await Promise.all([
        api.get<ShadowMetrics>(`/release/shadow/configs/${config.id}/metrics`),
        api.get<{ items: ShadowPair[] }>(`/release/shadow/pairs?configId=${config.id}`),
      ]);
      setSelectedMetrics(metricsData ?? null);
      setSelectedPairs(pairsData?.items ?? []);
    } catch (err: any) {
      console.error('Failed to load config details:', err);
    }
  };

  const handleToggleActive = async (configId: string, currentActive: boolean) => {
    try {
      await api.patch(`/release/shadow/configs/${configId}/toggle`, {
        active: !currentActive,
      });
      await fetchData();
    } catch (err: any) {
      console.error('Toggle config error:', err);
      alert(err?.message ?? 'Failed to toggle config');
    }
  };

  const handleCreateConfig = async (formData: any) => {
    try {
      await api.post('/release/shadow/configs', formData);
      setShowCreateModal(false);
      await fetchData();
    } catch (err: any) {
      console.error('Create config error:', err);
      alert(err?.message ?? 'Failed to create config');
    }
  };

  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';

  return (
    <div className="p-6">
      <PageHeader
        title="Shadow Execution"
        description="Run candidate versions in parallel with control versions to detect regressions"
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-accent text-dark rounded-lg text-xs font-semibold hover:bg-accent/90 transition"
            >
              <Plus size={14} /> Create Config
            </button>
            <button
              onClick={fetchData}
              className="p-1.5 text-muted-dark hover:text-dark transition"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SC label="Active Configs" value={stats.activeConfigs} c="accent" />
          <SC label="Total Pairs" value={stats.totalPairs} c="white" />
          <SC label="Match Rate" value={`${stats.matchRate}%`} c="success" />
          <SC label="Regression Rate" value={`${stats.regressionRate}%`} c="danger" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Two-column layout */}
      <div className="flex gap-4">
        {/* Left: Configs Table */}
        <div className="flex-1">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Copy size={14} className="text-accent" />
                <span className="text-xs font-semibold text-gray-900">
                  Shadow Configurations ({configs.length})
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                    <th className="text-left px-4 py-2">Name</th>
                    <th className="text-left px-4 py-2">Control Version</th>
                    <th className="text-left px-4 py-2">Candidate Version</th>
                    <th className="text-center px-4 py-2">Sampling Rate</th>
                    <th className="text-center px-4 py-2">Pairs</th>
                    <th className="text-center px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {configs.length === 0 && !loading && (
                    <tr>
                      <td colSpan={6} className="text-center text-gray-500 text-xs py-8">
                        No configs yet
                      </td>
                    </tr>
                  )}
                  {configs.map((config) => (
                    <tr
                      key={config.id}
                      onClick={() => handleSelectConfig(config)}
                      className={`border-b border-gray-200 hover:bg-gray-50 cursor-pointer transition ${
                        selectedConfig?.id === config.id ? 'bg-accent/5' : ''
                      }`}
                    >
                      <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{config.name}</td>
                      <td className="px-4 py-2.5 text-xs text-accent font-mono">
                        {config.controlVersionId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-accent font-mono">
                        {config.candidateVersionId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-900 text-center">
                        {(config.samplingRate * 100).toFixed(0)}%
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-900 text-center">
                        {config.pairCount}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleActive(config.id, config.active);
                          }}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold transition ${
                            config.active ? 'bg-success/20 text-success' : 'bg-muted/20 text-gray-500'
                          }`}
                        >
                          <ToggleLeft size={12} /> {config.active ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: Detail Panel */}
        <div className="w-80 flex-shrink-0 space-y-4">
          {selectedConfig && selectedMetrics ? (
            <>
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-accent">Configuration</span>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Name</p>
                    <p className="text-xs text-gray-900 font-medium mt-1">{selectedConfig.name}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Sampling Rate</p>
                    <p className="text-xs text-gray-900 font-medium mt-1">
                      {(selectedConfig.samplingRate * 100).toFixed(0)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Pairs</p>
                    <p className="text-xs text-gray-900 font-medium mt-1">
                      {selectedConfig.pairCount}
                    </p>
                  </div>
                </div>
              </div>

              {/* Shadow 안전 상태 — governance 가시성 */}
              <div className="bg-white rounded-lg border border-success/20 p-3">
                <p className="text-[10px] font-semibold text-success mb-1">
                  Shadow Isolation Active
                </p>
                <p className="text-[9px] text-gray-500">
                  Connector 호출이 차단되며, 정책이 동일하게 검사됩니다. Production side-effect
                  없음.
                </p>
              </div>

              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-accent">Metrics</span>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Match Rate</p>
                    <p
                      className={`text-lg font-bold mt-1 ${selectedMetrics.matchRate >= 95 ? 'text-success' : 'text-warning'}`}
                    >
                      {selectedMetrics.matchRate.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Regression Rate
                    </p>
                    <p
                      className={`text-lg font-bold mt-1 ${selectedMetrics.regressionRate > 5 ? 'text-danger' : 'text-success'}`}
                    >
                      {selectedMetrics.regressionRate.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Avg Latency Delta
                    </p>
                    <p className="text-xs text-gray-900 font-medium mt-1">
                      {selectedMetrics.avgLatencyDelta.toFixed(0)}ms
                    </p>
                  </div>
                </div>
              </div>

              {/* Pairs List */}
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-900">
                    Recent Pairs ({selectedPairs.length})
                  </span>
                </div>
                <div className="p-3 space-y-2 max-h-72 overflow-y-auto">
                  {selectedPairs.length === 0 ? (
                    <p className="text-xs text-gray-500">No pairs yet</p>
                  ) : (
                    selectedPairs.slice(0, 10).map((pair) => (
                      <div key={pair.id} className="bg-gray-50 rounded border border-gray-200">
                        <button
                          onClick={() =>
                            setExpandedPairId(expandedPairId === pair.id ? null : pair.id)
                          }
                          className="w-full px-2 py-2 flex items-center justify-between hover:bg-gray-50 transition"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-[10px] font-semibold px-2 py-1 rounded ${
                                pair.verdict === 'MATCH'
                                  ? 'bg-success/20 text-success'
                                  : pair.verdict === 'REGRESSION'
                                    ? 'bg-danger/20 text-danger'
                                    : 'bg-warning/20 text-warning'
                              }`}
                            >
                              {pair.verdict}
                            </span>
                            <span className="text-[9px] text-gray-500">
                              {pair.controlLatencyMs}ms → {pair.candidateLatencyMs}ms
                            </span>
                          </div>
                          {pair.controlOutput &&
                            pair.shadowOutput &&
                            (expandedPairId === pair.id ? (
                              <ChevronUp size={14} className="text-gray-500" />
                            ) : (
                              <ChevronDown size={14} className="text-gray-500" />
                            ))}
                        </button>

                        {expandedPairId === pair.id && pair.controlOutput && pair.shadowOutput && (
                          <div className="border-t border-gray-200 p-2">
                            <div className="grid grid-cols-2 gap-2 text-[9px] mb-2">
                              <div>
                                <p className="text-gray-500 font-semibold mb-1">Control</p>
                                <div className="bg-[#1E1E2E] rounded p-2 max-h-20 overflow-y-auto font-mono text-[8px]">
                                  <code className="text-cyan-400 whitespace-pre-wrap break-words">
                                    {pair.controlOutput}
                                  </code>
                                </div>
                              </div>
                              <div>
                                <p className="text-gray-500 font-semibold mb-1">Shadow</p>
                                <div className="bg-[#1E1E2E] rounded p-2 max-h-20 overflow-y-auto font-mono text-[8px]">
                                  <code className="text-cyan-400 whitespace-pre-wrap break-words">
                                    {pair.shadowOutput}
                                  </code>
                                </div>
                              </div>
                            </div>
                            {pair.diffSummary && (
                              <p className="text-[8px] text-gray-500 italic border-t border-gray-200 pt-1">
                                {pair.diffSummary}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Governance indicators */}
                        <div className="px-2 py-1 flex items-center gap-2">
                          {pair.policyViolations != null && pair.policyViolations > 0 && (
                            <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded bg-danger/20 text-danger">
                              {pair.policyViolations} 정책위반
                            </span>
                          )}
                          {pair.blockedConnectorCalls != null && pair.blockedConnectorCalls > 0 && (
                            <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded bg-warning/20 text-warning">
                              {pair.blockedConnectorCalls} 차단됨
                            </span>
                          )}
                          <span className="text-[9px] text-gray-500 ml-auto">
                            {fmt(pair.createdAt)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 flex flex-col items-center text-center">
              <Copy size={32} className="text-gray-500/30 mb-3" />
              <p className="text-xs text-gray-500">Select a configuration to see details</p>
            </div>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateConfigModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateConfig}
        />
      )}
    </div>
  );
}

function SC({ label, value, c }: { label: string; value: number | string; c: string }) {
  const cm: Record<string, string> = {
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    white: 'text-gray-900',
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold ${cm[c] ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function CreateConfigModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [controlVersionId, setControlVersionId] = useState('');
  const [candidateVersionId, setCandidateVersionId] = useState('');
  const [samplingRate, setSamplingRate] = useState('1.0');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !controlVersionId || !candidateVersionId) {
      alert('All fields are required');
      return;
    }
    const rate = parseFloat(samplingRate);
    if (isNaN(rate) || rate < 0 || rate > 1) {
      alert('Sampling rate must be between 0 and 1');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name,
        description,
        controlVersionId,
        candidateVersionId,
        samplingRate: rate,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white border border-gray-200 rounded-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Create Shadow Config</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-900 block mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              placeholder="Config name"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-900 block mb-1">
              Control Version ID
            </label>
            <input
              type="text"
              value={controlVersionId}
              onChange={(e) => setControlVersionId(e.target.value)}
              className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              placeholder="e.g. v1.0.0"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-900 block mb-1">
              Candidate Version ID
            </label>
            <input
              type="text"
              value={candidateVersionId}
              onChange={(e) => setCandidateVersionId(e.target.value)}
              className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              placeholder="e.g. v2.0.0"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-900 block mb-1">
              Sampling Rate (0-1)
            </label>
            <input
              type="number"
              value={samplingRate}
              onChange={(e) => setSamplingRate(e.target.value)}
              step="0.01"
              min="0"
              max="1"
              className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              placeholder="1.0"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-900 block mb-1">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              placeholder="Config description"
            />
          </div>
          <div className="flex gap-2 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs font-semibold text-gray-900 hover:bg-gray-100 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 px-4 py-2 bg-accent text-dark rounded text-xs font-semibold hover:bg-accent/90 transition disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
