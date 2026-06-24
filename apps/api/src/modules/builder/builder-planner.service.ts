/**
 * Builder Planner Service (BH-1 + BH-2)
 *
 * Responsibilities:
 *   - BH-1: Intent Classification (6-type model) + Template Matching (best-fit scoring)
 *   - BH-2: Parameter Extraction (NLP heuristic) + Connector Gap Detection (with alternatives)
 *   - Persist plan in BuilderRequest + BuilderPlan + BuilderParamSet + BuilderConnectorGap
 */
import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import type {
  BuilderPlanRequest,
  BuilderPlanResponse,
  BuilderParamsExtractRequest,
  BuilderParamsExtractResponse,
  BuilderConnectorsCheckRequest,
  BuilderConnectorsCheckResponse,
  IntentClassificationResult,
  HarnessTemplateNode,
  PolicyCheckpoint,
  WorkflowParameter,
  ConnectorGapEntry,
} from '@metis/types';

// ═══════════════════════════════════════════════════════════
//  BH-1: Intent Classification — 6-Type Model
// ═══════════════════════════════════════════════════════════

export type IntentType =
  | 'incident-response' // Incident 대응형
  | 'deploy-verification' // 배포 검증형
  | 'report-generation' // 보고서형
  | 'approval-workflow' // 승인형
  | 'knowledge-capture' // 지식화형
  | 'scheduled-execution'; // 주기 실행형

interface IntentPattern {
  id: string;
  type: IntentType;
  label: string;
  labelKo: string;
  keywords: string[];
  boostKeywords: string[]; // higher weight
  templateIds: string[];
  weight: number; // base priority weight
}

