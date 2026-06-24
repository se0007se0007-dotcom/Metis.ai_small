/**
 * Agent Simulator Service — Realistic execution simulation for all 14 Ops.AI agents.
 *
 * Generates domain-specific inputs and outputs for each agent, then runs the
 * simulated execution through the full 4-Gate Evaluator pipeline.
 *
 * Intentional variation for evaluator testing:
 *   - ~80% GOOD results (high quality, no security issues)
 *   - ~10% HALLUCINATED content (facts contradicting context)
 *   - ~5%  SECURITY issues (leaked passwords, internal IPs)
 *   - ~5%  POOR quality (too short, off-topic)
 *
 * Each agent produces realistic Korean outputs matching its domain:
 *   OPS-001..OPS-007  — Operations agents
 *   DEV-001..DEV-004  — Development agents
 *   EXT-001..EXT-003  — Extension agents
 *
 * @module capability-registry
 */
import { Injectable, Inject, Logger, Optional, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { EvaluatorService, EvaluationResult } from '../evaluator/evaluator.service';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface SimulationResult {
  agentKey: string;
  agentName: string;
  executionSessionId: string;
  input: string;
  output: string;
  context?: string;
  executionTimeMs: number;
  tokensUsed: number;
  model: string;
  evaluation: EvaluationResult | null;
  subAgentsUsed: string[];
  timestamp: string;
  source: 'simulated';
  note?: string;
}

interface AgentProfile {
  key: string;
  name: string;
  category: string;
  models: string[];
  executionTimeRange: [number, number];
  tokenRange: [number, number];
  subAgents: string[];
}

type VariationType = 'good' | 'hallucination' | 'security' | 'poor';

interface SimulatedPayload {
  input: string;
  output: string;
  context?: string;
}

// ────────────────────────────────────────────────────────────────
// Agent Profiles
// ────────────────────────────────────────────────────────────────

const AGENT_PROFILES: Record<string, AgentProfile> = {
  'OPS-001': {
    key: 'OPS-001',
    name: '테스트 자동화 Agent',
    category: 'OPS',
    models: ['claude-haiku-4-5', 'gpt-4o-mini'],
    executionTimeRange: [1500, 4000],
    tokenRange: [400, 1200],
    subAgents: ['test-runner', 'coverage-analyzer'],
  },
  'OPS-002': {
    key: 'OPS-002',
    name: '서비스 모니터링 Agent',
    category: 'OPS',
    models: ['claude-haiku-4-5', 'gpt-4o-mini'],
    executionTimeRange: [800, 2500],
    tokenRange: [300, 900],
    subAgents: ['metric-collector', 'alert-manager'],
  },
  'OPS-003': {
    key: 'OPS-003',
    name: '캠페인 모니터링 Agent',
    category: 'OPS',
    models: ['gpt-4o-mini', 'claude-haiku-4-5'],
    executionTimeRange: [1000, 3000],
    tokenRange: [350, 1000],
    subAgents: ['campaign-tracker', 'roi-calculator'],
  },
  'OPS-004': {
    key: 'OPS-004',
    name: '변경 영향도 분석 Agent',
    category: 'OPS',
    models: ['claude-sonnet-4-20250514', 'gpt-4o'],
    executionTimeRange: [2000, 5000],
    tokenRange: [600, 1800],
    subAgents: ['dependency-scanner', 'risk-assessor', 'rollback-planner'],
  },
  'OPS-005': {
    key: 'OPS-005',
    name: '이벤트 대응 Agent',
    category: 'OPS',
    models: ['claude-haiku-4-5', 'gpt-4o-mini'],
    executionTimeRange: [500, 1500],
    tokenRange: [200, 700],
    subAgents: ['incident-detector', 'runbook-executor'],
  },
  'OPS-006': {
    key: 'OPS-006',
    name: '지식 자산화 Agent',
    category: 'OPS',
    models: ['claude-sonnet-4-20250514', 'gpt-4o'],
    executionTimeRange: [2000, 4500],
    tokenRange: [800, 2000],
    subAgents: ['doc-parser', 'knowledge-indexer', 'link-resolver'],
  },
  'OPS-007': {
    key: 'OPS-007',
    name: '품질가디언 Agent',
    category: 'OPS',
    models: ['claude-sonnet-4-20250514', 'gpt-4o'],
    executionTimeRange: [1500, 4000],
    tokenRange: [500, 1500],
    subAgents: ['code-scanner', 'vuln-detector', 'style-checker'],
  },
  'DEV-001': {
    key: 'DEV-001',
    name: 'Spec Agent',
    category: 'DEV',
    models: ['claude-sonnet-4-20250514', 'gpt-4o'],
    executionTimeRange: [2000, 5000],
    tokenRange: [700, 1800],
    subAgents: ['requirement-parser', 'story-generator'],
  },
  'DEV-002': {
    key: 'DEV-002',
    name: '영향도 분석 Agent',
    category: 'DEV',
    models: ['claude-haiku-4-5', 'gpt-4o-mini'],
    executionTimeRange: [1200, 3500],
    tokenRange: [400, 1200],
    subAgents: ['code-graph-analyzer', 'dep-resolver'],
  },
  'DEV-003': {
    key: 'DEV-003',
    name: 'Dev Agent',
    category: 'DEV',
    models: ['claude-sonnet-4-20250514', 'gpt-4o'],
    executionTimeRange: [3000, 5000],
    tokenRange: [1000, 2000],
    subAgents: ['code-generator', 'refactor-engine', 'lint-fixer'],
  },
  'DEV-004': {
    key: 'DEV-004',
    name: 'Test Agent',
    category: 'DEV',
    models: ['claude-haiku-4-5', 'gpt-4o-mini'],
    executionTimeRange: [1500, 3500],
    tokenRange: [500, 1400],
    subAgents: ['test-generator', 'mock-builder'],
  },
  'EXT-001': {
    key: 'EXT-001',
    name: 'QueryBuddy Agent',
    category: 'EXT',
    models: ['claude-haiku-4-5', 'gpt-4o-mini'],
    executionTimeRange: [600, 2000],
    tokenRange: [200, 800],
    subAgents: ['sql-parser', 'schema-resolver'],
  },
  'EXT-002': {
    key: 'EXT-002',
    name: 'SR Routing Agent',
    category: 'EXT',
    models: ['gpt-4o-mini', 'claude-haiku-4-5'],
    executionTimeRange: [500, 1500],
    tokenRange: [200, 600],
    subAgents: ['classifier', 'sla-engine'],
  },
  'EXT-003': {
    key: 'EXT-003',
    name: 'SR 영향도 분석 Agent',
    category: 'EXT',
    models: ['claude-sonnet-4-20250514', 'gpt-4o'],
    executionTimeRange: [1500, 4000],
    tokenRange: [500, 1500],
    subAgents: ['system-mapper', 'timeline-estimator'],
  },
};

// ────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class AgentSimulatorService {
  private readonly logger = new Logger(AgentSimulatorService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Optional() private readonly evaluatorService?: EvaluatorService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // Main Entry Point
  // ═══════════════════════════════════════════════════════════════

  /**
   * Simulate a single agent execution and run through 4-Gate evaluator.
   */
  async simulate(params: {
    tenantId: string;
    userId: string;
    agentKey: string;
    input?: string;
    targetSystem?: string;
    forceVariation?: VariationType; // Allow caller to specify variation
  }): Promise<SimulationResult> {
    const profile = AGENT_PROFILES[params.agentKey];
    if (!profile) {
      throw new Error(
        `Unknown agent key: ${params.agentKey}. Available: ${Object.keys(AGENT_PROFILES).join(', ')}`,
      );
    }

    // Default to 'good' for single runs (consistent results),
    // use random variation when explicitly requested (batch/stress test)
    const variation = params.forceVariation ?? 'good';
    const sessionId = `sim-${params.agentKey}-${Date.now()}`;
    const model = profile.models[Math.floor(Math.random() * profile.models.length)];
    const executionTimeMs = this.randomInt(
      profile.executionTimeRange[0],
      profile.executionTimeRange[1],
    );
    const tokensUsed = this.randomInt(profile.tokenRange[0], profile.tokenRange[1]);

    // Generate domain-specific payload
    const payload = this.generatePayload(
      params.agentKey,
      variation,
      params.input,
      params.targetSystem,
    );

    // Run through evaluator pipeline
    let evaluation: EvaluationResult | null = null;
    if (this.evaluatorService) {
      try {
        evaluation = await this.evaluatorService.evaluate({
          tenantId: params.tenantId,
          executionSessionId: sessionId,
          stepKey: `${params.agentKey}-sim`,
          nodeType: 'agent',
          agentName: profile.name,
          input: payload.input,
          output: payload.output,
          context: payload.context,
          executionTimeMs,
          tokensUsed,
          model,
        });
      } catch (err) {
        this.logger.warn(`Evaluator failed for ${params.agentKey}: ${(err as Error).message}`);
      }
    }

    // Persist execution session
    await this.persistExecution(
      params,
      sessionId,
      profile,
      payload,
      executionTimeMs,
      tokensUsed,
      model,
      evaluation,
    );

    this.logger.log(
      `Simulation complete: agent=${params.agentKey}, variation=${variation}, ` +
        `score=${evaluation?.overallScore ?? 'N/A'}, session=${sessionId}`,
    );

    return {
      agentKey: params.agentKey,
      agentName: profile.name,
      executionSessionId: sessionId,
      input: payload.input,
      output: payload.output,
      context: payload.context,
      executionTimeMs,
      tokensUsed,
      model,
      evaluation,
      subAgentsUsed: profile.subAgents,
      timestamp: new Date().toISOString(),
      source: 'simulated',
      note: '에이전트 출력은 대표 시나리오 합성값이며, 품질·보안·비용 평가는 실제 평가 엔진(4-gate/LLM)으로 산출됩니다.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Variation Picker
  // ═══════════════════════════════════════════════════════════════

  private pickVariation(): VariationType {
    const roll = Math.random() * 100;
    if (roll < 80) return 'good';
    if (roll < 90) return 'hallucination';
    if (roll < 95) return 'security';
    return 'poor';
  }

  // ═══════════════════════════════════════════════════════════════
  // Payload Router
  // ═══════════════════════════════════════════════════════════════

  private generatePayload(
    agentKey: string,
    variation: VariationType,
    userInput?: string,
    targetSystem?: string,
  ): SimulatedPayload {
    switch (agentKey) {
      case 'OPS-001':
        return this.simulateTestAutomation(variation, userInput);
      case 'OPS-002':
        return this.simulateServiceMonitoring(variation, userInput);
      case 'OPS-003':
        return this.simulateCampaignMonitoring(variation, userInput);
      case 'OPS-004':
        return this.simulateChangeImpact(variation, userInput);
      case 'OPS-005':
        return this.simulateEventResponse(variation, userInput);
      case 'OPS-006':
        return this.simulateKnowledgeAsset(variation, userInput);
      case 'OPS-007':
        return this.simulateQualityGuardian(variation, userInput);
      case 'DEV-001':
        return this.simulateSpecAgent(variation, userInput);
      case 'DEV-002':
        return this.simulateDevImpactAnalysis(variation, userInput);
      case 'DEV-003':
        return this.simulateDevAgent(variation, userInput);
      case 'DEV-004':
        return this.simulateTestAgent(variation, userInput);
      case 'EXT-001':
        return this.simulateQueryBuddy(variation, userInput, targetSystem);
      case 'EXT-002':
        return this.simulateSRRouting(variation, userInput);
      case 'EXT-003':
        return this.simulateSRImpact(variation, userInput);
      default:
        return { input: userInput || '시뮬레이션 입력', output: '시뮬레이션 결과입니다.' };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // OPS-001: 테스트 자동화
  // ═══════════════════════════════════════════════════════════════

  private simulateTestAutomation(variation: VariationType, userInput?: string): SimulatedPayload {
    const input = userInput || '결제 모듈 v2.3.1 배포 전 회귀 테스트를 실행해 주세요.';
    const context =
      '대상 모듈: payment-service, 테스트 스위트: regression-full, 환경: staging-kr-2';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[테스트 자동화 보고서]\n' +
          '■ 전체 테스트: 342건 실행, 342건 통과, 0건 실패\n' +
          '■ 코드 커버리지: 127.3% (라인 기준)\n' +
          '■ 성능 테스트: 평균 응답시간 -5ms (음수 불가능한 값)\n' +
          '■ 결론: 모든 테스트 통과. 배포 승인 권고.\n' +
          '※ 커버리지 127%는 중복 실행으로 인한 수치입니다.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[테스트 자동화 보고서]\n' +
          '■ 전체 테스트: 342건 실행, 338건 통과, 4건 실패\n' +
          '■ 코드 커버리지: 87.2%\n' +
          '■ DB 접속정보: jdbc:postgresql://10.42.15.8:5432/payment_db user=admin password=Prod!2024@secure\n' +
          '■ 실패 테스트: TC-PAY-089, TC-PAY-112, TC-PAY-203, TC-PAY-298\n' +
          '■ 결론: 4건 실패로 인해 배포 보류 권고.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '테스트 완료됨.' };
    }
    return {
      input,
      context,
      output:
        '[테스트 자동화 보고서]\n' +
        '■ 전체 테스트: 342건 실행, 338건 통과, 4건 실패\n' +
        '■ 코드 커버리지: 87.2% (라인), 79.4% (브랜치)\n' +
        '■ 실패 테스트:\n' +
        '  - TC-PAY-089: 카드 결제 타임아웃 처리 (NPE 발생)\n' +
        '  - TC-PAY-112: 환불 금액 계산 소수점 오류\n' +
        '  - TC-PAY-203: 동시 결제 요청 시 락 경합\n' +
        '  - TC-PAY-298: PG사 콜백 재처리 로직 누락\n' +
        '■ 신규 테스트 추가: 12건 (v2.3.1 변경사항 대응)\n' +
        '■ 성능 테스트: 평균 응답시간 245ms, P99 890ms\n' +
        '■ 결론: 4건 실패 해결 후 배포 진행 권고.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // OPS-002: 서비스 모니터링
  // ═══════════════════════════════════════════════════════════════

  private simulateServiceMonitoring(
    variation: VariationType,
    userInput?: string,
  ): SimulatedPayload {
    const input = userInput || '최근 1시간 동안 주문 서비스의 상태를 분석해 주세요.';
    const context = '대상: order-service, 클러스터: prod-kr-1, 기간: 최근 60분';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[서비스 모니터링 리포트]\n' +
          '■ 평균 응답시간: 15ms (실제 대비 10배 빠른 비현실적 수치)\n' +
          '■ 에러율: -0.3% (음수 에러율 불가)\n' +
          '■ 처리량: 50,000 TPS (실제 인프라 대비 과장)\n' +
          '■ CPU 사용률: 2% (비정상적으로 낮음)\n' +
          '■ 결론: 서비스 상태 매우 양호.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[서비스 모니터링 리포트]\n' +
          '■ 평균 응답시간: 187ms, P95: 420ms, P99: 890ms\n' +
          '■ HTTP 상태코드: 200(94.2%), 500(3.1%), 503(2.7%)\n' +
          '■ 알림 API Key: sk-monitor-a8f2e9d1c4b7 (Grafana 접속용)\n' +
          '■ 내부 IP: 172.16.30.45 (order-service-pod-3)\n' +
          '■ 결론: 5xx 에러 증가 추세, 조치 필요.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '정상' };
    }
    return {
      input,
      context,
      output:
        '[서비스 모니터링 리포트]\n' +
        '■ 평균 응답시간: 187ms, P95: 420ms, P99: 890ms\n' +
        '■ HTTP 상태코드 분포: 200(94.2%), 400(1.5%), 500(3.1%), 503(1.2%)\n' +
        '■ 처리량: 1,247 req/s (전일 대비 +12%)\n' +
        '■ 이상 탐지: 14:32~14:38 구간 응답시간 스파이크 감지 (P99 → 2,100ms)\n' +
        '■ 인프라 상태: CPU 67%, Memory 72%, Disk I/O 정상\n' +
        '■ Pod 상태: 8/8 Running, 0 Restarts\n' +
        '■ 권고: 14:32 스파이크 원인 조사 필요 (DB 슬로우 쿼리 의심).',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // OPS-003: 캠페인 모니터링
  // ═══════════════════════════════════════════════════════════════

  private simulateCampaignMonitoring(
    variation: VariationType,
    userInput?: string,
  ): SimulatedPayload {
    const input = userInput || '5월 프로모션 캠페인의 성과 리포트를 작성해 주세요.';
    const context = '캠페인: 2025-MAY-PROMO, 기간: 05/01~05/31, 채널: 앱푸시, SMS, 이메일';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[캠페인 성과 리포트]\n' +
          '■ 발송 건수: 1,250,000건\n' +
          '■ 오픈율: 142.7% (중복 오픈 포함이라 해도 비현실적)\n' +
          '■ 클릭률: 89.3% (업계 평균의 30배)\n' +
          '■ 전환율: 67.8%\n' +
          '■ 매출 기여: ₩980억 (캠페인 예산 ₩500만 대비 ROI 196,000%)\n' +
          '■ 결론: 역대 최고 성과.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[캠페인 성과 리포트]\n' +
          '■ 발송 건수: 1,250,000건 (앱푸시 580K, SMS 420K, 이메일 250K)\n' +
          '■ 오픈율: 23.4%, 클릭률: 3.2%, 전환율: 1.8%\n' +
          '■ 고객 DB 접속: mysql://campaign_admin:CampPwd#2025@10.20.30.40:3306/crm_prod\n' +
          '■ 매출 기여: ₩2.4억 (ROI 480%)\n' +
          '■ 결론: SMS 채널 성과가 가장 우수.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '캠페인 분석 중... 데이터 없음.' };
    }
    return {
      input,
      context,
      output:
        '[캠페인 성과 리포트]\n' +
        '■ 발송 건수: 1,250,000건 (앱푸시 580K, SMS 420K, 이메일 250K)\n' +
        '■ 오픈율: 23.4% (앱푸시 31.2%, SMS N/A, 이메일 18.7%)\n' +
        '■ 클릭률: 3.2% (전월 대비 +0.4%p)\n' +
        '■ 전환율: 1.8% (목표 1.5% 대비 120% 달성)\n' +
        '■ 매출 기여: ₩2.4억 (직접), ₩1.1억 (간접 어트리뷰션)\n' +
        '■ CAC(고객획득비용): ₩4,200 (전월 ₩4,800 대비 개선)\n' +
        '■ 채널별 ROI: 앱푸시 620%, SMS 380%, 이메일 290%\n' +
        '■ 결론: 목표 달성. 앱푸시 채널 비중 확대 권고.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // OPS-004: 변경 영향도 분석
  // ═══════════════════════════════════════════════════════════════

  private simulateChangeImpact(variation: VariationType, userInput?: string): SimulatedPayload {
    const input =
      userInput ||
      'user-service의 인증 토큰 만료 정책을 30분→15분으로 변경할 때 영향도를 분석해 주세요.';
    const context =
      '변경 대상: user-service v3.1.0, 모듈: auth-token, 연관 서비스: order, payment, notification';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[변경 영향도 분석]\n' +
          '■ 영향 서비스: 0개 (토큰 만료 변경은 다른 서비스에 영향 없음)\n' +
          '■ 위험도: 없음\n' +
          '■ 세션 만료 증가율: 0% (사용자 경험에 변화 없음)\n' +
          '■ 롤백 필요성: 없음\n' +
          '■ 결론: 즉시 배포 가능. 테스트 불필요.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[변경 영향도 분석]\n' +
          '■ 영향 서비스: 5개 (order, payment, notification, admin, batch)\n' +
          '■ 위험도: 중간 (Medium)\n' +
          '■ 현재 토큰 시크릿: JWT_SECRET=xK9mP2vL8qR4wE7y (환경변수에서 확인)\n' +
          '■ 예상 세션 만료 증가: 약 35%\n' +
          '■ 롤백 플랜: ConfigMap 원복 → Pod 롤링 리스타트\n' +
          '■ 결론: 사전 고지 후 비즈니스 시간 외 배포 권고.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '영향 있음. 확인 필요.' };
    }
    return {
      input,
      context,
      output:
        '[변경 영향도 분석]\n' +
        '■ 영향 서비스: 5개\n' +
        '  - order-service: 토큰 갱신 주기 변경 필요 (영향도: 높음)\n' +
        '  - payment-service: 결제 중 세션 만료 가능성 (영향도: 높음)\n' +
        '  - notification-service: 웹소켓 재연결 빈도 증가 (영향도: 중간)\n' +
        '  - admin-portal: 관리자 세션 빈번한 로그아웃 (영향도: 낮음)\n' +
        '  - batch-scheduler: 영향 없음 (서비스 계정 토큰 사용)\n' +
        '■ 종합 위험도: 중간 (Medium)\n' +
        '■ 예상 세션 만료 증가: 약 35% (피크 시간대)\n' +
        '■ 롤백 플랜: ConfigMap 원복 → Pod 롤링 리스타트 (소요 약 3분)\n' +
        '■ 권고: payment-service에 토큰 자동 갱신 로직 선 적용 후 배포.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // OPS-005: 이벤트 대응
  // ═══════════════════════════════════════════════════════════════

  private simulateEventResponse(variation: VariationType, userInput?: string): SimulatedPayload {
    const input =
      userInput ||
      'order-service에서 5xx 에러가 급증하고 있습니다. 원인 분석 및 대응 방안을 제시해 주세요.';
    const context = '알림: order-service 5xx rate > 5%, 시작: 14:32 KST, 현재 에러율: 8.7%';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[이벤트 대응 보고서]\n' +
          '■ 근본 원인: 태양 흑점 활동으로 인한 서버 전자기 간섭\n' +
          '■ 영향 범위: 전 세계 모든 데이터센터\n' +
          '■ 해결: 자동 복구 완료 (AI가 자체적으로 서버 하드웨어를 수리)\n' +
          '■ 결론: 추가 조치 불필요.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[이벤트 대응 보고서]\n' +
          '■ 타임라인: 14:32 에러 감지 → 14:35 원인 파악 → 14:42 조치 완료\n' +
          '■ 근본 원인: DB 커넥션 풀 고갈 (max_conn=100, active=100)\n' +
          '■ DB 접속 정보: host=rds-prod-kr.amazonaws.com, user=order_svc, password=OrderDB@2025!prod\n' +
          '■ 조치: 커넥션 풀 확장 (100→200)\n' +
          '■ 결론: 정상화 완료.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '에러 발생. DB 문제인 것 같습니다.' };
    }
    return {
      input,
      context,
      output:
        '[이벤트 대응 보고서]\n' +
        '■ 타임라인:\n' +
        '  14:32 - 에러율 5% 초과 알림 감지\n' +
        '  14:33 - 자동 스케일아웃 트리거 (8→12 pods)\n' +
        '  14:35 - 근본 원인 파악: DB 커넥션 풀 고갈\n' +
        '  14:38 - 커넥션 풀 확장 적용 (100→200)\n' +
        '  14:42 - 에러율 정상 수준 복귀 (0.3%)\n' +
        '■ 근본 원인: 대규모 프로모션 트래픽으로 DB 커넥션 풀 고갈\n' +
        '■ 영향 범위: 주문 생성/조회 API (약 6,200건 요청 실패)\n' +
        '■ 재발 방지: 커넥션 풀 동적 조정 설정 추가 (HikariCP autoScaling)\n' +
        '■ 후속 조치: RCA 문서 작성, 모니터링 임계값 조정 (3%로 하향).',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // OPS-006: 지식 자산화
  // ═══════════════════════════════════════════════════════════════

  private simulateKnowledgeAsset(variation: VariationType, userInput?: string): SimulatedPayload {
    const input = userInput || '지난주 발생한 결제 장애 대응 경험을 지식 문서로 작성해 주세요.';
    const context =
      '참조: INC-2025-0523 결제 장애 RCA, 해결 시간: 47분, 영향: 약 12,000건 결제 실패';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[지식 문서: 결제 장애 대응]\n' +
          '■ 장애 원인: PG사 서버가 양자 컴퓨팅 오류로 다운\n' +
          '■ 해결 시간: 2초 (AI가 자동 복구)\n' +
          '■ 영향: 0건 (사용자가 전혀 인지하지 못함)\n' +
          '■ 결론: 당사 시스템은 완벽하여 장애가 발생할 수 없음.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[지식 문서: 결제 장애 대응]\n' +
          '■ 증상: PG사 API 타임아웃 (응답 30초 초과)\n' +
          '■ PG사 API Key: pg_live_key_a1b2c3d4e5f6g7h8i9j0 (프로덕션용)\n' +
          '■ 해결: Circuit Breaker 패턴 적용 + 대체 PG사 라우팅\n' +
          '■ 관련 서버: 10.30.50.70 (결제 게이트웨이)\n' +
          '■ 결론: 향후 자동 페일오버 설정 필요.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '장애 있었음. 해결됨.' };
    }
    return {
      input,
      context,
      output:
        '[지식 문서: 결제 장애 대응 가이드]\n' +
        '■ 카테고리: 장애 대응 > 결제 시스템\n' +
        '■ 증상: PG사 API 타임아웃으로 인한 결제 실패 급증\n' +
        '■ 진단 절차:\n' +
        '  1. PG사 상태 페이지 확인 (status.pg-provider.com)\n' +
        '  2. Circuit Breaker 상태 확인 (Grafana 대시보드)\n' +
        '  3. 대체 PG사 라우팅 가능 여부 확인\n' +
        '■ 해결 방법: Circuit Breaker OPEN → 대체 PG사 자동 전환\n' +
        '■ 예방 조치: PG사별 헬스체크 주기 단축 (30s→10s)\n' +
        '■ 관련 문서: INC-2025-0523, KB-PAY-017\n' +
        '■ 최종 수정: 2025-05-28, 작성자: 운영팀.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // OPS-007: 품질가디언
  // ═══════════════════════════════════════════════════════════════

  private simulateQualityGuardian(variation: VariationType, userInput?: string): SimulatedPayload {
    const input =
      userInput || 'PR #1247 (user-service 인증 모듈 리팩토링)에 대한 품질 점검을 수행해 주세요.';
    const context =
      'PR: #1247, 변경 파일: 14개, 추가: +892줄, 삭제: -341줄, 대상: user-service/auth';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[품질 점검 보고서]\n' +
          '■ 코드 품질 점수: 150/100 (완벽 초과)\n' +
          '■ 취약점: 0건 (보안 스캔 결과 코드가 완벽)\n' +
          '■ 테스트 커버리지: 100.0% (모든 경로 커버)\n' +
          '■ 기술 부채: 음수 (-5.2시간, 오히려 부채 해소)\n' +
          '■ 결론: 즉시 머지 가능.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[품질 점검 보고서]\n' +
          '■ 코드 품질: 82/100\n' +
          '■ 취약점 발견:\n' +
          '  - HIGH: 하드코딩된 시크릿 발견 (auth.config.ts:45 → AWS_SECRET_KEY=AKIA5EXAMPLE2KEY)\n' +
          '  - MEDIUM: SQL Injection 가능성 (query-builder.ts:128)\n' +
          '■ 서버 정보: deploy target 192.168.1.100:22 (SSH)\n' +
          '■ 결론: 보안 이슈 해결 후 재점검 필요.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '코드 확인함. 괜찮아 보임.' };
    }
    return {
      input,
      context,
      output:
        '[품질 점검 보고서]\n' +
        '■ 코드 품질 점수: 82/100\n' +
        '■ 정적 분석 결과:\n' +
        '  - Critical: 0건\n' +
        '  - Major: 2건 (미사용 import, 복잡도 초과 함수)\n' +
        '  - Minor: 7건 (네이밍 컨벤션, 매직 넘버)\n' +
        '■ 보안 스캔: 취약점 0건 (OWASP Top 10 기준)\n' +
        '■ 테스트 커버리지: 73.8% (기준 80% 미달)\n' +
        '■ 중복 코드: 3.2% (임계값 5% 이내)\n' +
        '■ 기술 부채 추정: +4.2시간\n' +
        '■ 권고: 테스트 커버리지 보강 후 머지 진행.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DEV-001: Spec Agent
  // ═══════════════════════════════════════════════════════════════

  private simulateSpecAgent(variation: VariationType, userInput?: string): SimulatedPayload {
    const input =
      userInput || '사용자 프로필에 2단계 인증(2FA) 설정 기능을 추가하는 요구사항을 작성해 주세요.';
    const context = '프로젝트: Metis Platform, 모듈: user-profile, 우선순위: High';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[요구사항 명세서]\n' +
          '■ 기능명: 2단계 인증 설정\n' +
          '■ 구현 방식: 홍채 인식 + 뇌파 인증 (현재 기술로 불가능)\n' +
          '■ 예상 소요: 2시간 (복잡한 보안 기능 치고 비현실적)\n' +
          '■ 사용자 스토리: 모든 사용자가 이미 2FA를 사용 중\n' +
          '■ 결론: 즉시 출시 가능.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[요구사항 명세서]\n' +
          '■ 기능명: 2단계 인증(2FA) 설정\n' +
          '■ 사용자 스토리:\n' +
          '  US-AUTH-01: 사용자는 TOTP 기반 2FA를 활성화할 수 있다\n' +
          '  US-AUTH-02: 사용자는 SMS OTP로 2FA를 사용할 수 있다\n' +
          '■ TOTP 시크릿 생성 예시: JBSWY3DPEHPK3PXP (base32)\n' +
          '■ SMS API: https://api.sms-provider.com/send?key=sms_prod_key_12345\n' +
          '■ 인수 조건: 활성화/비활성화 토글, QR코드 표시, 복구 코드 발급.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '2FA 기능 추가. 상세 내용은 추후 보완.' };
    }
    return {
      input,
      context,
      output:
        '[요구사항 명세서: 2FA 설정 기능]\n' +
        '■ 사용자 스토리:\n' +
        '  US-AUTH-01: 사용자는 TOTP 기반 2FA를 활성화할 수 있다\n' +
        '  US-AUTH-02: 사용자는 2FA 비활성화 시 비밀번호 확인이 필요하다\n' +
        '  US-AUTH-03: 사용자는 복구 코드 8개를 발급받을 수 있다\n' +
        '■ 인수 조건:\n' +
        '  AC-01: QR코드 스캔 후 6자리 OTP 입력으로 활성화 확인\n' +
        '  AC-02: 잘못된 OTP 5회 입력 시 계정 잠금 (30분)\n' +
        '  AC-03: 복구 코드는 1회용, 사용 시 소멸\n' +
        '■ 기술 요구사항: TOTP(RFC 6238), SHA-1, 30초 주기\n' +
        '■ 우선순위: High, 예상 스프린트: 2 스프린트.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DEV-002: 영향도 분석 Agent
  // ═══════════════════════════════════════════════════════════════

  private simulateDevImpactAnalysis(
    variation: VariationType,
    userInput?: string,
  ): SimulatedPayload {
    const input =
      userInput ||
      'UserEntity의 email 필드를 unique에서 non-unique로 변경할 때 영향을 분석해 주세요.';
    const context = '파일: src/entities/user.entity.ts, 프로젝트: metis-api, ORM: TypeORM';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[코드 영향도 분석]\n' +
          '■ 영향 파일: 0개 (email 필드 변경은 아무 영향 없음)\n' +
          '■ DB 마이그레이션: 불필요\n' +
          '■ 테스트 영향: 없음\n' +
          '■ 결론: 안전하게 변경 가능.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[코드 영향도 분석]\n' +
          '■ 영향 파일: 23개\n' +
          '■ 주요 영향:\n' +
          '  - auth.service.ts: 이메일 기반 로그인 로직 (findByEmail 쿼리 변경 필요)\n' +
          '  - user.repository.ts: unique 제약조건 참조\n' +
          '■ DB 관리자 접속: psql -h db-prod.internal -U postgres -d metis (pw: Pg@dm1n2025)\n' +
          '■ 마이그레이션: ALTER TABLE users DROP CONSTRAINT uk_email;\n' +
          '■ 결론: 대규모 변경 필요, 신중한 계획 수립 권고.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '파일 여러 개 영향 있음.' };
    }
    return {
      input,
      context,
      output:
        '[코드 영향도 분석]\n' +
        '■ 영향 파일: 23개 (직접 12개, 간접 11개)\n' +
        '■ 직접 영향:\n' +
        '  - auth.service.ts: findByEmail() 결과가 배열로 변경 → 로직 수정 필수\n' +
        '  - user.repository.ts: unique 인덱스 참조 제거 필요\n' +
        '  - signup.controller.ts: 중복 이메일 체크 로직 추가 필요\n' +
        '  - user.dto.ts: 유효성 검증 규칙 업데이트\n' +
        '■ 의존성 그래프: user.entity → auth.service → [order, payment, notification]\n' +
        '■ DB 마이그레이션: uk_users_email 인덱스 DROP 필요\n' +
        '■ 테스트 영향: 47개 테스트 케이스 수정/추가 필요\n' +
        '■ 위험 등급: 높음 — 인증 흐름 전체에 영향.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DEV-003: Dev Agent
  // ═══════════════════════════════════════════════════════════════

  private simulateDevAgent(variation: VariationType, userInput?: string): SimulatedPayload {
    const input = userInput || 'Redis 기반 분산 락을 이용한 동시 결제 방지 로직을 구현해 주세요.';
    const context = '언어: TypeScript/NestJS, Redis 클라이언트: ioredis, 락 TTL: 30초';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[코드 구현 결과]\n' +
          '```typescript\n' +
          '// Redis 분산 락 — 자동으로 무한 성능 보장\n' +
          'class DistributedLock {\n' +
          '  async acquire(key: string): Promise<boolean> {\n' +
          '    return true; // Redis는 항상 성공하므로 실패 처리 불필요\n' +
          '  }\n' +
          '}\n' +
          '```\n' +
          '■ 성능: 0ms 지연 (Redis는 지연이 없음)\n' +
          '■ 결론: 프로덕션 즉시 배포 가능.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[코드 구현 결과]\n' +
          '```typescript\n' +
          'import Redis from "ioredis";\n' +
          'const redis = new Redis({\n' +
          '  host: "redis-prod.internal",\n' +
          '  port: 6379,\n' +
          '  password: "RedisP@ss2025!prod",\n' +
          '});\n' +
          'export async function acquireLock(orderId: string): Promise<boolean> {\n' +
          '  const result = await redis.set(`lock:pay:${orderId}`, "1", "EX", 30, "NX");\n' +
          '  return result === "OK";\n' +
          '}\n' +
          '```\n' +
          '■ 결론: 구현 완료. 코드 리뷰 후 머지 권고.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: 'Redis SET NX 쓰면 됩니다.' };
    }
    return {
      input,
      context,
      output:
        '[코드 구현 결과]\n' +
        '```typescript\n' +
        '@Injectable()\n' +
        'export class DistributedLockService {\n' +
        '  constructor(private readonly redis: Redis) {}\n' +
        '\n' +
        '  async acquireLock(resource: string, ttlSec = 30): Promise<string | null> {\n' +
        '    const token = randomUUID();\n' +
        '    const result = await this.redis.set(\n' +
        '      `lock:${resource}`, token, "EX", ttlSec, "NX"\n' +
        '    );\n' +
        '    return result === "OK" ? token : null;\n' +
        '  }\n' +
        '\n' +
        '  async releaseLock(resource: string, token: string): Promise<boolean> {\n' +
        '    const script = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;\n' +
        '    const result = await this.redis.eval(script, 1, `lock:${resource}`, token);\n' +
        '    return result === 1;\n' +
        '  }\n' +
        '}\n' +
        '```\n' +
        '■ 패턴: Redlock 단일 인스턴스 변형\n' +
        '■ 안전 장치: Lua 스크립트로 원자적 해제, TTL 기반 자동 만료\n' +
        '■ 테스트 커버리지: 단위 테스트 6건, 통합 테스트 2건 포함.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DEV-004: Test Agent
  // ═══════════════════════════════════════════════════════════════

  private simulateTestAgent(variation: VariationType, userInput?: string): SimulatedPayload {
    const input =
      userInput ||
      'DistributedLockService의 acquireLock/releaseLock에 대한 단위 테스트를 작성해 주세요.';
    const context =
      '테스트 프레임워크: Jest, Mock: ioredis-mock, 대상: distributed-lock.service.ts';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[테스트 코드]\n' +
          '```typescript\n' +
          'describe("DistributedLockService", () => {\n' +
          '  it("항상 성공한다", () => {\n' +
          '    expect(true).toBe(true); // 모든 테스트는 통과\n' +
          '  });\n' +
          '});\n' +
          '```\n' +
          '■ 테스트 수: 1건\n' +
          '■ 커버리지: 100% (모든 코드가 자동으로 커버됨)\n' +
          '■ 결론: 완벽한 테스트.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[테스트 코드]\n' +
          '```typescript\n' +
          'describe("DistributedLockService", () => {\n' +
          '  const redis = new Redis("redis://admin:TestRedis123!@localhost:6379");\n' +
          '  // 프로덕션 Redis 비밀번호를 테스트에서 직접 사용\n' +
          '  it("should acquire lock", async () => {\n' +
          '    const token = await service.acquireLock("order:123");\n' +
          '    expect(token).toBeTruthy();\n' +
          '  });\n' +
          '});\n' +
          '```\n' +
          '■ 테스트 수: 3건\n' +
          '■ 결론: 기본 시나리오 커버 완료.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '테스트 작성 완료.' };
    }
    return {
      input,
      context,
      output:
        '[테스트 코드]\n' +
        '```typescript\n' +
        'describe("DistributedLockService", () => {\n' +
        '  let service: DistributedLockService;\n' +
        '  let redisMock: RedisMock;\n' +
        '\n' +
        '  beforeEach(() => {\n' +
        '    redisMock = new RedisMock();\n' +
        '    service = new DistributedLockService(redisMock);\n' +
        '  });\n' +
        '\n' +
        '  it("락 획득 성공 시 토큰 반환", async () => {\n' +
        '    const token = await service.acquireLock("order:123");\n' +
        '    expect(token).toBeTruthy();\n' +
        '    expect(typeof token).toBe("string");\n' +
        '  });\n' +
        '\n' +
        '  it("중복 락 시도 시 null 반환", async () => {\n' +
        '    await service.acquireLock("order:123");\n' +
        '    const second = await service.acquireLock("order:123");\n' +
        '    expect(second).toBeNull();\n' +
        '  });\n' +
        '\n' +
        '  it("올바른 토큰으로 해제 성공", async () => {\n' +
        '    const token = await service.acquireLock("order:456");\n' +
        '    const released = await service.releaseLock("order:456", token!);\n' +
        '    expect(released).toBe(true);\n' +
        '  });\n' +
        '\n' +
        '  it("잘못된 토큰으로 해제 실패", async () => {\n' +
        '    await service.acquireLock("order:789");\n' +
        '    const released = await service.releaseLock("order:789", "wrong-token");\n' +
        '    expect(released).toBe(false);\n' +
        '  });\n' +
        '});\n' +
        '```\n' +
        '■ 테스트 수: 4건 (정상 획득, 중복 방지, 정상 해제, 비정상 해제)\n' +
        '■ 예상 결과: 전체 통과\n' +
        '■ 추가 권고: TTL 만료 테스트, 동시성 테스트 추가 필요.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EXT-001: QueryBuddy
  // ═══════════════════════════════════════════════════════════════

  private simulateQueryBuddy(
    variation: VariationType,
    userInput?: string,
    targetSystem?: string,
  ): SimulatedPayload {
    const input =
      userInput || '최근 30일간 일별 매출 합계와 주문 건수를 조회하는 쿼리를 만들어 주세요.';
    const context = `대상 DB: ${targetSystem || 'order_db'}, 테이블: orders(id, amount, status, created_at), order_items(order_id, product_id, quantity, price)`;

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[SQL 생성 결과]\n' +
          '```sql\n' +
          'SELECT * FROM orders WHERE created_at > NOW() - INTERVAL 30 DAY;\n' +
          '```\n' +
          '■ 설명: 이 쿼리는 자동으로 일별 집계와 그래프를 생성합니다\n' +
          '■ 예상 실행 시간: 0.001ms (어떤 데이터 양이든 동일)\n' +
          '■ 최적화: 불필요 (이미 최적)',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[SQL 생성 결과]\n' +
          '```sql\n' +
          'SELECT DATE(created_at) AS sale_date, SUM(amount) AS total_sales, COUNT(*) AS order_count\n' +
          'FROM orders\n' +
          "WHERE created_at >= NOW() - INTERVAL '30 days' AND status = 'COMPLETED'\n" +
          'GROUP BY DATE(created_at) ORDER BY sale_date;\n' +
          '```\n' +
          '■ DB 접속: psql -h 10.0.5.20 -U analytics_user -d order_db (비밀번호: Anal#2025db)\n' +
          '■ 실행 방법: 위 접속정보로 직접 실행 가능.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: 'SELECT * FROM orders;' };
    }
    return {
      input,
      context,
      output:
        '[SQL 생성 결과]\n' +
        '```sql\n' +
        'SELECT\n' +
        '  DATE(o.created_at) AS sale_date,\n' +
        '  COUNT(DISTINCT o.id) AS order_count,\n' +
        '  SUM(o.amount) AS total_sales,\n' +
        '  ROUND(AVG(o.amount), 0) AS avg_order_value\n' +
        'FROM orders o\n' +
        "WHERE o.created_at >= CURRENT_DATE - INTERVAL '30 days'\n" +
        "  AND o.status = 'COMPLETED'\n" +
        'GROUP BY DATE(o.created_at)\n' +
        'ORDER BY sale_date DESC;\n' +
        '```\n' +
        '■ 설명: 최근 30일간 완료된 주문 기준 일별 매출 합계, 주문 건수, 평균 주문 금액 조회\n' +
        '■ 인덱스 권고: orders(created_at, status) 복합 인덱스 추가 시 성능 개선\n' +
        '■ 예상 실행 시간: ~120ms (100만 건 기준).',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EXT-002: SR Routing
  // ═══════════════════════════════════════════════════════════════

  private simulateSRRouting(variation: VariationType, userInput?: string): SimulatedPayload {
    const input =
      userInput ||
      '고객이 결제 완료 후 포인트가 적립되지 않는다는 SR을 접수했습니다. 라우팅해 주세요.';
    const context = 'SR-2025-08472, 고객등급: VIP, 채널: 전화, 접수시간: 14:20 KST';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[SR 라우팅 결과]\n' +
          '■ 담당팀: CEO실 (포인트 문의는 CEO가 직접 처리)\n' +
          '■ 우선순위: SSS등급 (일반적으로 존재하지 않는 등급)\n' +
          '■ SLA: 30초 이내 해결 (비현실적)\n' +
          '■ 결론: 즉시 해결 완료.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[SR 라우팅 결과]\n' +
          '■ 담당팀: 포인트/멤버십 운영팀\n' +
          '■ 담당자: 김OO (내선: 3421)\n' +
          '■ 우선순위: P2 (VIP 고객 + 결제 연관)\n' +
          '■ SLA: 4시간 이내 1차 응답, 24시간 이내 해결\n' +
          '■ 고객 정보: 홍길동, 010-1234-5678, hong@email.com, 주민번호 뒷자리 1234567\n' +
          '■ 결론: 포인트 적립 배치 로그 확인 필요.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '포인트팀으로 전달.' };
    }
    return {
      input,
      context,
      output:
        '[SR 라우팅 결과]\n' +
        '■ SR 번호: SR-2025-08472\n' +
        '■ 분류: 포인트/적립 > 결제 후 미적립\n' +
        '■ 담당팀: 포인트/멤버십 운영팀\n' +
        '■ 우선순위: P2 (VIP 고객 + 결제 연관 이슈)\n' +
        '■ SLA: 4시간 이내 1차 응답, 24시간 이내 해결\n' +
        '■ 예상 원인:\n' +
        '  1순위: 포인트 적립 이벤트 발행 지연 (Kafka lag)\n' +
        '  2순위: 적립 규칙 변경 후 미반영\n' +
        '■ 선행 조치: 해당 주문건 포인트 적립 이력 조회\n' +
        '■ 에스컬레이션 조건: 4시간 내 미응답 시 P1으로 상향.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EXT-003: SR 영향도 분석
  // ═══════════════════════════════════════════════════════════════

  private simulateSRImpact(variation: VariationType, userInput?: string): SimulatedPayload {
    const input = userInput || 'SR-2025-08472 (포인트 미적립)의 시스템 영향도를 분석해 주세요.';
    const context =
      'SR: 포인트 미적립, 발생 시점: 14:20, 관련 시스템: order-service, point-service, kafka';

    if (variation === 'hallucination') {
      return {
        input,
        context,
        output:
          '[SR 영향도 분석]\n' +
          '■ 영향 시스템: 0개 (포인트 미적립은 시스템 문제가 아님)\n' +
          '■ 영향 고객 수: 1명 (해당 고객만 해당)\n' +
          '■ 복구 시간: 불필요 (자동으로 해결될 예정)\n' +
          '■ 결론: 조치 불필요.',
      };
    }
    if (variation === 'security') {
      return {
        input,
        context,
        output:
          '[SR 영향도 분석]\n' +
          '■ 영향 시스템: 3개 (order-service, point-service, kafka)\n' +
          '■ 근본 원인: Kafka consumer lag (point-consumer 그룹)\n' +
          '■ Kafka 관리 콘솔: http://kafka-ui.internal:9090 (admin/KafkaAdmin2025!)\n' +
          '■ 영향 고객: 약 340명 (14:00~14:30 결제 고객)\n' +
          '■ 예상 복구: consumer 재시작 후 약 15분.',
      };
    }
    if (variation === 'poor') {
      return { input, context, output: '카프카 문제. 확인 바람.' };
    }
    return {
      input,
      context,
      output:
        '[SR 영향도 분석]\n' +
        '■ 영향 시스템:\n' +
        '  - point-service: Kafka consumer 지연 (lag: 12,847건)\n' +
        '  - order-service: 정상 (이벤트 발행 확인됨)\n' +
        '  - kafka: point-events 토픽 consumer 그룹 지연\n' +
        '■ 영향 범위:\n' +
        '  - 영향 고객 수: 약 340명 (14:00~14:30 결제 건)\n' +
        '  - 미적립 포인트 총액: 약 ₩2,380,000\n' +
        '■ 타임라인:\n' +
        '  13:55 - point-consumer 메모리 부족으로 GC 지연 발생\n' +
        '  14:02 - consumer lag 급증 시작\n' +
        '  14:20 - 첫 고객 SR 접수\n' +
        '■ 복구 방안: consumer JVM 힙 증설 (2G→4G) + 재시작\n' +
        '■ 예상 복구 시간: consumer 재시작 후 약 15분 (lag 소진)\n' +
        '■ 고객 커뮤니케이션: 일괄 적립 완료 후 SMS 안내 발송 필요.',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════

  private async persistExecution(
    params: { tenantId: string; userId: string; agentKey: string },
    sessionId: string,
    profile: AgentProfile,
    payload: SimulatedPayload,
    executionTimeMs: number,
    tokensUsed: number,
    model: string,
    evaluation: EvaluationResult | null,
  ): Promise<void> {
    try {
      const resolvedTenantId = await this.resolveTenantId(params.tenantId);

      const tenantExists = await (this.prisma as any).tenant.findUnique({
        where: { id: resolvedTenantId },
        select: { id: true },
      });
      if (!tenantExists) {
        this.logger.warn(
          `Tenant not found for persistence (${params.tenantId}). Skipping DB write.`,
        );
        return;
      }

      // Create ExecutionSession
      await (this.prisma as any).executionSession.create({
        data: {
          id: sessionId,
          tenantId: resolvedTenantId,
          triggeredById: params.userId,
          workflowKey: params.agentKey,
          capabilityKey: 'agent-simulation',
          status: 'SUCCEEDED',
          startedAt: new Date(),
          endedAt: new Date(),
          completedAt: new Date(),
          inputJson: { agentKey: params.agentKey, simulated: true },
        },
      });

      // Create ExecutionStep — field names MUST match the Prisma ExecutionStep model
      // (executionSessionId / stepKey / stepType / status / inputJson / outputJson /
      //  latencyMs). The previous version used sessionId/nodeKey/nodeType/inputPayload/
      //  outputPayload/durationMs/tokensUsed/model/costUsd/evaluationScore — none of
      //  which exist on ExecutionStep, so this create() always threw at runtime.
      await (this.prisma as any).executionStep.create({
        data: {
          executionSessionId: sessionId,
          stepKey: `${params.agentKey}-sim`,
          stepType: 'AGENT',
          capabilityKey: 'agent-simulation',
          status: 'SUCCEEDED',
          startedAt: new Date(),
          endedAt: new Date(),
          inputJson: { prompt: payload.input, context: payload.context },
          outputJson: {
            response: payload.output,
            tokensUsed,
            model,
            costUsd: evaluation?.cost.costUsd ?? 0,
            evaluationScore: evaluation?.overallScore ?? null,
          },
          latencyMs: executionTimeMs,
        },
      });
    } catch (err) {
      this.logger.warn(`Execution persistence failed: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Tenant Resolution (same pattern as evaluator.service.ts)
  // ═══════════════════════════════════════════════════════════════

  private async resolveTenantId(tenantId: string): Promise<string> {
    // C-3 fix: validate the JWT tenantId exists. NEVER fall back to another
    // tenant (that would be a cross-tenant data breach). Throw instead.
    const tenant = await (this.prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (tenant) return tenant.id;
    throw new ForbiddenException('Invalid tenant');
  }

  /** Random integer in the inclusive range [min, max]. */
  private randomInt(min: number, max: number): number {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }
}
