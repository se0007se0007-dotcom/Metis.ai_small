'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { api } from '@/lib/api-client';
import {
  GitBranch,
  Plus,
  AlertCircle,
  RefreshCw,
  X,
  Play,
  CheckCircle,
  XCircle,
} from 'lucide-react';

// ── Types ──

interface CanaryDeployment {
  id: string;
  name: string;
  packId: string;
  stableVersionId: string;
  candidateVersionId: string;
  status: string;
  currentTrafficPct: number;
  maxTrafficPct: number;
  incrementStepPct: number;
  windowDurationMs: number;
  currentWindow: number;
  totalWindows: number;
  gatesPassed: number;
  startedAt?: string;
  promotedAt?: string;
  rolledBackAt?: string;
}

interface GateEvaluation {
  id: string;
  deploymentId: string;
  windowNumber: number;
  result: string;
  metrics: Record<string, any>;
  evaluatedAt: string;
}

interface MetricComparison {
  metric: string;
  stableValue: number | string;
  candidateValue: number | string;
  delta: number | string;
  verdict: string;
  policyViolationsDelta?: number;
}

interface GateRule {
  id: string;
  name: string;
  expression: string;
  enabled: boolean;
}

interface PolicyCompliance {
  stableViolations: number;
  candidateViolations: number;
  delta: number;
}

interface CanaryStats {
  activeCanaries: number;
  totalDeployments: number;
  promotionRate: number;
  rollbackCount: number;
}

// ── Page ──

