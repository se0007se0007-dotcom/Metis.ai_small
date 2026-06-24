/**
 * seed-dashboard.ts — 현실적 대시보드 데이터 시드.
 *
 * main agent = Workflow, sub agent = WorkflowNodeDef (per metis.flo).
 * 14개 워크플로우(운영7/개발4/편의3) + 노드 + 최근 30일 ExecutionSession/
 * ExecutionStep/AgentEvaluation 이력을 생성한다. (지연/비용/품질/이상 표준 적재)
 *
 * 결정적 시드(seededRandom)로 매 실행 동일 데이터를 만든다.
 */
import type { PrismaClient } from '@prisma/client';

interface AgentDef {
  code: string;
  key: string;
  name: string;
  category: string;
  health: 'healthy' | 'degraded' | 'down'; // 데모용 의도된 건강 분포
  nodes: { key: string; type: string; name: string }[];
}

const DASHBOARD_AGENTS: AgentDef[] = [
  // 운영 7
  {
    code: 'OPS-001',
    key: 'ops-test-automation',
    name: '테스트 자동화 Agent',
    category: 'operations',
    health: 'healthy',
    nodes: [
      { key: 'collect', type: 'data-collect', name: '테스트 수집' },
      { key: 'run', type: 'ai-processing', name: '회귀 실행' },
      { key: 'report', type: 'report', name: '결과 리포트' },
    ],
  },
  {
    code: 'OPS-002',
    key: 'ops-service-monitoring',
    name: '서비스 모니터링 Agent',
    category: 'operations',
    health: 'healthy',
    nodes: [
      { key: 'probe', type: 'log-monitor', name: '지표 수집' },
      { key: 'analyze', type: 'ai-processing', name: '이상 분석' },
      { key: 'alert', type: 'notification', name: '알림' },
    ],
  },
  {
    code: 'OPS-003',
    key: 'ops-campaign-monitoring',
    name: '캠페인 모니터링 Agent',
    category: 'operations',
    health: 'degraded',
    nodes: [
      { key: 'fetch', type: 'api-call', name: '성과 수집' },
      { key: 'eval', type: 'ai-processing', name: '성과 평가' },
    ],
  },
  {
    code: 'OPS-004',
    key: 'ops-change-impact',
    name: '변경 영향도 Agent',
    category: 'operations',
    health: 'healthy',
    nodes: [
      { key: 'diff', type: 'ai-processing', name: '변경 분석' },
      { key: 'impact', type: 'ai-processing', name: '영향 산출' },
    ],
  },
  {
    code: 'OPS-005',
    key: 'ops-event-response',
    name: '이벤트 대응 Agent',
    category: 'operations',
    health: 'down',
    nodes: [
      { key: 'detect', type: 'log-monitor', name: '이벤트 감지' },
      { key: 'triage', type: 'ai-processing', name: '분류' },
      { key: 'remediate', type: 'git-deploy', name: '조치' },
    ],
  },
  {
    code: 'OPS-006',
    key: 'ops-knowledge-mgmt',
    name: '지식 자산화 Agent',
    category: 'operations',
    health: 'healthy',
    nodes: [
      { key: 'gather', type: 'data-collect', name: '수집' },
      { key: 'summarize', type: 'ai-processing', name: '정리' },
    ],
  },
  {
    code: 'OPS-007',
    key: 'ops-quality-guardian',
    name: '품질가디언 Agent',
    category: 'operations',
    health: 'degraded',
    nodes: [
      { key: 'scan', type: 'ai-processing', name: '품질 점검' },
      { key: 'gate', type: 'condition', name: '게이트' },
    ],
  },
  // 개발 4
  {
    code: 'DEV-001',
    key: 'dev-spec-agent',
    name: 'Spec Agent',
    category: 'development',
    health: 'healthy',
    nodes: [
      { key: 'parse', type: 'ai-processing', name: '요구 분석' },
      { key: 'spec', type: 'ai-processing', name: '명세 작성' },
    ],
  },
  {
    code: 'DEV-002',
    key: 'dev-impact-analysis',
    name: '영향도 분석 Agent',
    category: 'development',
    health: 'healthy',
    nodes: [
      { key: 'scan', type: 'ai-processing', name: '코드 스캔' },
      { key: 'report', type: 'report', name: '리포트' },
    ],
  },
  {
    code: 'DEV-003',
    key: 'dev-coding-agent',
    name: 'Dev Agent',
    category: 'development',
    health: 'degraded',
    nodes: [
      { key: 'plan', type: 'ai-processing', name: '계획' },
      { key: 'code', type: 'ai-processing', name: '코드 작성' },
      { key: 'review', type: 'ai-processing', name: '리뷰' },
    ],
  },
  {
    code: 'DEV-004',
    key: 'dev-test-agent',
    name: 'Test Agent',
    category: 'development',
    health: 'healthy',
    nodes: [
      { key: 'gen', type: 'ai-processing', name: '테스트 생성' },
      { key: 'run', type: 'ai-processing', name: '실행' },
    ],
  },
  // 편의 3
  {
    code: 'EXT-001',
    key: 'ext-query-buddy',
    name: 'QueryBuddy',
    category: 'utility',
    health: 'healthy',
    nodes: [
      { key: 'nl2sql', type: 'ai-processing', name: 'NL→SQL' },
      { key: 'exec', type: 'data-storage', name: '쿼리 실행' },
    ],
  },
  {
    code: 'EXT-002',
    key: 'ext-sr-routing',
    name: 'SR Routing',
    category: 'utility',
    health: 'healthy',
    nodes: [
      { key: 'classify', type: 'ai-processing', name: '분류' },
      { key: 'route', type: 'condition', name: '라우팅' },
    ],
  },
  {
    code: 'EXT-003',
    key: 'ext-sr-impact',
    name: 'SR 영향도',
    category: 'utility',
    health: 'down',
    nodes: [{ key: 'assess', type: 'ai-processing', name: '영향 평가' }],
  },
];

