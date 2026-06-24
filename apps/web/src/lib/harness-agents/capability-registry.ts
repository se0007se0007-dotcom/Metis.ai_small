/**
 * Metis.AI Builder Harness — Capability Registry Agent
 *
 * This module maintains a registry of available connectors and tools, matching
 * required capabilities to the best available implementation based on:
 *   - Installation status (tenant-specific)
 *   - Reliability metrics
 *   - Cost and latency
 *   - Feature coverage
 *
 * The registry acts as a decision engine for the Harness, helping builders:
 *   1. Discover available connectors
 *   2. Find alternatives when preferred connectors aren't installed
 *   3. Understand capability-to-connector mappings
 *   4. Make cost/reliability trade-offs
 *
 * Categories:
 *   - search: Web search, content discovery
 *   - ai: Language models, inference
 *   - communication: Email, messaging, notifications
 *   - storage: Databases, file storage, document management
 *   - integration: Ticketing, versioning, webhooks
 *   - monitoring: Auditing, observability, incident management
 *   - scheduling: Job scheduling, automation triggers
 */

/**
 * ConnectorCapability — Describes a single connector's capabilities
 *
 * Each connector represents either:
 *   - A SaaS API integration (Slack, Jira, GitHub, etc.)
 *   - A built-in Metis service (metis-audit, metis-cron, etc.)
 *   - An on-premise database or tool (PostgreSQL, MongoDB, etc.)
 */
export interface ConnectorCapability {
  /** Unique identifier: kebab-case, lowercase (e.g., 'google-search-api', 'slack-api') */
  id: string;

  /** Display name in Korean (e.g., '구글 검색 API', 'Slack') */
  name: string;

  /** Category for logical grouping */
  category:
    | 'search'
    | 'ai'
    | 'communication'
    | 'storage'
    | 'integration'
    | 'monitoring'
    | 'scheduling';

  /**
   * What this connector can do.
   * Examples: ['web-search', 'news-aggregation'], ['send-email', 'schedule-delivery']
   * Used for fine-grained capability matching.
   */
  capabilities: string[];

  /** SaaS tier: built-in services, standard (pre-integrated), premium, or enterprise-only */
  tier: 'built-in' | 'standard' | 'premium' | 'enterprise';

  /** Current status in this registry */
  status: 'available' | 'installed' | 'not-installed' | 'deprecated';

  /** Estimated USD cost per API call (0 for built-in/unlimited) */
  costPerCall: number;

  /** Average latency in milliseconds */
  latencyMs: number;

  /** Reliability score: 0 (unreliable) to 1 (highly reliable) */
  reliability: number;

  /**
   * IDs of alternative connectors that provide similar capabilities.
   * Ranked by preference (best first). Used for fallback suggestions.
   */
  alternatives: string[];

  /** Brief description of connector in Korean */
  description: string;

  /** Whether this connector requires authentication setup */
  requiresAuth: boolean;

  /** Example use cases in Korean */
  useCases?: string[];
}

/**
 * CONNECTOR_CATALOG — Comprehensive registry of ~25 available connectors
 *
 * Organized by category, with realistic metrics and status assignments.
 * Metis built-in connectors are marked 'available' unconditionally.
 * Popular SaaS connectors (Gmail, Slack) default to 'installed'.
 * Enterprise/specialized connectors default to 'not-installed'.
 */
