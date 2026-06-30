'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { SubTabs } from '@/components/shared/SubTabs';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import {
  Plus,
  RefreshCw,
  AlertCircle,
  Code2,
  Shield,
  X,
  AlertTriangle,
  Clock,
  BarChart3,
} from 'lucide-react';

// ── Types ──

interface Policy {
  id: string;
  name: string;
  type: string;
  scopeLevel: string; // 'PLATFORM'(공통) | 'TENANT'
  editable: boolean;
  isActive: boolean;
  scope: Record<string, unknown>;
  rulesJson: Record<string, unknown>;
  rulesCount: number;
  lastEvaluated: string | null;
  violationCount: number;
  violations24h: number;
  evalCount: number;
  createdAt: string;
}

// 규칙 빌더 한 줄 — 직접 JSON 대신 드롭다운/입력으로 규칙을 구성
interface RuleRow {
  field: string;
  op: string;
  value: string;
  effect: 'deny' | 'warn';
  custom?: boolean; // 목록에 없는 값 직접 입력 모드
}

interface FieldOption {
  value: string;
  label: string;
}
type FieldOptionsMap = Record<string, FieldOption[]>;

// 사용자 친화 라벨 ↔ 내부 필드/연산자 매핑
const FIELD_OPTS: { v: string; label: string; ph: string }[] = [
  { v: 'action', label: '작업 종류', ph: '예: EXECUTE, delete, deploy' },
  { v: 'workflowKey', label: '워크플로우(Agent) 키', ph: '예: ap-invoice, pentest-basic' },
  { v: 'capabilityKey', label: '역량(Capability) 키', ph: '예: db.write, web.search' },
  { v: 'targetType', label: '대상 유형', ph: '예: ExecutionSession' },
];
const OP_OPTS: { v: string; label: string }[] = [
  { v: 'in', label: '다음 중 하나(목록)' },
  { v: 'eq', label: '같음' },
  { v: 'contains', label: '포함' },
];
const fieldLabel = (v: string) => FIELD_OPTS.find((f) => f.v === v)?.label ?? v;
const opLabel = (v: string) => OP_OPTS.find((o) => o.v === v)?.label ?? v;

// 빌더 규칙 → 백엔드 ruleYaml.rules 포맷으로 변환
function buildRules(rows: RuleRow[]) {
  return rows
    .filter((r) => r.field && r.value.trim())
    .map((r) => {
      const value =
        r.op === 'in'
          ? r.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : r.value.trim();
      const shown = Array.isArray(value) ? value.join(', ') : value;
      return {
        conditions: [{ field: r.field, operator: r.op, value }],
        effect: r.effect,
        message: `${fieldLabel(r.field)}이(가) "${shown}"일 때 ${r.effect === 'deny' ? '차단' : '경고'}`,
      };
    });
}