const EFFECTIVENESS: Record<string, any> = {
  'ops-test-automation': {
    system: 'CI/CD 파이프라인',
    manualMinutesPerRun: 60,
    domain: '회귀 테스트',
    coverageTargetX: 3,
    valueLabel: '테스트 시간 절감',
  },
  'ops-service-monitoring': {
    system: '통합관제 시스템',
    manualMinutesPerRun: 30,
    domain: '서비스 모니터링',
    mttdTargetPct: 80,
    valueLabel: '모니터링 시간 절감',
  },
  'ops-campaign-monitoring': {
    system: '마케팅 캠페인 플랫폼',
    manualMinutesPerRun: 25,
    domain: '캠페인 모니터링',
    valueLabel: '모니터링 시간 절감',
  },
  'ops-change-impact': {
    system: '형상관리/배포 시스템',
    manualMinutesPerRun: 90,
    domain: '변경 영향도',
    valueLabel: '영향도 분석 시간 절감',
  },
  'ops-event-response': {
    system: '통합관제 시스템',
    manualMinutesPerRun: 45,
    domain: '이벤트 대응',
    mttdTargetPct: 70,
    valueLabel: '대응 시간 절감',
  },
  'ops-knowledge-mgmt': {
    system: '지식관리 포털',
    manualMinutesPerRun: 40,
    domain: '지식 자산화',
    valueLabel: '문서화 시간 절감',
  },
  'ops-quality-guardian': {
    system: '품질 게이트',
    manualMinutesPerRun: 35,
    domain: '품질 게이트',
    coverageTargetX: 2,
    valueLabel: '품질 점검 시간 절감',
  },
  'dev-spec-agent': {
    system: '형상관리/배포 시스템',
    manualMinutesPerRun: 90,
    domain: '명세/IA 문서',
    valueLabel: 'IA 문서 작성 시간 절감',
  },
  'dev-impact-analysis': {
    system: '형상관리/배포 시스템',
    manualMinutesPerRun: 120,
    domain: '영향도 분석',
    valueLabel: '영향도 분석 시간 절감',
  },
  'dev-coding-agent': {
    system: '형상관리/배포 시스템',
    manualMinutesPerRun: 150,
    domain: '코드 작성/리뷰',
    valueLabel: '개발 시간 절감',
  },
  'dev-test-agent': {
    system: '품질 게이트',
    manualMinutesPerRun: 60,
    domain: '테스트 생성',
    coverageTargetX: 3,
    valueLabel: '테스트 시간 절감',
  },
  'ext-query-buddy': {
    system: '데이터 분석 포털',
    manualMinutesPerRun: 20,
    domain: 'SQL 질의',
    valueLabel: '질의 시간 절감',
  },
  'ext-sr-routing': {
    system: 'SR/ITSM 시스템',
    manualMinutesPerRun: 15,
    domain: 'SR 라우팅',
    valueLabel: '분류 시간 절감',
  },
  'ext-sr-impact': {
    system: 'SR/ITSM 시스템',
    manualMinutesPerRun: 30,
    domain: 'SR 영향도',
    valueLabel: '영향 평가 시간 절감',
  },
};