export const CONNECTOR_CATALOG: ConnectorCapability[] = [
  // ── SEARCH CATEGORY (5 connectors) ──

  {
    id: 'google-search-api',
    name: '구글 검색 API',
    category: 'search',
    capabilities: ['web-search', 'image-search', 'news-search', 'result-ranking'],
    tier: 'standard',
    status: 'installed',
    costPerCall: 0.005,
    latencyMs: 800,
    reliability: 0.99,
    alternatives: ['bing-search-api', 'tavily-search', 'serpapi'],
    description: '실시간 웹 검색, 이미지, 뉴스 결과를 제공하는 Google 검색 API',
    requiresAuth: true,
    useCases: ['최신 뉴스 검색', '웹 콘텐츠 발굴', '이미지 검색', '뉴스 요약'],
  },

  {
    id: 'bing-search-api',
    name: 'Bing Search API',
    category: 'search',
    capabilities: ['web-search', 'image-search', 'video-search', 'news-search'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.001,
    latencyMs: 600,
    reliability: 0.98,
    alternatives: ['google-search-api', 'tavily-search'],
    description: 'Microsoft Bing의 검색 API로 저렴한 비용으로 웹, 이미지, 비디오 검색 제공',
    requiresAuth: true,
    useCases: ['저비용 웹 검색', '비디오 콘텐츠 검색'],
  },

  {
    id: 'tavily-search',
    name: 'Tavily AI Search',
    category: 'search',
    capabilities: ['web-search', 'research', 'information-extraction'],
    tier: 'premium',
    status: 'not-installed',
    costPerCall: 0.01,
    latencyMs: 2000,
    reliability: 0.97,
    alternatives: ['google-search-api', 'serpapi'],
    description: 'AI 강화 웹 검색으로 연구 목적에 최적화된 정보 추출 및 분석 제공',
    requiresAuth: true,
    useCases: ['연구 자료 수집', '시장 분석', 'AI 기반 정보 검색'],
  },

  {
    id: 'serpapi',
    name: 'SerpAPI',
    category: 'search',
    capabilities: ['web-search', 'google-search', 'bing-search', 'baidu-search'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.002,
    latencyMs: 700,
    reliability: 0.99,
    alternatives: ['google-search-api', 'bing-search-api'],
    description: '여러 검색 엔진(Google, Bing, Baidu 등)을 단일 API로 통합 제공',
    requiresAuth: true,
    useCases: ['다중 검색 엔진 비교', '지역별 검색 결과', '가격 비교'],
  },

  {
    id: 'naver-search',
    name: '네이버 검색 API',
    category: 'search',
    capabilities: ['web-search', 'blog-search', 'news-search', 'korean-content'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 500,
    reliability: 0.98,
    alternatives: ['google-search-api'],
    description: '한국어 콘텐츠 검색에 최적화된 네이버 검색 API',
    requiresAuth: true,
    useCases: ['한국어 웹 검색', '블로그 검색', '한국 뉴스', '쇼핑 정보'],
  },

  // ── AI CATEGORY (4 connectors) ──

  {
    id: 'claude-api',
    name: 'Claude API (Anthropic)',
    category: 'ai',
    capabilities: ['text-generation', 'analysis', 'coding', 'vision', 'long-context'],
    tier: 'premium',
    status: 'installed',
    costPerCall: 0.01,
    latencyMs: 2500,
    reliability: 0.99,
    alternatives: ['openai-api', 'google-gemini'],
    description: '고성능 LLM으로 분석, 코딩, 비전 작업에 최적화된 Claude API',
    requiresAuth: true,
    useCases: ['복잡한 분석', '코드 생성 및 검토', '이미지 분석', '긴 문맥 처리'],
  },

  {
    id: 'openai-api',
    name: 'OpenAI API',
    category: 'ai',
    capabilities: ['text-generation', 'embedding', 'moderation', 'image-generation'],
    tier: 'premium',
    status: 'installed',
    costPerCall: 0.002,
    latencyMs: 1500,
    reliability: 0.98,
    alternatives: ['claude-api', 'google-gemini'],
    description: '널리 사용되는 GPT 기반 LLM API로 다양한 AI 작업 지원',
    requiresAuth: true,
    useCases: ['GPT 기반 텍스트 생성', '임베딩 생성', '이미지 생성', '콘텐츠 검토'],
  },

  {
    id: 'google-gemini',
    name: 'Google Gemini API',
    category: 'ai',
    capabilities: ['text-generation', 'multimodal', 'code-generation', 'embedding'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0005,
    latencyMs: 1800,
    reliability: 0.97,
    alternatives: ['openai-api', 'claude-api'],
    description: 'Google의 최신 멀티모달 LLM으로 비용 효율적인 AI 작업 제공',
    requiresAuth: true,
    useCases: ['멀티모달 작업', '저비용 LLM', '이미지 및 텍스트 분석'],
  },

  {
    id: 'metis-builtin-llm',
    name: 'Metis Built-in LLM',
    category: 'ai',
    capabilities: ['text-generation', 'analysis', 'local-execution'],
    tier: 'built-in',
    status: 'available',
    costPerCall: 0.0,
    latencyMs: 3000,
    reliability: 0.95,
    alternatives: ['claude-api', 'openai-api'],
    description: 'Metis 플랫폼 내장 경량 LLM으로 외부 API 비용 없이 기본 작업 수행',
    requiresAuth: false,
    useCases: ['비용 절감', '오프라인 실행', '기본 텍스트 처리', '프로토타입 개발'],
  },

  // ── COMMUNICATION CATEGORY (6 connectors) ──

  {
    id: 'gmail-smtp',
    name: 'Gmail / Google Workspace',
    category: 'communication',
    capabilities: ['send-email', 'read-email', 'schedule-email', 'attachment-handling'],
    tier: 'standard',
    status: 'installed',
    costPerCall: 0.0,
    latencyMs: 500,
    reliability: 0.99,
    alternatives: ['outlook-smtp', 'sendgrid'],
    description: 'Gmail 또는 Google Workspace를 통한 이메일 송수신',
    requiresAuth: true,
    useCases: [
      '알림 이메일 전송',
      '자동화된 보고서 배포',
      '사용자 커뮤니케이션',
      '일정 기반 이메일',
    ],
  },

  {
    id: 'outlook-smtp',
    name: 'Microsoft Outlook / Office 365',
    category: 'communication',
    capabilities: ['send-email', 'read-email', 'calendar-integration', 'team-collaboration'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 600,
    reliability: 0.98,
    alternatives: ['gmail-smtp', 'sendgrid'],
    description: 'Outlook 또는 Office 365를 통한 이메일 및 캘린더 통합',
    requiresAuth: true,
    useCases: ['Office 365 통합', '팀 캘린더 동기화', '회사 이메일 자동화'],
  },

  {
    id: 'slack-api',
    name: 'Slack API',
    category: 'communication',
    capabilities: [
      'send-message',
      'create-channel',
      'file-upload',
      'reaction-handling',
      'thread-management',
    ],
    tier: 'standard',
    status: 'installed',
    costPerCall: 0.0,
    latencyMs: 400,
    reliability: 0.99,
    alternatives: ['discord-api', 'microsoft-teams'],
    description: 'Slack으로 메시지 전송, 채널 관리, 파일 공유',
    requiresAuth: true,
    useCases: ['실시간 알림', '자동화된 리포트', '팀 커뮤니케이션', '워크플로우 통지'],
  },

  {
    id: 'discord-api',
    name: 'Discord API',
    category: 'communication',
    capabilities: ['send-message', 'create-channel', 'user-management', 'webhook'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 300,
    reliability: 0.98,
    alternatives: ['slack-api', 'microsoft-teams'],
    description: 'Discord 서버에 메시지 전송 및 자동화 관리',
    requiresAuth: true,
    useCases: ['개발자 커뮤니티 알림', '팀 협업', '자동화된 봇 메시지'],
  },

  {
    id: 'microsoft-teams',
    name: 'Microsoft Teams API',
    category: 'communication',
    capabilities: ['send-message', 'create-channel', 'integration', 'meeting-scheduling'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 500,
    reliability: 0.98,
    alternatives: ['slack-api', 'discord-api'],
    description: 'Microsoft Teams 채널에 메시지 전송 및 통합',
    requiresAuth: true,
    useCases: ['Office 365 통합', '팀 알림', '회의실 예약', 'Enterprise 커뮤니케이션'],
  },

  {
    id: 'kakao-talk',
    name: '카카오 채팅 / 비즈니스메시지',
    category: 'communication',
    capabilities: ['send-message', 'send-notification', 'korean-support', 'business-messaging'],
    tier: 'premium',
    status: 'not-installed',
    costPerCall: 0.001,
    latencyMs: 600,
    reliability: 0.97,
    alternatives: ['slack-api', 'gmail-smtp'],
    description: '카카오 채팅 및 비즈니스메시지를 통한 한국 사용자 대상 메시징',
    requiresAuth: true,
    useCases: ['한국 사용자 알림', '비즈니스 메시지 전송', '고객 커뮤니케이션'],
  },

  // ── STORAGE CATEGORY (5 connectors) ──

  {
    id: 'postgresql',
    name: 'PostgreSQL',
    category: 'storage',
    capabilities: ['query-database', 'transaction-support', 'json-support', 'full-text-search'],
    tier: 'standard',
    status: 'installed',
    costPerCall: 0.0,
    latencyMs: 100,
    reliability: 0.99,
    alternatives: ['mongodb', 'mysql'],
    description: '오픈소스 관계형 데이터베이스로 안정성과 성능이 우수한 기본 저장소',
    requiresAuth: true,
    useCases: ['워크플로우 메타데이터 저장', '감사 로그', '사용자 데이터', '트랜잭션 기반 작업'],
  },

  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'storage',
    capabilities: ['document-storage', 'aggregation', 'json-native', 'scale-horizontally'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 80,
    reliability: 0.98,
    alternatives: ['postgresql', 'dynamodb'],
    description: 'NoSQL 문서 데이터베이스로 비정형 데이터 저장에 유연함',
    requiresAuth: true,
    useCases: ['반정형 데이터 저장', '빠른 쿼리 처리', '수평 확장', '동적 스키마'],
  },

  {
    id: 's3-storage',
    name: 'Amazon S3 / AWS S3',
    category: 'storage',
    capabilities: ['file-upload', 'file-download', 'versioning', 'encryption', 'public-access'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0001,
    latencyMs: 200,
    reliability: 0.999,
    alternatives: ['google-cloud-storage', 'azure-blob'],
    description: 'AWS 클라우드 파일 저장소로 대규모 파일 및 백업 저장에 이상적',
    requiresAuth: true,
    useCases: ['워크플로우 결과 저장', '백업 및 아카이빙', '미디어 파일 관리', '로그 저장소'],
  },

  {
    id: 'google-drive',
    name: 'Google Drive / Docs',
    category: 'storage',
    capabilities: ['file-storage', 'document-creation', 'sharing', 'version-control'],
    tier: 'standard',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 600,
    reliability: 0.98,
    alternatives: ['s3-storage', 'sharepoint'],
    description: 'Google Cloud 문서 및 파일 저장소로 협업 기능 제공',
    requiresAuth: true,
    useCases: ['팀 문서 관리', '공동 작업', '자동화된 보고서 생성', '파일 공유'],
  },

  {
    id: 'notion',
    name: 'Notion Database',
    category: 'storage',
    capabilities: ['database-operations', 'content-management', 'filtering', 'rich-text'],
    tier: 'premium',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 800,
    reliability: 0.96,
    alternatives: ['google-drive', 'airtable'],
    description: '올인원 워크스페이스로 데이터베이스, 문서, 칸반 보드 통합',
    requiresAuth: true,
    useCases: ['프로젝트 관리', '지식베이스 구축', '작업 추적', '팀 위키'],
  },

  // ── INTEGRATION CATEGORY (4 connectors) ──

  {
    id: 'jira-api',
    name: 'Jira / Atlassian',
    category: 'integration',
    capabilities: [
      'create-ticket',
      'update-ticket',
      'search-issues',
      'add-comment',
      'workflow-transition',
    ],
    tier: 'standard',
    status: 'installed',
    costPerCall: 0.0,
    latencyMs: 700,
    reliability: 0.98,
    alternatives: ['github-issues', 'azure-devops'],
    description: 'IT 서비스 관리 및 이슈 트래킹 플랫폼',
    requiresAuth: true,
    useCases: ['이슈 자동 생성', '상태 동기화', '스프린트 관리', 'IT 인시던트 추적'],
  },

  {
    id: 'github-api',
    name: 'GitHub / GitHub Enterprise',
    category: 'integration',
    capabilities: ['get-pr', 'list-commits', 'get-checks', 'create-comment', 'manage-releases'],
    tier: 'standard',
    status: 'installed',
    costPerCall: 0.0,
    latencyMs: 500,
    reliability: 0.99,
    alternatives: ['gitlab-api', 'bitbucket-api'],
    description: '소스코드 관리 및 DevOps 자동화 플랫폼',
    requiresAuth: true,
    useCases: ['배포 파이프라인 자동화', 'PR 검증', '릴리스 관리', '코드 품질 게이트'],
  },

  {
    id: 'webhook-generic',
    name: 'Generic Webhook / HTTP',
    category: 'integration',
    capabilities: ['receive-http', 'send-http', 'auth-support', 'header-control'],
    tier: 'built-in',
    status: 'available',
    costPerCall: 0.0,
    latencyMs: 200,
    reliability: 0.99,
    alternatives: [],
    description: '외부 시스템과의 범용 HTTP 통신을 위한 웹훅',
    requiresAuth: false,
    useCases: ['외부 이벤트 수신', '서드파티 통합', 'API 게이트웨이', '커스텀 통합'],
  },

  {
    id: 'zapier-integration',
    name: 'Zapier Integration',
    category: 'integration',
    capabilities: ['low-code-automation', 'multi-app-workflow', 'template-library'],
    tier: 'premium',
    status: 'not-installed',
    costPerCall: 0.001,
    latencyMs: 1000,
    reliability: 0.97,
    alternatives: ['webhook-generic'],
    description: 'No-code 자동화 플랫폼으로 1000+ 앱 통합 지원',
    requiresAuth: true,
    useCases: ['다중 앱 워크플로우', 'No-code 자동화', '레거시 시스템 통합'],
  },

  // ── MONITORING CATEGORY (3 connectors) ──

  {
    id: 'metis-audit',
    name: 'Metis Audit Log',
    category: 'monitoring',
    capabilities: ['log-events', 'audit-trail', 'compliance-report'],
    tier: 'built-in',
    status: 'available',
    costPerCall: 0.0,
    latencyMs: 50,
    reliability: 1.0,
    alternatives: [],
    description: '모든 워크플로우 실행과 정책 검증을 기록하는 감사 로그 시스템',
    requiresAuth: false,
    useCases: ['규제 준수', '보안 감사', '실행 추적', '성능 분석'],
  },

  {
    id: 'datadog',
    name: 'Datadog Monitoring',
    category: 'monitoring',
    capabilities: ['metrics-collection', 'log-aggregation', 'alerting', 'dashboards'],
    tier: 'premium',
    status: 'not-installed',
    costPerCall: 0.0001,
    latencyMs: 300,
    reliability: 0.99,
    alternatives: ['prometheus-grafana', 'splunk'],
    description: '엔터프라이즈 모니터링 플랫폼으로 메트릭, 로그, 성능 추적',
    requiresAuth: true,
    useCases: ['실시간 메트릭', '이상 탐지', '성능 모니터링', '서비스 대시보드'],
  },

  {
    id: 'pagerduty',
    name: 'PagerDuty Incident Management',
    category: 'monitoring',
    capabilities: ['create-incident', 'resolve-incident', 'oncall-management', 'escalation'],
    tier: 'premium',
    status: 'not-installed',
    costPerCall: 0.0,
    latencyMs: 600,
    reliability: 0.98,
    alternatives: ['splunk-oncall', 'opsgenie'],
    description: '인시던트 관리 및 온콜 일정 플랫폼',
    requiresAuth: true,
    useCases: ['심각 알림 에스컬레이션', '온콜 관리', '사후 분석', '인시던트 추적'],
  },

  // ── SCHEDULING CATEGORY (2 connectors) ──

  {
    id: 'metis-cron',
    name: 'Metis Scheduled Execution',
    category: 'scheduling',
    capabilities: ['cron-scheduling', 'timezone-support', 'retry-logic', 'dependency-management'],
    tier: 'built-in',
    status: 'available',
    costPerCall: 0.0,
    latencyMs: 100,
    reliability: 0.99,
    alternatives: [],
    description: 'Metis 플랫폼의 네이티브 스케줄러로 크론 표현식 및 고급 일정 지원',
    requiresAuth: false,
    useCases: ['일일 보고서 자동화', '정기적 데이터 동기화', '예약된 정리 작업', '야간 배치 처리'],
  },

  {
    id: 'aws-eventbridge',
    name: 'AWS EventBridge',
    category: 'scheduling',
    capabilities: ['event-routing', 'schedule-rules', 'cross-service-integration', 'event-replay'],
    tier: 'premium',
    status: 'not-installed',
    costPerCall: 0.0000001,
    latencyMs: 150,
    reliability: 0.999,
    alternatives: ['metis-cron'],
    description: 'AWS 서비스 간 이벤트 라우팅 및 스케줄링 서비스',
    requiresAuth: true,
    useCases: [
      'AWS 생태계 통합',
      '마이크로서비스 간 통신',
      '이벤트 기반 아키텍처',
      '엔터프라이즈 자동화',
    ],
  },
];

/**
 * CapabilityMatch — Result of matching a required capability to available connectors
 *
 * Used when the Builder needs to find which connector(s) can fulfill a requirement.
 */
export interface CapabilityMatch {
  /** The originally requested capability (e.g., 'send-email', 'web-search') */
  capability: string;

  /** Best matching connector, or null if none available */
  bestMatch: ConnectorCapability | null;

  /** Alternative connectors ranked by fit (highest score first) */
  alternatives: ConnectorCapability[];

  /** Confidence (0-1): how well the best match covers the requested capability */
  confidence: number;

  /** Reasoning for the match decision in Korean */
  reasoning: string;
}

/**
 * matchCapabilities — Match required capabilities to available connectors
 *
 * Scoring algorithm:
 *   1. Installed status: +0.3 if already installed for tenant
 *   2. Reliability: +0.4 * reliability score
 *   3. Cost: +0.2 * (1 - normalizedCost)
 *   4. Latency: +0.1 * (1 - normalizedLatency)
 *
 * @param requiredCapabilities — List of capabilities needed (e.g., ['send-email', 'web-search'])
 * @param tenantConnectors — Optional list of connector IDs already installed for this tenant
 * @returns Array of CapabilityMatch objects, one per required capability
 */
/**
 * Intent decomposer가 생성하는 capability명 → registry capability명 정규화 맵
 * 양측의 naming convention 차이를 흡수
 */
const CAPABILITY_ALIASES: Record<string, string[]> = {
  'cron-scheduler': ['cron-scheduling', 'schedule-recurring', 'interval-trigger'],
  'cron-scheduling': ['cron-scheduler', 'schedule-recurring', 'interval-trigger'],
  'llm-summarize': ['text-generation', 'summarization', 'text-summarize'],
  'llm-analyze': ['text-generation', 'analysis', 'text-analyze', 'sentiment-analysis'],
  'email-smtp': ['send-email', 'email-send', 'smtp-relay'],
  'send-email': ['email-smtp', 'email-send', 'smtp-relay'],
  'slack-api': ['send-message', 'channel-management', 'slack-messaging'],
  'news-api': ['news-search', 'news-aggregation', 'web-search'],
  'rss-feed': ['rss-monitoring', 'news-aggregation', 'feed-parsing'],
  webhook: ['send-http', 'receive-http', 'webhook-trigger'],
  'web-search': ['web-search', 'google-search', 'bing-search', 'search'],
};

function expandCapability(capability: string): string[] {
  const aliases = CAPABILITY_ALIASES[capability] || [];
  return [capability, ...aliases];
}

export function matchCapabilities(
  requiredCapabilities: string[],
  tenantConnectors?: string[],
): CapabilityMatch[] {
  const installedSet = new Set(tenantConnectors || []);

  return requiredCapabilities.map((capability) => {
    // Find all connectors that offer this capability (with alias expansion)
    const expandedCaps = expandCapability(capability);
    const candidates = CONNECTOR_CATALOG.filter((c) =>
      expandedCaps.some((cap) => c.capabilities.includes(cap)),
    );

    if (candidates.length === 0) {
      return {
        capability,
        bestMatch: null,
        alternatives: [],
        confidence: 0,
        reasoning: `"${capability}" 기능을 제공하는 커넥터가 없습니다. 커스텀 통합이 필요할 수 있습니다.`,
      };
    }

    // Score each candidate
    const scored = candidates.map((connector) => {
      let score = 0;

      // Status bonus: installed > available > not-installed > deprecated
      if (installedSet.has(connector.id)) {
        score += 0.35;
      } else if (connector.status === 'available') {
        score += 0.3;
      } else if (connector.status === 'installed') {
        score += 0.3;
      } else if (connector.status === 'not-installed') {
        score += 0.1;
      }

      // Reliability: 0.4 weight
      score += 0.4 * connector.reliability;

      // Cost: 0.15 weight (prefer cheaper, normalize to 0-1000 USD)
      const normalizedCost = Math.min(connector.costPerCall / 0.1, 1);
      score += 0.15 * (1 - normalizedCost);

      // Latency: 0.1 weight (prefer faster, normalize to 0-5000ms)
      const normalizedLatency = Math.min(connector.latencyMs / 5000, 1);
      score += 0.1 * (1 - normalizedLatency);

      // Tier bonus: built-in > standard > premium > enterprise
      if (connector.tier === 'built-in') {
        score += 0.05;
      } else if (connector.tier === 'standard') {
        score += 0.02;
      }

      return { connector, score };
    });

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);

    const bestMatch = scored[0].connector;
    const alternatives = scored.slice(1).map((s) => s.connector);
    const confidence = Math.min(scored[0].score, 1);

    // Generate reasoning in Korean
    let reasoning = '';
    if (installedSet.has(bestMatch.id)) {
      reasoning = `이미 설치된 "${bestMatch.name}"를 추천합니다. 즉시 사용 가능합니다.`;
    } else if (bestMatch.status === 'available') {
      reasoning = `"${bestMatch.name}"은 Metis 기본 제공 커넥터로 추가 설정이 불필요합니다.`;
    } else if (bestMatch.status === 'installed') {
      reasoning = `"${bestMatch.name}"은 기존 설치된 표준 커넥터로 안정성이 높습니다.`;
    } else {
      const installNote = bestMatch.status === 'not-installed' ? ' (설치 필요)' : '';
      reasoning = `"${bestMatch.name}"이 최적의 선택입니다${installNote}. 신뢰도: ${(bestMatch.reliability * 100).toFixed(0)}%, 평균 지연: ${bestMatch.latencyMs}ms`;
    }

    if (alternatives.length > 0) {
      const altNames = alternatives
        .slice(0, 2)
        .map((a) => `"${a.name}"`)
        .join(', ');
      reasoning += ` 대안으로는 ${altNames}을 고려할 수 있습니다.`;
    }

    return {
      capability,
      bestMatch,
      alternatives,
      confidence,
      reasoning,
    };
  });
}

/**
 * getConnectorById — Retrieve a connector by its ID
 *
 * @param id — Connector ID (e.g., 'slack-api', 'metis-audit')
 * @returns Connector details, or undefined if not found
 */
export function getConnectorById(id: string): ConnectorCapability | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}

/**
 * getCapabilitiesForCategory — List all connectors in a category
 *
 * @param category — Category name (e.g., 'search', 'ai', 'communication')
 * @returns Array of connectors in that category, sorted by reliability (descending)
 */
export function getCapabilitiesForCategory(category: string): ConnectorCapability[] {
  return CONNECTOR_CATALOG.filter((c) => c.category === category).sort(
    (a, b) => b.reliability - a.reliability,
  );
}

/**
 * getCategoryCounts — Return the count of connectors per category
 *
 * Useful for UI dashboards showing registry health and coverage.
 */
export function getCategoryCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  CONNECTOR_CATALOG.forEach((connector) => {
    counts[connector.category] = (counts[connector.category] || 0) + 1;
  });
  return counts;
}

/**
 * getConnectorsByStatus — Filter connectors by their current status
 *
 * @param status — Status filter ('available', 'installed', 'not-installed', 'deprecated')
 * @returns Array of matching connectors
 */
export function getConnectorsByStatus(
  status: ConnectorCapability['status'],
): ConnectorCapability[] {
  return CONNECTOR_CATALOG.filter((c) => c.status === status);
}

/**
 * estimateCost — Estimate total cost for a set of capability matches
 *
 * Useful for budget awareness in the Builder interface.
 *
 * @param matches — Array of CapabilityMatch results from matchCapabilities()
 * @param callsPerCapability — Estimated number of calls per capability
 * @returns Estimated monthly cost in USD
 */
export function estimateCost(
  matches: CapabilityMatch[],
  callsPerCapability: number = 1000,
): number {
  return matches.reduce((total, match) => {
    if (!match.bestMatch) return total;
    return total + match.bestMatch.costPerCall * callsPerCapability;
  }, 0);
}

/**
 * validateConnectorAccess — Check if a tenant can use a specific connector
 *
 * Returns:
 *   - 'allowed': Tenant has full access
 *   - 'needs-install': Available but not yet installed
 *   - 'needs-auth': Installed but missing credentials
 *   - 'denied': Tier/enterprise restrictions or deprecated
 */
export function validateConnectorAccess(
  connectorId: string,
  tenantTier: 'free' | 'professional' | 'enterprise',
  installedConnectors: string[],
  configuredConnectors: string[],
): 'allowed' | 'needs-install' | 'needs-auth' | 'denied' {
  const connector = getConnectorById(connectorId);

  if (!connector) {
    return 'denied';
  }

  // Check tier restrictions
  if (connector.tier === 'enterprise' && tenantTier !== 'enterprise') {
    return 'denied';
  }

  if (connector.tier === 'premium' && tenantTier === 'free') {
    return 'denied';
  }

  // Check deprecated
  if (connector.status === 'deprecated') {
    return 'denied';
  }

  // Check installation
  if (!installedConnectors.includes(connectorId)) {
    return 'needs-install';
  }

  // Check configuration
  if (connector.requiresAuth && !configuredConnectors.includes(connectorId)) {
    return 'needs-auth';
  }

  return 'allowed';
}
