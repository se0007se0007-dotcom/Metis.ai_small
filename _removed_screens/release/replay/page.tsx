'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { api } from '@/lib/api-client';
import { RotateCcw, Plus, AlertCircle, RefreshCw, X, ChevronDown, ChevronUp } from 'lucide-react';

// ── Types ──

interface ReplayDataset {
  id: string;
  name: string;
  description?: string;
  caseCount: number;
  baselineVersionId: string;
  filters?: Record<string, any>;
  createdAt: string;
  createdBy: string;
}

interface ReplayRun {
  id: string;
  datasetId: string;
  candidateVersionId: string;
  status: string;
  passCount: number;
  failCount: number;
  errorCount: number;
  policyViolationCount?: number;
  createdAt: string;
}

interface ReplayCase {
  id: string;
  caseKey: string;
  verdict: string;
  baselineOutput?: string;
  candidateOutput?: string;
  deltaMs?: number;
  policyViolations?: number;
}

interface ReplayStats {
  totalDatasets: number;
  totalRuns: number;
  passRate: number;
  lastRunStatus?: string;
}

// ── Page ──

export default function ReplayPage() {
  const [datasets, setDatasets] = useState<ReplayDataset[]>([]);
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [stats, setStats] = useState<ReplayStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<ReplayDataset | null>(null);
  const [selectedRun, setSelectedRun] = useState<ReplayRun | null>(null);
  const [selectedRunCases, setSelectedRunCases] = useState<ReplayCase[]>([]);
  const [activeTab, setActiveTab] = useState<'datasets' | 'runs'>('datasets');
  const [showCreateDatasetModal, setShowCreateDatasetModal] = useState(false);
  const [showStartRunModal, setShowStartRunModal] = useState(false);
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [datasetsData, runsData] = await Promise.all([
        api.get<{ items: ReplayDataset[] }>('/release/replay/datasets'),
        api.get<{ items: ReplayRun[] }>('/release/replay/runs'),
      ]);
      setDatasets(datasetsData?.items ?? []);
      setRuns(runsData?.items ?? []);
      // Calculate stats locally from datasets and runs
      const totalDatasets = datasetsData?.items?.length ?? 0;
      const totalRuns = runsData?.items?.length ?? 0;
      const passRate =
        totalRuns > 0
          ? Math.round(
              ((runsData?.items ?? []).filter((r) => r.status === 'COMPLETED').length / totalRuns) *
                100,
            )
          : 0;
      setStats({
        totalDatasets,
        totalRuns,
        passRate,
        lastRunStatus: (runsData?.items ?? [])[0]?.status ?? undefined,
      });
    } catch (err: any) {
      setError(err.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSelectDataset = async (dataset: ReplayDataset) => {
    setSelectedDataset(dataset);
    setSelectedRun(null);
    setSelectedRunCases([]);
  };

  const handleSelectRun = async (run: ReplayRun) => {
    setSelectedRun(run);
    setSelectedDataset(null);
    try {
      const cases = await api.get<{ items: ReplayCase[] }>(`/release/replay/runs/${run.id}`);
      setSelectedRunCases(cases?.items ?? []);
    } catch (err: any) {
      console.error('Failed to load run cases:', err);
    }
  };

  const handleCreateDataset = async (formData: any) => {
    try {
      await api.post('/release/replay/datasets', formData);
      setShowCreateDatasetModal(false);
      await fetchData();
    } catch (err: any) {
      console.error('Create dataset error:', err);
      alert(err?.message ?? 'Failed to create dataset');
    }
  };

  const handleStartRun = async (formData: any) => {
    try {
      await api.post('/release/replay/runs', formData);
      setShowStartRunModal(false);
      await fetchData();
    } catch (err: any) {
      console.error('Start run error:', err);
      alert(err?.message ?? 'Failed to start run');
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
        title="Replay Testing"
        description="Create datasets and run replay tests against candidate versions"
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => setShowCreateDatasetModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-accent text-dark rounded-lg text-xs font-semibold hover:bg-accent/90 transition"
            >
              <Plus size={14} /> Create Dataset
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
          <SC label="Total Datasets" value={stats.totalDatasets} c="white" />
          <SC label="Total Runs" value={stats.totalRuns} c="accent" />
          <SC label="Pass Rate" value={`${stats.passRate}%`} c="success" />
          <SC label="Last Run" value={stats.lastRunStatus ?? '-'} c="warning" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Two-column layout */}
      <div className="flex gap-4">
        {/* Left: Tables */}
        <div className="flex-1">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            {/* Tabs */}
            <div className="flex border-b border-gray-200 px-4">
              <button
                onClick={() => setActiveTab('datasets')}
                className={`py-3 px-4 text-xs font-semibold border-b-2 transition ${
                  activeTab === 'datasets'
                    ? 'border-b-accent text-accent'
                    : 'border-b-transparent text-gray-500 hover:text-gray-900'
                }`}
              >
                Datasets ({datasets.length})
              </button>
              <button
                onClick={() => setActiveTab('runs')}
                className={`py-3 px-4 text-xs font-semibold border-b-2 transition ${
                  activeTab === 'runs'
                    ? 'border-b-accent text-accent'
                    : 'border-b-transparent text-gray-500 hover:text-gray-900'
                }`}
              >
                Runs ({runs.length})
              </button>
            </div>

            <div className="overflow-x-auto">
              {activeTab === 'datasets' ? (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="text-left px-4 py-2">Name</th>
                      <th className="text-left px-4 py-2">Cases</th>
                      <th className="text-left px-4 py-2">Created</th>
                      <th className="text-left px-4 py-2">Baseline Version</th>
                      <th className="text-center px-4 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datasets.length === 0 && !loading && (
                      <tr>
                        <td colSpan={5} className="text-center text-gray-500 text-xs py-8">
                          No datasets yet
                        </td>
                      </tr>
                    )}
                    {datasets.map((ds) => (
                      <tr
                        key={ds.id}
                        onClick={() => handleSelectDataset(ds)}
                        className={`border-b border-gray-200 hover:bg-gray-50 cursor-pointer transition ${
                          selectedDataset?.id === ds.id ? 'bg-accent/5' : ''
                        }`}
                      >
                        <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{ds.name}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{ds.caseCount}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{fmt(ds.createdAt)}</td>
                        <td className="px-4 py-2.5 text-xs text-accent font-mono">
                          {ds.baselineVersionId.slice(0, 8)}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowStartRunModal(true);
                            }}
                            className="text-accent hover:text-accent/70 transition text-xs font-semibold"
                          >
                            Start Run
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="text-left px-4 py-2">Dataset</th>
                      <th className="text-left px-4 py-2">Candidate Version</th>
                      <th className="text-left px-4 py-2">Status</th>
                      <th className="text-center px-4 py-2">Pass/Fail/Error</th>
                      <th className="text-left px-4 py-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.length === 0 && !loading && (
                      <tr>
                        <td colSpan={5} className="text-center text-gray-500 text-xs py-8">
                          No runs yet
                        </td>
                      </tr>
                    )}
                    {runs.map((run) => (
                      <tr
                        key={run.id}
                        onClick={() => handleSelectRun(run)}
                        className={`border-b border-gray-200 hover:bg-gray-50 cursor-pointer transition ${
                          selectedRun?.id === run.id ? 'bg-accent/5' : ''
                        }`}
                      >
                        <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">
                          {datasets.find((d) => d.id === run.datasetId)?.name ||
                            run.datasetId.slice(0, 8)}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-accent font-mono">
                          {run.candidateVersionId.slice(0, 8)}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={run.status} />
                        </td>
                        <td className="px-4 py-2.5 text-center text-xs">
                          <span className="text-success">{run.passCount}</span> /
                          <span className="text-danger ml-1">{run.failCount}</span> /
                          <span className="text-warning ml-1">{run.errorCount}</span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{fmt(run.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* Right: Detail Panel */}
        <div className="w-80 flex-shrink-0 space-y-4">
          {selectedDataset ? (
            <>
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-accent flex items-center gap-1">
                    <RotateCcw size={12} /> Dataset Details
                  </span>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Name</p>
                    <p className="text-xs text-gray-900 font-medium mt-1">{selectedDataset.name}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Cases</p>
                    <p className="text-xs text-gray-900 font-medium mt-1">
                      {selectedDataset.caseCount}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Baseline Version
                    </p>
                    <p className="text-xs text-accent font-mono mt-1">
                      {selectedDataset.baselineVersionId}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Created</p>
                    <p className="text-xs text-gray-900 font-medium mt-1">
                      {fmt(selectedDataset.createdAt)}
                    </p>
                  </div>
                  {selectedDataset.description && (
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">Description</p>
                      <p className="text-xs text-gray-500 mt-1">{selectedDataset.description}</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : selectedRun ? (
            <>
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-accent">Run Details</span>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Status</p>
                    <div className="mt-1">
                      <StatusBadge status={selectedRun.status} />
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Results</p>
                    <div className="text-xs font-medium mt-1 space-y-1">
                      <p className="text-success">Pass: {selectedRun.passCount}</p>
                      <p className="text-danger">Fail: {selectedRun.failCount}</p>
                      <p className="text-warning">Error: {selectedRun.errorCount}</p>
                    </div>
                  </div>
                  {selectedRun.policyViolationCount != null && (
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                        Policy Violations
                      </p>
                      <p
                        className={`text-xs font-semibold mt-1 ${selectedRun.policyViolationCount > 0 ? 'text-danger' : 'text-success'}`}
                      >
                        {selectedRun.policyViolationCount > 0
                          ? `${selectedRun.policyViolationCount}건 위반`
                          : '위반 없음'}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">Created</p>
                    <p className="text-xs text-gray-900 font-medium mt-1">
                      {fmt(selectedRun.createdAt)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Case Results */}
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-900">
                    Case Results ({(selectedRunCases ?? []).length})
                  </span>
                </div>
                <div className="p-3 space-y-2 max-h-96 overflow-y-auto">
                  {(selectedRunCases ?? []).length === 0 ? (
                    <p className="text-xs text-gray-500">No case details</p>
                  ) : (
                    (selectedRunCases ?? []).map((c) => (
                      <div key={c.id} className="bg-gray-50 rounded border border-gray-200">
                        <button
                          onClick={() => setExpandedCaseId(expandedCaseId === c.id ? null : c.id)}
                          className="w-full px-2 py-2 flex items-center justify-between hover:bg-gray-50 transition"
                        >
                          <div className="flex items-center gap-2">
                            <p className="text-xs text-gray-900 font-mono text-left">{c.caseKey}</p>
                            <span
                              className={`text-[10px] font-semibold px-2 py-1 rounded ${
                                c.verdict === 'PASS'
                                  ? 'bg-success/20 text-success'
                                  : c.verdict === 'FAIL'
                                    ? 'bg-danger/20 text-danger'
                                    : c.verdict === 'REGRESSION'
                                      ? 'bg-warning/20 text-warning'
                                      : 'bg-muted/20 text-gray-500'
                              }`}
                            >
                              {c.verdict}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {c.policyViolations != null && c.policyViolations > 0 && (
                              <span
                                className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-danger/20 text-danger"
                                title="정책 위반"
                              >
                                {c.policyViolations} 정책위반
                              </span>
                            )}
                            {c.deltaMs !== undefined && (
                              <span className="text-[10px] text-gray-500">+{c.deltaMs}ms</span>
                            )}
                            {c.baselineOutput &&
                              c.candidateOutput &&
                              (expandedCaseId === c.id ? (
                                <ChevronUp size={14} className="text-gray-500" />
                              ) : (
                                <ChevronDown size={14} className="text-gray-500" />
                              ))}
                          </div>
                        </button>

                        {expandedCaseId === c.id && c.baselineOutput && c.candidateOutput && (
                          <div className="border-t border-gray-200 p-2">
                            <div className="grid grid-cols-2 gap-2 text-[9px]">
                              <div>
                                <p className="text-gray-500 font-semibold mb-1">Baseline</p>
                                <div className="bg-[#1E1E2E] rounded p-2 max-h-24 overflow-y-auto font-mono text-[8px]">
                                  <code className="text-cyan-400 whitespace-pre-wrap break-words">
                                    {c.baselineOutput}
                                  </code>
                                </div>
                              </div>
                              <div>
                                <p className="text-gray-500 font-semibold mb-1">Candidate</p>
                                <div className="bg-[#1E1E2E] rounded p-2 max-h-24 overflow-y-auto font-mono text-[8px]">
                                  <code className="text-cyan-400 whitespace-pre-wrap break-words">
                                    {c.candidateOutput}
                                  </code>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 flex flex-col items-center text-center">
              <RotateCcw size={32} className="text-gray-500/30 mb-3" />
              <p className="text-xs text-gray-500">Select a dataset or run to see details</p>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showCreateDatasetModal && (
        <CreateDatasetModal
          onClose={() => setShowCreateDatasetModal(false)}
          onSubmit={handleCreateDataset}
        />
      )}
      {showStartRunModal && selectedDataset && (
        <StartRunModal
          dataset={selectedDataset}
          onClose={() => setShowStartRunModal(false)}
          onSubmit={handleStartRun}
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

function CreateDatasetModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baselineVersionId, setBaselineVersionId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !baselineVersionId) {
      alert('Name and baseline version are required');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ name, description, baselineVersionId });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white border border-gray-200 rounded-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Create Dataset</h2>
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
              placeholder="Dataset name"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-900 block mb-1">
              Baseline Version ID
            </label>
            <input
              type="text"
              value={baselineVersionId}
              onChange={(e) => setBaselineVersionId(e.target.value)}
              className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              placeholder="e.g. v1.0.0"
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
              placeholder="Dataset description"
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

function StartRunModal({
  dataset,
  onClose,
  onSubmit,
}: {
  dataset: ReplayDataset;
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [candidateVersionId, setCandidateVersionId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!candidateVersionId) {
      alert('Candidate version is required');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        datasetId: dataset.id,
        candidateVersionId,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white border border-gray-200 rounded-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Start Run</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900">
            <X size={18} />
          </button>
        </div>
        <div className="mb-4">
          <p className="text-xs text-gray-500 mb-2">
            Dataset: <span className="text-gray-900 font-semibold">{dataset.name}</span>
          </p>
          <p className="text-xs text-gray-500">
            Cases: <span className="text-gray-900 font-semibold">{dataset.caseCount}</span>
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
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
              {submitting ? 'Starting...' : 'Start Run'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