const INTENT_PATTERNS: IntentPattern[] = [
  // ── Type 1: Incident 대응형 ──
  {
    id: 'incident-triage',
    type: 'incident-response',
    label: 'Incident Triage',
    labelKo: '장애 접수 Triage',
    keywords: [
      '장애',
      '인시던트',
      'triage',
      '접수',
      '티켓',
      'incident',
      '장애대응',
      '이슈',
      '오류',
      '에러',
      'error',
      'outage',
    ],
    boostKeywords: ['장애', 'incident', 'triage', '긴급'],
    templateIds: ['wf-incident-triage'],
    weight: 1.0,
  },
  {
    id: 'alert-dedup',
    type: 'incident-response',
    label: 'Alert Deduplication',
    labelKo: '알림 중복 제거',
    keywords: ['알림', '중복', 'dedup', '그룹핑', 'alert', '노이즈', '알림피로', '경고'],
    boostKeywords: ['중복', 'dedup', '알림피로'],
    templateIds: ['wf-alert-dedup'],
    weight: 0.9,
  },
  {
    id: 'rca-draft',
    type: 'incident-response',
    label: 'RCA Draft',
    labelKo: 'RCA 초안 생성',
    keywords: ['rca', '근본원인', 'root cause', '포스트모템', '장애보고', '사후분석', '재발방지'],
    boostKeywords: ['rca', '근본원인', 'root cause'],
    templateIds: ['wf-rca-draft'],
    weight: 0.9,
  },

  // ── Type 2: 배포 검증형 ──
  {
    id: 'pre-deploy',
    type: 'deploy-verification',
    label: 'Pre-Deploy Gate',
    labelKo: '배포 전 점검',
    keywords: [
      '배포',
      'deploy',
      '릴리스',
      'release',
      'pr',
      '점검',
      '게이트',
      'ci/cd',
      '파이프라인',
    ],
    boostKeywords: ['배포', 'deploy', '릴리스'],
    templateIds: ['wf-pre-deploy-gate'],
    weight: 1.0,
  },
  {
    id: 'post-deploy',
    type: 'deploy-verification',
    label: 'Post-Deploy Verify',
    labelKo: '배포 후 검증',
    keywords: [
      '배포후',
      '롤백',
      'rollback',
      '카나리',
      'canary',
      '검증',
      '배포검증',
      'health check',
      '헬스체크',
    ],
    boostKeywords: ['롤백', 'rollback', '카나리', '배포검증'],
    templateIds: ['wf-post-deploy-verify'],
    weight: 0.9,
  },
  {
    id: 'release-note',
    type: 'deploy-verification',
    label: 'Release Note',
    labelKo: '릴리스 노트 생성',
    keywords: ['릴리스노트', 'release note', '변경사항', 'changelog', '변경이력'],
    boostKeywords: ['릴리스노트', 'changelog'],
    templateIds: ['wf-release-note'],
    weight: 0.8,
  },

  // ── Type 3: 보고서형 ──
  {
    id: 'compliance-scan',
    type: 'report-generation',
    label: 'Compliance Scan',
    labelKo: '컴플라이언스 스캔',
    keywords: [
      '컴플라이언스',
      'compliance',
      '감사',
      'audit',
      '규정',
      '점검',
      '보고',
      '리포트',
      '보고서',
      '대시보드',
    ],
    boostKeywords: ['컴플라이언스', 'compliance', '보고서'],
    templateIds: ['wf-compliance-scan'],
    weight: 1.0,
  },
  {
    id: 'news-briefing',
    type: 'report-generation',
    label: 'News Briefing',
    labelKo: '뉴스/AI 브리핑',
    keywords: [
      '뉴스',
      'news',
      '기사',
      '브리핑',
      '트렌드',
      '요약',
      'summary',
      '분석',
      '정리',
      '리서치',
    ],
    boostKeywords: ['뉴스', '브리핑', '요약'],
    templateIds: ['wf-rca-draft'],
    weight: 0.8,
  },

  // ── Type 4: 승인형 ──
  {
    id: 'approval-flow',
    type: 'approval-workflow',
    label: 'Approval Workflow',
    labelKo: '승인 워크플로우',
    keywords: [
      '승인',
      'approval',
      '결재',
      '허가',
      '검토',
      'review',
      '확인',
      '서명',
      '사인오프',
      '관리자승인',
    ],
    boostKeywords: ['승인', 'approval', '결재'],
    templateIds: ['wf-pre-deploy-gate'],
    weight: 1.0,
  },
  {
    id: 'policy-review',
    type: 'approval-workflow',
    label: 'Policy Review',
    labelKo: '정책 리뷰',
    keywords: ['정책', 'policy', '거버넌스', 'governance', '규칙', '정책검토', '정책위반'],
    boostKeywords: ['정책', 'policy', '거버넌스'],
    templateIds: ['wf-policy-review'],
    weight: 0.9,
  },

  // ── Type 5: 지식화형 ──
  {
    id: 'knowledge-sync',
    type: 'knowledge-capture',
    label: 'Knowledge Sync',
    labelKo: '지식 베이스 동기화',
    keywords: [
      '지식',
      'knowledge',
      '런북',
      'runbook',
      '문서',
      'wiki',
      '기술문서',
      'rag',
      '임베딩',
      'embedding',
    ],
    boostKeywords: ['지식', 'knowledge', '런북', 'rag'],
    templateIds: ['wf-knowledge-sync'],
    weight: 1.0,
  },
  {
    id: 'evidence-pack',
    type: 'knowledge-capture',
    label: 'Evidence Pack',
    labelKo: 'Evidence Pack 수집',
    keywords: ['evidence', '에비던스', '증적', '아티팩트', '증거', '기록', '아카이브'],
    boostKeywords: ['evidence', '증적'],
    templateIds: ['wf-evidence-pack'],
    weight: 0.9,
  },
  {
    id: 'pattern-detect',
    type: 'knowledge-capture',
    label: 'Pattern Detection',
    labelKo: '패턴 감지/학습',
    keywords: ['패턴', 'pattern', '이상', 'anomaly', '트렌드', '학습', '분류', '유사도'],
    boostKeywords: ['패턴', 'anomaly'],
    templateIds: ['wf-pattern-detect'],
    weight: 0.8,
  },
  {
    id: 'training-gen',
    type: 'knowledge-capture',
    label: 'Training Material',
    labelKo: '교육 자료 생성',
    keywords: ['교육', 'training', '온보딩', 'onboarding', '가이드', '매뉴얼', '튜토리얼'],
    boostKeywords: ['교육', 'training', '온보딩'],
    templateIds: ['wf-training-gen'],
    weight: 0.7,
  },

  // ── Type 6: 주기 실행형 ──
  {
    id: 'scheduled-monitoring',
    type: 'scheduled-execution',
    label: 'Scheduled Monitoring',
    labelKo: '주기적 모니터링',
    keywords: [
      '모니터링',
      'monitoring',
      '감시',
      '헬스체크',
      '상태',
      '주기',
      '매시간',
      '매일',
      '스케줄',
      'cron',
    ],
    boostKeywords: ['주기', '스케줄', '매시간', '매일', 'cron'],
    templateIds: ['wf-post-deploy-verify'],
    weight: 1.0,
  },
  {
    id: 'email-automation',
    type: 'scheduled-execution',
    label: 'Email Automation',
    labelKo: '이메일 자동 발송',
    keywords: [
      '메일',
      '이메일',
      'email',
      '발송',
      '자동발송',
      '정기',
      '아침',
      '오전',
      '오후',
      '매주',
    ],
    boostKeywords: ['자동발송', '정기', '아침', '매주'],
    templateIds: ['wf-alert-dedup'],
    weight: 0.9,
  },
  {
    id: 'automation-general',
    type: 'scheduled-execution',
    label: 'General Automation',
    labelKo: '일반 자동화',
    keywords: ['자동화', 'automation', '워크플로우', '반복', '배치', 'batch', '정기실행'],
    boostKeywords: ['자동화', '반복', '배치'],
    templateIds: ['wf-incident-triage'],
    weight: 0.7,
  },
];