export async function seedDashboard(prisma: PrismaClient, tenantId: string, createdById: string) {
  const p = prisma as any;
  let seed = 20260530;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
  const DAYS = 30;

  // health → 품질/성공/이상 분포
  const profile = (h: AgentDef['health']) => {
    if (h === 'healthy')
      return {
        scoreBase: 88,
        scoreVar: 8,
        successRate: 0.97,
        anomalyRate: 0.03,
        secRisk: ['low', 'low', 'low', 'medium'],
      };
    if (h === 'degraded')
      return {
        scoreBase: 68,
        scoreVar: 12,
        successRate: 0.85,
        anomalyRate: 0.18,
        secRisk: ['low', 'medium', 'medium', 'high'],
      };
    return {
      scoreBase: 38,
      scoreVar: 15,
      successRate: 0.55,
      anomalyRate: 0.45,
      secRisk: ['medium', 'high', 'high', 'critical'],
    };
  };
  const models = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'gpt-4o-mini'];

  let wfCount = 0,
    sessionCount = 0,
    evalCount = 0,
    alertCount = 0,
    signalCount = 0;

  for (const agent of DASHBOARD_AGENTS) {
    // ── main agent = Workflow ──
    // 사용자가 기준정보에서 저장한 값(특히 launchUrl)을 시드가 덮어쓰지 않도록,
    // 기존 effectivenessJson 을 먼저 읽어 시드 기본값 위에 '사용자 값 우선'으로 병합한다.
    const existingWf = await p.workflow.findUnique({
      where: { tenantId_key: { tenantId, key: agent.key } },
      select: { effectivenessJson: true },
    });
    const baseEff = (EFFECTIVENESS[agent.key] ?? null) as any;
    const prevEff = (existingWf?.effectivenessJson as any) ?? null;
    const mergedEff =
      prevEff && typeof prevEff === 'object'
        ? { ...(baseEff ?? {}), ...prevEff } // 사용자 편집값(launchUrl 등) 우선 보존
        : baseEff;
    const wf = await p.workflow.upsert({
      where: { tenantId_key: { tenantId, key: agent.key } },
      update: {
        code: agent.code,
        name: agent.name,
        status: 'PUBLISHED',
        tags: [agent.category],
        updatedById: createdById,
        effectivenessJson: mergedEff,
        system: (mergedEff as any)?.system ?? EFFECTIVENESS[agent.key]?.system ?? null,
        listed: true,
      },
      create: {
        tenantId,
        key: agent.key,
        code: agent.code,
        name: agent.name,
        description: `${agent.name} (${agent.code})`,
        status: 'PUBLISHED',
        tags: [agent.category],
        createdById,
        updatedById: createdById,
        effectivenessJson: baseEff,
        system: EFFECTIVENESS[agent.key]?.system ?? null,
        listed: true,
      },
    });
    wfCount++;

    // ── sub agents = nodes ──
    for (let i = 0; i < agent.nodes.length; i++) {
      const n = agent.nodes[i];
      await p.workflowNodeDef.upsert({
        where: { workflowId_nodeKey: { workflowId: wf.id, nodeKey: n.key } },
        update: { uiType: n.type, name: n.name, executionOrder: i + 1 },
        create: {
          workflowId: wf.id,
          nodeKey: n.key,
          uiType: n.type,
          name: n.name,
          executionOrder: i + 1,
          dependsOn: i > 0 ? [agent.nodes[i - 1].key] : [],
        },
      });
    }

    const prof = profile(agent.health);

    // idempotency: clear ONLY previously *seeded* executions (inputJson.seeded=true)
    // so re-runs don't duplicate. 사용자의 실제 실행 이력은 절대 지우지 않는다.
    const priorSessions = await p.executionSession.findMany({
      where: {
        tenantId,
        workflowKey: agent.key,
        inputJson: { path: ['seeded'], equals: true },
      },
      select: { id: true },
    });
    const priorIds = priorSessions.map((s: { id: string }) => s.id);
    if (priorIds.length > 0) {
      await p.agentEvaluation.deleteMany({ where: { executionSessionId: { in: priorIds } } });
      await p.executionStep.deleteMany({ where: { executionSessionId: { in: priorIds } } });
      // 시드 알림은 correlationId=session.id 로 달려있으므로 시드 세션에 묶인 것만 정리.
      await p.fDSAlert.deleteMany({ where: { tenantId, correlationId: { in: priorIds } } });
      await p.executionSession.deleteMany({ where: { id: { in: priorIds } } });
    }

    // ── 30일 실행/평가 이력 ──
    for (let d = DAYS; d >= 0; d--) {
      const isWeekend = (() => {
        const dt = new Date();
        dt.setDate(dt.getDate() - d);
        const w = dt.getDay();
        return w === 0 || w === 6;
      })();
      const runsToday = Math.max(0, Math.round((isWeekend ? 1 : 3) * (0.5 + rnd())));
      for (let r = 0; r < runsToday; r++) {
        const ts = new Date();
        ts.setDate(ts.getDate() - d);
        ts.setHours(9 + Math.floor(rnd() * 9), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
        const success = rnd() < prof.successRate;
        const status = success ? 'SUCCEEDED' : rnd() < 0.7 ? 'FAILED' : 'BLOCKED';
        const latency = Math.floor(
          (agent.health === 'down' ? 4000 : agent.health === 'degraded' ? 1800 : 600) *
            (0.6 + rnd()),
        );
        const cost = Math.round((0.002 + rnd() * 0.03) * 10000) / 10000;

        const session = await p.executionSession.create({
          data: {
            tenantId,
            workflowKey: agent.key,
            capabilityKey: agent.nodes[0]?.type ?? 'task',
            status,
            startedAt: ts,
            endedAt: new Date(ts.getTime() + latency),
            completedAt: new Date(ts.getTime() + latency),
            triggeredById: createdById,
            latencyMs: latency,
            costUsd: cost,
            inputJson: { seeded: true },
            createdAt: ts,
          },
        });
        sessionCount++;

        // 노드별 step + 평가
        for (let i = 0; i < agent.nodes.length; i++) {
          const n = agent.nodes[i];
          const nodeLatency = Math.floor(latency / agent.nodes.length);
          const nodeOk = success || i < agent.nodes.length - 1; // 실패는 마지막 노드에서
          await p.executionStep.create({
            data: {
              executionSessionId: session.id,
              stepKey: n.key,
              stepType: n.type,
              capabilityKey: n.type,
              status: nodeOk ? 'SUCCEEDED' : 'FAILED',
              startedAt: ts,
              endedAt: new Date(ts.getTime() + nodeLatency),
              inputJson: { node: n.key },
              outputJson: { ok: nodeOk },
              latencyMs: nodeLatency,
            },
          });

          const score = Math.max(
            5,
            Math.min(
              99,
              Math.round(prof.scoreBase + (rnd() - 0.5) * 2 * prof.scoreVar - (nodeOk ? 0 : 25)),
            ),
          );
          const anomaly = rnd() < prof.anomalyRate;
          // Deterministic variety across the 5 anomaly types so the Anomalies
          // heatmap + risk overview show a realistic distribution. Uses rnd()
          // (seeded) so re-runs are stable.
          const ANOM_TYPES = [
            'latency_trend',
            'accuracy_drift',
            'token_spike',
            'error_surge',
            'security_pattern',
          ] as const;
          const anomTypeIdx = Math.floor(rnd() * ANOM_TYPES.length) % ANOM_TYPES.length;
          const anomType = ANOM_TYPES[anomTypeIdx];
          const anomSeverity = rnd() < 0.35 ? 'critical' : 'warning';
          const ANOM_META: Record<
            (typeof ANOM_TYPES)[number],
            { detail: string; algorithm: string; value: number; threshold: number }
          > = {
            latency_trend: {
              detail: '지연시간 상승 추세 감지',
              algorithm: 'linear_regression',
              value: Math.round((0.06 + rnd() * 0.2) * 1000) / 1000,
              threshold: 0.05,
            },
            accuracy_drift: {
              detail: '정확도 드리프트(기준선 이탈)',
              algorithm: 'z-score',
              value: Math.round((2.6 + rnd() * 2) * 100) / 100,
              threshold: 2.5,
            },
            token_spike: {
              detail: '토큰 사용량 급증(IQR 초과)',
              algorithm: 'iqr',
              value: Math.floor(3000 + rnd() * 5000),
              threshold: 2.0,
            },
            error_surge: {
              detail: '오류율 급증 감지',
              algorithm: 'ratio',
              value: Math.round((0.22 + rnd() * 0.3) * 100) / 100,
              threshold: 0.2,
            },
            security_pattern: {
              detail: '보안 위협 패턴 비율 이탈',
              algorithm: 'z-score',
              value: Math.round((2.7 + rnd() * 1.5) * 100) / 100,
              threshold: 2.5,
            },
          };
          const anomMeta = ANOM_META[anomType];
          const risk = pick(prof.secRisk);
          const grade =
            score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
          const inputThreats =
            risk === 'high' || risk === 'critical' ? Math.floor(rnd() * 2) + 1 : 0;
          const leaks = risk === 'critical' ? 1 : 0;

          await p.agentEvaluation.create({
            data: {
              tenantId,
              executionSessionId: session.id,
              workflowKey: agent.key,
              stepKey: n.key,
              nodeType: n.type,
              // Sub-Agent(노드) 고유 이름 — 메인 Agent명이 아니라 노드명이라야
              // 대시보드 Sub-Agent 목록/필터가 노드별로 구분된다.
              agentName: n.name,
              overallScore: score,
              accuracyScore: Math.min(1, score / 100 + (rnd() - 0.5) * 0.1),
              hallucationRate: Math.max(0, (100 - score) / 300 + rnd() * 0.05),
              responseQuality: Math.round((score / 20) * 10) / 10,
              qualityGrade: grade,
              securityScore:
                risk === 'critical' ? 25 : risk === 'high' ? 55 : risk === 'medium' ? 75 : 92,
              inputThreatCount: inputThreats,
              outputLeakageCount: leaks,
              toolChainRisk: risk === 'critical',
              securityRiskLevel: risk,
              anomalyDetected: anomaly,
              anomalyEvents: anomaly
                ? [
                    {
                      type: anomType,
                      severity: anomSeverity,
                      detail: anomMeta.detail,
                      value: anomMeta.value,
                      threshold: anomMeta.threshold,
                      algorithm: anomMeta.algorithm,
                      detectedAt: ts.toISOString(),
                      suggestedAction: '기준선 재학습 및 입력 데이터 품질 점검',
                    },
                  ]
                : undefined,
              executionTimeMs: nodeLatency,
              tokensUsed: Math.floor(200 + rnd() * 3000),
              estimatedCostUsd: Math.round((cost / agent.nodes.length) * 10000) / 10000,
              costEfficiency: Math.min(1, 0.5 + rnd() * 0.5),
              latencyGrade: nodeLatency <= 1500 ? 'fast' : nodeLatency <= 3000 ? 'normal' : 'slow',
              evaluationEngine: 'seed-v1',
              gatesApplied: ['quality', 'security', 'cost', 'anomaly'],
              createdAt: ts,
            },
          });
          evalCount++;

          // 정책 위반 → FDS 알람 (보안 high/critical 또는 점수<50)
          if (risk === 'high' || risk === 'critical' || score < 50) {
            const sev =
              risk === 'critical' ? 'CRITICAL' : risk === 'high' || score < 25 ? 'HIGH' : 'MEDIUM';
            // ~60% of alerts get RESOLVED with a deterministic resolution time
            // (createdAt + 0.5~8h) so MTTR has real data; ~40% stay OPEN.
            const isResolved = rnd() < 0.6;
            const resolveHours = 0.5 + rnd() * 7.5; // 0.5h .. 8h
            const resolvedAt = isResolved ? new Date(ts.getTime() + resolveHours * 3600000) : null;
            try {
              await p.fDSAlert.create({
                data: {
                  tenantId,
                  severity: sev,
                  status: isResolved ? 'RESOLVED' : 'OPEN',
                  subjectType: 'Agent',
                  subjectId: agent.key,
                  score: risk === 'critical' ? 0.95 : 0.75,
                  summary: `${agent.name} 보안/품질 위반 감지 (위험도 ${risk}, 점수 ${score})`,
                  detailsJson: {
                    workflowKey: agent.key,
                    stepKey: n.key,
                    score,
                    risk,
                    inputThreats,
                    leaks,
                    anomaly,
                  },
                  correlationId: session.id,
                  createdAt: ts,
                  resolvedAt,
                },
              });
              alertCount++;
            } catch {
              /* alert may already exist; ignore */
            }
          }
        }
      }
    }
  }

  // ── Effectiveness Signals: MEASURED MTTD (DETECTION) + coverage (COVERAGE) ──
  // source #3 (seed). Deterministic via rnd(). ~12-18 rows per relevant agent
  // across the 30-day window so signal-based averages are stable.
  const DETECTION_AGENTS = [
    'ops-service-monitoring',
    'ops-event-response',
    'ops-campaign-monitoring',
  ];
  const COVERAGE_AGENTS = ['ops-test-automation', 'dev-test-agent', 'ops-quality-guardian'];
  try {
    // Idempotency: seed regenerates → clear prior seeded signals for these keys.
    await p.effectivenessSignal.deleteMany({
      where: { tenantId, source: 'seed' },
    });

    const detRows: any[] = [];
    for (const key of DETECTION_AGENTS) {
      const n = 12 + Math.floor(rnd() * 7); // 12..18
      for (let i = 0; i < n; i++) {
        const dayBack = Math.floor(rnd() * DAYS);
        const detectedAt = new Date();
        detectedAt.setDate(detectedAt.getDate() - dayBack);
        detectedAt.setHours(8 + Math.floor(rnd() * 11), Math.floor(rnd() * 60), 0, 0);
        const detectSeconds = 30 + Math.floor(rnd() * 871); // 30..900s
        const occurredAt = new Date(detectedAt.getTime() - detectSeconds * 1000);
        detRows.push({
          tenantId,
          workflowKey: key,
          stepKey: 'detect',
          kind: 'DETECTION',
          occurredAt,
          detectedAt,
          detectSeconds,
          source: 'seed',
          createdAt: detectedAt,
          detailsJson: { seeded: true, signal: 'mttd' },
        });
      }
    }

    const covRows: any[] = [];
    for (const key of COVERAGE_AGENTS) {
      const n = 12 + Math.floor(rnd() * 7); // 12..18
      for (let i = 0; i < n; i++) {
        const dayBack = Math.floor(rnd() * DAYS);
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - dayBack);
        createdAt.setHours(8 + Math.floor(rnd() * 11), Math.floor(rnd() * 60), 0, 0);
        const testsTotal = 50 + Math.floor(rnd() * 351); // 50..400
        const passRate = 0.85 + rnd() * 0.14; // 85%..99%
        const testsPassed = Math.min(testsTotal, Math.round(testsTotal * passRate));
        const coveragePct = Math.round((60 + rnd() * 35) * 100) / 100; // 60..95
        covRows.push({
          tenantId,
          workflowKey: key,
          stepKey: 'run',
          kind: 'COVERAGE',
          testsTotal,
          testsPassed,
          coveragePct,
          source: 'seed',
          createdAt,
          detailsJson: { seeded: true, signal: 'coverage' },
        });
      }
    }

    if (detRows.length || covRows.length) {
      await p.effectivenessSignal.createMany({ data: [...detRows, ...covRows] });
      signalCount = detRows.length + covRows.length;
    }
  } catch {
    /* effectivenessSignal table may not exist yet (pre db push); ignore */
  }

  // ── Scenario 1: seed a few ErrorPattern knowledge rows (idempotent upsert) ──
  const ERR_PATTERNS = [
    {
      workflowKey: 'ops-event-response',
      stepKey: 'remediate',
      category: 'execution',
      severity: 'critical',
      signature: 'execution:ops-event-response:remediate:deploy timeout',
      sampleMessage: '조치 단계 배포 타임아웃 (git-deploy)',
      recommendation: '배포 타임아웃 임계값 상향 및 롤백 자동화 검토',
    },
    {
      workflowKey: 'ext-sr-impact',
      stepKey: 'assess',
      category: 'quality',
      severity: 'warning',
      signature: 'quality:ext-sr-impact:assess:low factual accuracy',
      sampleMessage: 'SR 영향 평가 사실정확도 저하(F등급)',
      recommendation: '근거 컨텍스트 보강 및 프롬프트에 출처 명시 요구',
    },
    {
      workflowKey: 'ops-campaign-monitoring',
      stepKey: 'eval',
      category: 'anomaly',
      severity: 'warning',
      signature: 'anomaly:ops-campaign-monitoring:eval:accuracy drift',
      sampleMessage: '캠페인 성과 평가 정확도 드리프트 감지',
      recommendation: '기준선 재학습 및 입력 데이터 품질 점검',
    },
  ];
  let errPatCount = 0;
  for (const ep of ERR_PATTERNS) {
    try {
      await p.errorPattern.upsert({
        where: { tenantId_signature: { tenantId, signature: ep.signature } },
        update: { occurrences: { increment: 1 }, lastSeenAt: new Date() },
        create: {
          tenantId,
          workflowKey: ep.workflowKey,
          stepKey: ep.stepKey,
          signature: ep.signature,
          category: ep.category,
          severity: ep.severity,
          occurrences: Math.floor(2 + rnd() * 6),
          sampleMessage: ep.sampleMessage,
          recommendation: ep.recommendation,
          status: 'OPEN',
        },
      });
      errPatCount++;
    } catch {
      /* errorPattern table may not exist yet (pre db push); ignore */
    }
  }

  // ── Operational Knowledge Management: artifacts + usage distribution ──
  await seedKnowledge(prisma, tenantId, createdById, rnd);

  console.log(
    `  Dashboard: ${wfCount} workflows, ${sessionCount} sessions, ${evalCount} evals, ${alertCount} alerts, ${errPatCount} errorPatterns, ${signalCount} effectivenessSignals`,
  );
}

