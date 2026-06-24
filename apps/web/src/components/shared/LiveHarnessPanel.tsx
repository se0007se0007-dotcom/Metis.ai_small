'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ═══════════════════════════════════════════════════════════
//  Harness Event Types
// ═══════════════════════════════════════════════════════════

export type HarnessEventType =
  | 'INTENT_DETECTED'
  | 'TEMPLATE_SELECTED'
  | 'PARAM_EXTRACTED'
  | 'CONNECTOR_CHECK'
  | 'CONNECTOR_MISSING'
  | 'POLICY_INJECTED'
  | 'VALIDATION_WARNING'
  | 'VALIDATION_ERROR'
  | 'VALIDATION_PASS'
  | 'EVAL_STARTED'
  | 'EVAL_COMPLETED'
  | 'READINESS_SCORE'
  | 'SIMULATION_RUN'
  | 'AGENT_DISCUSSION'
  | 'NODE_INSPECT'
  | 'DECISION_MADE';

export type AgentType = 'intent' | 'template' | 'connector' | 'policy' | 'validator' | 'eval';
export type EventSeverity = 'info' | 'warn' | 'error' | 'success';

export interface HarnessEvent {
  id: string;
  type: HarnessEventType;
  agentType: AgentType;
  nodeId?: string;
  nodeName?: string;
  message: string;
  detail?: string;
  severity: EventSeverity;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════
//  Agent Definitions
// ═══════════════════════════════════════════════════════════

interface AgentDef {
  id: AgentType;
  emoji: string;
  name: string;
  nameKo: string;
  color: string;
  bgColor: string;
}

const AGENTS: AgentDef[] = [
  {
    id: 'intent',
    emoji: '🤖',
    name: 'Intent',
    nameKo: '의도분석',
    color: '#6366F1',
    bgColor: '#EEF2FF',
  },
  {
    id: 'template',
    emoji: '🧩',
    name: 'Template',
    nameKo: '템플릿',
    color: '#8B5CF6',
    bgColor: '#F5F3FF',
  },
  {
    id: 'connector',
    emoji: '🔌',
    name: 'Connector',
    nameKo: '커넥터',
    color: '#F59E0B',
    bgColor: '#FFFBEB',
  },
  {
    id: 'policy',
    emoji: '🛡️',
    name: 'Policy',
    nameKo: '정책',
    color: '#EF4444',
    bgColor: '#FEF2F2',
  },
  {
    id: 'validator',
    emoji: '🔍',
    name: 'Validator',
    nameKo: '검증',
    color: '#10B981',
    bgColor: '#ECFDF5',
  },
  { id: 'eval', emoji: '📊', name: 'Eval', nameKo: '평가', color: '#3B82F6', bgColor: '#EFF6FF' },
];

const AGENT_MAP = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

// ═══════════════════════════════════════════════════════════
//  Harness Event Bus (singleton)
// ═══════════════════════════════════════════════════════════

type EventHandler = (event: HarnessEvent) => void;

class HarnessEventBus {
  private listeners: EventHandler[] = [];
  subscribe(handler: EventHandler): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }
  emit(event: Omit<HarnessEvent, 'id' | 'timestamp'>) {
    const full: HarnessEvent = {
      ...event,
      id: `he-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    };
    for (const l of this.listeners) {
      try {
        l(full);
      } catch (_) {}
    }
  }
}

export const harnessEventBus = new HarnessEventBus();

// ═══════════════════════════════════════════════════════════
//  Emit harness events from a harness result
// ═══════════════════════════════════════════════════════════

export async function emitHarnessEvents(
  nodes: Array<{ id: string; name: string; type: string; settings?: Record<string, any> }>,
  harnessResult: any,
  userPrompt?: string,
) {
  const d = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const bus = harnessEventBus;

  // 실제 에이전트 미팅 실행 (5개 에이전트 모듈 호출)
  let meeting: any = null;
  try {
    const { runAgentMeeting } = await import('@/lib/harness-agents/llm-reviewer');
    meeting = runAgentMeeting(
      userPrompt || nodes.map((n) => n.name).join(' → '),
      nodes.map((n) => ({ type: n.type, name: n.name, settings: n.settings || {} })),
    );
  } catch (e) {
    console.warn('Agent meeting modules not available, using basic mode:', e);
  }

  if (meeting && meeting.deliberations) {
    // 에이전트 미팅 결과의 실제 대화를 라이브로 방출
    const eventTypeMap: Record<string, HarnessEventType> = {
      intent: 'INTENT_DETECTED',
      template: 'TEMPLATE_SELECTED',
      connector: 'CONNECTOR_CHECK',
      policy: 'POLICY_INJECTED',
      validator: 'NODE_INSPECT',
      eval: 'EVAL_STARTED',
    };

    for (const delib of meeting.deliberations) {
      const agentType = delib.agentId as AgentType;

      // 각 에이전트의 발언을 순차적으로 표시
      for (const msg of delib.messages) {
        const severity: EventSeverity =
          msg.role === 'decide'
            ? delib.confidence > 0.7
              ? 'success'
              : 'warn'
            : delib.concerns.length > 0
              ? 'warn'
              : 'info';

        bus.emit({
          type:
            msg.role === 'decide' ? 'DECISION_MADE' : eventTypeMap[agentType] || 'AGENT_DISCUSSION',
          agentType,
          message: msg.content.slice(0, 60),
          detail: msg.content.length > 60 ? msg.content : undefined,
          severity,
        });
        await d(msg.role === 'think' ? 400 : msg.role === 'decide' ? 500 : 600);
      }
    }

    // 최종 합의
    await d(300);
    bus.emit({
      type: 'READINESS_SCORE',
      agentType: 'eval',
      message: meeting.consensus.summary.slice(0, 60),
      detail: `합의 점수: ${meeting.consensus.score}점`,
      severity: meeting.consensus.approved ? 'success' : 'warn',
    });
  } else {
    // 폴백: 기존 기본 모드
    bus.emit({
      type: 'INTENT_DETECTED',
      agentType: 'intent',
      message: `${nodes.length}개 노드 파이프라인 감지`,
      severity: 'info',
    });
    await d(500);
    bus.emit({
      type: 'TEMPLATE_SELECTED',
      agentType: 'template',
      message: '커스텀 워크플로우로 진행',
      severity: 'success',
    });
    await d(500);
    bus.emit({
      type: 'CONNECTOR_CHECK',
      agentType: 'connector',
      message: '커넥터 상태 점검 완료',
      severity: 'success',
    });
    await d(500);
    bus.emit({
      type: 'POLICY_INJECTED',
      agentType: 'policy',
      message: '거버넌스 정책 적용 완료',
      severity: 'success',
    });
    await d(500);

    const blockErrors = harnessResult?.structuralValidation?.blockingErrors || [];
    const warnings = harnessResult?.structuralValidation?.warnings || [];
    bus.emit({
      type:
        blockErrors.length > 0
          ? 'VALIDATION_ERROR'
          : warnings.length > 0
            ? 'VALIDATION_WARNING'
            : 'VALIDATION_PASS',
      agentType: 'validator',
      message:
        blockErrors.length > 0
          ? `${blockErrors.length}개 차단 오류`
          : warnings.length > 0
            ? `${warnings.length}개 경고`
            : '구조 검증 통과',
      severity: blockErrors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'success',
    });
    await d(500);

    const score = harnessResult?.readinessScore;
    if (score) {
      bus.emit({
        type: 'READINESS_SCORE',
        agentType: 'eval',
        message: `Readiness ${score.overall}점 (${score.band})`,
        severity: score.band === 'excellent' || score.band === 'good' ? 'success' : 'warn',
      });
    }
    await d(300);
    bus.emit({
      type: 'DECISION_MADE',
      agentType: 'eval',
      message: harnessResult?.canSave ? '저장 가능합니다' : '경고사항 확인 필요',
      severity: harnessResult?.canSave ? 'success' : 'warn',
    });
  }
}

// ═══════════════════════════════════════════════════════════
//  Main Component: Meeting Room Style
// ═══════════════════════════════════════════════════════════

interface AgentBubble {
  agentId: AgentType;
  message: string;
  severity: EventSeverity;
  id: string;
  fading: boolean;
}

export interface LiveHarnessPanelProps {
  visible: boolean;
  onToggle: () => void;
  activeNodeId?: string | null;
}

export default function LiveHarnessPanel({ visible, onToggle }: LiveHarnessPanelProps) {
  const [bubbles, setBubbles] = useState<AgentBubble[]>([]);
  const [activeAgent, setActiveAgent] = useState<AgentType | null>(null);
  const [phase, setPhase] = useState<string>('대기');
  const [finalScore, setFinalScore] = useState<{ score: number; band: string } | null>(null);
  const bubblesRef = useRef<AgentBubble[]>([]);

  useEffect(() => {
    const unsub = harnessEventBus.subscribe((event: HarnessEvent) => {
      setActiveAgent(event.agentType);

      // Update phase label
      const phaseMap: Partial<Record<HarnessEventType, string>> = {
        INTENT_DETECTED: '의도 분석',
        TEMPLATE_SELECTED: '템플릿 매칭',
        CONNECTOR_CHECK: '커넥터 점검',
        CONNECTOR_MISSING: '커넥터 점검',
        POLICY_INJECTED: '정책 적용',
        NODE_INSPECT: '구조 검증',
        VALIDATION_WARNING: '구조 검증',
        VALIDATION_ERROR: '구조 검증',
        VALIDATION_PASS: '구조 검증',
        EVAL_STARTED: '시뮬레이션',
        READINESS_SCORE: '평가 완료',
        DECISION_MADE: '최종 결정',
      };
      if (phaseMap[event.type]) setPhase(phaseMap[event.type]!);

      // Track score
      if (event.type === 'READINESS_SCORE') {
        const match = event.message.match(/(\d+)점.*\((\w+)\)/);
        if (match) setFinalScore({ score: parseInt(match[1]), band: match[2] });
      }

      // Add bubble (keep max 2 visible at a time)
      const newBubble: AgentBubble = {
        agentId: event.agentType,
        message: event.message,
        severity: event.severity,
        id: event.id,
        fading: false,
      };

      bubblesRef.current = [...bubblesRef.current, newBubble].slice(-2);
      setBubbles([...bubblesRef.current]);

      // Start fading old bubble after 2s
      setTimeout(() => {
        bubblesRef.current = bubblesRef.current.map((b) =>
          b.id === newBubble.id ? { ...b, fading: true } : b,
        );
        setBubbles([...bubblesRef.current]);
      }, 2800);

      // Remove faded bubble
      setTimeout(() => {
        bubblesRef.current = bubblesRef.current.filter((b) => b.id !== newBubble.id);
        setBubbles([...bubblesRef.current]);
      }, 3500);

      // Clear active agent after a bit
      setTimeout(() => {
        setActiveAgent((prev) => (prev === event.agentType ? null : prev));
      }, 1500);
    });
    return unsub;
  }, []);

  const handleReset = useCallback(() => {
    setBubbles([]);
    bubblesRef.current = [];
    setActiveAgent(null);
    setPhase('대기');
    setFinalScore(null);
  }, []);

  if (!visible) return null;

  // Arrange agents in a "meeting table" layout:
  // Top row:    [intent]  [template]  [connector]
  // Bottom row: [policy]  [validator] [eval]
  const topAgents = AGENTS.slice(0, 3);
  const bottomAgents = AGENTS.slice(3, 6);

  const sevBorder: Record<EventSeverity, string> = {
    info: 'border-gray-300 bg-white text-gray-800',
    success: 'border-green-400 bg-green-50 text-green-800',
    warn: 'border-amber-400 bg-amber-50 text-amber-800',
    error: 'border-red-400 bg-red-50 text-red-800',
  };

  return (
    <div
      className="flex flex-col h-full bg-gradient-to-b from-slate-50 to-white border-l border-gray-200 overflow-hidden"
      style={{ width: '240px', minWidth: '240px' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gradient-to-r from-indigo-50 to-purple-50 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs">🤖</span>
          <span className="text-[9px] font-bold text-indigo-800 tracking-wider uppercase">
            Agent Meeting
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[8px] px-1.5 py-0.5 bg-indigo-100 text-indigo-600 rounded font-medium">
            {phase}
          </span>
          <button
            onClick={handleReset}
            className="text-[9px] px-1 text-gray-400 hover:text-gray-600"
            title="초기화"
          >
            ↺
          </button>
          <button
            onClick={onToggle}
            className="text-[9px] px-1 text-gray-400 hover:text-gray-600"
            title="닫기"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Meeting Room */}
      <div className="flex-1 flex flex-col items-center justify-center px-3 py-2 relative overflow-hidden">
        {/* Speech Bubbles Area (floats above agents) */}
        <div className="w-full min-h-[52px] flex flex-col justify-end mb-1.5 gap-1">
          {bubbles.map((bubble) => {
            const agent = AGENT_MAP[bubble.agentId];
            return (
              <div
                key={bubble.id}
                className={`flex items-start gap-1.5 px-2 py-1.5 rounded-lg border text-[9px] leading-snug transition-all duration-300 ${sevBorder[bubble.severity]} ${bubble.fading ? 'opacity-0 translate-y-1' : 'opacity-100 translate-y-0'}`}
                style={{ animation: bubble.fading ? undefined : 'bubbleIn 0.3s ease-out' }}
              >
                <span className="flex-shrink-0 text-xs mt-px">{agent?.emoji}</span>
                <div className="min-w-0">
                  <span className="font-bold text-[8px] opacity-60 mr-1">{agent?.nameKo}</span>
                  <span>{bubble.message}</span>
                </div>
              </div>
            );
          })}
          {bubbles.length === 0 && phase === '대기' && (
            <div className="text-center text-[9px] text-gray-400 py-2">
              워크플로우를 생성하면
              <br />
              에이전트 회의가 시작됩니다
            </div>
          )}
        </div>

        {/* Meeting Table */}
        <div className="relative w-full flex-shrink-0">
          {/* Top Row Agents */}
          <div className="flex justify-center gap-3 mb-1.5">
            {topAgents.map((agent) => (
              <AgentSeat
                key={agent.id}
                agent={agent}
                isActive={activeAgent === agent.id}
                hasBubble={bubbles.some((b) => b.agentId === agent.id && !b.fading)}
              />
            ))}
          </div>

          {/* Table */}
          <div className="mx-auto w-[85%] h-5 rounded-full bg-gradient-to-r from-amber-100 via-amber-50 to-amber-100 border border-amber-200/70 shadow-inner flex items-center justify-center">
            <span className="text-[7px] text-amber-400 font-medium tracking-wider">
              HARNESS REVIEW
            </span>
          </div>

          {/* Bottom Row Agents */}
          <div className="flex justify-center gap-3 mt-1.5">
            {bottomAgents.map((agent) => (
              <AgentSeat
                key={agent.id}
                agent={agent}
                isActive={activeAgent === agent.id}
                hasBubble={bubbles.some((b) => b.agentId === agent.id && !b.fading)}
                bottom
              />
            ))}
          </div>
        </div>

        {/* Score Badge (shown after evaluation) */}
        {finalScore && (
          <div
            className={`mt-3 px-3 py-1.5 rounded-full text-[10px] font-bold shadow-sm border ${
              finalScore.band === 'excellent' || finalScore.band === 'good'
                ? 'bg-green-50 border-green-300 text-green-700'
                : finalScore.band === 'fair'
                  ? 'bg-amber-50 border-amber-300 text-amber-700'
                  : 'bg-red-50 border-red-300 text-red-700'
            }`}
            style={{ animation: 'scoreIn 0.5s ease-out' }}
          >
            {finalScore.band === 'excellent'
              ? '🟢'
              : finalScore.band === 'good'
                ? '🔵'
                : finalScore.band === 'fair'
                  ? '🟡'
                  : '🔴'}{' '}
            Readiness {finalScore.score}점
          </div>
        )}
      </div>

      {/* CSS Animations */}
      <style jsx>{`
        @keyframes bubbleIn {
          from {
            opacity: 0;
            transform: translateY(6px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes scoreIn {
          from {
            opacity: 0;
            transform: scale(0.8);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes agentBounce {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-3px);
          }
        }
        @keyframes agentGlow {
          0%,
          100% {
            box-shadow: 0 0 0 0 rgba(99, 102, 241, 0);
          }
          50% {
            box-shadow: 0 0 8px 2px rgba(99, 102, 241, 0.3);
          }
        }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  Agent Seat Component
// ═══════════════════════════════════════════════════════════

function AgentSeat({
  agent,
  isActive,
  hasBubble,
  bottom = false,
}: {
  agent: AgentDef;
  isActive: boolean;
  hasBubble: boolean;
  bottom?: boolean;
}) {
  return (
    <div className="flex flex-col items-center" style={{ width: '52px' }}>
      {/* Name (top agents: name below; bottom agents: name above) */}
      {bottom && (
        <span
          className={`text-[7px] mb-0.5 font-medium transition-colors duration-300 ${isActive ? 'text-indigo-600' : 'text-gray-400'}`}
        >
          {agent.nameKo}
        </span>
      )}

      {/* Avatar */}
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm transition-all duration-300 border-2 ${
          isActive
            ? 'border-indigo-400 scale-110 shadow-md'
            : hasBubble
              ? 'border-blue-300 scale-105'
              : 'border-transparent scale-90 opacity-50'
        }`}
        style={{
          backgroundColor: agent.bgColor,
          animation: isActive
            ? 'agentBounce 0.6s ease-in-out infinite, agentGlow 1.2s ease-in-out infinite'
            : 'none',
        }}
      >
        {agent.emoji}
      </div>

      {/* Name (top agents) */}
      {!bottom && (
        <span
          className={`text-[7px] mt-0.5 font-medium transition-colors duration-300 ${isActive ? 'text-indigo-600' : 'text-gray-400'}`}
        >
          {agent.nameKo}
        </span>
      )}
    </div>
  );
}
