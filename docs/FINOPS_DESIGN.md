# Metis.AI FinOps Token Optimization 설계서

**Version**: 1.0.0
**Date**: 2026-04-06
**Status**: Draft
**Owner**: FinOps 최적화 팀

---

## 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [Gate 1: Semantic Cache Engine](#2-gate-1-semantic-cache-engine)
3. [Gate 2: Model Router Engine](#3-gate-2-model-router-engine)
4. [Gate 3: Skill Packer Engine](#4-gate-3-skill-packer-engine)
5. [데이터 모델 (Prisma)](#5-데이터-모델-prisma)
6. [API 엔드포인트](#6-api-엔드포인트)
7. [프론트엔드 통합](#7-프론트엔드-통합)
8. [구현 페이즈](#8-구현-페이즈)
9. [비용 최적화 목표](#9-비용-최적화-목표)
10. [보안 및 거버넌스](#10-보안-및-거버넌스)
11. [모니터링 및 알림](#11-모니터링-및-알림)

---

## 1. 아키텍처 개요

### 1.1 3-Gate Pipeline 다이어그램

```
┌────────────────────────────────────────────────────────────────────────┐
│                         Agent Execution Flow                            │
└────────────────────────────────────────────────────────────────────────┘

  Prompt Input
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │              FinOps Pipeline (Middleware)                    │
  │                                                              │
  │  ┌──────────────┐      ┌──────────────┐    ┌──────────────┐ │
  │  │    Gate 1    │      │    Gate 2    │    │    Gate 3    │ │
  │  │  Semantic    │──────│   Model      │───│   Skill      │ │
  │  │   Cache      │      │   Router     │    │   Packer     │ │
  │  └──────────────┘      └──────────────┘    └──────────────┘ │
  │      ↓                       ↓                    ↓           │
  │   Hit? →──Cache Hit──→ Skip Gates ─────────────→ Response   │
  │      ↓                       ↓                    ↓           │
  │   Miss ──────────────→ Route Model ────→ Pack Prompt         │
  └─────────────────────────────────────────────────────────────┘
      │
      ▼
  ┌────────────────────────────┐
  │   LLM Service              │
  │  (Claude, GPT, Gemini)     │
  └────────────────────────────┘
      │
      ▼
  Response + Metadata
      │
      ▼
  ┌────────────────────────────┐
  │  Token Usage Logging       │
  │  Cost Calculation          │
  │  Cache Storage (if enabled)│
  └────────────────────────────┘
```

### 1.2 에이전트 실행 플로우 통합

FinOps Pipeline은 Agent Executor의 미들웨어로 동작한다:

```typescript
// Agent Executor Flow (pseudo-code)
async executeSkill(skill, input) {
  // 1. Pre-execution: FinOps optimization
  const optimized = await finopsPipeline.optimize({
    skill,
    input,
    tenantId,
    agentConfig
  });

  // optimized = {
  //   cached: boolean,           // Gate 1 결과
  //   response?: CachedResponse, // Cache hit 시
  //   modelTier?: Tier,          // Gate 2 결과
  //   packedPrompt?: string,     // Gate 3 결과
  //   estimatedTokens?: number,  // 예상 토큰
  //   estimatedCost?: Decimal
  // }

  if (optimized.cached && optimized.response) {
    // Cache hit - Skip LLM call
    return optimized.response;
  }

  // 2. Route to appropriate model based on Tier
  const model = selectModel(optimized.modelTier);

  // 3. Use packed prompt (or original if no packing needed)
  const prompt = optimized.packedPrompt || input.prompt;

  // 4. Call LLM
  const response = await model.call(prompt, {
    agentId: skill.agentId,
    tier: optimized.modelTier,
    maxTokens: calculateTokenBudget(skill, optimized.modelTier)
  });

  // 5. Post-execution: Log and update cache
  await finopsLogger.log({
    executionId,
    skillKey: skill.key,
    tier: optimized.modelTier,
    cacheHit: false,
    actualTokens: response.usage.total_tokens,
    actualCost: calculateCost(response.usage),
    latencyMs: response.latencyMs
  });

  // Store in cache if applicable
  if (shouldCache(skill, response)) {
    await cacheEngine.put(hashPrompt(prompt), response);
  }

  return response;
}
```

### 1.3 데이터 흐름 상세

```
Prompt Input
├─ Tenant Context (tenant_id, agent_id, tier_restrictions)
├─ Skill Context (skill_key, required_capabilities)
├─ Input Parameters (user input, context windows)
└─ FinOps Config (agent_level, skill_level, global defaults)
    │
    ├─→ Gate 1: Semantic Cache Engine
    │   ├─ Embedding generation from prompt
    │   ├─ Namespace-based vector search
    │   ├─ Similarity threshold check (configurable 0.85-0.95)
    │   ├─ TTL validation
    │   └─ Output: { hit: boolean, cachedResponse?, confidence }
    │
    ├─→ Gate 2: Model Router Engine (if no cache hit)
    │   ├─ Rule-based stage (prompt analysis)
    │   ├─ LLM-based classification (optional)
    │   ├─ Tier selection (1/2/3)
    │   ├─ Budget enforcement
    │   └─ Output: { tier: Tier, model: string, maxTokens: number }
    │
    └─→ Gate 3: Skill Packer Engine (if routed)
        ├─ Context pruning
        ├─ Few-shot reduction
        ├─ System prompt compression
        ├─ Output format optimization
        └─ Output: { packedPrompt: string, tokensReduced: number }

Final Output: Optimized Request to LLM
└─ Response + Metadata
   ├─ Actual token usage
   ├─ Actual cost
   ├─ Optimization impact metrics
   └─ Cache storage (optional)
```

---

## 2. Gate 1: Semantic Cache Engine

### 2.1 설계 원칙

Semantic Cache는 단순 문자열 매칭을 넘어 의미론적으로 유사한 프롬프트를 감지한다. 이를 통해:

- 반복적인 유사 질문에 대한 LLM 호출 제거
- 신뢰도 높은 캐시 히트로 응답 품질 유지
- 네임스페이스별 격리로 다중 테넌트 보안 보장

### 2.2 아키텍처 컴포넌트

```typescript
// Core Components

interface SemanticCacheEngine {
  // 임베딩 서비스
  embeddingService: EmbeddingService;

  // 벡터 저장소 (Redis with RedisSearch 또는 Qdrant)
  vectorStore: VectorStore;

  // 캐시 관리자
  cacheManager: CacheManager;

  // 메서드들
  put(namespace: string, prompt: string, response: CachedResponse, ttl?: number): Promise<void>;
  get(namespace: string, prompt: string, threshold?: number): Promise<CacheHit | null>;
  invalidate(namespace: string, patterns?: string[]): Promise<void>;
  getStats(namespace: string): Promise<CacheStats>;
}

interface EmbeddingService {
  // 프롬프트를 벡터로 변환
  embed(text: string): Promise<number[]>;

  // 배치 임베딩 (비용 최적화)
  embedBatch(texts: string[]): Promise<number[][]>;

  // 임베딩 차원: 1536 (OpenAI text-embedding-3-small)
  // 또는 768 (open-source Sentence Transformers)
  dimension: number;
}

interface VectorStore {
  // 벡터 저장
  upsert(namespace: string, id: string, vector: number[], metadata: CacheMetadata): Promise<void>;

  // 유사도 검색
  search(
    namespace: string,
    vector: number[],
    topK: number,
    minSimilarity: number,
  ): Promise<SearchResult[]>;

  // 네임스페이스 관리
  deleteNamespace(namespace: string): Promise<void>;

  // 통계
  getNamespaceStats(namespace: string): Promise<NamespaceStats>;
}

interface CacheManager {
  // 정의된 제외 패턴에 따라 캐싱 여부 판단
  canCache(prompt: string, config: CacheConfig): boolean;

  // TTL에 따른 만료 관리
  isExpired(entry: CacheEntry): boolean;

  // 통계 수집
  recordHit(namespace: string): void;
  recordMiss(namespace: string): void;
  getStats(namespace: string): CacheStats;
}
```

### 2.3 유사도 알고리즘

```typescript
// Cosine Similarity (Vector-based)
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

  if (magnitudeA === 0 || magnitudeB === 0) return 0;

  return dotProduct / (magnitudeA * magnitudeB);
  // 범위: 0 ~ 1 (1 = 완벽히 유사, 0 = 완전히 다름)
}

// 설정 가능한 임계값:
// - Conservative (0.95): 거의 동일한 프롬프트만 캐싱
// - Balanced (0.90): 의미상 거의 같은 프롬프트 캐싱
// - Aggressive (0.85): 의미상 유사한 프롬프트도 캐싱

// 신뢰도 점수 계산
function calculateConfidence(similarity: number, metadata: CacheMetadata): number {
  const similarityScore = similarity * 0.7; // 70% 가중치
  const ageScore = calculateAgeScore(metadata.createdAt) * 0.2; // 20% 가중치
  const qualityScore = (metadata.quality / 100) * 0.1; // 10% 가중치

  return similarityScore + ageScore + qualityScore;
  // 범위: 0 ~ 1
}
```

### 2.4 네임스페이스 기반 TTL 관리

```typescript
interface NamespaceTTLConfig {
  namespace: string;

  // Default TTL (초 단위)
  defaultTtl: number; // 예: 604800 = 7일

  // 스킬별 커스텀 TTL
  skillOverrides: {
    [skillKey: string]: number;
  };

  // 응답 타입별 TTL
  responseTypeOverrides: {
    [type: string]: number; // FAQ, Code, Analysis 등
  };

  // 조건부 TTL (예: FAQ는 더 오래 유지)
  conditional: {
    condition: (prompt: string, response: any) => boolean;
    ttl: number;
  }[];
}

// TTL 결정 로직
function resolveTTL(
  namespace: string,
  skillKey: string,
  response: any,
  config: NamespaceTTLConfig,
): number {
  // 1. 조건부 TTL 확인
  for (const rule of config.conditional) {
    if (rule.condition(skillKey, response)) {
      return rule.ttl;
    }
  }

  // 2. 응답 타입별 오버라이드 확인
  const responseType = detectResponseType(response);
  if (config.responseTypeOverrides[responseType]) {
    return config.responseTypeOverrides[responseType];
  }

  // 3. 스킬별 오버라이드 확인
  if (config.skillOverrides[skillKey]) {
    return config.skillOverrides[skillKey];
  }

  // 4. 기본값
  return config.defaultTtl;
}
```

### 2.5 제외 패턴 매칭

```typescript
interface CacheExclusionRules {
  namespace: string;

  // 정규식 패턴
  regexPatterns: RegExp[];

  // 키워드 기반 (AND 조건)
  keywords: {
    any: string[]; // 하나라도 포함되면 제외
    all: string[]; // 모두 포함되어야 제외
    none: string[]; // 하나라도 포함되면 제외 (NOT)
  };

  // 함수 기반 커스텀 로직
  customFilters: ((prompt: string) => boolean)[];

  // 예외 조건 (이 조건이 맞으면 제외 규칙 무시)
  overrides: {
    condition: (prompt: string) => boolean;
    reason: string;
  }[];
}

// 제외 검사
function shouldExcludeFromCache(
  prompt: string,
  rules: CacheExclusionRules,
): { excluded: boolean; reason?: string } {
  // 1. 예외 조건 우선 확인
  for (const override of rules.overrides) {
    if (override.condition(prompt)) {
      return { excluded: false }; // 캐싱 허용
    }
  }

  // 2. 정규식 패턴 확인
  for (const pattern of rules.regexPatterns) {
    if (pattern.test(prompt)) {
      return { excluded: true, reason: 'Regex pattern matched' };
    }
  }

  // 3. 키워드 기반 확인
  if (rules.keywords.any.some((kw) => prompt.includes(kw))) {
    return { excluded: true, reason: 'Any keyword matched' };
  }

  if (!rules.keywords.all.every((kw) => prompt.includes(kw))) {
    return { excluded: true, reason: 'Not all required keywords present' };
  }

  if (rules.keywords.none.some((kw) => prompt.includes(kw))) {
    return { excluded: true, reason: 'Excluded keyword present' };
  }

  // 4. 커스텀 필터 확인
  for (const filter of rules.customFilters) {
    if (filter(prompt)) {
      return { excluded: true, reason: 'Custom filter matched' };
    }
  }

  return { excluded: false };
}

// 기본 제외 규칙 (모든 네임스페이스)
const DEFAULT_EXCLUSION_RULES: CacheExclusionRules = {
  namespace: 'global',

  regexPatterns: [
    /\{current_date\}/i, // 동적 변수
    /\{current_time\}/i,
    /\{user_id\}/i,
    /\{session_id\}/i,
  ],

  keywords: {
    any: ['real-time', 'current user', 'random', 'unique', 'personalized'],
    all: [],
    none: [],
  },

  customFilters: [
    (prompt) => prompt.length > 10000, // 매우 긴 프롬프트는 캐싱 비효율
  ],

  overrides: [],
};
```

### 2.6 Warm-up 전략

```typescript
interface WarmupConfig {
  namespace: string;

  // 자동 우워밍 활성화
  enabled: boolean;

  // 일반적인 프롬프트 템플릿 (테스트용)
  commonPrompts: string[];

  // 임베딩 배치 크기
  batchSize: number;

  // 스케줄 (cron expression)
  schedule: string; // 예: "0 2 * * *" (매일 2시)
}

// Warm-up 로직
async function warmupCache(config: WarmupConfig): Promise<WarmupStats> {
  const embeddings = await embeddingService.embedBatch(config.commonPrompts);

  const results = {
    total: config.commonPrompts.length,
    successful: 0,
    failed: 0,
    startTime: Date.now(),
    endTime: 0,
  };

  for (let i = 0; i < config.commonPrompts.length; i++) {
    try {
      // 더미 응답으로 벡터만 저장
      await vectorStore.upsert(config.namespace, `warmup_${i}`, embeddings[i], {
        prompt: config.commonPrompts[i],
        createdAt: new Date(),
        ttl: config.enabled ? 86400 * 30 : 0,
        isWarmup: true,
        quality: 100,
      });
      results.successful++;
    } catch (error) {
      results.failed++;
      logger.error(`Warmup failed for prompt ${i}:`, error);
    }
  }

  results.endTime = Date.now();
  return results;
}
```

### 2.7 캐시 무효화 규칙

```typescript
interface CacheInvalidationRule {
  // 무효화 트리거
  trigger: 'manual' | 'ttl' | 'event' | 'policy';

  // 대상 네임스페이스 (와일드카드 지원)
  namespace: string; // "tenant_123::*" 또는 "tenant_123::skill_*"

  // 추가 필터 (선택)
  filter?: {
    ageMs?: number; // N ms 이상 된 항목만
    similarityThreshold?: number; // 특정 벡터와 유사도 이상인 항목
    metadata?: Record<string, any>; // 메타데이터 매칭
  };

  // 실행 방식
  mode: 'sync' | 'async';

  // 보상 전략 (만약 무효화 실패 시)
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
  };
}

// 무효화 시나리오
enum InvalidationScenario {
  // 프롬프트 엔지니어링 정책 변경
  POLICY_UPDATED = 'POLICY_UPDATED',

  // 새 LLM 모델 배포
  MODEL_CHANGED = 'MODEL_CHANGED',

  // 스킬 로직 업데이트
  SKILL_UPDATED = 'SKILL_UPDATED',

  // 테넌트 설정 변경
  TENANT_CONFIG_CHANGED = 'TENANT_CONFIG_CHANGED',

  // 수동 무효화
  MANUAL = 'MANUAL',

  // TTL 만료
  TTL_EXPIRED = 'TTL_EXPIRED',

  // 메모리 압박
  MEMORY_PRESSURE = 'MEMORY_PRESSURE',
}

// 무효화 실행
async function invalidateCache(
  rules: CacheInvalidationRule[],
  scenario: InvalidationScenario,
  context: any,
): Promise<InvalidationResult> {
  const result = {
    scenario,
    rulesProcessed: 0,
    itemsInvalidated: 0,
    itemsFailed: 0,
    duration: 0,
  };

  const startTime = Date.now();

  for (const rule of rules) {
    if (rule.trigger === scenario || rule.trigger === 'manual') {
      result.rulesProcessed++;

      try {
        const namespacePattern = rule.namespace;
        const stats = await vectorStore.deleteNamespace(namespacePattern, rule.filter);
        result.itemsInvalidated += stats.deleted;
      } catch (error) {
        result.itemsFailed++;
        logger.error(`Invalidation failed for rule:`, rule, error);

        // 재시도 로직
        if (rule.retryPolicy.maxRetries > 0) {
          // 지수 백오프로 재시도
          for (let retry = 0; retry < rule.retryPolicy.maxRetries; retry++) {
            await sleep(rule.retryPolicy.backoffMs * 2 ** retry);
            try {
              const stats = await vectorStore.deleteNamespace(rule.namespace, rule.filter);
              result.itemsInvalidated += stats.deleted;
              result.itemsFailed--;
              break;
            } catch (e) {
              if (retry === rule.retryPolicy.maxRetries - 1) {
                throw e;
              }
            }
          }
        }
      }
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}
```

### 2.8 성능 목표

| 메트릭                    | 목표   | 상세                         |
| ------------------------- | ------ | ---------------------------- |
| **Cache Hit Rate**        | >20%   | 초기: 15%, 3개월: >25% 목표  |
| **Cache Lookup Latency**  | <50ms  | 벡터 검색 + 임베딩 생성 포함 |
| **Embedding Generation**  | <100ms | 배치 처리로 최적화           |
| **Vector Search (Top-K)** | <20ms  | Qdrant 또는 Redis 최적화     |
| **False Positive Rate**   | <2%    | 신뢰도 낮은 캐시 히트        |
| **Memory Utilization**    | <500MB | 100K 항목 기준               |
| **Cost Savings**          | 15-20% | 캐시 히트 LLM 비용 절감      |

---

## 3. Gate 2: Model Router Engine

### 3.1 설계 원칙

Model Router는 프롬프트의 복잡도를 판단하여 최적 비용의 LLM 모델로 라우팅한다. 2단계 분류 방식으로 속도와 정확도의 균형을 맞춘다.

### 3.2 2단계 분류 아키텍처

```typescript
interface ModelRouterEngine {
  // Stage 1: 규칙 기반 분류
  classifyByRules(prompt: string, context: ExecutionContext): Classification | null;

  // Stage 2: LLM 기반 분류 (Stage 1 결과 불확실 시)
  classifyByLLM(prompt: string, context: ExecutionContext): Promise<Classification>;

  // 통합 라우팅 로직
  route(prompt: string, context: ExecutionContext, config: RouterConfig): Promise<RouteDecision>;

  // 라우팅 통계
  getStats(): RouterStats;

  // 설정 관리
  updateConfig(config: RouterConfig): void;
}

// Stage 1 분류 규칙
interface RuleBasedClassification {
  // 키워드 분석
  keywordMatches: {
    tier1: string[]; // FAQ, 번역, 포맷팅
    tier2: string[]; // 코드 리뷰, 분석, 요약
    tier3: string[]; // 아키텍처, 복잡 추론
  };

  // 프롬프트 길이 임계값
  lengthThresholds: {
    tier1Max: number; // 500 토큰
    tier2Max: number; // 2000 토큰
    tier3Min: number; // 2000+ 토큰
  };

  // 패턴 기반 감지
  patterns: {
    multiStep: RegExp; // 다단계 추론
    codeGeneration: RegExp; // 코드 생성
    archAnalysis: RegExp; // 아키텍처 분석
    sentiment: RegExp; // 감정 분석
  };

  // 복잡도 지표 계산
  complexityMetrics: {
    braceDepth: number; // JSON/코드 중첩 깊이
    uniqueTokenCount: number; // 고유 토큰 수
    referenceCount: number; // 외부 참조 개수
    constraintCount: number; // 제약사항 개수
  };
}

// Stage 1 분류 결과
type ClassificationResult =
  | { tier: Tier; confidence: number; reason: string }
  | { uncertain: true; reason: string }; // Stage 2로 진행

// Stage 2 LLM 분류 (가벼운 모델 사용)
interface LLMClassifier {
  // 분류용 가벼운 모델 (GPT-3.5, Claude Haiku 등)
  classifyPrompt(
    prompt: string,
    context: ExecutionContext,
  ): Promise<{
    tier: Tier;
    confidence: number;
    reasoning: string;
    alternatives: Tier[];
  }>;

  // 분류 모델 설정
  model: string; // "gpt-3.5-turbo" 또는 "claude-3-haiku"
  maxTokens: number; // 100-200 토큰
  temperature: number; // 0.0-0.2 (일관성)
}
```

### 3.3 Tier 정의

```typescript
enum Tier {
  TIER_1 = 'TIER_1', // 기본
  TIER_2 = 'TIER_2', // 표준
  TIER_3 = 'TIER_3', // 프리미엄
}

interface TierDefinition {
  tier: Tier;

  // 가격 책정 (1M 토큰 기준)
  pricing: {
    inputPricePerMToken: number; // 예: 0.25
    outputPricePerMToken: number; // 예: 0.75
  };

  // 모델 선택
  models: {
    primary: string; // 예: "gpt-3.5-turbo"
    fallback: string[]; // 예: ["gpt-4-turbo", "claude-3-opus"]
    description: string;
  };

  // 리소스 제약
  constraints: {
    maxInputTokens: number; // 예: 4000
    maxOutputTokens: number; // 예: 2000
    maxConcurrent: number; // 동시 요청 수
    rateLimit: {
      requestsPerMinute: number;
      tokensPerMinute: number;
    };
  };

  // 품질 기준
  quality: {
    expectedLatencyMs: number; // 예: 1000ms
    accuracyScore: number; // 0-100
    supportedCapabilities: string[];
  };

  // 사용 사례
  useCases: {
    primary: string[]; // 예: ["FAQ", "Translation", "Formatting"]
    notSupported: string[]; // 예: ["Complex reasoning", "Architecture design"]
  };
}

// Tier 1: 기본 (저비용)
const TIER_1: TierDefinition = {
  tier: Tier.TIER_1,

  pricing: {
    inputPricePerMToken: 0.25,
    outputPricePerMToken: 0.75,
  },

  models: {
    primary: 'gpt-3.5-turbo',
    fallback: ['claude-3-haiku'],
    description: '빠르고 저비용, 간단한 작업 최적화',
  },

  constraints: {
    maxInputTokens: 4000,
    maxOutputTokens: 2000,
    maxConcurrent: 100,
    rateLimit: {
      requestsPerMinute: 300,
      tokensPerMinute: 90000,
    },
  },

  quality: {
    expectedLatencyMs: 500,
    accuracyScore: 85,
    supportedCapabilities: ['text-generation', 'classification', 'formatting', 'qa'],
  },

  useCases: {
    primary: [
      'FAQ',
      'Simple translation',
      'Text formatting',
      'Basic summarization',
      'Simple classification',
    ],
    notSupported: ['Complex code generation', 'Architecture design', 'Multi-step reasoning'],
  },
};

// Tier 2: 표준 (중간 비용)
const TIER_2: TierDefinition = {
  tier: Tier.TIER_2,

  pricing: {
    inputPricePerMToken: 3.0,
    outputPricePerMToken: 15.0,
  },

  models: {
    primary: 'gpt-4-turbo',
    fallback: ['claude-3-sonnet'],
    description: '균형잡힌 성능, 일반적인 작업',
  },

  constraints: {
    maxInputTokens: 128000,
    maxOutputTokens: 4000,
    maxConcurrent: 50,
    rateLimit: {
      requestsPerMinute: 100,
      tokensPerMinute: 300000,
    },
  },

  quality: {
    expectedLatencyMs: 2000,
    accuracyScore: 92,
    supportedCapabilities: [
      'code-generation',
      'analysis',
      'summarization',
      'reasoning',
      'translation',
    ],
  },

  useCases: {
    primary: [
      'Code review',
      'Document analysis',
      'Content summarization',
      'Complex translation',
      'API documentation',
    ],
    notSupported: ['Very long context windows (>128K)', 'Real-time processing'],
  },
};

// Tier 3: 프리미엄 (고비용, 최고 성능)
const TIER_3: TierDefinition = {
  tier: Tier.TIER_3,

  pricing: {
    inputPricePerMToken: 15.0,
    outputPricePerMToken: 75.0,
  },

  models: {
    primary: 'gpt-4-vision',
    fallback: ['claude-3-opus'],
    description: '최고 성능, 복잡한 작업 최적화',
  },

  constraints: {
    maxInputTokens: 200000,
    maxOutputTokens: 8000,
    maxConcurrent: 10,
    rateLimit: {
      requestsPerMinute: 20,
      tokensPerMinute: 1000000,
    },
  },

  quality: {
    expectedLatencyMs: 5000,
    accuracyScore: 98,
    supportedCapabilities: [
      'complex-reasoning',
      'architecture-design',
      'multi-step-analysis',
      'vision',
      'code-generation-advanced',
    ],
  },

  useCases: {
    primary: [
      'Architecture design',
      'Complex system analysis',
      'Multi-step reasoning',
      'Advanced code generation',
      'Research paper analysis',
      'Image understanding',
    ],
    notSupported: [],
  },
};
```

### 3.4 규칙 기반 라우팅 (Stage 1)

```typescript
class RuleBasedRouter {
  private rules: RuleBasedClassification;

  classify(prompt: string, context: ExecutionContext): ClassificationResult {
    // 1. 프롬프트 길이 확인
    const tokenCount = estimateTokens(prompt);

    if (tokenCount > this.rules.lengthThresholds.tier3Min) {
      return {
        tier: Tier.TIER_3,
        confidence: 0.8,
        reason: `Prompt length (${tokenCount} tokens) exceeds Tier 3 threshold`,
      };
    }

    if (tokenCount > this.rules.lengthThresholds.tier2Max) {
      return {
        tier: Tier.TIER_2,
        confidence: 0.75,
        reason: `Prompt length (${tokenCount} tokens) exceeds Tier 2 threshold`,
      };
    }

    // 2. 키워드 매칭
    const keywords = extractKeywords(prompt);

    for (const keyword of keywords) {
      if (this.rules.keywordMatches.tier3.includes(keyword)) {
        return {
          tier: Tier.TIER_3,
          confidence: 0.85,
          reason: `Matched Tier 3 keyword: ${keyword}`,
        };
      }

      if (this.rules.keywordMatches.tier2.includes(keyword)) {
        return {
          tier: Tier.TIER_2,
          confidence: 0.8,
          reason: `Matched Tier 2 keyword: ${keyword}`,
        };
      }
    }

    // 3. 패턴 매칭
    if (this.rules.patterns.multiStep.test(prompt)) {
      return {
        tier: Tier.TIER_3,
        confidence: 0.82,
        reason: 'Multi-step reasoning detected',
      };
    }

    if (this.rules.patterns.codeGeneration.test(prompt)) {
      return {
        tier: Tier.TIER_2,
        confidence: 0.78,
        reason: 'Code generation detected',
      };
    }

    // 4. 복잡도 메트릭 계산
    const complexity = this.calculateComplexity(prompt);

    if (complexity.score > 0.75) {
      return {
        tier: Tier.TIER_3,
        confidence: 0.7,
        reason: `High complexity score: ${complexity.score.toFixed(2)}`,
      };
    }

    if (complexity.score > 0.5) {
      return {
        tier: Tier.TIER_2,
        confidence: 0.65,
        reason: `Medium complexity score: ${complexity.score.toFixed(2)}`,
      };
    }

    // 5. 기본값: Tier 1
    return {
      tier: Tier.TIER_1,
      confidence: 0.5,
      reason: 'Default classification (low complexity)',
    };
  }

  private calculateComplexity(prompt: string): ComplexityMetrics {
    return {
      braceDepth: calculateBraceDepth(prompt),
      uniqueTokenCount: new Set(tokenize(prompt)).size,
      referenceCount: (prompt.match(/\[.*?\]/g) || []).length,
      constraintCount: (prompt.match(/must|should|require|constraint/gi) || []).length,
      score: 0, // 정규화된 0-1 점수
    };
  }
}

// 복잡도 계산 헬퍼
function calculateComplexity(prompt: string): number {
  const metrics = {
    length: Math.min(prompt.length / 5000, 1.0) * 0.25, // 길이: 25%
    keywords: (countKeywords(prompt) / 50) * 0.25, // 키워드: 25%
    structure: calculateStructuralComplexity(prompt) * 0.25, // 구조: 25%
    constraints: ((prompt.match(/must|should|require/gi) || []).length / 10) * 0.25, // 제약: 25%
  };

  return Object.values(metrics).reduce((a, b) => a + b, 0);
}

// 토큰 추정 (대략적)
function estimateTokens(text: string): number {
  // 평균: 1 토큰 ≈ 4 문자
  return Math.ceil(text.length / 4);
}
```

### 3.5 LLM 기반 라우팅 (Stage 2)

```typescript
class LLMBasedClassifier {
  private llm: LLMClient;
  private config: LLMClassifier;

  async classify(prompt: string, context: ExecutionContext): Promise<Classification> {
    const classificationPrompt = this.buildClassificationPrompt(prompt);

    // 분류용 경량 모델 사용 (토큰 절약)
    const response = await this.llm.call({
      model: this.config.model,
      messages: [
        {
          role: 'system',
          content: `You are an AI routing expert. Classify the given user prompt into one of three tiers based on complexity and required capabilities.

Tier 1 (Simple): FAQ, translation, formatting, basic classification. Low complexity. Short context.
Tier 2 (Standard): Code review, analysis, summarization, general reasoning. Medium complexity. Standard context.
Tier 3 (Complex): Architecture design, advanced reasoning, multi-step analysis. High complexity. Long context needed.

Respond in JSON format:
{
  "tier": "TIER_1" | "TIER_2" | "TIER_3",
  "confidence": 0.0-1.0,
  "reasoning": "explanation",
  "alternatives": ["TIER_1", "TIER_2", "TIER_3"]
}`,
        },
        {
          role: 'user',
          content: classificationPrompt,
        },
      ],
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
    });

    // 응답 파싱
    const result = JSON.parse(response.content[0].text);

    return {
      tier: result.tier,
      confidence: result.confidence,
      reason: result.reasoning,
      classification_method: 'llm_based',
    };
  }

  private buildClassificationPrompt(prompt: string): string {
    return `Classify this user prompt:

<prompt>
${prompt.substring(0, 1000)}
${prompt.length > 1000 ? '...' : ''}
</prompt>

Consider:
1. Task complexity
2. Reasoning depth required
3. Context window needs
4. Capability requirements`;
  }
}
```

### 3.6 Fallback 전략

```typescript
interface FallbackStrategy {
  // Primary 모델 실패 시
  primaryFailure: {
    retryCount: number;
    backoffMs: number;
    fallbackTier: Tier; // 더 높은 Tier로 업그레이드
  };

  // Rate limit 도달 시
  rateLimit: {
    fallbackTier: Tier;
    queue: boolean; // 큐에 추가하고 나중에 재시도
  };

  // Cost budget 초과 시
  costBudget: {
    fallbackTier: Tier; // 더 저렴한 Tier로 다운그레이드
    rejectIfTierNotFeasible: boolean;
  };

  // 응답 품질 낮음 시
  qualityCheck: {
    minQualityScore: number; // 0-100
    fallbackTier: Tier;
    maxRetries: number;
  };
}

// Fallback 실행 로직
async function executeFallback(
  originalTier: Tier,
  reason: string,
  strategy: FallbackStrategy,
): Promise<Tier> {
  switch (reason) {
    case 'PRIMARY_FAILURE':
      return strategy.primaryFailure.fallbackTier;

    case 'RATE_LIMIT':
      if (strategy.rateLimit.queue) {
        // 큐에 추가하고 원래 Tier 반환 (나중에 재시도)
        return originalTier;
      }
      return strategy.rateLimit.fallbackTier;

    case 'COST_BUDGET_EXCEEDED':
      const fallbackTier = strategy.costBudget.fallbackTier;
      if (!isTierFeasible(fallbackTier)) {
        throw new Error('No feasible tier available within cost budget');
      }
      return fallbackTier;

    case 'QUALITY_CHECK_FAILED':
      return strategy.qualityCheck.fallbackTier;

    default:
      return originalTier;
  }
}
```

### 3.7 에이전트 레벨 Tier 제약

```typescript
interface FinOpsAgentConfig {
  agentId: string;
  tenantId: string;

  // 이 에이전트가 사용할 수 있는 최대 Tier
  maxTier: Tier; // 예: TIER_2 (Tier 3 사용 불가)

  // Tier별 월간 할당량
  tierQuotas: {
    [key in Tier]: {
      maxTokens: number; // 월간 최대 토큰
      maxCalls: number; // 월간 최대 호출
      maxCostUsd: number; // 월간 최대 비용
    };
  };

  // 스킬별 기본 Tier (라우터 제안 무시)
  skillTierDefaults: {
    [skillKey: string]: Tier;
  };

  // 긴급 모드 설정
  emergencyMode: {
    enabled: boolean;
    fallbackTier: Tier; // 모든 요청을 이 Tier로 라우팅
    activationCondition: 'manual' | 'cost_exceeded' | 'quota_exceeded';
  };
}

// Tier 제약 검증
function validateTierForAgent(
  proposedTier: Tier,
  agentConfig: FinOpsAgentConfig,
): { allowed: boolean; reason?: string; suggestedTier?: Tier } {
  // 1. 최대 Tier 확인
  if (!isTierAllowed(proposedTier, agentConfig.maxTier)) {
    return {
      allowed: false,
      reason: `Proposed tier ${proposedTier} exceeds agent max tier ${agentConfig.maxTier}`,
      suggestedTier: agentConfig.maxTier,
    };
  }

  // 2. 월간 쿼터 확인
  const quota = agentConfig.tierQuotas[proposedTier];
  const usage = getCurrentMonthUsage(agentConfig.agentId, proposedTier);

  if (usage.tokens >= quota.maxTokens) {
    return {
      allowed: false,
      reason: `Monthly token quota exceeded (${usage.tokens}/${quota.maxTokens})`,
      suggestedTier: findFeasibleTier(agentConfig),
    };
  }

  if (usage.calls >= quota.maxCalls) {
    return {
      allowed: false,
      reason: `Monthly call quota exceeded (${usage.calls}/${quota.maxCalls})`,
    };
  }

  // 3. 긴급 모드 확인
  if (agentConfig.emergencyMode.enabled) {
    return {
      allowed: proposedTier === agentConfig.emergencyMode.fallbackTier,
      reason: 'Emergency mode active - only fallback tier allowed',
      suggestedTier: agentConfig.emergencyMode.fallbackTier,
    };
  }

  return { allowed: true };
}

function isTierAllowed(proposed: Tier, max: Tier): boolean {
  const tierOrder = [Tier.TIER_1, Tier.TIER_2, Tier.TIER_3];
  return tierOrder.indexOf(proposed) <= tierOrder.indexOf(max);
}
```

### 3.8 비용 계산 공식

```typescript
interface CostCalculation {
  // 입력 토큰 비용
  inputCost: number;

  // 출력 토큰 비용
  outputCost: number;

  // 총 비용
  totalCost: number;

  // 예상 비용 (실제 실행 전)
  estimatedCost: number;

  // 비용 절감 (캐시 히트 등)
  savedCost?: number;
}

// 비용 계산 함수
function calculateCost(tier: Tier, inputTokens: number, outputTokens: number): CostCalculation {
  const tierDef = getTierDefinition(tier);

  const inputCost = (inputTokens / 1_000_000) * tierDef.pricing.inputPricePerMToken;
  const outputCost = (outputTokens / 1_000_000) * tierDef.pricing.outputPricePerMToken;
  const totalCost = inputCost + outputCost;

  return {
    inputCost,
    outputCost,
    totalCost,
    estimatedCost: totalCost, // 실제 호출 전에는 같음
  };
}

// 예상 비용 계산 (실행 전)
function estimateCost(
  tier: Tier,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): CostCalculation {
  const tierDef = getTierDefinition(tier);

  const estimatedInputCost =
    (estimatedInputTokens / 1_000_000) * tierDef.pricing.inputPricePerMToken;
  const estimatedOutputCost =
    (estimatedOutputTokens / 1_000_000) * tierDef.pricing.outputPricePerMToken;

  return {
    inputCost: estimatedInputCost,
    outputCost: estimatedOutputCost,
    totalCost: estimatedInputCost + estimatedOutputCost,
    estimatedCost: estimatedInputCost + estimatedOutputCost,
  };
}

// 여러 Tier 비용 비교
function compareTierCosts(
  inputTokens: number,
  outputTokens: number,
): { tier: Tier; cost: number; savings: number }[] {
  const costs = [Tier.TIER_1, Tier.TIER_2, Tier.TIER_3].map((tier) => ({
    tier,
    cost: calculateCost(tier, inputTokens, outputTokens).totalCost,
    savings: 0,
  }));

  const minCost = Math.min(...costs.map((c) => c.cost));

  return costs
    .map((c) => ({
      ...c,
      savings: c.cost - minCost,
    }))
    .sort((a, b) => a.cost - b.cost);
}
```

---

## 4. Gate 3: Skill Packer Engine

### 4.1 설계 원칙

Skill Packer는 프롬프트 최적화를 통해 불필요한 토큰을 제거하면서 응답 품질을 유지한다. 압축 기법들을 조합하여 구성되며, 스킬별로 토큰 예산을 관리한다.

### 4.2 아키텍처

```typescript
interface SkillPackerEngine {
  // 프롬프트 최적화
  pack(skill: Skill, prompt: string, tier: Tier, config: PackerConfig): Promise<PackedResult>;

  // 토큰 예산 조회
  getTokenBudget(skillKey: string, tier: Tier): number;

  // 최적화 결과 분석
  analyzeOptimization(result: PackedResult): OptimizationAnalysis;

  // 설정 관리
  updateConfig(config: PackerConfig): void;
}

interface PackedResult {
  // 최적화된 프롬프트
  packedPrompt: string;

  // 최적화 통계
  statistics: {
    originalTokens: number;
    packedTokens: number;
    tokensReduced: number;
    reductionPercent: number;
    compressionRatio: number; // 원본 / 압축본
  };

  // 적용된 기법
  techniquesApplied: string[]; // ['context_pruning', 'few_shot_reduction', ...]

  // 품질 메트릭
  quality: {
    contextPreservation: number; // 0-100
    completeness: number; // 0-100
    readability: number; // 0-100
  };

  // 예상 출력 포맷
  outputFormat: 'json' | 'markdown' | 'text' | 'xml';

  // 적용된 제약사항
  constraints: {
    maxTokensBudget: number;
    actualTokensUsed: number;
    budgetCompliance: boolean;
  };
}

interface PackerConfig {
  // 전역 설정
  global: {
    enabled: boolean;
    minTokensToOptimize: number; // 예: 500 토큰 이상만 최적화
  };

  // 스킬별 설정
  skills: {
    [skillKey: string]: SkillPackerConfig;
  };

  // Tier별 설정
  tiers: {
    [key in Tier]: TierPackerConfig;
  };
}

interface SkillPackerConfig {
  // 토큰 예산
  tokenBudgets: {
    [key in Tier]: number; // Tier별 최대 토큰
  };

  // 활성화할 최적화 기법
  techniques: {
    contextPruning: boolean;
    fewShotReduction: boolean;
    systemPromptCompression: boolean;
    outputFormatOptimization: boolean;
    parameterExtraction: boolean;
  };

  // 기법별 설정
  contextPruning: {
    aggressiveness: 'conservative' | 'balanced' | 'aggressive'; // 0.5 ~ 0.9 비율 유지
    keepMinContextTokens: number; // 최소 유지 컨텍스트
  };

  fewShotReduction: {
    maxExamples: number; // 최대 예제 개수
    exampleSelectionStrategy: 'relevance' | 'diversity' | 'balanced';
  };

  outputFormatOptimization: {
    preferredFormat: 'json' | 'markdown' | 'text' | 'xml';
    includeInstructions: boolean;
  };
}

interface TierPackerConfig {
  // 기본 토큰 예산 (스킬이 정의하지 않으면 사용)
  defaultTokenBudget: number;

  // 최적화 강도 (aggressive일수록 더 많이 압축)
  optimizationStrength: number; // 0.5 ~ 1.0

  // 허용되는 품질 저하
  allowedQualityDegradation: number; // 0 ~ 30 (퍼센트)
}
```

### 4.3 최적화 기법: Context Pruning

```typescript
interface ContextPruningConfig {
  // 공격성 수준 (유지할 컨텍스트 비율)
  aggressiveness: 'conservative' | 'balanced' | 'aggressive';
  ratios: {
    conservative: 0.8; // 80% 유지
    balanced: 0.6; // 60% 유지
    aggressive: 0.5; // 50% 유지
  };

  // 최소 유지 컨텍스트 토큰
  keepMinContextTokens: number;

  // 제외할 섹션 패턴
  excludePatterns: RegExp[];

  // 우선순위 섹션 (항상 유지)
  prioritySections: string[]; // "instructions", "constraints", etc.
}

async function pruneContext(
  prompt: string,
  skill: Skill,
  config: ContextPruningConfig,
  targetTokens: number,
): Promise<PruningResult> {
  // 1. 프롬프트를 섹션으로 분할
  const sections = parsePromptSections(prompt);

  // 2. 각 섹션의 토큰 계산
  const sectionTokens = sections.map((s) => ({
    ...s,
    tokens: estimateTokens(s.content),
    importance: calculateImportance(s, skill, config),
  }));

  // 3. 우선순위 기반 제거
  let currentTokens = sumTokens(sectionTokens);
  const targetRatio = config.ratios[config.aggressiveness];
  const targetSize = Math.max(Math.floor(currentTokens * targetRatio), config.keepMinContextTokens);

  const prioritized = sectionTokens.sort((a, b) => b.importance - a.importance);

  let selectedSections = [];
  let accumulatedTokens = 0;

  for (const section of prioritized) {
    if (accumulatedTokens + section.tokens <= targetSize) {
      selectedSections.push(section);
      accumulatedTokens += section.tokens;
    }
  }

  // 4. 제외 패턴 적용
  selectedSections = selectedSections.filter(
    (s) => !config.excludePatterns.some((p) => p.test(s.content)),
  );

  // 5. 재구성
  const prunedPrompt = reconstructPrompt(selectedSections);

  return {
    originalPrompt: prompt,
    prunedPrompt,
    originalTokens: currentTokens,
    prunedTokens: estimateTokens(prunedPrompt),
    tokensRemoved: currentTokens - estimateTokens(prunedPrompt),
    sectionsRemoved: sectionTokens.length - selectedSections.length,
    contextPreservationScore: estimateContextQuality(selectedSections),
  };
}

function calculateImportance(
  section: PromptSection,
  skill: Skill,
  config: ContextPruningConfig,
): number {
  let score = 0;

  // 1. 우선순위 섹션 가중치
  if (config.prioritySections.includes(section.type)) {
    score += 100;
  }

  // 2. 섹션 타입 기반
  switch (section.type) {
    case 'instructions':
      score += 50;
      break;
    case 'constraints':
      score += 40;
      break;
    case 'examples':
      score += 30;
      break;
    case 'context':
      score += 20;
      break;
    case 'metadata':
      score += 10;
      break;
  }

  // 3. 스킬 특화 가중치
  if (skill.essentialContextPatterns) {
    const matches = skill.essentialContextPatterns.filter((p) => p.test(section.content));
    score += matches.length * 15;
  }

  return score;
}
```

### 4.4 최적화 기법: Few-Shot Example Reduction

```typescript
interface FewShotReductionConfig {
  // 최대 예제 개수
  maxExamples: number;

  // 선택 전략
  strategy: 'relevance' | 'diversity' | 'balanced';

  // 각 전략의 가중치
  weights: {
    relevance: number; // 0 ~ 1
    diversity: number; // 0 ~ 1
    coverage: number; // 0 ~ 1
  };
}

async function reduceFewShotExamples(
  prompt: string,
  skill: Skill,
  config: FewShotReductionConfig,
  targetTokens: number,
): Promise<ReductionResult> {
  // 1. 프롬프트에서 예제 추출
  const examples = extractExamples(prompt);

  if (examples.length <= config.maxExamples) {
    return {
      originalPrompt: prompt,
      reducedPrompt: prompt,
      examplesRemoved: 0,
      tokensReduced: 0,
      examplesKept: examples,
    };
  }

  // 2. 각 예제의 품질 점수 계산
  const exampleScores = examples.map((ex) => ({
    example: ex,
    tokens: estimateTokens(ex.content),
    relevance: calculateExampleRelevance(ex, skill),
    diversity: 0, // 나중에 계산
  }));

  // 3. 다양성 계산 (이미 선택된 예제와의 차이)
  const selected: any[] = [];

  for (let i = 0; i < exampleScores.length; i++) {
    let diversityScore = 1.0;

    for (const selectedEx of selected) {
      const similarity = calculateSimilarity(exampleScores[i].example, selectedEx.example);
      diversityScore *= 1 - similarity; // 유사할수록 낮은 다양성 점수
    }

    exampleScores[i].diversity = diversityScore;
  }

  // 4. 전략별 최종 점수 계산
  const finalScores = exampleScores.map((ex) => {
    let score = 0;

    switch (config.strategy) {
      case 'relevance':
        score = ex.relevance;
        break;
      case 'diversity':
        score = ex.diversity;
        break;
      case 'balanced':
        score = ex.relevance * config.weights.relevance + ex.diversity * config.weights.diversity;
        break;
    }

    return { ...ex, finalScore: score };
  });

  // 5. 상위 예제 선택
  const selected = finalScores
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, config.maxExamples);

  let accumulatedTokens = 0;
  const kept = [];

  for (const item of selected) {
    if (accumulatedTokens + item.tokens <= targetTokens) {
      kept.push(item.example);
      accumulatedTokens += item.tokens;
    }
  }

  // 6. 프롬프트 재구성
  const reducedPrompt = reconstructPromptWithExamples(prompt, kept);

  return {
    originalPrompt: prompt,
    reducedPrompt,
    examplesRemoved: examples.length - kept.length,
    tokensReduced: estimateTokens(prompt) - estimateTokens(reducedPrompt),
    examplesKept: kept,
    strategy: config.strategy,
  };
}

function calculateExampleRelevance(example: Example, skill: Skill): number {
  let score = 0;

  // 1. 스킬 태그 매칭
  const matchingTags = skill.tags.filter((tag) => example.tags?.includes(tag));
  score += matchingTags.length * 20;

  // 2. 입력 타입 호환성
  if (example.inputType === skill.inputType) {
    score += 25;
  }

  // 3. 출력 타입 호환성
  if (example.outputType === skill.outputType) {
    score += 25;
  }

  // 4. 복잡도 매칭
  const complexityDiff = Math.abs(example.complexity - skill.expectedComplexity);
  score += Math.max(0, 30 - complexityDiff);

  return Math.min(score, 100) / 100; // 0-1 정규화
}

function calculateSimilarity(example1: Example, example2: Example): number {
  // 의미론적 유사도 계산 (태그 기반)
  const tags1 = new Set(example1.tags || []);
  const tags2 = new Set(example2.tags || []);

  const intersection = new Set([...tags1].filter((x) => tags2.has(x)));
  const union = new Set([...tags1, ...tags2]);

  if (union.size === 0) return 0;

  return intersection.size / union.size; // Jaccard similarity
}
```

### 4.5 최적화 기법: System Prompt Compression

```typescript
interface SystemPromptCompressionConfig {
  // 압축 수준
  level: 'conservative' | 'moderate' | 'aggressive';

  // 유지할 최소 명령어
  keepMinInstructions: number;

  // 제거할 수 있는 섹션
  removableSections: string[]; // 'examples', 'notes', 'warnings'

  // 약어 사전
  abbreviations: Record<string, string>;
}

async function compressSystemPrompt(
  systemPrompt: string,
  config: SystemPromptCompressionConfig,
  targetTokens: number,
): Promise<CompressionResult> {
  // 1. 원문 파싱
  let compressed = systemPrompt;
  const originalTokens = estimateTokens(systemPrompt);

  // 2. 단계적 압축

  // Step 1: 불필요한 공백과 줄바꿈 제거
  compressed = compressed
    .replace(/\n\n+/g, '\n') // 여러 빈 줄을 하나로
    .replace(/\s+$/gm, '') // 라인 끝 공백 제거
    .trim();

  // Step 2: 약어 적용
  for (const [full, abbr] of Object.entries(config.abbreviations)) {
    if (config.level === 'aggressive') {
      // 정규식으로 모든 변형 처리
      const pattern = new RegExp(`\\b${escapeRegex(full)}\\b`, 'gi');
      compressed = compressed.replace(pattern, abbr);
    }
  }

  // Step 3: 제거 가능한 섹션 제거
  if (config.level !== 'conservative') {
    const sections = parsePromptSections(compressed);

    for (const removeSection of config.removableSections) {
      compressed = sections
        .filter((s) => s.type !== removeSection)
        .map((s) => s.content)
        .join('\n');
    }
  }

  // Step 4: 문장 단순화 (aggressive 모드)
  if (config.level === 'aggressive') {
    compressed = simplifyLanguage(compressed);
  }

  // Step 5: 지정된 토큰 수에 맞도록 조정
  let compressedTokens = estimateTokens(compressed);

  if (compressedTokens > targetTokens) {
    compressed = truncateToTokens(compressed, targetTokens);
    compressedTokens = targetTokens;
  }

  return {
    original: systemPrompt,
    compressed,
    originalTokens,
    compressedTokens,
    tokensReduced: originalTokens - compressedTokens,
    reductionPercent: ((originalTokens - compressedTokens) / originalTokens) * 100,
    compressionLevel: config.level,
  };
}

function simplifyLanguage(text: string): string {
  const replacements = [
    { from: /please /gi, to: '' },
    { from: /would you /gi, to: '' },
    { from: /it is important to /gi, to: '' },
    { from: / in order to /gi, to: ' to ' },
    { from: /due to the fact that /gi, to: 'because ' },
    { from: /at this point in time/gi, to: 'now' },
    { from: /in the near future/gi, to: 'soon' },
  ];

  let result = text;

  for (const { from, to } of replacements) {
    result = result.replace(from, to);
  }

  return result;
}
```

### 4.6 최적화 기법: Output Format Optimization

```typescript
interface OutputFormatConfig {
  // 선호하는 출력 포맷
  format: 'json' | 'markdown' | 'text' | 'xml';

  // 프롬프트 선택사항에 명시적으로 포함
  explicitly: boolean;

  // 각 포맷의 토큰 효율성
  efficiency: {
    json: 0.9; // JSON은 구조화되어 효율적
    markdown: 1.0; // Markdown은 표준
    text: 1.1; // 일반 텍스트는 약간 비효율
    xml: 1.2; // XML은 태그로 인해 비효율
  };
}

function optimizeOutputFormat(
  prompt: string,
  skill: Skill,
  config: OutputFormatConfig,
): OutputFormatResult {
  // 1. 스킬의 기본 포맷 확인
  const skillPreferredFormat = skill.outputFormat || 'markdown';

  // 2. 효율성 기반 선택
  const selectedFormat = selectEfficientFormat(skillPreferredFormat, config);

  // 3. 프롬프트에 포맷 명시
  let optimizedPrompt = prompt;

  if (config.explicitly) {
    const formatInstruction = buildFormatInstruction(selectedFormat);

    // 프롬프트 끝에 추가 (또는 기존 포맷 지시사항 덮어쓰기)
    optimizedPrompt = removeExistingFormatInstructions(prompt);
    optimizedPrompt += `\n\nPlease format your response as ${selectedFormat}.`;

    if (selectedFormat === 'json') {
      optimizedPrompt += '\nReturn valid JSON only, no markdown code blocks.';
    }
  }

  const estimatedTokenSavings = estimateTokens(prompt) - estimateTokens(optimizedPrompt);

  return {
    originalPrompt: prompt,
    optimizedPrompt,
    format: selectedFormat,
    estimatedTokenSavings,
    efficiency: config.efficiency[selectedFormat],
  };
}

function selectEfficientFormat(preferred: string, config: OutputFormatConfig): string {
  // 선호 포맷이 있으면 그걸 사용
  if (preferred && config.efficiency[preferred] <= 1.0) {
    return preferred;
  }

  // 아니면 가장 효율적인 포맷 선택
  return Object.entries(config.efficiency).sort((a, b) => a[1] - b[1])[0][0];
}

function buildFormatInstruction(format: string): string {
  switch (format) {
    case 'json':
      return 'Return a valid JSON object.';
    case 'markdown':
      return 'Format your response using Markdown.';
    case 'text':
      return 'Provide a plain text response.';
    case 'xml':
      return 'Wrap your response in XML tags.';
    default:
      return '';
  }
}
```

### 4.7 토큰 계산 및 추적

```typescript
interface TokenTracker {
  // 프롬프트 토큰 계산
  countPromptTokens(prompt: string, model: string): number;

  // 응답 토큰 예상
  estimateResponseTokens(prompt: string, skill: Skill, tier: Tier): number;

  // 전체 토큰 합산
  countTotalTokens(input: string, output: string, model: string): number;

  // 예산 확인
  checkBudget(tokens: number, budget: number): { withinBudget: boolean; remaining: number };

  // 기록 조회
  getTokenUsage(skillKey: string, period: 'hour' | 'day' | 'month'): TokenUsageStats;
}

class OpenAITokenCounter implements TokenCounter {
  private encoding: Encoding; // tiktoken encoding

  constructor(model: string = 'gpt-4') {
    // OpenAI 토큰 인코딩 로드
    this.encoding = getEncoding('cl100k_base'); // GPT-4 인코딩
  }

  countTokens(text: string): number {
    try {
      const tokens = this.encoding.encode(text);
      return tokens.length;
    } catch (error) {
      // 폴백: 대략적 계산 (1 토큰 ≈ 4 문자)
      return Math.ceil(text.length / 4);
    }
  }

  countPromptTokens(prompt: string, model: string): number {
    // 모델별 오버헤드 계산
    const overhead = this.getModelOverhead(model);
    return this.countTokens(prompt) + overhead;
  }

  estimateResponseTokens(prompt: string, skill: Skill, tier: Tier): number {
    // 스킬과 Tier 기반 예상 응답 길이
    const basedOnPromptLength = Math.ceil(this.countTokens(prompt) * 0.5);
    const skillBasedEstimate = skill.estimatedOutputTokens || 500;
    const tierBasedLimit = getTierDefinition(tier).constraints.maxOutputTokens;

    return Math.min(basedOnPromptLength, skillBasedEstimate, tierBasedLimit);
  }

  private getModelOverhead(model: string): number {
    // 각 메시지의 오버헤드 (역할, 마크업 등)
    const overheads = {
      'gpt-4': 4,
      'gpt-3.5-turbo': 4,
      'claude-3-opus': 5,
      'claude-3-sonnet': 5,
      'claude-3-haiku': 5,
    };

    return overheads[model] || 4;
  }
}

interface TokenUsageStats {
  period: string;
  skillKey: string;

  // 사용 통계
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalTokens: number;

  // 호출 통계
  callCount: number;
  cacheHitCount: number;
  cacheHitRate: number;

  // 비용 통계
  totalCost: number;
  averageCostPerCall: number;

  // 최적화 효과
  tokensSavedByCache: number;
  tokensSavedByPacking: number;
  costSavedUsd: number;
}
```

---

## 5. 데이터 모델 (Prisma)

### 5.1 핵심 모델

```prisma
// FinOps 설정 (테넌트 레벨)
model FinOpsConfig {
  id            String      @id @default(cuid())
  tenantId      String      @unique

  // Cache 설정
  cacheEnabled  Boolean     @default(true)
  cacheNamespace String     @default("")  // 테넌트 격리 prefix
  cacheDefaultTtl Int       @default(604800)  // 7일
  cacheSimilarityThreshold Float @default(0.90)
  cacheWarmupEnabled Boolean @default(false)

  // Router 설정
  routerEnabled Boolean     @default(true)
  routerStage1Only Boolean  @default(false)  // Stage 2 (LLM) 비활성화
  defaultTier   String      @default("TIER_2")  // Tier.TIER_2

  // Packer 설정
  packerEnabled Boolean     @default(true)
  packerMinTokensToOptimize Int @default(500)

  // FinOps 전역 토글
  finopsEnabled Boolean     @default(true)
  emergencyMode Boolean     @default(false)
  emergencyFallbackTier String?  // 긴급 모드 Tier

  // 모니터링
  tokenLoggingEnabled Boolean @default(true)
  costTrackingEnabled Boolean @default(true)

  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  tenant        Tenant      @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  agentConfigs  FinOpsAgentConfig[]
  skills        FinOpsSkill[]
  namespaces    FinOpsNamespace[]
  tokenLogs     FinOpsTokenLog[]

  @@index([tenantId])
}

// FinOps 에이전트 설정
model FinOpsAgentConfig {
  id            String      @id @default(cuid())
  tenantId      String
  agentId       String

  // Tier 제약
  maxTier       String      @default("TIER_3")  // 최대 허용 Tier

  // 월간 쿼터 (Tier 1)
  tier1MaxTokens Int        @default(1000000)
  tier1MaxCalls Int         @default(10000)
  tier1MaxCostUsd Decimal   @default("100") @db.Decimal(10, 2)

  // 월간 쿼터 (Tier 2)
  tier2MaxTokens Int        @default(500000)
  tier2MaxCalls Int         @default(5000)
  tier2MaxCostUsd Decimal   @default("500") @db.Decimal(10, 2)

  // 월간 쿼터 (Tier 3)
  tier3MaxTokens Int        @default(100000)
  tier3MaxCalls Int         @default(1000)
  tier3MaxCostUsd Decimal   @default("1000") @db.Decimal(10, 2)

  // 당월 누적 사용량
  tier1UsedTokens Int       @default(0)
  tier1UsedCalls Int        @default(0)
  tier1UsedCostUsd Decimal  @default("0") @db.Decimal(10, 2)

  tier2UsedTokens Int       @default(0)
  tier2UsedCalls Int        @default(0)
  tier2UsedCostUsd Decimal  @default("0") @db.Decimal(10, 2)

  tier3UsedTokens Int       @default(0)
  tier3UsedCalls Int        @default(0)
  tier3UsedCostUsd Decimal  @default("0") @db.Decimal(10, 2)

  // 긴급 모드
  emergencyModeEnabled Boolean @default(false)
  emergencyModeSince DateTime?

  // 스킬별 기본 Tier 오버라이드
  skillTierOverrides Json?  // { skillKey: "TIER_1" | "TIER_2" | "TIER_3" }

  // 메타데이터
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  finopsConfig  FinOpsConfig @relation(fields: [tenantId], references: [tenantId], onDelete: Cascade)

  @@unique([tenantId, agentId])
  @@index([tenantId])
}

// FinOps 스킬 설정
model FinOpsSkill {
  id            String      @id @default(cuid())
  tenantId      String
  skillKey      String

  // 토큰 예산
  tier1TokenBudget Int
  tier2TokenBudget Int
  tier3TokenBudget Int

  // 최적화 활성화
  cachingEnabled Boolean    @default(true)
  routingEnabled Boolean    @default(true)
  packingEnabled Boolean    @default(true)

  // 캐싱 제외 규칙
  cacheExclusionPatterns Json?  // { patterns: string[], keywords: {...} }
  cacheCustomTtl Int?       // 기본값 오버라이드

  // 기본 Tier (라우터 무시)
  defaultTier   String?     // "TIER_1" | "TIER_2" | "TIER_3"

  // 성능 메타데이터
  estimatedOutputTokens Int?
  averageResponseTimeMs Int?

  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  finopsConfig  FinOpsConfig @relation(fields: [tenantId], references: [tenantId], onDelete: Cascade)

  @@unique([tenantId, skillKey])
  @@index([tenantId, skillKey])
}

// FinOps 네임스페이스 (캐시 격리)
model FinOpsNamespace {
  id            String      @id @default(cuid())
  tenantId      String
  namespace     String

  // TTL 설정
  defaultTtl    Int

  // 캐시 통계
  cacheHitCount Int         @default(0)
  cacheMissCount Int        @default(0)
  totalItems    Int         @default(0)

  // 무효화 설정
  invalidateOn  Json?       // 무효화 트리거 조건
  lastInvalidatedAt DateTime?

  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  finopsConfig  FinOpsConfig @relation(fields: [tenantId], references: [tenantId], onDelete: Cascade)

  @@unique([tenantId, namespace])
  @@index([tenantId])
}

// FinOps 토큰 로깅
model FinOpsTokenLog {
  id            String      @id @default(cuid())
  tenantId      String
  agentId       String
  executionId   String?     // ExecutionSession 참조
  skillKey      String

  // 요청 정보
  promptTokens  Int
  estimatedOutputTokens Int?

  // 응답 정보
  actualOutputTokens Int?
  totalTokens   Int?

  // 최적화 효과
  cacheHit      Boolean     @default(false)
  cachedTokens  Int?        // 캐시 히트 시 토큰 절감
  tier          String      // "TIER_1" | "TIER_2" | "TIER_3"

  // Gate별 처리 시간 (ms)
  gate1Latency  Int?        // Cache lookup
  gate2Latency  Int?        // Router
  gate3Latency  Int?        // Packer
  llmLatency    Int?

  // 비용
  estimatedCost Decimal     @db.Decimal(10, 6)
  actualCost    Decimal?    @db.Decimal(10, 6)
  savedCost     Decimal     @default("0") @db.Decimal(10, 6)

  // 최적화 통계
  originalPromptTokens Int?
  packedPromptTokens Int?
  tokensReduced Int?        @default(0)

  // 상태
  status        String      @default("SUCCESS")  // SUCCESS, FAILED, TIMEOUT
  error         String?

  createdAt     DateTime    @default(now())

  finopsConfig  FinOpsConfig @relation(fields: [tenantId], references: [tenantId], onDelete: Cascade)
  execution     ExecutionSession? @relation(fields: [executionId], references: [id])

  @@index([tenantId, createdAt])
  @@index([agentId, createdAt])
  @@index([skillKey, createdAt])
  @@index([tier, createdAt])
  @@index([cacheHit])
}

// ExecutionSession에 FinOps 관련 필드 추가 (기존 스키마 연장)
// model ExecutionSession {
//   ...existing fields...
//   finopsLogs    FinOpsTokenLog[]  // 역관계
// }
```

### 5.2 관계 및 인덱싱

```
FinOpsConfig
├─ (1:N) FinOpsAgentConfig
├─ (1:N) FinOpsSkill
├─ (1:N) FinOpsNamespace
└─ (1:N) FinOpsTokenLog

Key Indexes:
- FinOpsTokenLog: (tenantId, createdAt) - 시간 범위 쿼리
- FinOpsTokenLog: (skillKey, createdAt) - 스킬별 분석
- FinOpsTokenLog: (tier, createdAt) - Tier별 분석
- FinOpsTokenLog: (cacheHit) - 캐시 효율성 분석
```

---

## 6. API 엔드포인트

### 6.1 FinOps 설정 API

```yaml
/v1/finops/config:
  GET:
    summary: 테넌트 FinOps 설정 조회
    responses:
      200:
        schema:
          $ref: '#/components/schemas/FinOpsConfig'

  PUT:
    summary: FinOps 설정 업데이트
    requestBody:
      schema:
        type: object
        properties:
          cacheEnabled: { type: boolean }
          cacheSimilarityThreshold: { type: number }
          routerEnabled: { type: boolean }
          packerEnabled: { type: boolean }
          finopsEnabled: { type: boolean }
          emergencyMode: { type: boolean }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/FinOpsConfig'

/v1/finops/agents/{agentId}/config:
  GET:
    summary: 에이전트별 FinOps 설정 조회
    parameters:
      - name: agentId
        in: path
        required: true
        schema: { type: string }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/FinOpsAgentConfig'

  PUT:
    summary: 에이전트별 FinOps 설정 업데이트
    parameters:
      - name: agentId
        in: path
        required: true
        schema: { type: string }
    requestBody:
      schema:
        type: object
        properties:
          maxTier: { type: string, enum: [TIER_1, TIER_2, TIER_3] }
          tier1MaxCostUsd: { type: number }
          tier2MaxCostUsd: { type: number }
          tier3MaxCostUsd: { type: number }
          emergencyModeEnabled: { type: boolean }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/FinOpsAgentConfig'

/v1/finops/skills/{skillKey}/config:
  GET:
    summary: 스킬별 FinOps 설정 조회
    parameters:
      - name: skillKey
        in: path
        required: true
        schema: { type: string }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/FinOpsSkill'

  PUT:
    summary: 스킬별 FinOps 설정 업데이트
    parameters:
      - name: skillKey
        in: path
        required: true
        schema: { type: string }
    requestBody:
      schema:
        type: object
        properties:
          tier1TokenBudget: { type: integer }
          tier2TokenBudget: { type: integer }
          tier3TokenBudget: { type: integer }
          cachingEnabled: { type: boolean }
          routingEnabled: { type: boolean }
          packingEnabled: { type: boolean }
          defaultTier: { type: string }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/FinOpsSkill'
```

### 6.2 FinOps 최적화 API

```yaml
/v1/finops/optimize:
  POST:
    summary: 프롬프트 최적화 요청
    description: 단일 프롬프트를 3-Gate Pipeline으로 처리
    requestBody:
      schema:
        type: object
        required: [prompt, skillKey]
        properties:
          prompt: { type: string }
          skillKey: { type: string }
          agentId: { type: string }
          context: { type: object }
          config:
            type: object
            properties:
              gate1Enabled: { type: boolean }
              gate2Enabled: { type: boolean }
              gate3Enabled: { type: boolean }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/OptimizeResult'

/v1/finops/cache/invalidate:
  POST:
    summary: 캐시 무효화
    requestBody:
      schema:
        type: object
        properties:
          namespace: { type: string }
          scenario: { type: string, enum: [POLICY_UPDATED, MODEL_CHANGED, SKILL_UPDATED, MANUAL] }
          patterns: { type: array, items: { type: string } }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/InvalidationResult'

/v1/finops/router/classify:
  POST:
    summary: 프롬프트 복잡도 분류
    requestBody:
      schema:
        type: object
        required: [prompt]
        properties:
          prompt: { type: string }
          skillKey: { type: string }
          stageOverride: { type: string, enum: [RULE_BASED, LLM_BASED] }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/Classification'
```

### 6.3 FinOps 모니터링 API

```yaml
/v1/finops/stats:
  GET:
    summary: 테넌트 FinOps 통계 조회
    parameters:
      - name: period
        in: query
        schema: { type: string, enum: [hour, day, month, year] }
        default: month
    responses:
      200:
        schema:
          $ref: '#/components/schemas/FinOpsStats'

/v1/finops/agents/{agentId}/usage:
  GET:
    summary: 에이전트별 토큰 사용량 조회
    parameters:
      - name: agentId
        in: path
        required: true
        schema: { type: string }
      - name: from
        in: query
        schema: { type: string, format: date-time }
      - name: to
        in: query
        schema: { type: string, format: date-time }
    responses:
      200:
        schema:
          $ref: '#/components/schemas/AgentUsageStats'

/v1/finops/logs:
  GET:
    summary: FinOps 토큰 로그 조회
    parameters:
      - name: skillKey
        in: query
        schema: { type: string }
      - name: tier
        in: query
        schema: { type: string }
      - name: cacheHit
        in: query
        schema: { type: boolean }
      - name: limit
        in: query
        schema: { type: integer, default: 100 }
      - name: offset
        in: query
        schema: { type: integer, default: 0 }
    responses:
      200:
        schema:
          type: object
          properties:
            items:
              type: array
              items:
                $ref: '#/components/schemas/FinOpsTokenLog'
            total: { type: integer }
            limit: { type: integer }
            offset: { type: integer }
```

---

## 7. 프론트엔드 통합

### 7.1 Agent Control에서의 FinOps 탭

```typescript
// apps/web/app/(dashboard)/agents/[agentId]/settings/finops/page.tsx

export default function FinOpsSettingsPage() {
  const { agentId } = useParams();
  const { data: config, isLoading } = useQuery(
    ['finops-agent-config', agentId],
    () => api.get(`/finops/agents/${agentId}/config`)
  );

  return (
    <div className="space-y-6">
      {/* 1. Tier 제약 설정 */}
      <Card>
        <CardHeader>
          <CardTitle>Tier 제약</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={config?.maxTier}>
            <Option value="TIER_1">Tier 1 (기본)</Option>
            <Option value="TIER_2">Tier 2 (표준)</Option>
            <Option value="TIER_3">Tier 3 (프리미엄)</Option>
          </Select>
        </CardContent>
      </Card>

      {/* 2. 월간 쿼터 설정 */}
      <Card>
        <CardHeader>
          <CardTitle>월간 쿼터</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {['tier1', 'tier2', 'tier3'].map(tier => (
              <div key={tier}>
                <Label>Tier {tier.slice(-1)}</Label>
                <Input
                  type="number"
                  defaultValue={config?.[`${tier}MaxCostUsd`]}
                  suffix=" USD"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 3. 긴급 모드 */}
      <Card>
        <CardHeader>
          <CardTitle>긴급 모드</CardTitle>
        </CardHeader>
        <CardContent>
          <Toggle
            checked={config?.emergencyModeEnabled}
            label="활성화"
            description="모든 요청을 저비용 모델로 라우팅"
          />
        </CardContent>
      </Card>

      {/* 4. 사용량 현황 */}
      <Card>
        <CardHeader>
          <CardTitle>당월 사용량</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart agentId={agentId} />
        </CardContent>
      </Card>
    </div>
  );
}
```

### 7.2 Builder에서의 토큰 최적화 표시

```typescript
// apps/web/app/(dashboard)/builder/canvas/execution-panel.tsx

export function ExecutionPanel() {
  const { selectedNode } = useBuilder();
  const { data: tokenEstimate } = useQuery(
    ['finops-estimate', selectedNode?.id],
    async () => {
      if (!selectedNode) return null;

      const response = await api.post('/finops/optimize', {
        prompt: selectedNode.prompt,
        skillKey: selectedNode.skillKey,
        agentId: selectedNode.agentId,
        config: { gate1Enabled: false, gate2Enabled: true, gate3Enabled: true }
      });

      return response;
    }
  );

  return (
    <Panel>
      <div className="space-y-4">
        {/* 노드 실행 컨트롤 */}
        <ExecutionControls node={selectedNode} />

        {/* FinOps 메트릭 */}
        {tokenEstimate && (
          <Card className="bg-blue-50">
            <CardHeader>
              <CardTitle className="text-sm">Token Optimization</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {/* Gate 1: Cache */}
              <div className="flex justify-between text-sm">
                <span>Cache Hit Probability</span>
                <Badge variant={tokenEstimate.gate1?.cacheHit ? 'success' : 'outline'}>
                  {tokenEstimate.gate1?.confidence ? `${(tokenEstimate.gate1.confidence * 100).toFixed(0)}%` : 'No match'}
                </Badge>
              </div>

              {/* Gate 2: Router */}
              <div className="flex justify-between text-sm">
                <span>Recommended Tier</span>
                <Badge>{tokenEstimate.gate2?.tier || 'TIER_2'}</Badge>
              </div>

              <TierComparison tiers={tokenEstimate.tierComparison} />

              {/* Gate 3: Packer */}
              <div className="flex justify-between text-sm">
                <span>Token Reduction</span>
                <span className="font-semibold text-green-600">
                  {tokenEstimate.gate3?.tokensReduced || 0} tokens
                </span>
              </div>

              {/* 비용 예상 */}
              <Separator />
              <div className="flex justify-between text-sm font-semibold">
                <span>Estimated Cost</span>
                <span>${tokenEstimate.estimatedCost?.toFixed(4) || '0.0000'}</span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Panel>
  );
}

function TierComparison({ tiers }: { tiers: TierCost[] }) {
  return (
    <div className="space-y-1 text-xs">
      {tiers?.map(tier => (
        <div key={tier.tier} className="flex justify-between">
          <span>{tier.tier}</span>
          <span className={tier.recommended ? 'font-bold text-green-600' : ''}>
            ${tier.cost.toFixed(4)}
          </span>
        </div>
      ))}
    </div>
  );
}
```

### 7.3 Monitor에서의 비용 추적

```typescript
// apps/web/app/(dashboard)/monitor/finops/page.tsx

export default function FinOpsMonitorPage() {
  const { data: stats } = useQuery(
    ['finops-stats'],
    () => api.get('/finops/stats', { period: 'month' })
  );

  const { data: logs } = useQuery(
    ['finops-logs'],
    () => api.get('/finops/logs', { limit: 500 })
  );

  return (
    <div className="space-y-6">
      {/* 1. 요약 카드 */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          title="Total Cost"
          value={`$${stats?.totalCost?.toFixed(2)}`}
          subtext="This month"
        />
        <StatCard
          title="Cache Hit Rate"
          value={`${stats?.cacheHitRate?.toFixed(1)}%`}
          trend={stats?.cacheHitRateTrend}
        />
        <StatCard
          title="Tokens Saved"
          value={`${(stats?.tokensSaved || 0).toLocaleString()}`}
          subtext={`${stats?.costSaved?.toFixed(2)} USD`}
        />
        <StatCard
          title="Optimization Impact"
          value={`${stats?.optimizationPercent?.toFixed(1)}%`}
          subtext="Cost reduction"
        />
      </div>

      {/* 2. Tier 분포 */}
      <Card>
        <CardHeader>
          <CardTitle>Tier Usage Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <TierDistributionChart data={stats?.tierDistribution} />
        </CardContent>
      </Card>

      {/* 3. Gate별 효율성 */}
      <Card>
        <CardHeader>
          <CardTitle>Gate Efficiency</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4">
          <GateMetric
            name="Gate 1: Cache"
            hitRate={stats?.cache?.hitRate}
            savedTokens={stats?.cache?.savedTokens}
            avgLatency={stats?.cache?.avgLatency}
          />
          <GateMetric
            name="Gate 2: Router"
            hitRate={stats?.router?.accuracyRate}
            savedCost={stats?.router?.savedCost}
            avgLatency={stats?.router?.avgLatency}
          />
          <GateMetric
            name="Gate 3: Packer"
            reductionPercent={stats?.packer?.reductionPercent}
            savedTokens={stats?.packer?.savedTokens}
            avgLatency={stats?.packer?.avgLatency}
          />
        </CardContent>
      </Card>

      {/* 4. 상세 로그 테이블 */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Executions</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable columns={tokenLogColumns} data={logs?.items} />
        </CardContent>
      </Card>
    </div>
  );
}

const tokenLogColumns = [
  {
    accessorKey: 'skillKey',
    header: 'Skill',
  },
  {
    accessorKey: 'tier',
    header: 'Tier',
    cell: ({ row }) => <Badge>{row.original.tier}</Badge>,
  },
  {
    accessorKey: 'promptTokens',
    header: 'Input Tokens',
  },
  {
    accessorKey: 'actualOutputTokens',
    header: 'Output Tokens',
  },
  {
    accessorKey: 'cacheHit',
    header: 'Cache',
    cell: ({ row }) => <Badge variant={row.original.cacheHit ? 'success' : 'outline'}>
      {row.original.cacheHit ? 'Hit' : 'Miss'}
    </Badge>,
  },
  {
    accessorKey: 'actualCost',
    header: 'Cost',
    cell: ({ row }) => `$${(row.original.actualCost || 0).toFixed(4)}`,
  },
  {
    accessorKey: 'savedCost',
    header: 'Saved',
    cell: ({ row }) => (
      <span className="text-green-600 font-semibold">
        ${(row.original.savedCost || 0).toFixed(4)}
      </span>
    ),
  },
  {
    accessorKey: 'createdAt',
    header: 'Time',
    cell: ({ row }) => formatTime(row.original.createdAt),
  },
];
```

---

## 8. 구현 페이즈

### 8.1 Phase 1: Mock Simulation (현재)

**목표**: FinOps 기본 구조 검증, UI 완성, 로깅 기반 구축

**작업 항목**:

- [ ] Prisma 스키마 확장 (FinOpsConfig, FinOpsTokenLog)
- [ ] Mock FinOps 미들웨어 (항상 Tier 2, 캐시 없음)
- [ ] API 엔드포인트 (GET/PUT 설정, 로깅 조회)
- [ ] Agent Control - FinOps 탭 UI
- [ ] Builder - 토큰 추정 표시 (하드코딩)
- [ ] Monitor - FinOps 차트 (시뮬레이션 데이터)
- [ ] 토큰 로깅 파이프라인

**예상 기간**: 2주

### 8.2 Phase 2: Real Cache Implementation

**목표**: Gate 1 캐시 엔진 실제 구현

**작업 항목**:

- [ ] Redis 또는 Qdrant 벡터 저장소 설정
- [ ] OpenAI Embeddings API 통합
- [ ] SemanticCacheEngine 구현
- [ ] 캐시 무효화 규칙 엔진
- [ ] TTL 관리 및 Warm-up
- [ ] 캐시 성능 모니터링

**성능 목표**:

- Cache hit rate: >15%
- Cache lookup: <50ms

**예상 기간**: 3주

### 8.3 Phase 3: Real Router Implementation

**목표**: Gate 2 Model Router 실제 구현

**작업 항목**:

- [ ] Rule-based classifier (Stage 1) 구현
- [ ] LLM-based classifier (Stage 2) - 경량 모델 사용
- [ ] Tier별 모델 매핑
- [ ] Fallback 전략 구현
- [ ] Agent 레벨 tier 제약 적용
- [ ] 비용 계산 엔진

**성능 목표**:

- Stage 1 분류: <10ms
- Stage 2 분류: <500ms
- Router 정확도: >90%

**예상 기간**: 3주

### 8.4 Phase 4: Real Packer Implementation

**목표**: Gate 3 Skill Packer 실제 구현

**작업 항목**:

- [ ] Context pruning 알고리즘
- [ ] Few-shot example reduction
- [ ] System prompt compression
- [ ] Output format optimization
- [ ] Token counter (tiktoken 또는 openai api)
- [ ] 토큰 예산 관리

**성능 목표**:

- Packing latency: <100ms
- Token reduction: 15-25%
- Quality degradation: <5%

**예상 기간**: 3주

### 8.5 Phase 5: Production Hardening

**목표**: 프로덕션 배포 준비

**작업 항목**:

- [ ] 알림 및 모니터링 설정
- [ ] 예산 초과 경고
- [ ] 비용 제어 (자동 throttling)
- [ ] 자동 스케일링
- [ ] A/B 테스트 프레임워크
- [ ] SLA 모니터링

**예상 기간**: 2주

---

## 9. 비용 최적화 목표

### 9.1 정량적 목표

| 메트릭                 | 목표        | 현황            | 추적 방법                                       |
| ---------------------- | ----------- | --------------- | ----------------------------------------------- |
| **전체 LLM 비용 감소** | 30-40%      | 베이스라인      | FinOpsStats 월간 비교                           |
| **Cache Hit Rate**     | >20%        | Phase 2 완료 후 | FinOpsTokenLog.cacheHit 비율                    |
| **평균 응답 시간**     | <100ms 증가 | Phase 1부터     | sum(gate1Latency + gate2Latency + gate3Latency) |
| **응답 품질 저하**     | <5%         | Phase 3부터     | 수동 품질 심사 샘플링                           |
| **Router 정확도**      | >90%        | Phase 3부터     | Tier 실제 vs 예측 비율                          |

### 9.2 Gate별 기여도

```
Cache (Gate 1):     15-20% 절감  (Cache hit 시 100% 절감)
Router (Gate 2):    10-15% 절감  (저비용 모델 선택)
Packer (Gate 3):     5-10% 절감  (토큰 압축)
───────────────────────────────
Total Target:      30-40% 절감
```

### 9.3 Tier별 비용 분석

```
Before FinOps:
- Tier 1: 20% calls @ $0.25-1/1M
- Tier 2: 60% calls @ $3-15/1M
- Tier 3: 20% calls @ $15-75/1M
- Average: ~$7/1M

After FinOps:
- Tier 1: 40% calls (Router 개선)
- Tier 2: 50% calls
- Tier 3: 10% calls (Cache + Router)
- Average: ~$4.5/1M
- Savings: ~35%
```

---

## 10. 보안 및 거버넌스

### 10.1 Multi-Tenant 격리

- **테넌트 격리**: 모든 FinOps 데이터에 `tenant_id` 필수
- **네임스페이스 격리**: 캐시 키에 테넌트 프리픽스 추가
- **벡터 저장소**: Qdrant 또는 Redis에서 테넌트별 컬렉션
- **API 권한**: 테넌트의 FinOps 설정만 조회 가능

### 10.2 감사 로깅

```prisma
model FinOpsAuditLog {
  id        String    @id @default(cuid())
  tenantId  String
  userId    String
  action    String    // UPDATE_CONFIG, INVALIDATE_CACHE, SET_EMERGENCY_MODE
  resource  String    // FinOpsConfig, FinOpsAgentConfig, etc.
  resourceId String

  oldValue  Json?
  newValue  Json?

  createdAt DateTime  @default(now())
}
```

### 10.3 정책 준수

- **예산 제어**: Agent 레벨 월간 쿼터 enforced
- **비용 알림**: 쿼터 80%, 90%, 100% 도달 시 알림
- **긴급 모드**: 수동 활성화 또는 쿼터 초과 시 자동 활성화
- **감사 추적**: 모든 설정 변경 기록

---

## 11. 모니터링 및 알림

### 11.1 Prometheus 메트릭

```
# Gate별 성능
finops_gate1_latency_ms (histogram)
finops_gate2_latency_ms (histogram)
finops_gate3_latency_ms (histogram)

# 캐시 효율성
finops_cache_hit_total (counter)
finops_cache_miss_total (counter)
finops_cache_hit_ratio (gauge)

# Router 정확도
finops_router_tier1_total (counter)
finops_router_tier2_total (counter)
finops_router_tier3_total (counter)

# 토큰 및 비용
finops_tokens_saved_total (counter)
finops_cost_saved_usd_total (counter)
finops_actual_cost_usd_total (counter)

# 에이전트별 사용량
finops_agent_tier1_tokens (gauge, per agent)
finops_agent_tier2_tokens (gauge, per agent)
finops_agent_tier3_tokens (gauge, per agent)
finops_agent_cost_usd (gauge, per agent)
```

### 11.2 알림 규칙

```yaml
# Cache Hit Rate 저하
- alert: FinOpsCacheHitRateLow
  expr: finops_cache_hit_ratio < 0.1
  for: 1h
  annotations:
    summary: 'Cache hit rate below 10%'

# 에이전트 비용 쿼터 도달
- alert: FinOpsAgentCostQuotaHigh
  expr: finops_agent_cost_usd / finops_agent_cost_budget > 0.9
  for: 5m
  annotations:
    summary: 'Agent cost quota {{ $value }}% used'

# Router 정확도 저하
- alert: FinOpsRouterAccuracyLow
  expr: (finops_router_tier_mismatch / finops_router_total) > 0.1
  for: 1h
  annotations:
    summary: 'Router accuracy below 90%'

# Gate 응답 시간 증가
- alert: FinOpsGateLatencyHigh
  expr: |
    (finops_gate1_latency_ms +
     finops_gate2_latency_ms +
     finops_gate3_latency_ms) > 500
  for: 5m
  annotations:
    summary: 'FinOps pipeline latency above 500ms'
```

### 11.3 대시보드 (Grafana)

**Finops Overview**:

- 월간 비용 절감 (%)
- Cache hit rate (%)
- 평균 응답 시간 (ms)
- Tier 분포 (pie chart)

**Gate Analytics**:

- Gate 1: Hit rate, avg latency
- Gate 2: Tier distribution, fallback rate
- Gate 3: Token reduction %, quality score

**Agent Performance**:

- 에이전트별 비용 (월간)
- 에이전트별 cache hit rate
- 에이전트별 tier usage

---

## 12. 참고 자료

### 12.1 관련 문서

- `/docs/architecture/` - 전체 시스템 아키텍처
- `/docs/api/` - OpenAPI 스펙
- `/docs/phases/` - 구현 페이즈 상세

### 12.2 외부 라이브러리

- **Embeddings**: `openai` (text-embedding-3-small) 또는 `sentence-transformers`
- **Vector DB**: `redis` (RedisSearch) 또는 `qdrant-client`
- **Token Counting**: `js-tiktoken` (OpenAI) 또는 `anthropic` SDK
- **LLM Calls**: 기존 `openai`, `anthropic` 클라이언트 재사용

### 12.3 성능 벤치마크 (예상)

```
Phase 1 (Mock):
- Gate 1 (no-op): <1ms
- Gate 2 (mock): 1-5ms
- Gate 3 (mock): 1-5ms
- Total overhead: <20ms

Phase 2 (Real Cache):
- Gate 1 (cache lookup): 20-50ms
- Overall throughput: 1000+ req/s

Phase 3 (Real Router):
- Stage 1 (rules): <10ms
- Stage 2 (LLM): 300-800ms (경량 모델)
- Total: <1s (대부분 LLM 호출)

Phase 4 (Real Packer):
- Packing: 50-150ms
- Total pipeline: <2s
```

---

## 13. 다음 단계

1. **Immediate**: Phase 1 시작 (Mock 구현)

   - Prisma 스키마 확장
   - API 스캐폴딩
   - UI 프로토타입

2. **Week 2**: Mock 완성

   - 토큰 로깅 검증
   - 대시보드 통합
   - 내부 테스트

3. **Week 4**: Phase 2 캐시 구현

   - 벡터 저장소 통합
   - Embedding 서비스
   - 성능 프로파일링

4. **Week 7**: Phase 3 Router 구현
   - Rule-based 분류
   - LLM 분류기
   - 비용 최적화 검증

---

**Document Version**: 1.0.0
**Last Updated**: 2026-04-06
**Next Review**: 2026-05-06