// ══════════════════════════════════════════════════════════════════
//  Operational Knowledge Management seed
//  - ACTIVE KnowledgeArtifacts (MANUAL + AUTO_ERROR), varied categories,
//    scopeJson targeting seeded workflowKeys.
//  - KnowledgeUsage rows producing a realistic "많이 쓰임 / 안 쓰임" spread:
//    some artifacts with many usages, some with zero.
//  Idempotent: upsert artifacts by tenantId_key; usage is reset to a
//  deterministic count per artifact on each run.
// ══════════════════════════════════════════════════════════════════
interface SeedArtifact {
  key: string;
  title: string;
  category: string; // SECURITY | QUALITY | RUNBOOK | ERROR_PATTERN | COST
  source: 'MANUAL' | 'AUTO_ERROR' | 'EVALUATION';
  priority: number;
  tags: string[];
  scope: { global?: boolean; workflowKeys?: string[]; categories?: string[] };
  content: string;
  // deterministic usage count to seed (0 = unused/cleanup candidate)
  usages: number;
  // map usages across these agents (workflowKey + display name)
  agents: { workflowKey: string; name: string; stepKey?: string }[];
}

const SEED_ARTIFACTS: SeedArtifact[] = [
  {
    key: 'kn-deploy-timeout-runbook',
    title: '배포 타임아웃 대응 런북',
    category: 'RUNBOOK',
    source: 'MANUAL',
    priority: 10,
    tags: ['배포', '타임아웃', '롤백'],
    scope: { global: false, workflowKeys: ['ops-event-response'] },
    content:
      '## 배포 타임아웃 대응\n1. 배포 파이프라인 단계별 소요시간 확인\n2. 타임아웃 임계값(기본 300s) 일시 상향\n3. 실패 시 직전 안정 버전으로 자동 롤백\n4. 사후 원인분석(RCA) 티켓 생성',
    usages: 42,
    agents: [
      {
        workflowKey: 'ops-event-response',
        name: 'OPS-005 이벤트 대응 Agent',
        stepKey: 'remediate',
      },
    ],
  },
  {
    key: 'kn-secret-handling-policy',
    title: '민감정보/시크릿 취급 보안 가이드',
    category: 'SECURITY',
    source: 'MANUAL',
    priority: 9,
    tags: ['보안', '시크릿', 'PII'],
    scope: { global: true },
    content:
      '## 시크릿 취급 원칙\n- API 키/토큰은 환경변수 또는 시크릿 매니저에서만 로드\n- 프롬프트/로그에 평문 시크릿 출력 금지\n- 출력에 PII가 포함되면 마스킹 후 반환',
    usages: 35,
    agents: [
      { workflowKey: 'dev-coding-agent', name: 'DEV-003 Dev Agent', stepKey: 'review' },
      { workflowKey: 'ops-quality-guardian', name: 'OPS-007 품질가디언 Agent', stepKey: 'scan' },
    ],
  },
  {
    key: 'kn-coding-review-checklist',
    title: '코드 리뷰 품질 체크리스트',
    category: 'QUALITY',
    source: 'MANUAL',
    priority: 7,
    tags: ['코드리뷰', '품질', '테스트'],
    scope: { global: false, workflowKeys: ['dev-coding-agent', 'dev-test-agent'] },
    content:
      '## 코드 리뷰 체크\n- 경계조건/예외처리 누락 여부\n- N+1 쿼리 및 불필요한 동기 호출\n- 테스트 커버리지 신규 코드 80% 이상\n- 시크릿/하드코딩 값 부재',
    usages: 28,
    agents: [
      { workflowKey: 'dev-coding-agent', name: 'DEV-003 Dev Agent', stepKey: 'review' },
      { workflowKey: 'dev-test-agent', name: 'DEV-004 Test Agent', stepKey: 'gen' },
    ],
  },
  {
    key: 'kn-deploy-timeout-pattern',
    title: '[오류패턴] 배포 단계 타임아웃 자동수집',
    category: 'ERROR_PATTERN',
    source: 'AUTO_ERROR',
    priority: 6,
    tags: ['error-pattern', 'execution', '배포'],
    scope: { global: false, workflowKeys: ['ops-event-response'] },
    content:
      '## 자동수집 오류패턴\n- 시그니처: execution:ops-event-response:remediate:deploy timeout\n- 권고: 타임아웃 임계값 상향 + 롤백 자동화',
    usages: 14,
    agents: [
      {
        workflowKey: 'ops-event-response',
        name: 'OPS-005 이벤트 대응 Agent',
        stepKey: 'remediate',
      },
    ],
  },
  {
    key: 'kn-accuracy-drift-pattern',
    title: '[오류패턴] 정확도 드리프트 자동수집',
    category: 'ERROR_PATTERN',
    source: 'AUTO_ERROR',
    priority: 5,
    tags: ['error-pattern', 'anomaly', '정확도'],
    scope: { global: false, workflowKeys: ['ops-campaign-monitoring'] },
    content:
      '## 자동수집 오류패턴\n- 시그니처: anomaly:ops-campaign-monitoring:eval:accuracy drift\n- 권고: 기준선 재학습 + 입력 데이터 품질 점검',
    usages: 6,
    agents: [
      {
        workflowKey: 'ops-campaign-monitoring',
        name: 'OPS-003 캠페인 모니터링 Agent',
        stepKey: 'eval',
      },
    ],
  },
  {
    key: 'kn-cost-budget-guide',
    title: '실행 비용 예산 가이드 (FinOps)',
    category: 'COST',
    source: 'EVALUATION',
    priority: 4,
    tags: ['비용', '예산', 'finops'],
    scope: { global: true },
    content:
      '## 비용 가이드\n- 실행당 비용 임계값 초과 시 경량 모델로 폴백\n- 동일 입력 캐시 활용\n- 토큰 사용량 모니터링 및 프롬프트 압축',
    usages: 3,
    agents: [{ workflowKey: 'ext-query-buddy', name: 'EXT-001 QueryBuddy', stepKey: 'nl2sql' }],
  },
  {
    key: 'kn-legacy-onprem-runbook',
    title: '레거시 온프레미스 점검 런북 (구형)',
    category: 'RUNBOOK',
    source: 'MANUAL',
    priority: 1,
    tags: ['레거시', '온프레미스'],
    scope: { global: false, workflowKeys: ['ops-service-monitoring'] },
    content: '## 레거시 점검\n- 구형 절차로 현재 거의 사용되지 않음. 정리(아카이브) 후보.',
    usages: 0,
    agents: [
      {
        workflowKey: 'ops-service-monitoring',
        name: 'OPS-002 서비스 모니터링 Agent',
        stepKey: 'probe',
      },
    ],
  },
  {
    key: 'kn-deprecated-sql-tips',
    title: 'SQL 작성 팁 (미사용)',
    category: 'QUALITY',
    source: 'MANUAL',
    priority: 0,
    tags: ['sql', '미사용'],
    scope: { global: false, workflowKeys: ['ext-query-buddy'] },
    content: '## SQL 팁\n- 초기 작성 후 활용되지 않은 지식. 활용도 점검 대상.',
    usages: 0,
    agents: [{ workflowKey: 'ext-query-buddy', name: 'EXT-001 QueryBuddy', stepKey: 'nl2sql' }],
  },
];