export default function CanaryPage() {
  const [deployments, setDeployments] = useState<CanaryDeployment[]>([]);
  const [stats, setStats] = useState<CanaryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState<CanaryDeployment | null>(null);
  const [selectedGates, setSelectedGates] = useState<GateEvaluation[]>([]);
  const [selectedMetrics, setSelectedMetrics] = useState<MetricComparison[]>([]);
  const [selectedGateRules, setSelectedGateRules] = useState<GateRule[]>([]);
  const [selectedPolicyCompliance, setSelectedPolicyCompliance] = useState<PolicyCompliance | null>(
    null,
  );
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [deploymentsData, statsData] = await Promise.all([
        api.get<{ items: CanaryDeployment[] }>('/release/canary'),
        api.get<CanaryStats>('/release/canary/stats'),
      ]);
      setDeployments(deploymentsData?.items ?? []);
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

  const handleSelectDeployment = async (deployment: CanaryDeployment) => {
    setSelectedDeployment(deployment);
    try {
      const detailsData = await api.get<{
        gates: GateEvaluation[];
        metrics: MetricComparison[];
        gateRules?: GateRule[];
        policyCompliance?: PolicyCompliance;
      }>(`/release/canary/${deployment.id}`);
      setSelectedGates(detailsData?.gates ?? []);
      setSelectedMetrics(detailsData?.metrics ?? []);
      setSelectedGateRules(detailsData?.gateRules ?? []);
      setSelectedPolicyCompliance(detailsData?.policyCompliance ?? null);
    } catch (err: any) {
      console.error('Failed to load deployment details:', err);
    }
  };

  const handleStart = async (deploymentId: string) => {
    if (!confirm('Start canary deployment?')) return;
    try {
      await api.post(`/release/canary/${deploymentId}/start`, {});
      await fetchData();
    } catch (err: any) {
      console.error('Start deployment error:', err);
      alert(err?.message ?? 'Failed to start deployment');
    }
  };

  const handlePromote = async (deploymentId: string) => {
    if (!confirm('Promote candidate to stable?')) return;
    try {
      await api.post(`/release/canary/${deploymentId}/promote`, {});
      await fetchData();
    } catch (err: any) {
      console.error('Promote error:', err);
      alert(err?.message ?? 'Failed to promote');
    }
  };

  const handleRollback = async (deploymentId: string) => {
    if (!confirm('Rollback to stable version?')) return;
    try {
      await api.post(`/release/canary/${deploymentId}/rollback`, {});
      await fetchData();
    } catch (err: any) {
      console.error('Rollback error:', err);
      alert(err?.message ?? 'Failed to rollback');
    }
  };

  const handleCreateCanary = async (formData: any) => {
    try {
      await api.post('/release/canary', formData);
      setShowCreateModal(false);
      await fetchData();
    } catch (err: any) {
      console.error('Create canary error:', err);
      alert(err?.message ?? 'Failed to create canary');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PENDING':
        return 'text-gray-500';
      case 'ACTIVE':
        return 'text-accent';
      case 'PAUSED':
        return 'text-warning';
      case 'PROMOTED':
        return 'text-success';
      case 'ROLLED_BACK':
        return 'text-danger';
      default:
        return 'text-gray-900';
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
        title="Canary Deployment"
        description="Control and monitor canary rollouts with progressive traffic shifting"
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-accent text-dark rounded-lg text-xs font-semibold hover:bg-accent/90 transition"
            >
              <Plus size={14} /> New Canary
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
          <SC label="Active Canaries" value={stats.activeCanaries} c="accent" />
          <SC label="Total Deployments" value={stats.totalDeployments} c="white" />
          <SC label="Promotion Rate" value={`${stats.promotionRate}%`} c="success" />
          <SC label="Rollback Count" value={stats.rollbackCount} c="danger" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Two-column layout */}
      <div className="flex gap-4">
        {/* Left: Deployments List */}
        <div className="flex-1">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <GitBranch size={14} className="text-accent" />
                <span className="text-xs font-semibold text-gray-900">
                  Canary Deployments ({deployments.length})
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                    <th className="text-left px-4 py-2">Name</th>
                    <th className="text-left px-4 py-2">Pack</th>
                    <th className="text-center px-4 py-2">Traffic</th>
                    <th className="text-center px-4 py-2">Window</th>
                    <th className="text-center px-4 py-2">Gates</th>
                    <th className="text-center px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {deployments.length === 0 && !loading && (
                    <tr>
                      <td colSpan={6} className="text-center text-gray-500 text-xs py-8">
                        No deployments yet
                      </td>
                    </tr>
                  )}
                  {deployments.map((dep) => (
                    <tr
                      key={dep.id}
                      onClick={() => handleSelectDeployment(dep)}
                      className={`border-b border-gray-200 hover:bg-gray-50 cursor-pointer transition ${
                        selectedDeployment?.id === dep.id ? 'bg-accent/5' : ''
                      }`}
                    >
                      <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">{dep.name}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">{dep.packId.slice(0, 8)}</td>
                      <td className="px-4 py-2.5 text-xs text-center">
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent transition-all"
                              style={{ width: `${Math.min(dep.currentTrafficPct, 100)}%` }}
                            />
                          </div>
                          <span className="w-8 text-right">{dep.currentTrafficPct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-center text-gray-500">
                        {dep.currentWindow}/{dep.totalWindows}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-center">
                        <span className="text-success font-semibold">{dep.gatesPassed}</span>
                        <span className="text-gray-500">/{dep.currentWindow}</span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <StatusBadge status={dep.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: Detail Panel */}
        <div className="w-96 flex-shrink-0 space-y-4">
          {selectedDeployment ? (
            <>
              {/* Traffic Progress */}
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-accent">Traffic Progress</span>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-500">Stable → Candidate</span>
                      <span className="text-sm font-bold text-accent">
                        {selectedDeployment.currentTrafficPct}%
                      </span>
                    </div>
                    <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-success via-accent to-warning transition-all"
                        style={{ width: `${Math.min(selectedDeployment.currentTrafficPct, 100)}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-gray-500 mt-1">
                      <span>0%</span>
                      <span>{selectedDeployment.maxTrafficPct}%</span>
                      <span>100%</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="p-2 bg-gray-50 rounded">
                      <p className="text-gray-500">Current Window</p>
                      <p className="text-gray-900 font-semibold">
                        {selectedDeployment.currentWindow}/{selectedDeployment.totalWindows}
                      </p>
                    </div>
                    <div className="p-2 bg-gray-50 rounded">
                      <p className="text-gray-500">Step Size</p>
                      <p className="text-gray-900 font-semibold">
                        {selectedDeployment.incrementStepPct}%
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Gate Evaluation */}
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-accent">Gate Evaluations</span>
                </div>
                <div className="p-3 space-y-2 max-h-48 overflow-y-auto">
                  {selectedGates.length === 0 ? (
                    <p className="text-xs text-gray-500">No evaluations yet</p>
                  ) : (
                    selectedGates.slice(0, 8).map((gate) => (
                      <div key={gate.id} className="p-2 bg-gray-50 rounded border border-gray-200">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-500">Window {gate.windowNumber}</span>
                          <span
                            className={`text-[10px] font-semibold px-2 py-1 rounded ${
                              gate.result === 'PASS'
                                ? 'bg-success/20 text-success'
                                : gate.result === 'FAIL'
                                  ? 'bg-danger/20 text-danger'
                                  : 'bg-warning/20 text-warning'
                            }`}
                          >
                            {gate.result}
                          </span>
                        </div>
                        <p className="text-[9px] text-gray-500 mt-1">{fmt(gate.evaluatedAt)}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Policy Compliance */}
              {selectedPolicyCompliance && (
                <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                  <div className="px-4 py-3 border-b border-gray-200">
                    <span className="text-xs font-semibold text-accent">Policy Compliance</span>
                  </div>
                  <div className="p-4 space-y-3">
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                        Stable Violations
                      </p>
                      <p className="text-lg font-bold text-warning mt-1">
                        {selectedPolicyCompliance.stableViolations}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                        Candidate Violations
                      </p>
                      <p className="text-lg font-bold text-accent mt-1">
                        {selectedPolicyCompliance.candidateViolations}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider">Delta</p>
                      <p
                        className={`text-lg font-bold mt-1 ${
                          selectedPolicyCompliance.delta <= 0 ? 'text-success' : 'text-danger'
                        }`}
                      >
                        {selectedPolicyCompliance.delta > 0 ? '+' : ''}
                        {selectedPolicyCompliance.delta}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Gate Rules */}
              {selectedGateRules.length > 0 && (
                <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                  <div className="px-4 py-3 border-b border-gray-200">
                    <span className="text-xs font-semibold text-accent">
                      Gate Rules ({selectedGateRules.length})
                    </span>
                  </div>
                  <div className="p-3 space-y-2 max-h-32 overflow-y-auto">
                    {selectedGateRules.map((rule) => (
                      <div key={rule.id} className="p-2 bg-gray-50 rounded border border-gray-200">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] text-gray-900 font-semibold">{rule.name}</p>
                            <p className="text-[8px] text-gray-500 font-mono truncate">
                              {rule.expression}
                            </p>
                          </div>
                          <span
                            className={`text-[9px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${rule.enabled ? 'bg-success/20 text-success' : 'bg-muted/20 text-gray-500'}`}
                          >
                            {rule.enabled ? 'On' : 'Off'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Metrics */}
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <span className="text-xs font-semibold text-accent">Metric Comparison</span>
                </div>
                <div className="p-3 space-y-2 max-h-48 overflow-y-auto">
                  {selectedMetrics.length === 0 ? (
                    <p className="text-xs text-gray-500">No metrics available</p>
                  ) : (
                    selectedMetrics.slice(0, 6).map((m, i) => (
                      <div key={i} className="p-2 bg-gray-50 rounded border border-gray-200">
                        <p className="text-[10px] text-gray-500 font-semibold">{m.metric}</p>
                        <div className="flex items-center justify-between text-[10px] mt-1">
                          <span className="text-gray-900">
                            Stable: <span className="text-success">{m.stableValue}</span>
                          </span>
                          <span className="text-gray-900">
                            Candidate: <span className="text-accent">{m.candidateValue}</span>
                          </span>
                        </div>
                        {m.policyViolationsDelta !== undefined && (
                          <p
                            className={`text-[9px] mt-1 ${m.policyViolationsDelta <= 0 ? 'text-success' : 'text-danger'}`}
                          >
                            Policy Delta: {m.policyViolationsDelta > 0 ? '+' : ''}
                            {m.policyViolationsDelta}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="space-y-2">
                {selectedDeployment.status === 'PENDING' && (
                  <button
                    onClick={() => handleStart(selectedDeployment.id)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-accent text-dark rounded-lg text-xs font-semibold hover:bg-accent/90 transition"
                  >
                    <Play size={14} /> Start Deployment
                  </button>
                )}
                {selectedDeployment.status === 'ACTIVE' && (
                  <>
                    <button
                      onClick={() => handlePromote(selectedDeployment.id)}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-success text-dark rounded-lg text-xs font-semibold hover:bg-success/90 transition"
                    >
                      <CheckCircle size={14} /> Promote
                    </button>
                    <button
                      onClick={() => handleRollback(selectedDeployment.id)}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-danger text-gray-900 rounded-lg text-xs font-semibold hover:bg-danger/90 transition"
                    >
                      <XCircle size={14} /> Rollback
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 flex flex-col items-center text-center">
              <GitBranch size={32} className="text-gray-500/30 mb-3" />
              <p className="text-xs text-gray-500">Select a deployment to see details</p>
            </div>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateCanaryModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateCanary}
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

function CreateCanaryModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [name, setName] = useState('');
  const [packId, setPackId] = useState('');
  const [stableVersionId, setStableVersionId] = useState('');
  const [candidateVersionId, setCandidateVersionId] = useState('');
  const [initialTrafficPct, setInitialTrafficPct] = useState('5');
  const [maxTrafficPct, setMaxTrafficPct] = useState('100');
  const [incrementStepPct, setIncrementStepPct] = useState('10');
  const [windowDurationMs, setWindowDurationMs] = useState('300000');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !packId || !stableVersionId || !candidateVersionId) {
      alert('All fields are required');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name,
        packId,
        stableVersionId,
        candidateVersionId,
        initialTrafficPct: parseInt(initialTrafficPct),
        maxTrafficPct: parseInt(maxTrafficPct),
        incrementStepPct: parseInt(incrementStepPct),
        windowDurationMs: parseInt(windowDurationMs),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white border border-gray-200 rounded-lg w-full max-w-md p-6 my-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">New Canary Deployment</h2>
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
              placeholder="Canary name"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-900 block mb-1">Pack ID</label>
            <input
              type="text"
              value={packId}
              onChange={(e) => setPackId(e.target.value)}
              className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              placeholder="Pack ID"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-900 block mb-1">Stable Version</label>
              <input
                type="text"
                value={stableVersionId}
                onChange={(e) => setStableVersionId(e.target.value)}
                className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
                placeholder="v1.0.0"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-900 block mb-1">
                Candidate Version
              </label>
              <input
                type="text"
                value={candidateVersionId}
                onChange={(e) => setCandidateVersionId(e.target.value)}
                className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
                placeholder="v2.0.0"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-900 block mb-1">
                Initial Traffic %
              </label>
              <input
                type="number"
                value={initialTrafficPct}
                onChange={(e) => setInitialTrafficPct(e.target.value)}
                min="0"
                max="100"
                className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-900 block mb-1">Max Traffic %</label>
              <input
                type="number"
                value={maxTrafficPct}
                onChange={(e) => setMaxTrafficPct(e.target.value)}
                min="0"
                max="100"
                className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-900 block mb-1">Step Size %</label>
              <input
                type="number"
                value={incrementStepPct}
                onChange={(e) => setIncrementStepPct(e.target.value)}
                min="1"
                max="100"
                className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-900 block mb-1">
                Window Duration (ms)
              </label>
              <input
                type="number"
                value={windowDurationMs}
                onChange={(e) => setWindowDurationMs(e.target.value)}
                min="60000"
                className="w-full px-3 py-2 bg-white/[0.05] border border-gray-200 rounded text-xs text-gray-900 placeholder-gray-400"
              />
            </div>
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