function ScopeBadge({ level }: { level: string }) {
  const platform = level === 'PLATFORM';
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
        platform
          ? 'bg-indigo-100 text-indigo-700 border-indigo-200'
          : 'bg-gray-100 text-gray-600 border-gray-200'
      }`}
      title={platform ? '공통 정책 — 모든 테넌트에 적용' : '테넌트 정책 — 이 테넌트에만 적용'}
    >
      {platform ? '공통' : '테넌트'}
    </span>
  );
}

// ── 정책 통계/이력 타입 ──
interface StatBucket {
  total: number;
  pass: number;
  warn: number;
  fail: number;
}
interface PerPolicyStat extends StatBucket {
  policyId: string;
  policyName: string;
  scopeLevel: string;
}
interface DayStat extends StatBucket {
  date: string;
}
interface PolicyStats {
  windowDays: number;
  overall: StatBucket;
  perPolicy: PerPolicyStat[];
  timeseries: DayStat[];
}
interface EvalRow {
  id: string;
  policyId: string;
  policyName: string;
  scopeLevel: string;
  result: string;
  reason: string | null;
  executionSessionId: string | null;
  createdAt: string;
}

// 일별 호출/정상/경고/차단 스택 막대 (차트 라이브러리 없이 CSS로)
function TrendChart({ data }: { data: DayStat[] }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  if (data.every((d) => d.total === 0)) {
    return (
      <div className="h-32 flex items-center justify-center text-[11px] text-gray-400">
        기간 내 정책 호출이 없습니다.
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-end gap-[2px] h-32">
        {data.map((d) => (
          <div
            key={d.date}
            className="flex-1 h-full flex flex-col justify-end"
            title={`${d.date} · 호출 ${d.total} (정상 ${d.pass}/경고 ${d.warn}/차단 ${d.fail})`}
          >
            <div
              className="w-full flex flex-col rounded-t overflow-hidden min-h-[2px]"
              style={{ height: `${(d.total / max) * 100}%` }}
            >
              <div className="bg-red-400" style={{ flexGrow: d.fail }} />
              <div className="bg-amber-400" style={{ flexGrow: d.warn }} />
              <div className="bg-emerald-400" style={{ flexGrow: d.pass }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-gray-400 mt-1">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

interface ViolationRow {
  id: string;
  result: string; // 'FAIL' | 'WARN' | 'PASS'
  reason: string | null;
  executionSessionId: string | null;
  createdAt: string;
  policyId?: string;
  policyName?: string;
}

// 정책 평가 결과 배지 — FAIL(차단) / WARN(경고) / PASS(통과)
function ResultBadge({ result }: { result: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    FAIL: { label: '차단 (FAIL)', cls: 'bg-red-100 text-red-700 border-red-200' },
    WARN: { label: '경고 (WARN)', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    PASS: { label: '통과 (PASS)', cls: 'bg-green-100 text-green-700 border-green-200' },
  };
  const m = map[result] ?? { label: result, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

function relTime(iso: string) {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

// ── Page Component ──

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const policiesPage = usePagination(policies, 10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [userRole, setUserRole] = useState<string>('');
  const [createFormData, setCreateFormData] = useState({
    name: '',
    type: 'COMPLIANCE',
    isActive: true,
    scopeLevel: 'TENANT',
  });
  const [builderRows, setBuilderRows] = useState<RuleRow[]>([
    { field: 'action', op: 'in', value: '', effect: 'deny' },
  ]);
  const [fieldOptions, setFieldOptions] = useState<FieldOptionsMap>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [recentViolations, setRecentViolations] = useState<ViolationRow[]>([]);
  const [policyHistory, setPolicyHistory] = useState<ViolationRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // 탭 / 통계 / 이력
  const [tab, setTab] = useState<'overview' | 'history'>('overview');
  const [statsDays, setStatsDays] = useState(30);
  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [histPolicyId, setHistPolicyId] = useState('');
  const [histResult, setHistResult] = useState('');
  const [histDays, setHistDays] = useState(30);
  const [histPage, setHistPage] = useState(1);
  const [histData, setHistData] = useState<{
    items: EvalRow[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const [histLoading, setHistLoading] = useState(false);

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
    // 전체 최근 위반(7일) 피드 — 정책이 실제로 무엇을 막았는지 한눈에
    try {
      const v = await api.get<{ items: ViolationRow[] }>(
        '/governance/policy-violations/recent?days=7&limit=20',
      );
      setRecentViolations(v?.items ?? []);
    } catch {
      setRecentViolations([]);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  // 공통 정책 생성 권한 판단을 위한 역할 로드
  useEffect(() => {
    (async () => {
      try {
        const me = await api.get<{ role: string }>('/auth/me');
        setUserRole(me?.role ?? '');
      } catch {
        setUserRole('');
      }
    })();
  }, []);

  // 규칙 빌더 값 선택용 — 실제 키 목록(워크플로우/역량) 로드
  useEffect(() => {
    (async () => {
      try {
        const opts = await api.get<FieldOptionsMap>('/governance/policy-field-options');
        setFieldOptions(opts ?? {});
      } catch {
        setFieldOptions({});
      }
    })();
  }, []);

  // 정책 호출/위반 통계 (기간별)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.get<PolicyStats>(`/governance/policy-stats?days=${statsDays}`);
        if (alive) setStats(s ?? null);
      } catch {
        if (alive) setStats(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [statsDays]);

  // 실행 이력 (탭/필터/페이지)
  useEffect(() => {
    if (tab !== 'history') return;
    let alive = true;
    setHistLoading(true);
    (async () => {
      try {
        const q = new URLSearchParams();
        if (histPolicyId) q.set('policyId', histPolicyId);
        if (histResult) q.set('result', histResult);
        q.set('days', String(histDays));
        q.set('page', String(histPage));
        q.set('pageSize', '20');
        const d = await api.get<{
          items: EvalRow[];
          total: number;
          page: number;
          pageSize: number;
        }>(`/governance/policy-evaluations?${q.toString()}`);
        if (alive) setHistData(d ?? null);
      } catch {
        if (alive) setHistData(null);
      } finally {
        if (alive) setHistLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, histPolicyId, histResult, histDays, histPage]);

  // 선택된 정책의 최근 평가/위반 이력 로드
  useEffect(() => {
    if (!selectedPolicy) {
      setPolicyHistory([]);
      return;
    }
    let alive = true;
    setHistoryLoading(true);
    (async () => {
      try {
        const data = await api.get<{ items: ViolationRow[] }>(
          `/governance/policies/${selectedPolicy.id}/violations?limit=20`,
        );
        if (alive) setPolicyHistory(data?.items ?? []);
      } catch {
        if (alive) setPolicyHistory([]);
      } finally {
        if (alive) setHistoryLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedPolicy]);

  const handleCreatePolicy = async () => {
    if (!createFormData.name.trim()) {
      alert('정책 이름을 입력하세요');
      return;
    }
    const rules = buildRules(builderRows);
    if (rules.length === 0) {
      alert('규칙을 최소 1개 이상 입력하세요 (대상과 값을 채워주세요).');
      return;
    }
    try {
      await api.post('/governance/policies', {
        name: createFormData.name,
        type: createFormData.type,
        isActive: createFormData.isActive,
        scopeLevel: createFormData.scopeLevel,
        scope: {},
        rules,
      });
      setToastMessage('정책이 생성되었습니다.');
      setTimeout(() => setToastMessage(null), 3000);
      setCreateFormData({ name: '', type: 'COMPLIANCE', isActive: true, scopeLevel: 'TENANT' });
      setBuilderRows([{ field: 'action', op: 'in', value: '', effect: 'deny' }]);
      setShowCreateModal(false);
      await fetchPolicies();
    } catch (err: any) {
      alert(err.message ?? '정책 생성 실패');
    }
  };

  // 규칙 빌더 행 조작 헬퍼
  const addBuilderRow = () =>
    setBuilderRows((rows) => [...rows, { field: 'action', op: 'in', value: '', effect: 'deny' }]);
  const updateBuilderRow = (i: number, patch: Partial<RuleRow>) =>
    setBuilderRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeBuilderRow = (i: number) =>
    setBuilderRows((rows) => (rows.length <= 1 ? rows : rows.filter((_, idx) => idx !== i)));

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

  const activeCount = policies.filter((p) => p.isActive).length;

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

      {/* 탭 */}
      <div className="flex gap-1 border-b border-gray-200 mb-5">
        {(
          [
            ['overview', '정책 현황'],
            ['history', '실행 이력'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={
              tab === k
                ? 'px-4 py-2 text-sm font-semibold text-blue-700 border-b-2 border-blue-600 -mb-px'
                : 'px-4 py-2 text-sm text-gray-500 hover:text-gray-800 border-b-2 border-transparent -mb-px'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <p className="text-[11px] text-gray-500 mb-4 flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-amber-500" />
            정책은 실행 생성 시 평가되어 <b className="text-red-600 font-semibold">FAIL이면 실행 차단</b>,{' '}
            <b className="text-amber-600 font-semibold">WARN이면 경고</b>로 기록됩니다. 건별 상세 이력은 「실행
            이력」 탭에서 검색하세요.
          </p>

          {/* 기간별 호출 · 위반 추이 */}
          <div className="bg-gray-50 rounded-lg border border-gray-200 mb-6">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <BarChart3 size={14} className="text-blue-600" />
                <span className="text-xs font-semibold text-gray-900">정책 호출 · 위반 추이</span>
              </div>
              <div className="flex gap-1">
                {[7, 30, 90].map((d) => (
                  <button
                    key={d}
                    onClick={() => setStatsDays(d)}
                    className={`px-2 py-1 text-[11px] rounded border ${
                      statsDays === d
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {d}일
                  </button>
                ))}
              </div>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-4 gap-3 mb-4">
                <StatCard label="총 호출" value={stats?.overall.total ?? 0} color="white" />
                <StatCard label="정상(PASS)" value={stats?.overall.pass ?? 0} color="success" />
                <StatCard
                  label="위반(경고+차단)"
                  value={stats ? stats.overall.warn + stats.overall.fail : 0}
                  color="warning"
                />
                <StatCard label="차단(FAIL)" value={stats?.overall.fail ?? 0} color="danger" />
              </div>
              <TrendChart data={stats?.timeseries ?? []} />
              <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" />정상
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />경고
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-red-400 inline-block" />차단
                </span>
              </div>
            </div>
          </div>

          {/* 정책별 집계 */}
          <div className="bg-gray-50 rounded-lg border border-gray-200 mb-6">
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-900">정책별 집계 ({statsDays}일)</span>
              <span className="text-[10px] text-gray-500">{stats?.perPolicy.length ?? 0}개 정책</span>
            </div>
            {(stats?.perPolicy.length ?? 0) === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-gray-500">
                기간 내 호출된 정책이 없습니다.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="text-left px-4 py-2">정책명</th>
                      <th className="text-left px-4 py-2">범위</th>
                      <th className="text-right px-4 py-2">호출</th>
                      <th className="text-right px-4 py-2">정상</th>
                      <th className="text-right px-4 py-2">위반</th>
                      <th className="text-right px-4 py-2">차단</th>
                      <th className="text-left px-4 py-2 w-32">차단률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats!.perPolicy.map((pp) => {
                      const viol = pp.warn + pp.fail;
                      const blockPct = pp.total ? Math.round((pp.fail / pp.total) * 100) : 0;
                      return (
                        <tr key={pp.policyId} className="border-b border-gray-100">
                          <td className="px-4 py-2 text-xs text-gray-900 font-medium">{pp.policyName}</td>
                          <td className="px-4 py-2">
                            <ScopeBadge level={pp.scopeLevel} />
                          </td>
                          <td className="px-4 py-2 text-xs text-right tabular-nums">{pp.total}</td>
                          <td className="px-4 py-2 text-xs text-right tabular-nums text-emerald-600">
                            {pp.pass}
                          </td>
                          <td className="px-4 py-2 text-xs text-right tabular-nums text-amber-600">
                            {viol}
                          </td>
                          <td className="px-4 py-2 text-xs text-right tabular-nums text-red-600">
                            {pp.fail}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-gray-100 rounded">
                                <div
                                  className="h-1.5 bg-red-400 rounded"
                                  style={{ width: `${blockPct}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-gray-500 w-8 text-right">{blockPct}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

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

      {/* Two-Column Layout — 정책 관리 (현황 탭) */}
      {tab === 'overview' && (
      <div className="flex gap-4">
        {/* Left: Policies Table */}
        <div className="flex-1">
          <div className="bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Shield size={14} className="text-blue-600" />
                <span className="text-xs font-semibold text-gray-900">정책 목록 (관리)</span>
              </div>
              <span className="text-[10px] text-gray-500">
                활성 {activeCount} / 전체 {policies.length}
              </span>
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
                      <th className="text-right px-3 py-2 w-10">#</th>
                      <th className="text-left px-4 py-2">정책명</th>
                      <th className="text-left px-4 py-2">적용 범위</th>
                      <th className="text-left px-4 py-2">유형</th>
                      <th className="text-left px-4 py-2">상태</th>
                      <th className="text-left px-4 py-2">규칙 수</th>
                      <th className="text-left px-4 py-2">마지막 평가</th>
                      <th className="text-left px-4 py-2">위반</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policiesPage.pageItems.map((policy, idx) => (
                      <tr
                        key={policy.id}
                        onClick={() => setSelectedPolicy(policy)}
                        className={`border-b border-gray-200 hover:bg-gray-50 cursor-pointer transition ${
                          selectedPolicy?.id === policy.id ? 'bg-blue-50' : ''
                        }`}
                      >
                        <td className="px-3 py-2.5 text-[11px] text-gray-400 text-right tabular-nums">
                          {policiesPage.from + idx}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-900 font-medium">
                          <span className="flex items-center gap-1.5">
                            {policy.name}
                            {!policy.editable && (
                              <span className="text-[9px] text-gray-400">(읽기전용)</span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <ScopeBadge level={policy.scopeLevel} />
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{policy.type}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={policy.isActive ? 'ACTIVE' : 'INACTIVE'} />
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
                    <p className="text-gray-500 mb-1">적용 범위</p>
                    <ScopeBadge level={selectedPolicy.scopeLevel} />
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

              {/* 평가 이력 요약 — 상세 건별은 「실행 이력」 탭 */}
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-3">
                <p className="text-[11px] text-gray-600">
                  누적 위반 <b className="text-red-600">{selectedPolicy.violationCount ?? 0}</b> · 평가{' '}
                  {selectedPolicy.evalCount ?? 0}건
                </p>
                <button
                  onClick={() => {
                    setHistPolicyId(selectedPolicy.id);
                    setHistResult('');
                    setHistPage(1);
                    setTab('history');
                  }}
                  className="mt-2 w-full px-3 py-1.5 border border-gray-200 rounded text-[11px] font-semibold text-blue-600 hover:bg-blue-50 transition"
                >
                  이 정책의 실행 이력 보기 →
                </button>
              </div>

              {selectedPolicy.editable ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleTogglePolicy(selectedPolicy.id, selectedPolicy.isActive)}
                    className="flex-1 px-3 py-2 bg-blue-100 text-blue-600 rounded text-xs font-semibold hover:bg-blue-600/30 transition"
                  >
                    {selectedPolicy.isActive ? '비활성화' : '활성화'}
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-gray-400 text-center">
                  공통 정책은 플랫폼 관리자만 변경할 수 있습니다 (읽기 전용).
                </p>
              )}
            </>
          ) : (
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-6 flex flex-col items-center text-center">
              <Shield size={32} className="text-gray-500/30 mb-3" />
              <p className="text-xs text-gray-500">왼쪽 목록에서 정책을 선택하세요</p>
            </div>
          )}
        </div>
      </div>
      )}

      {/* 실행 이력 탭 */}
      {tab === 'history' && (
        <PolicyHistoryTab
          policies={policies}
          histPolicyId={histPolicyId}
          setHistPolicyId={(v) => {
            setHistPolicyId(v);
            setHistPage(1);
          }}
          histResult={histResult}
          setHistResult={(v) => {
            setHistResult(v);
            setHistPage(1);
          }}
          histDays={histDays}
          setHistDays={(v) => {
            setHistDays(v);
            setHistPage(1);
          }}
          histPage={histPage}
          setHistPage={setHistPage}
          data={histData}
          loading={histLoading}
        />
      )}

      {/* Create Policy Modal — 가이드형 규칙 빌더 (직접 JSON 입력 최소화) */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg border border-gray-200 max-w-2xl w-full max-h-[88vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 sticky top-0 bg-white">
              <h2 className="text-sm font-bold text-gray-900">새 정책 생성</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-500 hover:text-gray-900 transition"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* 1) 기본 정보 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold text-gray-600 mb-1.5">
                    정책명 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={createFormData.name}
                    onChange={(e) => setCreateFormData({ ...createFormData, name: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-200"
                    placeholder="예: 운영시간 외 배포 차단"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-gray-600 mb-1.5">
                    적용 범위
                  </label>
                  <select
                    value={createFormData.scopeLevel}
                    onChange={(e) =>
                      setCreateFormData({ ...createFormData, scopeLevel: e.target.value })
                    }
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
                  >
                    <option value="TENANT">테넌트 (이 테넌트에만)</option>
                    {userRole === 'PLATFORM_ADMIN' && (
                      <option value="PLATFORM">공통 (모든 테넌트)</option>
                    )}
                  </select>
                  {userRole !== 'PLATFORM_ADMIN' && (
                    <p className="text-[10px] text-gray-400 mt-1">공통 정책은 플랫폼 관리자만 생성</p>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-gray-600 mb-1.5">유형</label>
                  <select
                    value={createFormData.type}
                    onChange={(e) => setCreateFormData({ ...createFormData, type: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
                  >
                    <option value="COMPLIANCE">규정준수 (COMPLIANCE)</option>
                    <option value="SECURITY">보안 (SECURITY)</option>
                    <option value="PERFORMANCE">성능 (PERFORMANCE)</option>
                    <option value="COST">비용 (COST)</option>
                  </select>
                </div>
              </div>

              {/* 2) 규칙 빌더 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[11px] font-semibold text-gray-600">
                    규칙 — &ldquo;무엇을 만나면 차단/경고할지&rdquo;
                  </label>
                  <button
                    onClick={addBuilderRow}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-blue-600 border border-blue-200 rounded hover:bg-blue-50 transition"
                  >
                    <Plus size={12} /> 규칙 추가
                  </button>
                </div>
                <div className="space-y-2">
                  {builderRows.map((r, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center gap-2 p-2 bg-gray-50 border border-gray-200 rounded"
                    >
                      <select
                        value={r.field}
                        onChange={(e) =>
                          updateBuilderRow(i, { field: e.target.value, value: '', custom: false })
                        }
                        className="px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
                      >
                        {FIELD_OPTS.map((f) => (
                          <option key={f.v} value={f.v}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={r.op}
                        onChange={(e) => updateBuilderRow(i, { op: e.target.value })}
                        className="px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
                      >
                        {OP_OPTS.map((o) => (
                          <option key={o.v} value={o.v}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {(() => {
                        const opts = fieldOptions[r.field] ?? [];
                        if (opts.length > 0 && !r.custom) {
                          return (
                            <select
                              value={r.value}
                              onChange={(e) => {
                                if (e.target.value === '__custom__')
                                  updateBuilderRow(i, { custom: true, value: '' });
                                else updateBuilderRow(i, { value: e.target.value });
                              }}
                              className="flex-1 min-w-[160px] px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200"
                            >
                              <option value="">— 값 선택 —</option>
                              {opts.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                              <option value="__custom__">(직접 입력…)</option>
                            </select>
                          );
                        }
                        return (
                          <div className="flex-1 min-w-[160px] flex items-center gap-1">
                            <input
                              type="text"
                              value={r.value}
                              onChange={(e) => updateBuilderRow(i, { value: e.target.value })}
                              placeholder={FIELD_OPTS.find((f) => f.v === r.field)?.ph ?? '값'}
                              className="flex-1 px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-200"
                            />
                            {opts.length > 0 && (
                              <button
                                onClick={() => updateBuilderRow(i, { custom: false, value: '' })}
                                className="text-[10px] text-blue-600 whitespace-nowrap px-1"
                              >
                                목록
                              </button>
                            )}
                          </div>
                        );
                      })()}
                      <select
                        value={r.effect}
                        onChange={(e) =>
                          updateBuilderRow(i, { effect: e.target.value as 'deny' | 'warn' })
                        }
                        className={`px-2 py-1.5 border rounded text-[11px] font-semibold focus:outline-none focus:ring-1 focus:ring-blue-200 ${
                          r.effect === 'deny'
                            ? 'bg-red-50 border-red-200 text-red-700'
                            : 'bg-amber-50 border-amber-200 text-amber-700'
                        }`}
                      >
                        <option value="deny">차단</option>
                        <option value="warn">경고</option>
                      </select>
                      <button
                        onClick={() => removeBuilderRow(i)}
                        disabled={builderRows.length <= 1}
                        className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-30 transition"
                        title="규칙 삭제"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1.5">
                  &ldquo;다음 중 하나(목록)&rdquo;는 쉼표로 여러 값을 넣을 수 있습니다. 예: EXECUTE, delete, deploy
                </p>
              </div>

              {/* 3) 활성 + 미리보기 */}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-gray-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createFormData.isActive}
                    onChange={(e) =>
                      setCreateFormData({ ...createFormData, isActive: e.target.checked })
                    }
                    className="rounded"
                  />
                  활성 상태로 생성 (생성 즉시 적용)
                </label>
                <span className="text-[10px] text-gray-400">규칙 {buildRules(builderRows).length}개</span>
              </div>

              <details className="group">
                <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600 flex items-center gap-1">
                  <Code2 size={11} /> 고급: 저장될 규칙 미리보기(JSON)
                </summary>
                <div className="mt-2 bg-gray-100 rounded p-2 font-mono text-[10px] text-gray-500 max-h-40 overflow-y-auto">
                  <pre>{JSON.stringify(buildRules(builderRows), null, 2)}</pre>
                </div>
              </details>

              <div className="flex gap-3 pt-1">
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

// ── 실행 이력 탭 (정책·결과·기간 필터 + 페이지네이션) ──
function PolicyHistoryTab({
  policies,
  histPolicyId,
  setHistPolicyId,
  histResult,
  setHistResult,
  histDays,
  setHistDays,
  histPage,
  setHistPage,
  data,
  loading,
}: {
  policies: Policy[];
  histPolicyId: string;
  setHistPolicyId: (v: string) => void;
  histResult: string;
  setHistResult: (v: string) => void;
  histDays: number;
  setHistDays: (v: number) => void;
  histPage: number;
  setHistPage: (v: number) => void;
  data: { items: EvalRow[]; total: number; page: number; pageSize: number } | null;
  loading: boolean;
}) {
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selCls =
    'px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-200';
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200">
      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-200">
        <span className="text-[11px] font-semibold text-gray-700 mr-1">필터</span>
        <select value={histPolicyId} onChange={(e) => setHistPolicyId(e.target.value)} className={selCls}>
          <option value="">전체 정책</option>
          {policies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={histResult} onChange={(e) => setHistResult(e.target.value)} className={selCls}>
          <option value="">전체 결과</option>
          <option value="PASS">통과(PASS)</option>
          <option value="WARN">경고(WARN)</option>
          <option value="FAIL">차단(FAIL)</option>
        </select>
        <select
          value={histDays}
          onChange={(e) => setHistDays(parseInt(e.target.value, 10))}
          className={selCls}
        >
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
          <option value={365}>최근 1년</option>
        </select>
        <span className="ml-auto text-[10px] text-gray-500">총 {total.toLocaleString()}건</span>
      </div>

      {/* 표 */}
      {loading ? (
        <div className="p-8 text-center text-[11px] text-gray-400">불러오는 중…</div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="p-10 text-center text-[11px] text-gray-500">
          조건에 해당하는 실행 이력이 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <th className="text-right px-3 py-2 w-10">#</th>
                <th className="text-left px-4 py-2">정책명</th>
                <th className="text-left px-4 py-2">범위</th>
                <th className="text-left px-4 py-2">결과</th>
                <th className="text-left px-4 py-2">사유</th>
                <th className="text-left px-4 py-2">세션</th>
                <th className="text-left px-4 py-2">시각</th>
              </tr>
            </thead>
            <tbody>
              {data!.items.map((r, idx) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-[11px] text-gray-400 text-right tabular-nums">
                    {(histPage - 1) * pageSize + idx + 1}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-900 font-medium">{r.policyName}</td>
                  <td className="px-4 py-2">
                    <ScopeBadge level={r.scopeLevel} />
                  </td>
                  <td className="px-4 py-2">
                    <ResultBadge result={r.result} />
                  </td>
                  <td className="px-4 py-2 text-[11px] text-gray-600 max-w-[280px] truncate" title={r.reason ?? ''}>
                    {r.reason || '—'}
                  </td>
                  <td className="px-4 py-2 text-[10px] text-gray-400 font-mono">
                    {r.executionSessionId ? r.executionSessionId.slice(0, 12) + '…' : '—'}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-gray-500 whitespace-nowrap">
                    {new Date(r.createdAt).toLocaleString('ko-KR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 페이지네이션 */}
      {total > pageSize && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 text-[11px] text-gray-500">
          <span>
            {histPage} / {totalPages} 페이지
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setHistPage(Math.max(1, histPage - 1))}
              disabled={histPage <= 1}
              className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
            >
              이전
            </button>
            <button
              onClick={() => setHistPage(Math.min(totalPages, histPage + 1))}
              disabled={histPage >= totalPages}
              className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
            >
              다음
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
