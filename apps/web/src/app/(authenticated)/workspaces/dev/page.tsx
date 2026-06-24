'use client';

/**
 * Development Workspace — Developer-focused hub.
 * Aggregates Builder requests, active builds, Canary in progress, and Replay runs.
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/shared/PageHeader';
import { api } from '@/lib/api-client';
import {
  Code,
  Palette,
  GitBranch,
  Beaker,
  RefreshCw,
  PlayCircle,
  CheckCircle2,
  AlertTriangle,
  Hammer,
  FileCode,
  Rocket,
  ArrowRight,
} from 'lucide-react';

interface BuilderRequest {
  id: string;
  intent: string;
  status: string;
  readinessBand?: string;
  createdAt: string;
}

interface Mission {
  id: string;
  title: string;
  status: string;
  kind: string;
  updatedAt: string;
}

export default function DevWorkspace() {
  const [builders, setBuilders] = useState<BuilderRequest[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [builderRes, missionRes] = await Promise.all([
        api.get<{ items: BuilderRequest[] }>('/builder/requests').catch(() => ({ items: [] })),
        api.get<{ items: Mission[] }>('/missions?status=RUNNING').catch(() => ({ items: [] })),
      ]);
      setBuilders(builderRes.items || []);
      setMissions(missionRes.items || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const h = setInterval(fetchAll, 30000);
    return () => clearInterval(h);
  }, [fetchAll]);

  const pendingBuilders = builders.filter((b) => ['PLANNING', 'VALIDATING'].includes(b.status));
  const readyBuilders = builders.filter((b) => b.status === 'READY');
  const deploymentMissions = missions.filter((m) => m.kind === 'DEPLOYMENT');

  return (
    <div className="p-6">
      <PageHeader
        title="Development 워크스페이스"
        description="빌더 검증, 배포 진행, 릴리스 엔지니어링을 개발자 관점에서 모니터링합니다."
      />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="대기 중 Builder"
          value={pendingBuilders.length}
          icon={<Hammer size={16} />}
          color="blue"
        />
        <StatCard
          label="배포 준비 완료"
          value={readyBuilders.length}
          icon={<CheckCircle2 size={16} />}
          color="green"
        />
        <StatCard
          label="진행 중 배포"
          value={deploymentMissions.length}
          icon={<Rocket size={16} />}
          color="purple"
        />
        <StatCard
          label="전체 Builder"
          value={builders.length}
          icon={<FileCode size={16} />}
          color="amber"
        />
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <QuickLink
          href="/orchestration/builder"
          label="Flo Builder"
          icon={<Palette />}
          color="cyan"
        />
      </div>

      {/* Two-column content */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-900 flex items-center gap-1.5">
              <Hammer size={14} className="text-blue-600" /> 최근 Builder 요청
            </span>
            <button onClick={fetchAll} className="p-1 text-gray-500 hover:text-gray-900">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div>
            {builders.slice(0, 12).map((b) => (
              <div key={b.id} className="px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50">
                <div className="flex justify-between items-start mb-1">
                  <p className="text-xs font-semibold text-gray-900 line-clamp-1 flex-1">
                    {b.intent}
                  </p>
                  <StatusPill status={b.status} />
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gray-500">
                  <span>{new Date(b.createdAt).toLocaleString()}</span>
                  {b.readinessBand && (
                    <span
                      className={`px-1.5 py-0.5 rounded font-semibold ${
                        b.readinessBand === 'EXCELLENT'
                          ? 'bg-green-100 text-green-700'
                          : b.readinessBand === 'GOOD'
                            ? 'bg-blue-100 text-blue-700'
                            : b.readinessBand === 'FAIR'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {b.readinessBand}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {builders.length === 0 && (
              <div className="p-8 text-center text-xs text-gray-500">
                아직 Builder 요청이 없습니다
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-1.5">
            <Rocket size={14} className="text-purple-600" />
            <span className="text-xs font-semibold text-gray-900">진행 중 배포 미션</span>
          </div>
          <div>
            {deploymentMissions.map((m) => (
              <Link key={m.id} href={`/missions/${m.id}`}>
                <div className="px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 cursor-pointer flex justify-between items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-gray-900 truncate">{m.title}</p>
                    <p className="text-[10px] text-gray-500">
                      업데이트: {new Date(m.updatedAt).toLocaleTimeString()}
                    </p>
                  </div>
                  <ArrowRight size={14} className="text-gray-400 flex-shrink-0" />
                </div>
              </Link>
            ))}
            {deploymentMissions.length === 0 && (
              <div className="p-8 text-center text-xs text-gray-500">진행 중 배포 없음</div>
            )}
          </div>
        </div>
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
  color: 'blue' | 'green' | 'purple' | 'amber';
}) {
  const cm = {
    blue: 'text-blue-600',
    green: 'text-green-600',
    purple: 'text-purple-600',
    amber: 'text-amber-600',
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

function QuickLink({
  href,
  label,
  icon,
  color,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <Link href={href}>
      <div className="bg-white rounded-lg border border-gray-200 p-3 hover:border-blue-400 hover:shadow-sm cursor-pointer transition flex items-center gap-2">
        <span className={`text-${color}-600`}>{icon}</span>
        <span className="text-xs font-semibold text-gray-900">{label}</span>
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    PLANNING: 'bg-blue-100 text-blue-700',
    VALIDATING: 'bg-amber-100 text-amber-700',
    READY: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
    SAVED: 'bg-gray-100 text-gray-700',
  };
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[9px] font-semibold flex-shrink-0 ${styles[status] || 'bg-gray-100 text-gray-700'}`}
    >
      {status}
    </span>
  );
}
