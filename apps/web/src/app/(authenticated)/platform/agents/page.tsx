'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { api } from '@/lib/api-client';
import { RefreshCw, AlertCircle, Zap, Code, CheckCircle, Tool, Activity } from 'lucide-react';

// ── Types ──

interface Agent {
  id: string;
  name: string;
  category: 'OPERATIONS' | 'DEVELOPMENT' | 'QA' | 'UTILITY';
  status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
  description: string;
  version: string;
  lastUpdated: string;
  invokeCount: number;
}

// ── Page Component ──

export default function AgentsPage() {
  const [tab, setTab] = useState<'operations' | 'development' | 'qa' | 'utility'>('operations');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ items: Agent[] }>('/platform/agents');
      setAgents(data?.items || getMockAgents());
    } catch (err: any) {
      setError(err.message ?? 'Failed to load agents');
      setAgents(getMockAgents());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Filter agents by tab
  const filteredAgents = agents.filter((a) => a.category.toLowerCase() === tab.toUpperCase());

  const categoryMap: Record<string, { label: string; icon: any; color: string }> = {
    operations: {
      label: '[Operations]',
      icon: Activity,
      color: 'text-accent',
    },
    development: {
      label: '[Development]',
      icon: Code,
      color: 'text-warning',
    },
    qa: {
      label: '[QA]',
      icon: CheckCircle,
      color: 'text-success',
    },
    utility: {
      label: '[Utility]',
      icon: Tool,
      color: 'text-gray-500',
    },
  };

  const statusColorMap: Record<string, string> = {
    ACTIVE: 'success',
    INACTIVE: 'muted',
    MAINTENANCE: 'warning',
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Agent 레지스트리"
        description="모든 Agent 및 자동화 도구 관리"
        actions={
          <button
            onClick={fetchAgents}
            className="p-1.5 text-muted-dark hover:text-dark transition"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        }
      />

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-danger/10 border border-danger/20 rounded text-xs text-danger">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {(['operations', 'development', 'qa', 'utility'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-semibold border-b-2 transition ${
              tab === t
                ? 'text-accent border-accent'
                : 'text-muted-dark border-transparent hover:text-dark'
            }`}
          >
            {categoryMap[t].label}
          </button>
        ))}
      </div>

      {/* Agents Grid */}
      {loading ? (
        <div className="grid grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-40 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center">
          <Zap size={32} className="mx-auto mb-3 text-muted-dark/40" />
          <p className="text-xs text-gray-500">
            {tab === 'operations' && 'Operations Agent가 없습니다'}
            {tab === 'development' && 'Development Agent가 없습니다'}
            {tab === 'qa' && 'QA Agent가 없습니다'}
            {tab === 'utility' && 'Utility Agent가 없습니다'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {filteredAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} statusColor={statusColorMap[agent.status]} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Agent Card ──

function AgentCard({ agent, statusColor }: { agent: Agent; statusColor: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:border-accent/20 transition">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-xs font-bold text-gray-900">{agent.name}</h3>
          <p className="text-[11px] text-gray-500 mt-1">{agent.description}</p>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-gray-500">버전</span>
          <span className="text-gray-900 font-mono font-semibold">{agent.version}</span>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-gray-500">상태</span>
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
              statusColor === 'success'
                ? 'bg-success/20 text-success'
                : statusColor === 'warning'
                  ? 'bg-warning/20 text-warning'
                  : 'bg-muted/20 text-gray-500'
            }`}
          >
            {agent.status}
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-gray-500">호출 수</span>
          <span className="text-accent font-semibold">{agent.invokeCount.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-gray-500">업데이트</span>
          <span className="text-gray-500 font-mono">
            {new Date(agent.lastUpdated).toLocaleDateString('ko-KR')}
          </span>
        </div>
      </div>

      <button className="w-full px-3 py-2 text-xs font-semibold border border-gray-200 text-gray-900 rounded hover:border-accent hover:text-accent transition">
        설정
      </button>
    </div>
  );
}

// ── Mock Data ──

function getMockAgents(): Agent[] {
  return [
    // Operations
    {
      id: 'agent-op-1',
      name: 'Log Aggregator',
      category: 'OPERATIONS',
      status: 'ACTIVE',
      description: '로그 수집 및 분석',
      version: '2.3.1',
      lastUpdated: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 15420,
    },
    {
      id: 'agent-op-2',
      name: 'Incident Responder',
      category: 'OPERATIONS',
      status: 'ACTIVE',
      description: '인시던트 자동 응답',
      version: '1.8.5',
      lastUpdated: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 8234,
    },
    {
      id: 'agent-op-3',
      name: 'Health Monitor',
      category: 'OPERATIONS',
      status: 'ACTIVE',
      description: '시스템 상태 모니터링',
      version: '3.1.0',
      lastUpdated: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 42156,
    },
    // Development
    {
      id: 'agent-dev-1',
      name: 'Code Reviewer',
      category: 'DEVELOPMENT',
      status: 'ACTIVE',
      description: 'PR 자동 리뷰',
      version: '2.0.1',
      lastUpdated: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 5821,
    },
    {
      id: 'agent-dev-2',
      name: 'Documentation Generator',
      category: 'DEVELOPMENT',
      status: 'MAINTENANCE',
      description: '자동 문서 생성',
      version: '1.5.2',
      lastUpdated: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 1243,
    },
    {
      id: 'agent-dev-3',
      name: 'Dependency Manager',
      category: 'DEVELOPMENT',
      status: 'ACTIVE',
      description: '의존성 업데이트 관리',
      version: '1.9.3',
      lastUpdated: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 3456,
    },
    // QA
    {
      id: 'agent-qa-1',
      name: 'Test Executor',
      category: 'QA',
      status: 'ACTIVE',
      description: '자동 테스트 실행',
      version: '3.2.0',
      lastUpdated: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 28934,
    },
    {
      id: 'agent-qa-2',
      name: 'Performance Analyzer',
      category: 'QA',
      status: 'ACTIVE',
      description: '성능 분석 및 보고',
      version: '2.1.1',
      lastUpdated: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 6789,
    },
    {
      id: 'agent-qa-3',
      name: 'Bug Reporter',
      category: 'QA',
      status: 'ACTIVE',
      description: '버그 자동 리포팅',
      version: '1.7.4',
      lastUpdated: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 4521,
    },
    // Utility
    {
      id: 'agent-util-1',
      name: 'Data Migrator',
      category: 'UTILITY',
      status: 'ACTIVE',
      description: '데이터 마이그레이션',
      version: '1.3.1',
      lastUpdated: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 234,
    },
    {
      id: 'agent-util-2',
      name: 'Backup Manager',
      category: 'UTILITY',
      status: 'INACTIVE',
      description: '백업 관리',
      version: '2.0.0',
      lastUpdated: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 52,
    },
    {
      id: 'agent-util-3',
      name: 'Report Generator',
      category: 'UTILITY',
      status: 'ACTIVE',
      description: '보고서 생성',
      version: '1.6.2',
      lastUpdated: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      invokeCount: 892,
    },
  ];
}
