/**
 * seed-agents.ts — Ops.AI PPT 기반 14개 Main Agent + 27개 Sub Agent 시드 데이터
 *
 * 운영 Agent 7건 (OPS-001 ~ OPS-007)
 * 개발 Agent 4건 (DEV-001 ~ DEV-004)
 * 고도화 Agent 3건 (EXT-001 ~ EXT-003)
 *
 * 각 Agent는 AgentDefinition 테이블에 upsert 되며,
 * Sub Agent 정보는 kernelConfigJson.subAgents에 포함됩니다.
 *
 * 또한 3건의 샘플 ORB Review 데이터를 생성합니다.
 *   - OPS-002 서비스 모니터링: approved (82점)
 *   - DEV-003 Dev Agent: conditional (63점)
 *   - EXT-001 QueryBuddy: pending (심사 전)
 */

// ────────────────────────────────────────────────────────────────
// Agent definition data
// ────────────────────────────────────────────────────────────────

interface AgentSeedDef {
  code: string;
  key: string;
  name: string;
  category: string;
  description: string;
  capabilities: string[];
  subAgents: string[];
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  defaultTimeoutSec: number;
  totalInvocations: number;
  lastSuccessRate: number;
}

const AGENT_DEFINITIONS: AgentSeedDef[] = [
  // ════════════════════════════════════════════════════════════════
  //  운영 Agent (7건)
  // ════════════════════════════════════════════════════════════════
  {
    code: 'OPS-001',
    key: 'ops-test-automation',
    name: '테스트 자동화 Agent',
    category: 'operations',
    description:
      '서비스 배포 전후 자동화 테스트를 수행합니다. 시나리오 기반 E2E 테스트, API 회귀 테스트, 성능 부하 테스트를 자동 실행하고 결과를 리포트합니다. Sub Agent로 시나리오 생성기와 결과 분석기를 포함합니다.',
    capabilities: [
      'test-execution',
      'regression-test',
      'e2e-test',
      'performance-test',
      'report-generation',
    ],
    subAgents: ['시나리오 생성기', '결과 분석기'],
    inputSchema: {
      type: 'object',
      properties: {
        testType: { type: 'string', enum: ['e2e', 'api', 'performance', 'regression'] },
        targetService: { type: 'string' },
        scenarios: { type: 'array', items: { type: 'object' } },
        config: {
          type: 'object',
          properties: {
            maxDurationSec: { type: 'number' },
            parallelism: { type: 'number' },
          },
        },
      },
      required: ['testType', 'targetService'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        totalTests: { type: 'number' },
        passed: { type: 'number' },
        failed: { type: 'number' },
        duration: { type: 'number' },
        report: { type: 'object' },
        failedDetails: { type: 'array', items: { type: 'object' } },
      },
    },
    defaultTimeoutSec: 120,
    totalInvocations: 342,
    lastSuccessRate: 0.96,
  },
  {
    code: 'OPS-002',
    key: 'ops-service-monitoring',
    name: '서비스 모니터링 Agent',
    category: 'operations',
    description:
      '운영 서비스의 가용성, 성능, 이상 징후를 실시간 모니터링합니다. 웹 점검, 이상 탐지, 로그 분석, KOS 통합, B-OS/B-MON 연동, 서류 검증 등 6개 Sub Agent를 통해 종합적인 운영 감시를 수행합니다.',
    capabilities: [
      'monitoring',
      'log-analysis',
      'alert-detection',
      'web-check',
      'anomaly-detection',
      'kos-integration',
    ],
    subAgents: ['웹점검', '이상탐지', '로그분석', 'KOS통합', 'B-OS/B-MON', '서류검증'],
    inputSchema: {
      type: 'object',
      properties: {
        monitoringTarget: { type: 'string' },
        checkType: { type: 'string', enum: ['web', 'anomaly', 'log', 'kos', 'bos', 'document'] },
        thresholds: {
          type: 'object',
          properties: {
            responseTimeMs: { type: 'number' },
            errorRate: { type: 'number' },
            cpuPct: { type: 'number' },
            memoryPct: { type: 'number' },
          },
        },
        timeRange: { type: 'string' },
      },
      required: ['monitoringTarget'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['healthy', 'warning', 'critical'] },
        metrics: { type: 'object' },
        alerts: { type: 'array', items: { type: 'object' } },
        recommendations: { type: 'array', items: { type: 'string' } },
      },
    },
    defaultTimeoutSec: 60,
    totalInvocations: 12847,
    lastSuccessRate: 0.99,
  },
  {
    code: 'OPS-003',
    key: 'ops-campaign-monitoring',
    name: '캠페인 모니터링 Agent',
    category: 'operations',
    description:
      '마케팅 및 프로모션 캠페인의 실행 상태를 모니터링하고 이상 징후를 탐지합니다. 타겟 대상 오발송, 중복 발송, 발송량 이상 등을 실시간 감시하며 즉시 알림을 전달합니다.',
    capabilities: ['campaign-monitoring', 'anomaly-detection', 'alert-notification'],
    subAgents: ['캠페인 이상 탐지기'],
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        campaignType: { type: 'string', enum: ['email', 'sms', 'push', 'kakao'] },
        expectedVolume: { type: 'number' },
        monitoringWindow: { type: 'string' },
      },
      required: ['campaignId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sentCount: { type: 'number' },
        deliveredCount: { type: 'number' },
        anomalyDetected: { type: 'boolean' },
        anomalies: { type: 'array', items: { type: 'object' } },
        status: { type: 'string' },
      },
    },
    defaultTimeoutSec: 45,
    totalInvocations: 1256,
    lastSuccessRate: 0.97,
  },
  {
    code: 'OPS-004',
    key: 'ops-change-impact',
    name: '변경 영향도 Agent',
    category: 'operations',
    description:
      '시스템 변경(배포, 설정 변경, 인프라 변경) 시 영향 범위를 자동 분석합니다. 서비스 의존성 그래프를 기반으로 영향 받는 시스템과 업무를 식별하고 위험도를 산정합니다.',
    capabilities: ['impact-analysis', 'dependency-graph', 'risk-assessment', 'change-management'],
    subAgents: ['영향 범위 분석기'],
    inputSchema: {
      type: 'object',
      properties: {
        changeType: { type: 'string', enum: ['deploy', 'config', 'infra', 'schema', 'api'] },
        targetSystem: { type: 'string' },
        changeDescription: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
      },
      required: ['changeType', 'targetSystem'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        impactedSystems: { type: 'array', items: { type: 'string' } },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        impactScore: { type: 'number' },
        recommendations: { type: 'array', items: { type: 'string' } },
        dependencyMap: { type: 'object' },
      },
    },
    defaultTimeoutSec: 90,
    totalInvocations: 534,
    lastSuccessRate: 0.94,
  },
  {
    code: 'OPS-005',
    key: 'ops-event-response',
    name: '이벤트 대응 Agent',
    category: 'operations',
    description:
      '운영 이벤트(장애, 알림, 인시던트) 발생 시 자동 대응 절차를 수행합니다. 이벤트 분류, 1차 조치, 에스컬레이션, 후속 조치 가이드를 자동으로 제공합니다.',
    capabilities: ['event-classification', 'auto-response', 'escalation', 'incident-management'],
    subAgents: ['이벤트 대응 오케스트레이터'],
    inputSchema: {
      type: 'object',
      properties: {
        eventType: { type: 'string', enum: ['alert', 'incident', 'warning', 'notification'] },
        severity: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
        source: { type: 'string' },
        message: { type: 'string' },
        context: { type: 'object' },
      },
      required: ['eventType', 'severity', 'source', 'message'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['auto-resolved', 'escalated', 'manual-required'] },
        resolution: { type: 'string' },
        escalationTarget: { type: 'string' },
        timeline: { type: 'array', items: { type: 'object' } },
      },
    },
    defaultTimeoutSec: 30,
    totalInvocations: 2891,
    lastSuccessRate: 0.92,
  },
  {
    code: 'OPS-006',
    key: 'ops-knowledge-mgmt',
    name: '지식 자산화 Agent',
    category: 'operations',
    description:
      '운영 과정에서 축적된 장애 대응 이력, 해결 패턴, 운영 노하우를 체계적으로 분류하고 지식 베이스로 자산화합니다. 유사 장애 검색, 해결책 추천, 문서 자동 생성 Sub Agent를 포함합니다.',
    capabilities: [
      'knowledge-extraction',
      'pattern-recognition',
      'document-generation',
      'similarity-search',
    ],
    subAgents: ['유사 장애 검색기', '해결책 추천기', '문서 자동 생성기'],
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'classify', 'generate', 'recommend'] },
        query: { type: 'string' },
        incidentData: { type: 'object' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['action'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array', items: { type: 'object' } },
        confidence: { type: 'number' },
        generatedDoc: { type: 'string' },
        relatedArticles: { type: 'array', items: { type: 'string' } },
      },
    },
    defaultTimeoutSec: 60,
    totalInvocations: 876,
    lastSuccessRate: 0.95,
  },
  {
    code: 'OPS-007',
    key: 'ops-quality-guardian',
    name: '품질가디언 Agent',
    category: 'operations',
    description:
      '서비스 품질 지표(SLA, SLO, SLI)를 지속적으로 모니터링하고 품질 기준 미달 시 자동 경고 및 개선 권고를 제공합니다. 품질 트렌드 분석 및 리포트를 생성합니다.',
    capabilities: ['sla-monitoring', 'quality-analysis', 'trend-reporting', 'compliance-check'],
    subAgents: ['품질 트렌드 분석기'],
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string' },
        slaDefinition: {
          type: 'object',
          properties: {
            availability: { type: 'number' },
            latencyP95Ms: { type: 'number' },
            errorRatePct: { type: 'number' },
          },
        },
        period: { type: 'string' },
      },
      required: ['serviceId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        compliance: { type: 'boolean' },
        currentMetrics: { type: 'object' },
        violations: { type: 'array', items: { type: 'object' } },
        trendReport: { type: 'object' },
      },
    },
    defaultTimeoutSec: 45,
    totalInvocations: 4521,
    lastSuccessRate: 0.98,
  },

  // ════════════════════════════════════════════════════════════════
  //  개발 Agent (4건)
  // ════════════════════════════════════════════════════════════════
  {
    code: 'DEV-001',
    key: 'dev-spec-agent',
    name: 'Spec Agent',
    category: 'development',
    description:
      '요구사항 문서, 화면설계서, API 스펙으로부터 개발 스펙을 자동 생성합니다. 요구사항 추적 매트릭스(RTM) 생성, 스펙 일관성 검증, 누락 항목 식별을 수행합니다.',
    capabilities: ['spec-generation', 'requirement-tracing', 'consistency-check', 'gap-analysis'],
    subAgents: ['스펙 파서/생성기'],
    inputSchema: {
      type: 'object',
      properties: {
        sourceType: { type: 'string', enum: ['requirement', 'wireframe', 'api-doc', 'erd'] },
        sourceContent: { type: 'string' },
        outputFormat: { type: 'string', enum: ['markdown', 'json', 'yaml'] },
        existingSpecs: { type: 'array', items: { type: 'string' } },
      },
      required: ['sourceType', 'sourceContent'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object' },
        traceabilityMatrix: { type: 'array', items: { type: 'object' } },
        gaps: { type: 'array', items: { type: 'string' } },
        consistency: { type: 'object' },
      },
    },
    defaultTimeoutSec: 90,
    totalInvocations: 214,
    lastSuccessRate: 0.91,
  },
  {
    code: 'DEV-002',
    key: 'dev-impact-analysis',
    name: '영향도 분석 Agent',
    category: 'development',
    description:
      '코드 변경에 따른 영향도를 소스코드 레벨에서 분석합니다. AST 기반 호출 관계 분석, 데이터 흐름 추적, 테스트 커버리지 영향 범위 산출을 수행합니다. 코드 분석기와 테스트 영향 분석기 2개 Sub Agent를 포함합니다.',
    capabilities: [
      'code-analysis',
      'ast-parsing',
      'call-graph',
      'test-coverage-impact',
      'data-flow-tracking',
    ],
    subAgents: ['코드 의존성 분석기', '테스트 영향 분석기'],
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        branch: { type: 'string' },
        diff: { type: 'string' },
        language: { type: 'string', enum: ['typescript', 'java', 'python', 'kotlin'] },
      },
      required: ['repository', 'changedFiles'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        impactedFiles: { type: 'array', items: { type: 'string' } },
        impactedTests: { type: 'array', items: { type: 'string' } },
        callGraph: { type: 'object' },
        riskScore: { type: 'number' },
        coverageDelta: { type: 'number' },
      },
    },
    defaultTimeoutSec: 120,
    totalInvocations: 678,
    lastSuccessRate: 0.93,
  },
  {
    code: 'DEV-003',
    key: 'dev-coding-agent',
    name: 'Dev Agent',
    category: 'development',
    description:
      'AI 기반 코드 생성 및 리팩터링을 수행합니다. 코드 생성, 코드 리뷰, 리팩터링, 마이그레이션, 문서화 등 5개 Sub Agent를 통해 개발 생산성을 극대화합니다.',
    capabilities: ['code-generation', 'code-review', 'refactoring', 'migration', 'documentation'],
    subAgents: [
      '코드 생성기',
      '코드 리뷰어',
      '리팩터링 엔진',
      '마이그레이션 도우미',
      '문서화 생성기',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['generate', 'review', 'refactor', 'migrate', 'document'] },
        language: { type: 'string' },
        sourceCode: { type: 'string' },
        instructions: { type: 'string' },
        context: { type: 'object' },
        standards: { type: 'array', items: { type: 'string' } },
      },
      required: ['action', 'language'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        diff: { type: 'string' },
        reviewComments: { type: 'array', items: { type: 'object' } },
        qualityScore: { type: 'number' },
        suggestions: { type: 'array', items: { type: 'string' } },
      },
    },
    defaultTimeoutSec: 120,
    totalInvocations: 1543,
    lastSuccessRate: 0.89,
  },
  {
    code: 'DEV-004',
    key: 'dev-test-agent',
    name: 'Test Agent',
    category: 'development',
    description:
      '테스트 코드 자동 생성, 테스트 실행, 커버리지 분석, 테스트 리포트를 수행합니다. 단위 테스트, 통합 테스트, E2E 테스트, 성능 테스트 4개 Sub Agent를 통해 종합 테스트를 지원합니다.',
    capabilities: ['test-generation', 'test-execution', 'coverage-analysis', 'test-reporting'],
    subAgents: [
      '단위 테스트 생성기',
      '통합 테스트 생성기',
      'E2E 테스트 생성기',
      '성능 테스트 생성기',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['generate', 'execute', 'analyze', 'report'] },
        testType: { type: 'string', enum: ['unit', 'integration', 'e2e', 'performance'] },
        targetCode: { type: 'string' },
        framework: { type: 'string', enum: ['jest', 'vitest', 'playwright', 'k6'] },
        config: { type: 'object' },
      },
      required: ['action', 'testType'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        generatedTests: { type: 'array', items: { type: 'object' } },
        executionResult: { type: 'object' },
        coverage: { type: 'object' },
        report: { type: 'object' },
      },
    },
    defaultTimeoutSec: 120,
    totalInvocations: 987,
    lastSuccessRate: 0.94,
  },

  // ════════════════════════════════════════════════════════════════
  //  고도화 Agent (3건)
  // ════════════════════════════════════════════════════════════════
  {
    code: 'EXT-001',
    key: 'ext-query-buddy',
    name: 'QueryBuddy',
    category: 'operations',
    description:
      '자연어 질의를 SQL 쿼리로 자동 변환합니다. 데이터베이스 스키마를 학습하여 최적의 SQL을 생성하고, 실행 계획 분석과 쿼리 최적화 제안을 제공합니다.',
    capabilities: ['nl-to-sql', 'query-optimization', 'schema-analysis', 'execution-plan'],
    subAgents: ['SQL자동생성'],
    inputSchema: {
      type: 'object',
      properties: {
        naturalLanguageQuery: { type: 'string' },
        databaseType: { type: 'string', enum: ['postgresql', 'mysql', 'oracle', 'mssql'] },
        schemaContext: { type: 'object' },
        dialect: { type: 'string' },
      },
      required: ['naturalLanguageQuery'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        confidence: { type: 'number' },
        executionPlan: { type: 'object' },
        optimizationSuggestions: { type: 'array', items: { type: 'string' } },
        explanation: { type: 'string' },
      },
    },
    defaultTimeoutSec: 30,
    totalInvocations: 3254,
    lastSuccessRate: 0.91,
  },
  {
    code: 'EXT-002',
    key: 'ext-sr-routing',
    name: 'SR Routing',
    category: 'operations',
    description:
      'SR(Service Request)을 최적 담당 팀/개인에게 자동 라우팅합니다. SR 내용 분석, 과거 처리 이력 기반 학습, 담당자 가용성 및 역량을 고려한 최적 라우팅을 수행합니다.',
    capabilities: [
      'sr-classification',
      'routing-optimization',
      'workload-balancing',
      'history-learning',
    ],
    subAgents: ['라우팅최적화'],
    inputSchema: {
      type: 'object',
      properties: {
        srId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
        requester: { type: 'string' },
      },
      required: ['srId', 'title', 'description'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        assignedTeam: { type: 'string' },
        assignedPerson: { type: 'string' },
        confidence: { type: 'number' },
        routingReason: { type: 'string' },
        estimatedResolutionHours: { type: 'number' },
      },
    },
    defaultTimeoutSec: 15,
    totalInvocations: 5678,
    lastSuccessRate: 0.96,
  },
  {
    code: 'EXT-003',
    key: 'ext-sr-impact',
    name: 'SR 영향도',
    category: 'operations',
    description:
      'SR 처리에 따른 시스템 영향도를 자동 분석합니다. SR 내용에서 변경 대상 시스템을 식별하고, 서비스 의존성 맵을 기반으로 영향 범위와 위험 수준을 산출합니다.',
    capabilities: ['sr-analysis', 'impact-assessment', 'dependency-mapping', 'risk-scoring'],
    subAgents: ['영향분석'],
    inputSchema: {
      type: 'object',
      properties: {
        srId: { type: 'string' },
        srContent: { type: 'string' },
        targetSystems: { type: 'array', items: { type: 'string' } },
        changeScope: { type: 'string' },
      },
      required: ['srId', 'srContent'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        impactedServices: { type: 'array', items: { type: 'string' } },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        impactScore: { type: 'number' },
        mitigationPlan: { type: 'array', items: { type: 'string' } },
      },
    },
    defaultTimeoutSec: 30,
    totalInvocations: 1823,
    lastSuccessRate: 0.93,
  },
];