const INTENT_TYPE_LABELS: Record<IntentType, string> = {
  'incident-response': 'Incident 대응형',
  'deploy-verification': '배포 검증형',
  'report-generation': '보고서형',
  'approval-workflow': '승인형',
  'knowledge-capture': '지식화형',
  'scheduled-execution': '주기 실행형',
};

// ═══════════════════════════════════════════════════════════
//  BH-2: Parameter Definitions per Template
// ═══════════════════════════════════════════════════════════

const TEMPLATE_PARAMETERS: Record<string, WorkflowParameter[]> = {
  'wf-incident-triage': [
    {
      key: 'service_name',
      label: '대상 서비스',
      type: 'string',
      required: true,
      description: '장애가 발생한 서비스명',
    },
    {
      key: 'ticket_id',
      label: '티켓 ID',
      type: 'string',
      required: false,
      description: 'ITSM 티켓 ID (자동 생성 가능)',
    },
    {
      key: 'environment',
      label: '환경',
      type: 'select',
      required: true,
      options: ['production', 'staging', 'development'],
      defaultValue: 'production',
      description: '영향 환경',
    },
    {
      key: 'priority',
      label: '우선순위',
      type: 'select',
      required: true,
      options: ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'],
      description: '인시던트 우선순위',
    },
    {
      key: 'approver',
      label: '승인자',
      type: 'string',
      required: false,
      description: '에스컬레이션 승인자',
    },
  ],
  'wf-alert-dedup': [
    {
      key: 'service_name',
      label: '대상 서비스',
      type: 'string',
      required: true,
      description: '알림 발생 서비스',
    },
    {
      key: 'alert_type',
      label: '알림 유형',
      type: 'select',
      required: false,
      options: ['error_rate', 'latency', 'saturation', 'availability', 'security'],
      description: '알림 카테고리',
    },
  ],
  'wf-rca-draft': [
    {
      key: 'ticket_id',
      label: '인시던트 ID',
      type: 'string',
      required: true,
      description: '해결된 인시던트 ID',
    },
    {
      key: 'service_name',
      label: '서비스명',
      type: 'string',
      required: false,
      description: '장애 서비스',
    },
  ],
  'wf-pre-deploy-gate': [
    {
      key: 'service_name',
      label: '서비스명',
      type: 'string',
      required: true,
      description: '배포 대상 서비스',
    },
    {
      key: 'environment',
      label: '대상 환경',
      type: 'select',
      required: true,
      options: ['production', 'staging', 'canary'],
      defaultValue: 'production',
      description: '배포 환경',
    },
    {
      key: 'release_id',
      label: '릴리스 ID',
      type: 'string',
      required: false,
      description: '릴리스 버전',
    },
    {
      key: 'approver',
      label: '승인자',
      type: 'string',
      required: true,
      description: '배포 승인 관리자',
    },
    {
      key: 'report_cycle',
      label: '보고 주기',
      type: 'select',
      required: false,
      options: ['즉시', '매일', '매주'],
      defaultValue: '즉시',
      description: '결과 보고 주기',
    },
  ],
  'wf-post-deploy-verify': [
    {
      key: 'service_name',
      label: '서비스명',
      type: 'string',
      required: true,
      description: '배포된 서비스',
    },
    {
      key: 'environment',
      label: '환경',
      type: 'select',
      required: true,
      options: ['production', 'staging', 'canary'],
      description: '배포 환경',
    },
    {
      key: 'release_id',
      label: '릴리스 ID',
      type: 'string',
      required: false,
      description: '릴리스 버전',
    },
  ],
  'wf-release-note': [
    {
      key: 'release_id',
      label: '릴리스 ID',
      type: 'string',
      required: true,
      description: '릴리스 버전',
    },
    {
      key: 'service_name',
      label: '서비스명',
      type: 'string',
      required: false,
      description: '대상 서비스',
    },
    {
      key: 'report_cycle',
      label: '보고 주기',
      type: 'select',
      required: false,
      options: ['즉시', '매주', '매달'],
      description: '노트 생성 주기',
    },
  ],
  'wf-compliance-scan': [
    {
      key: 'service_name',
      label: '대상 시스템',
      type: 'string',
      required: true,
      description: '스캔 대상 시스템',
    },
    {
      key: 'report_cycle',
      label: '보고 주기',
      type: 'select',
      required: true,
      options: ['매일', '매주', '매달', '분기'],
      defaultValue: '매주',
      description: '컴플라이언스 보고 주기',
    },
    {
      key: 'approver',
      label: '검토자',
      type: 'string',
      required: false,
      description: '감사 검토 승인자',
    },
  ],
  'wf-policy-review': [
    {
      key: 'approver',
      label: '승인자',
      type: 'string',
      required: true,
      description: '정책 검토 승인자',
    },
    {
      key: 'service_name',
      label: '대상 시스템',
      type: 'string',
      required: false,
      description: '정책 적용 대상',
    },
  ],
  'wf-evidence-pack': [
    {
      key: 'ticket_id',
      label: '관련 티켓',
      type: 'string',
      required: false,
      description: '연관 인시던트/변경 티켓',
    },
    {
      key: 'service_name',
      label: '대상 서비스',
      type: 'string',
      required: false,
      description: '증적 수집 대상',
    },
  ],
  'wf-knowledge-sync': [
    {
      key: 'service_name',
      label: '대상 도메인',
      type: 'string',
      required: true,
      description: '지식 대상 도메인/서비스',
    },
    {
      key: 'report_cycle',
      label: '동기화 주기',
      type: 'select',
      required: false,
      options: ['실시간', '매일', '매주'],
      defaultValue: '매일',
      description: '지식 동기화 주기',
    },
  ],
  'wf-pattern-detect': [
    {
      key: 'service_name',
      label: '대상 서비스',
      type: 'string',
      required: true,
      description: '패턴 감지 대상',
    },
    {
      key: 'report_cycle',
      label: '분석 주기',
      type: 'select',
      required: false,
      options: ['매시간', '매일', '매주'],
      defaultValue: '매일',
      description: '패턴 분석 주기',
    },
  ],
  'wf-training-gen': [
    {
      key: 'service_name',
      label: '교육 주제',
      type: 'string',
      required: true,
      description: '교육 자료 주제/서비스',
    },
  ],
};

