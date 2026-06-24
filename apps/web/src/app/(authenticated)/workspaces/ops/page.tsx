'use client';

/**
 * IT Ops Workspace — SRE/Operator focused incident & deployment view.
 * Aggregates Auto-actions, active Missions, and recent Executions.
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/shared/PageHeader';
import { api } from '@/lib/api-client';
import {
  Wrench,
  AlertTriangle,
  Zap,
  Activity,
  Clock,
  RotateCcw,
  CheckCircle2,
  PlayCircle,
} from 'lucide-react';

interface AutoAction {
  id: string;
  kind: string;
  targetType: string;
  targetId: string;
  triggerReason: string;
  status: string;
  createdAt: string;
  revertWindowSec: number;
  missionId?: string;
}

interface Mission {
  id: string;
  key: string;
  title: string;
  status: string;
  kind: string;
  updatedAt: string;
  humanInterventionsCount: number;
}

const TABS = [
  { key: 'overview', label: '개요' },
  { key: 'auto-actions', label: '자율 조치' },
  { key: 'active', label: '활성 미션' },
  { key: 'waiting', label: '개입 필요' },
] as const;

export default function ITOpsWorkspace() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('overview');
  const [actions, setActions] = useState<AutoAction[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [summary, setSummary] = useState<any>({
    total: 0,
    revertable: 0,
    byKind: {},
    byStatus: {},
  });
  const [loading, setLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [actionsRes, missionsRes, sumRes] = await Promise.all([
        api
          .get<{ items: AutoAction[] }>('/auto-actions?hours=24&limit=200')
          .catch(() => ({ items: [] })),
        api.get<{ items: Mission[] }>('/missions').catch(() => ({ items: [] })),
        api
          .get('/auto-actions/summary?hours=24')
          .catch(() => ({ total: 0, revertable: 0, byKind: {}, byStatus: {} })),
      ]);
      setActions(actionsRes.items || []);
      setMissions(missionsRes.items || []);
      setSummary(sumRes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const h = setInterval(fetchAll, 30000);
    return () => clearInterval(h);
  }, [fetchAll]);

  const activeMissions = missions.filter((m) => m.status === 'RUNNING');
  const waitingMissions = missions.filter((m) => m.status === 'WAITING_HUMAN');
  const revertable = actions.filter((a) => {
    if (a.status !== 'EXECUTED') return false;
    const age = (Date.now() - new Date(a.createdAt).getTime()) / 1000;
    return age < a.revertWindowSec;
  });

  return (
    <div className="p-6">
      <PageHeader
        title="IT Ops 워크스페이스"
        description="자율 조치, 활성 미션, 장애 대응을 한 화면에서 관리합니다."
      />

      {/* Top Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="활성 미션"
          value={activeMissions.length}
          icon={<PlayCircle size={16} />}
          color="green"
        />
        <StatCard
          label="개입 필요"
          value={waitingMissions.length}
          icon={<AlertTriangle size={16} />}
          color="amber"
        />
        <StatCard
          label="24h 자율 조치"
          value={summary.total || 0}
          icon={<Zap size={16} />}
          color="purple"
        />
        <StatCard
          label="되돌릴 수 있는 조치"
          value={revertable.length}
          icon={<RotateCcw size={16} />}
          color="blue"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs font-medium transition border-b-2 ${
              tab === t.key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-2 gap-6">
          <SectionCard title="최근 자율 조치" icon={<Zap size={14} />}>
            {actions.slice(0, 10).map((a) => (
              <AutoActionRow key={a.id} action={a} onRevert={fetchAll} />
            ))}
            {actions.length === 0 && <EmptyState text="최근 24시간 자율 조치 없음" />}
          </SectionCard>
          <SectionCard title="활성 미션" icon={<PlayCircle size={14} />}>
            {activeMissions.slice(0, 10).map((m) => (
              <Link key={m.id} href={`/missions/${m.id}`}>
                <div className="px-3 py-2 border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-xs font-semibold text-gray-900">{m.title}</p>
                      <p className="text-[10px] text-gray-500">
                        {m.kind} · {new Date(m.updatedAt).toLocaleTimeString()}
                      </p>
                    </div>
                    <span className="px-2 py-0.5 bg-green-100 text-green-800 text-[10px] rounded font-semibold">
                      RUNNING
                    </span>
                  </div>
                </div>
              </Link>
            ))}
            {activeMissions.length === 0 && <EmptyState text="활성 미션 없음" />}
          </SectionCard>
        </div>
      )}

      {tab === 'auto-actions' && (
        <div className="bg-white rounded border border-gray-200">
          {actions.map((a) => (
            <AutoActionRow key={a.id} action={a} onRevert={fetchAll} />
          ))}
          {actions.length === 0 && <EmptyState text="자율 조치 없음" />}
        </div>
      )}

      {tab === 'active' && (
        <div className="bg-white rounded border border-gray-200">
          {activeMissions.map((m) => (
            <Link key={m.id} href={`/missions/${m.id}`}>
              <div className="px-4 py-3 border-b border-gray-100 hover:bg-gray-50 cursor-pointer flex justify-between items-center">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{m.title}</p>
                  <p className="text-xs text-gray-500">{m.kind}</p>
                </div>
                <Clock size={14} className="text-gray-400" />
              </div>
            </Link>
          ))}
          {activeMissions.length === 0 && <EmptyState text="활성 미션 없음" />}
        </div>
      )}

      {tab === 'waiting' && (
        <div className="bg-white rounded border border-gray-200">
          {waitingMissions.map((m) => (
            <Link key={m.id} href={`/missions/${m.id}`}>
              <div className="px-4 py-3 border-b border-gray-100 hover:bg-amber-50 cursor-pointer flex justify-between items-center bg-amber-25">
                <div>
                  <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                    <AlertTriangle size={14} className="text-amber-500" /> {m.title}
                  </p>
                  <p className="text-xs text-gray-500">
                    사용자 개입 필요 · 개입 {m.humanInterventionsCount}회
                  </p>
                </div>
                <span className="px-2 py-1 bg-amber-100 text-amber-800 text-[10px] rounded font-semibold">
                  WAITING
                </span>
              </div>
            </Link>
          ))}
          {waitingMissions.length === 0 && <EmptyState text="개입 필요 항목 없음" />}
        </div>
      )}
    </div>
  );
}

function AutoActionRow({ action, onRevert }: { action: AutoAction; onRevert: () => void }) {
  const age = (Date.now() - new Date(action.createdAt).getTime()) / 1000;
  const canRevert = action.status === 'EXECUTED' && age < action.revertWindowSec;
  const handleRevert = async () => {
    if (!confirm('이 자율 조치를 되돌리시겠습니까?')) return;
    try {
      await api.post(`/auto-actions/${action.id}/revert`, {});
      onRevert();
    } catch (e: any) {
      alert(e.message || '되돌리기 실패');
    }
  };

  const statusColor =
    {
      EXECUTED: 'bg-blue-100 text-blue-800',
      VERIFIED: 'bg-green-100 text-green-800',
      REVERTED: 'bg-gray-100 text-gray-600',
      FAILED: 'bg-red-100 text-red-800',
    }[action.status] || 'bg-gray-100 text-gray-600';

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 flex justify-between items-center">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-gray-900 truncate">
          {action.kind} · {action.targetType}:{action.targetId.slice(0, 8)}
        </p>
        <p className="text-[10px] text-gray-500 truncate">{action.triggerReason}</p>
        <p className="text-[10px] text-gray-400 mt-0.5">
          {new Date(action.createdAt).toLocaleString()}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${statusColor}`}>
          {action.status}
        </span>
        {canRevert && (
          <button
            onClick={handleRevert}
            className="flex items-center gap-1 px-2 py-1 bg-red-50 text-red-700 text-[10px] font-semibold rounded hover:bg-red-100"
            title={`${Math.floor(action.revertWindowSec - age)}초 남음`}
          >
            <RotateCcw size={10} /> 되돌리기
          </button>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'amber' | 'purple';
}) {
  const cm = {
    blue: 'text-blue-600',
    green: 'text-green-600',
    amber: 'text-amber-600',
    purple: 'text-purple-600',
  }[color];
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center gap-1.5 mb-2">
        <span className={cm}>{icon}</span>
        <p className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold">{label}</p>
      </div>
      <p className={`text-2xl font-bold ${cm}`}>{value}</p>
    </div>
  );
}

function SectionCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-semibold text-gray-900">{title}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="p-8 text-center text-xs text-gray-500">{text}</div>;
}