async function seedKnowledge(
  prisma: PrismaClient,
  tenantId: string,
  createdById: string,
  rnd: () => number,
) {
  const p = prisma as any;
  let artCount = 0;
  let usageCount = 0;

  for (const a of SEED_ARTIFACTS) {
    const lastUsedAt =
      a.usages > 0 ? new Date(Date.now() - Math.floor(rnd() * 10) * 24 * 60 * 60 * 1000) : null;

    let artifact: { id: string };
    try {
      artifact = await p.knowledgeArtifact.upsert({
        where: { tenantId_key: { tenantId, key: a.key } },
        update: {
          title: a.title,
          category: a.category,
          status: 'ACTIVE',
          source: a.source,
          priority: a.priority,
          content: a.content,
          tags: a.tags,
          scopeJson: a.scope,
          usageCount: a.usages,
          lastUsedAt,
        },
        create: {
          tenantId,
          key: a.key,
          title: a.title,
          category: a.category,
          status: 'ACTIVE',
          version: 'v1',
          source: a.source,
          priority: a.priority,
          content: a.content,
          tags: a.tags,
          scopeJson: a.scope,
          usageCount: a.usages,
          lastUsedAt,
          createdById,
        },
      });
      artCount++;
    } catch {
      // table may not exist before db push; skip the rest
      continue;
    }

    // Reset usage rows for determinism, then create a fixed number.
    try {
      await p.knowledgeUsage.deleteMany({ where: { tenantId, artifactId: artifact.id } });
      const rows = [];
      for (let i = 0; i < a.usages; i++) {
        const agent = a.agents[i % a.agents.length];
        const usedAt = new Date(
          Date.now() - Math.floor((i / Math.max(1, a.usages)) * 28) * 24 * 60 * 60 * 1000,
        );
        rows.push({
          tenantId,
          artifactId: artifact.id,
          workflowKey: agent.workflowKey,
          stepKey: agent.stepKey ?? null,
          agentName: agent.name,
          usedAt,
        });
      }
      if (rows.length > 0) {
        await p.knowledgeUsage.createMany({ data: rows });
        usageCount += rows.length;
      }
    } catch {
      /* knowledgeUsage table may not exist yet; ignore */
    }
  }

  console.log(`  Knowledge: ${artCount} artifacts, ${usageCount} usage records`);
}