// ═══════════════════════════════════════════════════════════
//  Connector Alternative Map
// ═══════════════════════════════════════════════════════════

const CONNECTOR_ALTERNATIVES: Record<string, string[]> = {
  jira: ['github', 'metis-knowledge'], // ITSM → GitHub Issues → Knowledge
  github: ['jenkins'], // GitHub → Jenkins
  slack: ['teams', 'email-smtp'], // Slack → Teams → Email
  teams: ['slack', 'email-smtp'], // Teams → Slack → Email
  prometheus: ['elk'], // Prometheus → ELK
  elk: ['prometheus', 'metis-audit'], // ELK → Prometheus → Audit
  pagerduty: ['slack', 'email-smtp'], // PagerDuty → Slack → Email
  jenkins: ['github'], // Jenkins → GitHub
  confluence: ['metis-knowledge'], // Confluence → Metis Knowledge
  'email-smtp': ['slack', 'teams'], // Email → Slack → Teams
  s3: ['metis-evidence', 'postgresql'], // S3 → Evidence → PostgreSQL
};

// ═══════════════════════════════════════════════════════════
//  NLP Parameter Extraction Patterns
// ═══════════════════════════════════════════════════════════

const PARAM_EXTRACT_PATTERNS: Record<string, RegExp[]> = {
  service_name: [
    /(?:서비스|시스템|대상|서버|앱|어플|application|service|system|server)\s*[:=]?\s*['"]?([a-zA-Z가-힣0-9_\-.]+)/i,
    /([a-zA-Z가-힣][a-zA-Z가-힣0-9_\-]+)\s*(?:서비스|시스템|서버|앱)/i,
  ],
  ticket_id: [
    /(?:티켓|ticket|이슈|issue|인시던트|incident)\s*(?:id|ID|번호)?\s*[:=]?\s*['"]?([A-Z]+-\d+|#?\d{4,})/i,
    /(INC-\d+|CHG-\d+|TASK-\d+|[A-Z]{2,5}-\d{3,})/i,
  ],
  environment: [
    /(?:환경|env|environment)\s*[:=]?\s*['"]?(production|staging|development|canary|prod|stg|dev)/i,
    /(프로덕션|스테이징|개발|운영|상용)/i,
  ],
  release_id: [
    /(?:릴리스|release|버전|version)\s*(?:id|ID)?\s*[:=]?\s*['"]?([a-zA-Z0-9._\-]+)/i,
    /(v?\d+\.\d+(?:\.\d+)?)/i,
  ],
  approver: [
    /(?:승인자|승인|approver|검토자|담당자|관리자)\s*[:=]?\s*['"]?([a-zA-Z가-힣][a-zA-Z가-힣0-9@._\- ]+)/i,
  ],
  report_cycle: [
    /(?:주기|cycle|간격|빈도)\s*[:=]?\s*['"]?(매시간|매일|매주|매달|분기|즉시|daily|weekly|monthly|hourly)/i,
    /(매시간|매일|매주|매달|분기|아침|오전|오후)/i,
  ],
};

const ENVIRONMENT_MAP: Record<string, string> = {
  프로덕션: 'production',
  운영: 'production',
  상용: 'production',
  prod: 'production',
  스테이징: 'staging',
  stg: 'staging',
  개발: 'development',
  dev: 'development',
};

const REPORT_CYCLE_MAP: Record<string, string> = {
  hourly: '매시간',
  아침: '매일',
  오전: '매일',
  오후: '매일',
  daily: '매일',
  weekly: '매주',
  monthly: '매달',
};

@Injectable()
export class BuilderPlannerService {
  private readonly logger = new Logger(BuilderPlannerService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ═══════════════════════════════════════════
  //  POST /builder/plan
  // ═══════════════════════════════════════════

  async createPlan(ctx: TenantContext, dto: BuilderPlanRequest): Promise<BuilderPlanResponse> {
    const db = withTenantIsolation(this.prisma, ctx);

    // 1. Classify intent (6-type model with scoring)
    const intents = this.classifyIntent(dto.userPrompt);

    // 2. Best-fit template matching
    let matchedTemplateId: string | null = dto.templateId ?? null;
    if (!matchedTemplateId && intents.length > 0) {
      matchedTemplateId = this.findBestTemplate(intents);
    }

    // 3. Build plan
    const planNodes = matchedTemplateId ? this.getTemplateNodes(matchedTemplateId) : [];
    const planConnectors = matchedTemplateId ? this.getTemplateConnectors(matchedTemplateId) : [];
    const planPolicies = matchedTemplateId ? this.getTemplatePolicies(matchedTemplateId) : [];
    const planParameters = matchedTemplateId ? this.getTemplateParameters(matchedTemplateId) : [];

    // 4. Auto-extract parameters from prompt
    const extractedParams = this.extractParametersFromPrompt(dto.userPrompt, planParameters);

    // 5. Persist
    const request = await db.builderRequest.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: 'PLANNING',
        userPrompt: dto.userPrompt,
        detectedIntents: intents as any,
        matchedTemplate: matchedTemplateId,
        planCreatedAt: new Date(),
        plan: {
          create: {
            templateId: matchedTemplateId,
            templateName: matchedTemplateId ? this.getTemplateName(matchedTemplateId) : null,
            nodesJson: planNodes as any,
            connectorsJson: planConnectors,
            policiesJson: planPolicies as any,
            parametersJson: extractedParams as any,
            metadata: {
              intentCount: intents.length,
              topIntent: intents[0]?.patternId || null,
              intentType: intents[0]?.type || null,
              intentTypeLabel: intents[0]?.type
                ? INTENT_TYPE_LABELS[intents[0].type as IntentType]
                : null,
            },
          },
        },
      },
    });

    this.logger.log(
      `Plan created: ${request.id}, intent=${intents[0]?.type || 'none'}, template=${matchedTemplateId}`,
    );

    return {
      requestId: request.id,
      detectedIntents: intents,
      matchedTemplateId,
      matchedTemplateName: matchedTemplateId ? this.getTemplateName(matchedTemplateId) : null,
      plan:
        planNodes.length > 0
          ? {
              nodes: planNodes,
              connectors: planConnectors,
              policies: planPolicies,
              parameters: extractedParams,
              metadata: { intentCount: intents.length, intentType: intents[0]?.type || null },
            }
          : null,
    };
  }

  // ═══════════════════════════════════════════
  //  POST /builder/params/extract
  // ═══════════════════════════════════════════

  async extractParams(
    ctx: TenantContext,
    dto: BuilderParamsExtractRequest,
  ): Promise<BuilderParamsExtractResponse> {
    const db = withTenantIsolation(this.prisma, ctx);
    const request = await db.builderRequest.findUnique({
      where: { id: dto.requestId },
      include: { plan: true },
    });
    if (!request) throw new NotFoundException('Builder request not found');

    const planParams = (request.plan?.parametersJson as WorkflowParameter[] | null) || [];
    const resolved = this.extractParametersFromPrompt(dto.userPrompt, planParams);
    const asResolved = resolved.map((p) => ({
      key: p.key,
      label: p.label,
      value: p.defaultValue || null,
      resolved: !!p.defaultValue,
    }));
    const unresolvedCount = asResolved.filter((r) => !r.resolved).length;

    await this.prisma.builderParamSet.upsert({
      where: { requestId: dto.requestId },
      create: { requestId: dto.requestId, parametersJson: asResolved as any, unresolvedCount },
      update: { parametersJson: asResolved as any, unresolvedCount },
    });

    return { requestId: dto.requestId, parameters: asResolved, unresolvedCount };
  }

  // ═══════════════════════════════════════════
  //  POST /builder/connectors/check
  // ═══════════════════════════════════════════

  async checkConnectors(
    ctx: TenantContext,
    dto: BuilderConnectorsCheckRequest,
  ): Promise<BuilderConnectorsCheckResponse> {
    const db = withTenantIsolation(this.prisma, ctx);
    const tenantConnectors = await db.connector.findMany({
      select: { key: true, name: true, status: true },
    });
    const activeKeys = new Set(
      tenantConnectors.filter((c: any) => c.status === 'ACTIVE').map((c: any) => c.key),
    );

    const gaps: ConnectorGapEntry[] = dto.connectorKeys.map((key: string) => {
      const isAvailable = activeKeys.has(key) || key.startsWith('metis-');
      const tier = this.getConnectorTier(key);

      // Find alternatives if not available
      const alternatives = !isAvailable ? CONNECTOR_ALTERNATIVES[key] || [] : [];
      const availableAlternative = alternatives.find(
        (alt) => activeKeys.has(alt) || alt.startsWith('metis-'),
      );

      return {
        connectorKey: key,
        connectorName: this.getConnectorName(key),
        tier,
        status: isAvailable ? 'available' : 'placeholder',
        requiredSecrets: this.getConnectorSecrets(key),
        resolution: !isAvailable
          ? availableAlternative
            ? `대체 가능: ${this.getConnectorName(availableAlternative)} (${availableAlternative})`
            : `placeholder 생성됨 — 설치 필요. 대체 후보: ${alternatives.map((a) => this.getConnectorName(a)).join(', ') || '없음'}`
          : undefined,
      };
    });

    await this.prisma.builderConnectorGap.deleteMany({ where: { requestId: dto.requestId } });
    if (gaps.length > 0) {
      await this.prisma.builderConnectorGap.createMany({
        data: gaps.map((g) => ({
          requestId: dto.requestId,
          connectorKey: g.connectorKey,
          connectorName: g.connectorName,
          tier: g.tier,
          status: g.status,
          requiredSecrets: g.requiredSecrets as any,
          resolution: g.resolution,
        })),
      });
    }

    return {
      requestId: dto.requestId,
      gaps,
      availableCount: gaps.filter((g) => g.status === 'available').length,
      placeholderCount: gaps.filter((g) => g.status === 'placeholder').length,
      missingCount: gaps.filter((g) => g.status === 'missing').length,
    };
  }

  // ═══════════════════════════════════════════
  //  Private: Intent Classification (scored)
  // ═══════════════════════════════════════════

  private classifyIntent(prompt: string): (IntentClassificationResult & { type: IntentType })[] {
    const lower = prompt.toLowerCase();
    const results: (IntentClassificationResult & { type: IntentType })[] = [];

    for (const pattern of INTENT_PATTERNS) {
      const matched = pattern.keywords.filter((kw) => lower.includes(kw));
      const boosted = pattern.boostKeywords.filter((kw) => lower.includes(kw));
      if (matched.length === 0) continue;

      // Weighted scoring: normal keywords = 1pt, boost keywords = 2pt, then multiply by base weight
      const rawScore =
        (matched.length + boosted.length) /
        (pattern.keywords.length + pattern.boostKeywords.length);
      const score = rawScore * pattern.weight;

      results.push({
        patternId: pattern.id,
        type: pattern.type,
        label: `${pattern.labelKo} (${INTENT_TYPE_LABELS[pattern.type]})`,
        score: Math.round(score * 100) / 100,
        matchedKeywords: matched,
        templateIds: pattern.templateIds,
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // ═══════════════════════════════════════════
  //  Private: Best-Fit Template Matching
  // ═══════════════════════════════════════════

  private findBestTemplate(
    intents: (IntentClassificationResult & { type: IntentType })[],
  ): string | null {
    if (intents.length === 0) return null;

    // Aggregate scores per template across all matching intents
    const templateScores = new Map<string, number>();
    for (const intent of intents) {
      for (const tid of intent.templateIds) {
        const current = templateScores.get(tid) || 0;
        templateScores.set(tid, current + intent.score);
      }
    }

    // Return highest scoring template
    let bestTemplate: string | null = null;
    let bestScore = -1;
    for (const [tid, score] of templateScores) {
      if (score > bestScore) {
        bestScore = score;
        bestTemplate = tid;
      }
    }

    return bestTemplate;
  }

  // ═══════════════════════════════════════════
  //  Private: NLP Parameter Extraction
  // ═══════════════════════════════════════════

  private extractParametersFromPrompt(
    prompt: string,
    templateParams: WorkflowParameter[],
  ): WorkflowParameter[] {
    // First, extract all extractable values from the prompt
    const extracted: Record<string, string> = {};

    for (const [paramKey, patterns] of Object.entries(PARAM_EXTRACT_PATTERNS)) {
      for (const regex of patterns) {
        const match = prompt.match(regex);
        if (match && match[1]) {
          let value = match[1].trim();
          // Normalize environment values
          if (paramKey === 'environment' && ENVIRONMENT_MAP[value.toLowerCase()]) {
            value = ENVIRONMENT_MAP[value.toLowerCase()];
          }
          // Normalize report cycle
          if (paramKey === 'report_cycle' && REPORT_CYCLE_MAP[value.toLowerCase()]) {
            value = REPORT_CYCLE_MAP[value.toLowerCase()];
          }
          extracted[paramKey] = value;
          break;
        }
      }
    }

    // Map extracted values to template parameters
    return templateParams.map((p) => {
      const extractedValue = extracted[p.key];
      if (extractedValue) {
        // Validate against options if select type
        if (p.type === 'select' && p.options) {
          const matchedOption = p.options.find(
            (opt: string) => opt.toLowerCase() === extractedValue.toLowerCase(),
          );
          if (matchedOption) return { ...p, defaultValue: matchedOption };
        } else {
          return { ...p, defaultValue: extractedValue };
        }
      }
      return p;
    });
  }

  // ═══════════════════════════════════════════
  //  Private: Template Registry
  // ═══════════════════════════════════════════

  getTemplateNodes(templateId: string): HarnessTemplateNode[] {
    const baseNodes: Record<string, HarnessTemplateNode[]> = {
      'wf-incident-triage': [
        {
          id: 'n1',
          type: 'webhook',
          name: 'ITSM Webhook 수신',
          icon: '🔗',
          color: '#8B4513',
          order: 1,
          connectorKey: 'jira',
          actionType: 'read',
          failureAction: 'stop',
          description: 'ITSM 이벤트 수신',
          outputKeys: ['incident_id'],
          settings: {},
        },
        {
          id: 'n2',
          type: 'api-call',
          name: '인시던트 상세 로드',
          icon: '🌐',
          color: '#FF6348',
          order: 2,
          connectorKey: 'jira',
          actionType: 'read',
          failureAction: 'stop',
          description: '상세 정보 조회',
          outputKeys: ['full_incident'],
          settings: {},
        },
        {
          id: 'n3',
          type: 'log-monitor',
          name: '로그/메트릭 수집',
          icon: '📊',
          color: '#20B2AA',
          order: 3,
          connectorKey: 'elk',
          actionType: 'read',
          failureAction: 'skip',
          description: '에러 로그 수집',
          outputKeys: ['error_logs'],
          settings: {},
        },
        {
          id: 'n4',
          type: 'condition',
          name: '정책 점검',
          icon: '⚡',
          color: '#F77F00',
          order: 4,
          actionType: 'read',
          policyCheckpoint: 'pol-1',
          failureAction: 'stop',
          description: '거버넌스 정책 확인',
          outputKeys: ['policy_result'],
          settings: {},
        },
        {
          id: 'n5',
          type: 'ai-processing',
          name: '심각도 분류 & Triage',
          icon: '🤖',
          color: '#6C5CE7',
          order: 5,
          actionType: 'execute',
          failureAction: 'fallback',
          description: 'AI Triage',
          outputKeys: ['severity', 'triage_summary'],
          settings: {},
        },
        {
          id: 'n6',
          type: 'slack-message',
          name: '운영 채널 알림',
          icon: '💬',
          color: '#00B894',
          order: 6,
          connectorKey: 'slack',
          actionType: 'external-send',
          failureAction: 'retry',
          retryCount: 2,
          description: '운영팀 알림',
          outputKeys: ['notification_sent'],
          settings: {},
        },
        {
          id: 'n7',
          type: 'data-storage',
          name: '감사 로그 기록',
          icon: '💾',
          color: '#00A8CC',
          order: 7,
          connectorKey: 'metis-audit',
          actionType: 'write',
          failureAction: 'retry',
          retryCount: 3,
          description: '감사 기록',
          outputKeys: ['audit_id'],
          settings: {},
        },
      ],
    };
    return baseNodes[templateId] || [];
  }

  getTemplateConnectors(templateId: string): string[] {
    const map: Record<string, string[]> = {
      'wf-incident-triage': [
        'jira',
        'github',
        'elk',
        'metis-knowledge',
        'slack',
        'metis-audit',
        'metis-evidence',
      ],
      'wf-alert-dedup': ['pagerduty', 'jira', 'metis-audit'],
      'wf-rca-draft': ['jira', 'elk', 'confluence', 'metis-evidence'],
      'wf-pre-deploy-gate': ['github', 'jira', 'slack', 'metis-audit'],
      'wf-post-deploy-verify': ['prometheus', 'slack', 'metis-audit'],
      'wf-release-note': ['github', 'confluence', 'metis-audit'],
      'wf-compliance-scan': ['metis-audit', 'metis-evidence', 'slack'],
      'wf-policy-review': ['metis-audit', 'metis-knowledge'],
      'wf-evidence-pack': ['metis-evidence', 'metis-audit', 's3'],
      'wf-knowledge-sync': ['metis-knowledge', 'confluence', 'metis-audit'],
      'wf-pattern-detect': ['elk', 'metis-knowledge', 'metis-audit'],
      'wf-training-gen': ['metis-knowledge', 'confluence', 'metis-audit'],
    };
    return map[templateId] || [];
  }

  private getTemplatePolicies(templateId: string): PolicyCheckpoint[] {
    return [];
  }

  getTemplateParameters(templateId: string): WorkflowParameter[] {
    return TEMPLATE_PARAMETERS[templateId] || [];
  }

  getTemplateName(templateId: string): string {
    const names: Record<string, string> = {
      'wf-incident-triage': '장애 접수 Triage 자동화',
      'wf-alert-dedup': '알림 중복 제거 & 그룹핑',
      'wf-rca-draft': 'RCA 초안 자동 생성',
      'wf-pre-deploy-gate': '배포 전 점검 게이트',
      'wf-post-deploy-verify': '배포 후 검증 & 롤백 추천',
      'wf-release-note': '릴리스 노트 자동 생성',
      'wf-compliance-scan': '컴플라이언스 스캔',
      'wf-policy-review': '정책 리뷰 자동화',
      'wf-evidence-pack': 'Evidence Pack 자동 수집',
      'wf-knowledge-sync': '지식 베이스 동기화',
      'wf-pattern-detect': '장애 패턴 감지',
      'wf-training-gen': '교육 자료 자동 생성',
    };
    return names[templateId] || templateId;
  }

  getConnectorTier(key: string): 'tier1-must' | 'tier2-reporting' | 'tier3-knowledge' {
    const tier1 = new Set([
      'jira',
      'github',
      'slack',
      'prometheus',
      'kubernetes',
      'pagerduty',
      'jenkins',
      'elk',
    ]);
    const tier2 = new Set(['email-smtp', 'confluence', 'teams']);
    return tier1.has(key) ? 'tier1-must' : tier2.has(key) ? 'tier2-reporting' : 'tier3-knowledge';
  }

  private getConnectorName(key: string): string {
    const names: Record<string, string> = {
      jira: 'Jira / ITSM',
      github: 'GitHub',
      slack: 'Slack',
      prometheus: 'Prometheus / Grafana',
      kubernetes: 'Kubernetes',
      pagerduty: 'PagerDuty',
      jenkins: 'Jenkins / ArgoCD',
      elk: 'ELK / Splunk',
      'email-smtp': 'Email (SMTP)',
      confluence: 'Confluence / Notion',
      teams: 'Microsoft Teams',
      postgresql: 'PostgreSQL',
      s3: 'S3 / Cloud Storage',
      'metis-knowledge': 'Metis Knowledge Registry',
      'metis-audit': 'Metis Audit Log',
      'metis-evidence': 'Metis Evidence Pack',
    };
    return names[key] || key;
  }

  private getConnectorSecrets(key: string): string[] {
    const secrets: Record<string, string[]> = {
      jira: ['JIRA_URL', 'JIRA_API_TOKEN'],
      github: ['GITHUB_TOKEN'],
      slack: ['SLACK_BOT_TOKEN'],
      prometheus: ['PROMETHEUS_URL', 'GRAFANA_API_KEY'],
      kubernetes: ['KUBECONFIG'],
      pagerduty: ['PAGERDUTY_API_KEY'],
      jenkins: ['JENKINS_URL', 'JENKINS_TOKEN'],
      elk: ['ELASTICSEARCH_URL'],
      'email-smtp': ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
      confluence: ['CONFLUENCE_URL', 'CONFLUENCE_TOKEN'],
      teams: ['TEAMS_WEBHOOK_URL'],
    };
    return secrets[key] || [];
  }
}