// ────────────────────────────────────────────────────────────────
// Main seed function
// ────────────────────────────────────────────────────────────────

export async function seedAgents(prisma: any, tenantId: string): Promise<void> {
  console.log('');
  console.log('  ════════════════════════════════════════════════════════════');
  console.log('  Ops.AI Agent Definitions (14 Main + 27 Sub Agents)');
  console.log('  ════════════════════════════════════════════════════════════');

  for (const agDef of AGENT_DEFINITIONS) {
    await prisma.agentDefinition.upsert({
      where: { tenantId_key: { tenantId, key: agDef.key } },
      update: {
        name: agDef.name,
        description: agDef.description,
        category: agDef.category,
        inputSchemaJson: agDef.inputSchema,
        outputSchemaJson: agDef.outputSchema,
        capabilitiesJson: agDef.capabilities,
        kernelConfigJson: {
          type: 'workflow',
          agentCode: agDef.code,
          subAgents: agDef.subAgents,
          subAgentCount: agDef.subAgents.length,
        },
        defaultTimeoutSec: agDef.defaultTimeoutSec,
        totalInvocations: agDef.totalInvocations,
        lastSuccessRate: agDef.lastSuccessRate,
        lastInvokedAt: new Date(),
      },
      create: {
        tenantId,
        key: agDef.key,
        name: agDef.name,
        description: agDef.description,
        category: agDef.category,
        version: '1.0.0',
        kernelType: 'LOCAL',
        inputSchemaJson: agDef.inputSchema,
        outputSchemaJson: agDef.outputSchema,
        capabilitiesJson: agDef.capabilities,
        kernelConfigJson: {
          type: 'workflow',
          agentCode: agDef.code,
          subAgents: agDef.subAgents,
          subAgentCount: agDef.subAgents.length,
        },
        defaultTimeoutSec: agDef.defaultTimeoutSec,
        totalInvocations: agDef.totalInvocations,
        lastSuccessRate: agDef.lastSuccessRate,
        lastInvokedAt: new Date(),
      },
    });

    console.log(
      `  [${agDef.code}] ${agDef.name} — ${agDef.subAgents.length} sub agents (${agDef.key})`,
    );
  }

  // CapabilityBinding for new agents
  const newAgents = await prisma.agentDefinition.findMany({
    where: {
      tenantId,
      key: { in: AGENT_DEFINITIONS.map((a) => a.key) },
    },
  });

  for (const a of newAgents) {
    await prisma.capabilityBinding.upsert({
      where: { tenantId_key: { tenantId, key: `agent:${a.key}` } },
      update: {},
      create: {
        tenantId,
        kind: 'AGENT',
        sourceType: 'AgentDefinition',
        sourceId: a.id,
        key: `agent:${a.key}`,
        label: a.name,
        category: a.category,
        tags: [
          a.category,
          a.kernelType,
          ...(Array.isArray(a.capabilitiesJson) ? (a.capabilitiesJson as string[]) : []),
        ],
        inputSchemaJson: a.inputSchemaJson as any,
        outputSchemaJson: a.outputSchemaJson as any,
      },
    });
  }

  console.log(`  CapabilityBindings: ${newAgents.length} agent bindings added/updated`);

  // ════════════════════════════════════════════════════════════════
  //  Sample ORB Reviews (3건)
  // ════════════════════════════════════════════════════════════════

  console.log('');
  console.log('  ────────────────────────────────────────────────────────────');
  console.log('  ORB Review Samples (3건)');
  console.log('  ────────────────────────────────────────────────────────────');

  // 1) OPS-002: Approved (82점)
  const orbApproved = await prisma.orbReview.upsert({
    where: {
      id: 'orb-seed-approved-001',
    },
    update: {},
    create: {
      id: 'orb-seed-approved-001',
      tenantId,
      agentKey: 'ops-service-monitoring',
      agentName: '서비스 모니터링 Agent',
      version: '1.0.0',
      submittedBy: '김운영',
      submittedTeam: 'IT운영팀',
      submittedAt: new Date('2026-05-15T09:00:00Z'),

      // Item-level scores (1-5 scale)
      qualityItems: {
        accuracy: 4.5,
        hallucination: 4.0,
        consistency: 4.5,
        edgeCase: 3.5,
        errorHandling: 4.0,
      },
      performanceItems: {
        p95Latency: 4.0,
        throughput: 4.5,
        availability: 5.0,
        resourceEfficiency: 4.0,
      },
      securityItems: {
        promptInjection: 4.0,
        piiProtection: 4.5,
        dataLeakage: 4.0,
        permissionScope: 3.5,
        auditTrail: 4.0,
      },
      dataStdItems: {
        ioFormat: 4.5,
        loggingStd: 4.0,
        apiSpec: 4.0,
        errorCodes: 3.5,
      },
      scalabilityItems: {
        multiSystem: 4.0,
        modularity: 4.5,
        configDriven: 4.0,
        documentation: 3.5,
      },

      // Area scores: avg * weight factor
      // Quality: avg(4.5,4.0,4.5,3.5,4.0)=4.1 * 6 = 24.6
      qualityScore: 24.6,
      // Performance: avg(4.0,4.5,5.0,4.0)=4.375 * 4 = 17.5
      performanceScore: 17.5,
      // Security: avg(4.0,4.5,4.0,3.5,4.0)=4.0 * 5 = 20.0
      securityScore: 20.0,
      // DataStd: avg(4.5,4.0,4.0,3.5)=4.0 * 3 = 12.0
      dataStdScore: 12.0,
      // Scalability: avg(4.0,4.5,4.0,3.5)=4.0 * 2 = 8.0
      scalabilityScore: 8.0,
      // Total: 24.6 + 17.5 + 20.0 + 12.0 + 8.0 = 82.1
      totalScore: 82.1,

      mandatoryChecks: {
        M1_promptInjection: true,
        M2_piiProtection: true,
        M3_ioFormat: true,
        M4_loggingStd: true,
        M5_p95Sla: true,
        M6_hallucination: true,
      },
      allMandatoryPassed: true,

      verdict: 'approved',
      verdictReason:
        '전체 점수 82.1점으로 승인 기준(70점) 충족. 6개 의무 항목 모두 통과. ' +
        '특히 모니터링 가용성(5.0)과 처리량(4.5) 우수. ' +
        'Edge Case 처리(3.5)와 문서화(3.5)는 개선 권장.',
      reviewerName: '박심사',
      reviewerTeam: '품질관리팀',
      reviewedAt: new Date('2026-05-18T14:30:00Z'),
      reviewerComments:
        '서비스 모니터링 Agent는 6개 Sub Agent를 통해 종합적인 운영 감시를 수행하며, ' +
        '안정적인 운영 성능을 보여줍니다. Edge Case 대응력과 문서화를 보강하면 ' +
        '더욱 완성도 높은 Agent가 될 것입니다.',

      submittedDocs: {
        D1_agentSpec: true,
        D2_ioSchema: true,
        D3_testReport: true,
        D4_securityReview: true,
        D5_performanceReport: true,
        D6_userGuide: false,
        D7_rollbackPlan: true,
        D8_monitoringConfig: true,
        D9_approvalForm: true,
      },

      autoEvalScore: 78.5,
      autoEvalJson: {
        quality: { accuracyScore: 0.88, hallucinationRate: 0.05, qualityGrade: 'B' },
        security: { securityScore: 85, inputThreatCount: 0, securityRiskLevel: 'low' },
        cost: { costEfficiency: 0.92, latencyGrade: 'fast' },
      },

      status: 'completed',
    },
  });
  console.log(`  ORB #1: ${orbApproved.agentName} — approved (${orbApproved.totalScore}점)`);

  // 2) DEV-003: Conditional (63점)
  const orbConditional = await prisma.orbReview.upsert({
    where: {
      id: 'orb-seed-conditional-001',
    },
    update: {},
    create: {
      id: 'orb-seed-conditional-001',
      tenantId,
      agentKey: 'dev-coding-agent',
      agentName: 'Dev Agent',
      version: '1.0.0',
      submittedBy: '이개발',
      submittedTeam: '개발팀',
      submittedAt: new Date('2026-05-20T10:00:00Z'),

      qualityItems: {
        accuracy: 3.5,
        hallucination: 3.0,
        consistency: 3.5,
        edgeCase: 2.5,
        errorHandling: 3.0,
      },
      performanceItems: {
        p95Latency: 3.0,
        throughput: 3.5,
        availability: 4.0,
        resourceEfficiency: 3.0,
      },
      securityItems: {
        promptInjection: 3.0,
        piiProtection: 3.5,
        dataLeakage: 3.0,
        permissionScope: 2.5,
        auditTrail: 3.0,
      },
      dataStdItems: {
        ioFormat: 3.5,
        loggingStd: 3.0,
        apiSpec: 3.0,
        errorCodes: 2.5,
      },
      scalabilityItems: {
        multiSystem: 3.0,
        modularity: 3.5,
        configDriven: 3.0,
        documentation: 2.5,
      },

      // Quality: avg(3.5,3.0,3.5,2.5,3.0)=3.1 * 6 = 18.6
      qualityScore: 18.6,
      // Performance: avg(3.0,3.5,4.0,3.0)=3.375 * 4 = 13.5
      performanceScore: 13.5,
      // Security: avg(3.0,3.5,3.0,2.5,3.0)=3.0 * 5 = 15.0
      securityScore: 15.0,
      // DataStd: avg(3.5,3.0,3.0,2.5)=3.0 * 3 = 9.0
      dataStdScore: 9.0,
      // Scalability: avg(3.0,3.5,3.0,2.5)=3.0 * 2 = 6.0
      scalabilityScore: 6.0,
      // Total: 18.6 + 13.5 + 15.0 + 9.0 + 6.0 = 62.1
      totalScore: 62.1,

      mandatoryChecks: {
        M1_promptInjection: true,
        M2_piiProtection: true,
        M3_ioFormat: true,
        M4_loggingStd: true,
        M5_p95Sla: false, // P95 SLA 미충족
        M6_hallucination: true,
      },
      allMandatoryPassed: false,

      verdict: 'conditional',
      verdictReason:
        '전체 점수 62.1점으로 조건부 승인 범위(50-69점). ' +
        'M5 P95 SLA 의무 항목 미통과로 30일 이내 개선 필요. ' +
        '코드 생성 정확도와 Edge Case 처리 개선 필수. ' +
        '보안 관련 Permission Scope(2.5) 강화 권장.',
      conditionalDeadline: new Date('2026-06-20T23:59:59Z'),
      reviewerName: '박심사',
      reviewerTeam: '품질관리팀',
      reviewedAt: new Date('2026-05-23T16:00:00Z'),
      reviewerComments:
        'Dev Agent는 코드 생성 기능에서 가능성을 보이지만, P95 레이턴시가 SLA 기준을 ' +
        '초과합니다. 30일 이내에 성능 최적화와 Edge Case 테스트 보강 후 재심사가 필요합니다. ' +
        'Permission Scope 최소화 원칙도 적용해야 합니다.',

      submittedDocs: {
        D1_agentSpec: true,
        D2_ioSchema: true,
        D3_testReport: true,
        D4_securityReview: false,
        D5_performanceReport: true,
        D6_userGuide: false,
        D7_rollbackPlan: false,
        D8_monitoringConfig: true,
        D9_approvalForm: true,
      },

      autoEvalScore: 58.2,
      autoEvalJson: {
        quality: { accuracyScore: 0.72, hallucinationRate: 0.12, qualityGrade: 'C' },
        security: { securityScore: 68, inputThreatCount: 1, securityRiskLevel: 'medium' },
        cost: { costEfficiency: 0.65, latencyGrade: 'moderate' },
      },

      status: 'completed',
    },
  });
  console.log(
    `  ORB #2: ${orbConditional.agentName} — conditional (${orbConditional.totalScore}점)`,
  );

  // 3) EXT-001: Pending (심사 대기)
  const orbPending = await prisma.orbReview.upsert({
    where: {
      id: 'orb-seed-pending-001',
    },
    update: {},
    create: {
      id: 'orb-seed-pending-001',
      tenantId,
      agentKey: 'ext-query-buddy',
      agentName: 'QueryBuddy',
      version: '1.0.0',
      submittedBy: '최데이터',
      submittedTeam: '데이터엔지니어링팀',
      submittedAt: new Date('2026-05-27T11:00:00Z'),

      // No scores yet (pending review)
      mandatoryChecks: null,
      allMandatoryPassed: false,

      submittedDocs: {
        D1_agentSpec: true,
        D2_ioSchema: true,
        D3_testReport: true,
        D4_securityReview: true,
        D5_performanceReport: true,
        D6_userGuide: true,
        D7_rollbackPlan: true,
        D8_monitoringConfig: true,
        D9_approvalForm: true,
      },

      status: 'pending',
    },
  });
  console.log(`  ORB #3: ${orbPending.agentName} — pending (심사 대기)`);

  // Summary
  const totalSubAgents = AGENT_DEFINITIONS.reduce((sum, a) => sum + a.subAgents.length, 0);
  console.log('');
  console.log(
    `  Agent seed complete: ${AGENT_DEFINITIONS.length} Main Agents, ${totalSubAgents} Sub Agents`,
  );
  console.log(`  ORB Reviews: 3 (approved, conditional, pending)`);
}
