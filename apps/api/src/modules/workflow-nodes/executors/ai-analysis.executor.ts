/**
 * AI Analysis Executor
 *
 * Handles all AI-processing nodes:
 *   - Security inspection (SAST, DAST, SCA, Secret Scan, Pentest)
 *   - Code analysis / review
 *   - Summary generation
 *   - General AI processing
 *
 * Uses real LLM API calls (Anthropic Claude / OpenAI GPT) to perform analysis.
 * Integrates with FinOps 3-Gate pipeline for cost optimization.
 *
 * Registers as connector: metis-ai-analysis
 */
import { Injectable, OnModuleInit, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
} from '../node-executor-registry';
import { TokenOptimizerService } from '../../finops/token-optimizer.service';
import { NodeGovernanceProfilerService } from '../../governance/node-governance-profiler.service';
import { deriveGovernanceParams } from '../governance-params.util';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../../database.module';
import { KnowledgeRetrievalService } from '../../knowledge/knowledge-retrieval.service';
import { redactSecrets } from '../../evaluator/prompt-guard';

// Security scan prompt templates
const SCAN_PROMPTS: Record<string, string> = {
  sast: `당신은 숙련된 보안 엔지니어입니다. 다음 소스 코드를 정적 분석(SAST) 관점에서 검사하세요.

점검 항목:
- SQL Injection, XSS, CSRF 취약점
- 버퍼 오버플로우 / 메모리 안전성
- 인증/인가 우회 가능성
- 입력값 검증 미비
- 안전하지 않은 역직렬화
- 경로 탐색 취약점
- 기타 OWASP Top 10 항목

각 발견된 취약점에 대해:
1. 위험도 (CRITICAL / HIGH / MEDIUM / LOW / INFO)
2. 취약점 유형 (CWE 번호 포함)
3. 해당 파일명과 라인 번호 (가능한 경우)
4. 상세 설명
5. 권고 수정사항 (코드 예시 포함)

결과를 구조화된 형태로 정리하세요.`,

  secrets: `당신은 보안 전문가입니다. 다음 소스 코드에서 하드코딩된 비밀 정보를 찾으세요.

점검 대상:
- API 키 (AWS, GCP, Azure, 각종 서비스)
- 데이터베이스 비밀번호 / 연결 문자열
- JWT 시크릿 / 토큰
- SSH 키 / 인증서
- OAuth 클라이언트 시크릿
- 환경변수에 있어야 할 설정값
- .env 파일 내용이 코드에 포함된 경우

각 발견된 시크릿에 대해:
1. 위험도
2. 파일명과 라인 번호
3. 시크릿 유형
4. 수정 방법 (환경변수 전환 등)`,

  pentest: `당신은 침투 테스트 전문가입니다. 다음 소스 코드를 분석하여 모의해킹 관점에서 공격 가능한 취약점을 식별하세요.

분석 관점:
- 인증 우회 경로
- 권한 상승 가능성
- API 엔드포인트 악용 시나리오
- 세션 하이재킹 가능성
- 파일 업로드 취약점 악용
- SSRF / IDOR 공격 벡터
- Rate limiting 미비

각 공격 벡터에 대해:
1. 공격 시나리오 설명
2. 영향 범위 및 위험도
3. 실제 익스플로잇 가능성 평가
4. 방어 방안`,

  sca: `당신은 소프트웨어 구성 분석(SCA) 전문가입니다. 다음 코드의 의존성을 분석하세요.

점검 항목:
- package.json, requirements.txt, pom.xml 등의 의존성 파일 분석
- 알려진 CVE가 있는 패키지 식별
- 오래된 / 유지보수 중단된 의존성
- 라이선스 호환성 문제

결과를 구조화된 형태로 정리하세요.`,

  license: `소스 코드와 의존성 파일을 분석하여 오픈소스 라이선스 규정 준수 여부를 점검하세요.

점검 항목:
- 사용된 오픈소스 라이선스 목록
- GPL 등 카피레프트 라이선스 감염 여부
- 라이선스 충돌 가능성
- 라이선스 고지 누락 여부
- 상업적 사용 제한 라이선스`,
};

const SUMMARY_PROMPTS: Record<string, string> = {
  executive: `이전 단계의 분석 결과를 경영진 보고용으로 요약하세요.

포함 사항:
- 핵심 결론 (1-2문장)
- 주요 발견 사항 (상위 5개)
- 위험 수준 종합 평가
- 즉시 조치 필요 항목
- 권고 사항

비기술적인 용어로 간결하게 작성하세요.`,

  technical: `이전 단계의 분석 결과를 기술팀 대상으로 상세하게 정리하세요.

포함 사항:
- 발견된 모든 이슈 상세 목록
- 각 이슈의 기술적 설명, 코드 참조
- 심각도별 분류
- 구체적인 수정 방안 (코드 스니펫 포함)
- 우선순위 기반 수정 로드맵`,

  bullet: `이전 단계의 분석 결과를 핵심 요점 위주로 정리하세요.

형식:
- 불릿포인트로 간결하게
- 각 항목은 1-2줄 이내
- 심각도 표시 포함
- 중요한 것부터 순서대로`,

  narrative: `이전 단계의 분석 결과를 서술형 리포트로 작성하세요.

구조:
1. 개요 및 배경
2. 분석 방법론
3. 주요 발견 사항
4. 상세 분석 결과
5. 결론 및 권고사항

전체 맥락이 자연스럽게 전달되도록 서술형으로 작성하세요.`,
};

@Injectable()
export class AIAnalysisExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'ai-analysis';
  readonly displayName = 'AI 분석 / 보안 점검';
  readonly handledNodeTypes = ['ai-processing'];
  readonly handledCategories = ['inspection', 'analysis', 'summarize'];

  private readonly logger = new Logger(AIAnalysisExecutor.name);
  private anthropicApiKey: string | undefined;
  private openaiApiKey: string | undefined;
  private anthropicBaseUrl = 'https://api.anthropic.com';
  private openaiBaseUrl = 'https://api.openai.com/v1';

  /** Current execution context — set per execute() call for callLLM() to reference */
  private currentInput: NodeExecutionInput | null = null;

  /** Artifact ids retrieved for the current LLM call (for usage recording). */
  private lastRetrievedArtifactIds: string[] = [];

  constructor(
    private readonly registry: NodeExecutorRegistry,
    private readonly config: ConfigService,
    @Optional() private readonly tokenOptimizer?: TokenOptimizerService,
    @Optional() @Inject(PRISMA_TOKEN) private readonly prisma?: PrismaClient,
    @Optional() private readonly knowledgeRetrieval?: KnowledgeRetrievalService,
    @Optional() private readonly governanceProfiler?: NodeGovernanceProfilerService,
  ) {
    this.anthropicApiKey = this.config.get('ANTHROPIC_API_KEY');
    this.openaiApiKey = this.config.get('OPENAI_API_KEY');
    this.anthropicBaseUrl = (this.config.get<string>('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.openaiBaseUrl = (this.config.get<string>('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  onModuleInit() {
    this.registry.register(this);
    // Log API key availability (not the key itself)
    const anthKey = this.anthropicApiKey;
    const oaiKey = this.openaiApiKey;
    this.logger.log(
      `API Keys: Anthropic=${anthKey ? `...${anthKey.slice(-6)}` : 'NOT SET'}, ` +
        `OpenAI=${oaiKey ? `...${oaiKey.slice(-6)}` : 'NOT SET'}`,
    );
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;
    const category = settings.stepCategory || 'analysis';

    // Store execution context for FinOps integration in callLLM()
    this.currentInput = input;

    try {
      let result: string;

      if (category === 'inspection' || category === 'analysis') {
        result = await this.executeInspection(input);
      } else if (category === 'summarize') {
        result = await this.executeSummary(input);
      } else {
        result = await this.executeGeneral(input);
      }

      const output: NodeExecutionOutput = {
        success: true,
        data: {
          category,
          model: settings.model || 'claude-sonnet-4.6',
          analysisType: settings.analysisType || category,
          resultLength: result.length,
          finopsEnabled: !!this.tokenOptimizer,
        },
        outputText: result,
        durationMs: Date.now() - start,
      };

      // NOTE: 노드 평가(4게이트)는 PipelineEngine 루프가 모든 노드에 일괄 호출한다
      // (pipeline-engine.ts). 실행기에서 중복 평가하지 않는다.

      // ── 효과성 신호(MEASURED) 발신 계약 ──
      // 이 실행기가 구조화된 테스트/품질 결과를 보유하게 되면, PipelineEngine 의
      // EffectivenessSignal 자동 훅이 수집하도록 아래 형태로 첨부한다:
      //   output.data.effectivenessSignal =
      //     { kind: 'COVERAGE', testsTotal, testsPassed, coveragePct };
      // (탐지 지연을 측정하는 경우)
      //   output.data.effectivenessSignal =
      //     { kind: 'DETECTION', occurredAt, detectedAt };
      // 현재 점검 결과는 자유 텍스트(LLM 출력)라 구조화 수치가 없으므로,
      // 실측 커버리지는 seed + POST /metrics/effectiveness-signal API 로 적재한다.
      // (런타임에 가짜 수치를 만들지 않는다.)

      return output;
    } catch (err) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  private async executeInspection(input: NodeExecutionInput): Promise<string> {
    const settings = input.settings;
    const scanners: string[] = settings.scanners || ['sast', 'secrets'];
    const minSeverity = settings.minSeverity || 'low';
    const customRules = settings.customRules || '';
    const sourceCode = input.previousOutput;

    if (!sourceCode || sourceCode.length < 50) {
      throw new Error('분석할 소스 코드가 없습니다. 이전 노드에서 소스를 로딩해주세요.');
    }

    const allResults: string[] = [];

    for (const scanner of scanners) {
      const scanPrompt = SCAN_PROMPTS[scanner];
      if (!scanPrompt) continue;

      const fullPrompt = `${scanPrompt}

${customRules ? `추가 점검 규칙:\n${customRules}\n\n` : ''}최소 리포트 등급: ${minSeverity.toUpperCase()}
(이 등급 미만의 발견은 생략하세요)

=== 분석 대상 소스 코드 ===
${sourceCode.slice(0, 150000)}`;

      this.logger.log(
        `Running ${scanner.toUpperCase()} scan with ${settings.model || 'claude-sonnet-4.6'}`,
      );

      const result = await this.callLLM(
        fullPrompt,
        settings.model || 'claude-sonnet-4.6',
        settings.maxTokens || 4000,
        settings.temperature ?? 0.3,
      );

      allResults.push(
        `\n${'='.repeat(60)}\n${scanner.toUpperCase()} 점검 결과\n${'='.repeat(60)}\n\n${result}`,
      );
    }

    return allResults.join('\n\n');
  }

  private async executeSummary(input: NodeExecutionInput): Promise<string> {
    const settings = input.settings;
    const style = settings.summaryStyle || 'technical';
    const focusAreas = settings.focusAreas || '';
    const maxLength = settings.maxLength || 'medium';
    const previousOutput = input.previousOutput;

    if (!previousOutput || previousOutput.length < 20) {
      throw new Error('정리할 데이터가 없습니다. 이전 노드의 결과를 확인해주세요.');
    }

    const stylePrompt = SUMMARY_PROMPTS[style] || SUMMARY_PROMPTS.technical;
    const lengthGuide: Record<string, string> = {
      short: '500자 이내로 간결하게',
      medium: '1000-1500자 수준으로',
      long: '2000-3000자 수준으로 상세하게',
      unlimited: '필요한 만큼 충분히 상세하게',
    };

    const fullPrompt = `${stylePrompt}

${focusAreas ? `특별 집중 영역: ${focusAreas}\n` : ''}분량: ${lengthGuide[maxLength] || lengthGuide.medium}
출력 언어: ${settings.outputLanguage === 'en' ? 'English' : '한국어'}

=== 이전 단계 분석 결과 ===
${previousOutput.slice(0, 150000)}`;

    return this.callLLM(
      fullPrompt,
      settings.model || 'claude-sonnet-4.6',
      settings.maxTokens || 4000,
      settings.temperature ?? 0.5,
    );
  }

  private async executeGeneral(input: NodeExecutionInput): Promise<string> {
    const settings = input.settings;
    let prompt = settings.promptTemplate || '';

    // Replace template variables
    prompt = prompt
      .replace(/\{\{이전 노드 결과\}\}/g, input.previousOutput || '(이전 노드 결과 없음)')
      .replace(/\{\{검색 결과\}\}/g, input.previousOutput || '')
      .replace(/\{\{파일 내용\}\}/g, input.previousOutput || '');

    if (!prompt || prompt.length < 5) {
      prompt = `다음 데이터를 분석하고 결과를 정리하세요:\n\n${input.previousOutput || '(데이터 없음)'}`;
    }

    return this.callLLM(
      prompt,
      settings.model || 'claude-sonnet-4.6',
      settings.maxTokens || 2000,
      settings.temperature ?? 0.7,
    );
  }

  /**
   * Scenario 1 (Part B) — FEEDBACK / read-back of captured knowledge.
   *
   * Retrieves the top relevant OPEN ErrorPattern rows for the current workflow
   * and renders them as a "과거 발견된 오류/주의사항" preamble that is prepended
   * to the LLM prompt, so the agent actively avoids repeating known errors.
   *
   * This is the half of the loop that READS knowledge back into agent behavior.
   * Best-effort: if Prisma is unavailable, none exist, or the query fails, it
   * returns an empty string and the run proceeds normally.
   */
  private async buildKnowledgeContext(): Promise<string> {
    this.lastRetrievedArtifactIds = [];
    if (!this.currentInput) return '';
    const tenantId = this.currentInput.tenantId;
    const workflowKey =
      (this.currentInput as any).workflowKey ||
      (this.currentInput.settings && (this.currentInput.settings as any).workflowKey) ||
      undefined;
    const category =
      (this.currentInput.settings && (this.currentInput.settings as any).stepCategory) || undefined;

    // ── Preferred path: full Operational Knowledge retrieval (artifacts + errors) ──
    if (this.knowledgeRetrieval) {
      try {
        const retrieved = await this.knowledgeRetrieval.getRelevant(tenantId, {
          workflowKey,
          category,
          limit: 5,
        });
        this.lastRetrievedArtifactIds = (retrieved.artifacts || [])
          .map((a: any) => a?.id)
          .filter(Boolean);
        const rendered = this.knowledgeRetrieval.renderForPrompt(retrieved);
        if (rendered) {
          this.logger.log(
            `[Knowledge] Injecting ${retrieved.artifacts.length} artifact(s) + ` +
              `${retrieved.errorPatterns.length} error pattern(s) (tenant=${tenantId})`,
          );
        }
        return rendered;
      } catch (err) {
        this.logger.warn(`[Knowledge] retrieval failed, falling back: ${(err as Error).message}`);
      }
    }

    // ── Fallback: legacy ErrorPattern-only read-back (when retrieval unavailable) ──
    if (!this.prisma) return '';
    try {
      const where: any = { tenantId, status: 'OPEN' };
      if (workflowKey) where.workflowKey = workflowKey;

      let patterns = await (this.prisma as any).errorPattern.findMany({
        where,
        orderBy: { occurrences: 'desc' },
        take: 3,
      });

      if ((!patterns || patterns.length === 0) && workflowKey) {
        patterns = await (this.prisma as any).errorPattern.findMany({
          where: { tenantId, status: 'OPEN' },
          orderBy: { occurrences: 'desc' },
          take: 3,
        });
      }

      if (!patterns || patterns.length === 0) return '';

      const lines = patterns.map((p: any, idx: number) => {
        const sev = (p.severity || 'warning').toUpperCase();
        const cat = p.category || 'execution';
        const occ = p.occurrences ?? 1;
        const sample = (p.sampleMessage || '').slice(0, 180);
        const rec = p.recommendation ? `\n   권고: ${p.recommendation}` : '';
        return `${idx + 1}. [${sev}/${cat}] (발생 ${occ}회) ${sample}${rec}`;
      });

      return (
        `=== 과거 발견된 오류/주의사항 (반복하지 마세요) ===\n` +
        `아래는 이 워크플로우/테넌트에서 과거에 반복적으로 발견된 문제입니다.\n` +
        `동일한 오류를 재발시키지 말고, 분석/응답 시 아래 사항을 반드시 고려하세요.\n\n` +
        lines.join('\n') +
        `\n=== 주의사항 끝 ===\n\n`
      );
    } catch (err) {
      this.logger.warn(`[Feedback] Knowledge read-back skipped: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * Record that the retrieved knowledge artifacts were actually consumed by this
   * LLM call. Best-effort — never blocks or throws.
   */
  private async recordKnowledgeUsage(): Promise<void> {
    if (!this.knowledgeRetrieval || !this.currentInput) return;
    if (!this.lastRetrievedArtifactIds || this.lastRetrievedArtifactIds.length === 0) return;
    try {
      const workflowKey =
        (this.currentInput as any).workflowKey ||
        (this.currentInput.settings && (this.currentInput.settings as any).workflowKey) ||
        undefined;
      await this.knowledgeRetrieval.recordUsage(
        this.currentInput.tenantId,
        this.lastRetrievedArtifactIds,
        {
          workflowKey,
          executionSessionId: this.currentInput.executionSessionId,
          stepKey: this.currentInput.nodeId,
          agentName: this.displayName,
        },
      );
    } catch (err) {
      this.logger.warn(`[Knowledge] recordUsage skipped: ${(err as Error).message}`);
    }
  }
  /**
   * G6a: returns true if the tenant has disabled external LLM calls. Best-effort:
   * if Prisma is unavailable or the lookup fails, defaults to FALSE (enabled) so
   * existing behavior is preserved and the pipeline never breaks.
   */
  private async isExternalLlmDisabled(tenantId: string): Promise<boolean> {
    if (!this.prisma || !tenantId) return false;
    try {
      const tenant = await (this.prisma as any).tenant.findUnique({
        where: { id: tenantId },
        select: { externalLlmDisabled: true },
      });
      return tenant?.externalLlmDisabled === true;
    } catch (err) {
      this.logger.warn(
        `[Governance] externalLlmDisabled lookup failed (default enabled): ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Call LLM API (Anthropic Claude or OpenAI GPT)
   *
   * ── FinOps 3-Gate Integration ──
   * Before the actual LLM call, this method routes through the FinOps
   * TokenOptimizerService (if available) which applies:
   *   Gate 1: Semantic Cache — returns cached response if similar prompt was seen
   *   Gate 2: Model Router  — selects optimal model tier based on complexity
   *   Gate 3: Skill Packer  — compresses/optimizes the prompt tokens
   *
   * Auto-fallback: if primary API fails (credit exhausted, rate limit, etc.),
   * tries the other provider.
   */
  private async callLLM(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number,
  ): Promise<string> {
    // ════════════════════════════════════════════════
    // G6a: per-tenant governance — if this tenant disabled external LLM calls,
    // do NOT egress to any provider. Return a deterministic local fallback so
    // the workflow continues without breaking the pipeline.
    // ════════════════════════════════════════════════
    const tenantId = this.currentInput?.tenantId;
    if (tenantId && (await this.isExternalLlmDisabled(tenantId))) {
      this.logger.warn(
        `[Governance] External LLM disabled by tenant policy (tenant=${tenantId}) — ` +
          `returning local fallback result instead of calling ${model}.`,
      );
      return (
        `[외부 LLM 호출이 테넌트 정책에 의해 비활성화되었습니다]\n\n` +
        `이 단계(${model})는 외부 LLM API를 호출하지 않고 로컬 폴백 결과를 반환했습니다.\n` +
        `외부 LLM 사용을 허용하려면 테넌트 관리자가 설정에서 externalLlmDisabled 플래그를 해제하세요.`
      );
    }

    // ════════════════════════════════════════════════
    // Scenario 1 (Part B): FEEDBACK — prepend known-error knowledge
    // so the agent avoids repeating past mistakes. Best-effort.
    // ════════════════════════════════════════════════
    try {
      const knowledgeContext = await this.buildKnowledgeContext();
      if (knowledgeContext) {
        // F2 (security): the trusted instruction/system template MUST come FIRST,
        // then the (delimited, untrusted) knowledge reference block AFTER it — so
        // injected content cannot override the instructions that precede it.
        prompt = `${prompt}\n\n${knowledgeContext}`;
        // Record that the retrieved artifacts were consumed (best-effort).
        void this.recordKnowledgeUsage();
      }
    } catch {
      /* read-back failure must never block the LLM call */
    }

    // ════════════════════════════════════════════════
    // FinOps 3-Gate Optimization Pass
    // ════════════════════════════════════════════════
    let optimizedModel = model;
    let effectivePrompt = prompt;

    if (this.tokenOptimizer && this.currentInput) {
      try {
        const agentName = `ai-analysis-${this.currentInput.settings.stepCategory || 'general'}`;
        const optimResult = await this.tokenOptimizer.optimize({
          tenantId: this.currentInput.tenantId,
          agentName,
          executionSessionId: this.currentInput.executionSessionId,
          nodeId: this.currentInput.nodeId,
          prompt,
          requestedModel: model,
          // 점검 H-1: pass governance context so policy-aware cache/router applies
          ...deriveGovernanceParams(this.governanceProfiler, this.currentInput, agentName),
        });

        this.logger.log(
          `[FinOps] Optimization: cacheHit=${optimResult.cacheHit}, ` +
            `routedModel=${optimResult.routedModel}, ` +
            `costReduction=${optimResult.estimatedCostReduction}%, ` +
            `gates=[${optimResult.optimizationApplied.join(',')}]`,
        );

        // F2-1: budget BLOCK — the optimizer says this call must not happen.
        if (optimResult.blocked) {
          throw new Error(
            `[FinOps] 예산 한도 초과로 LLM 호출이 차단되었습니다.\n` +
              `${optimResult.budgetEnforcement?.reason ?? ''}\n` +
              `FinOps 설정에서 일일 한도를 조정하거나 내일 다시 시도하세요.`,
          );
        }

        // Gate 1: If cache hit, return cached response — skip LLM call entirely
        if (optimResult.cacheHit && optimResult.cachedResponse) {
          this.logger.log('[FinOps] Cache HIT — skipping LLM call');
          return optimResult.cachedResponse;
        }

        // Gate 2: Use the routed model from the optimizer
        if (optimResult.routedModel) {
          optimizedModel = optimResult.routedModel;
        }

        // Gate 3 (F1-1): actually USE the compressed prompt for the real call.
        if (optimResult.optimizedPrompt) {
          effectivePrompt = optimResult.optimizedPrompt;
        }
      } catch (finopsErr) {
        // Budget blocks must propagate; other FinOps failures degrade gracefully.
        if ((finopsErr as Error).message?.includes('[FinOps] 예산 한도 초과')) {
          throw finopsErr;
        }
        this.logger.warn(
          `[FinOps] Optimization failed, proceeding with original model: ${(finopsErr as Error).message}`,
        );
      }
    }

    // ════════════════════════════════════════════════
    // Actual LLM API Call (with optimized model)
    // ════════════════════════════════════════════════
    const isAnthropicModel =
      optimizedModel.startsWith('claude') || optimizedModel.startsWith('anthropic');
    const isOpenAIModel =
      optimizedModel.startsWith('gpt') ||
      optimizedModel.startsWith('o3') ||
      optimizedModel.startsWith('o1');

    // Try primary API (with the FinOps-compressed prompt when available)
    try {
      if (isOpenAIModel) {
        return await this.callOpenAI(effectivePrompt, optimizedModel, maxTokens, temperature);
      }
      // Default: try Anthropic first
      if (this.anthropicApiKey) {
        return await this.callAnthropic(
          effectivePrompt,
          isAnthropicModel ? optimizedModel : 'claude-sonnet-4-6',
          maxTokens,
          temperature,
        );
      }
    } catch (primaryErr) {
      const errMsg = (primaryErr as Error).message || '';
      this.logger.warn(`Primary LLM API failed: ${errMsg.slice(0, 200)}`);

      // Check if it's a retryable error (credit, rate limit, etc.) — try fallback
      const isRetryable = /credit|balance|quota|rate.?limit|429|402|400|503/i.test(errMsg);
      if (!isRetryable) throw primaryErr;

      this.logger.log('Attempting fallback to alternate LLM provider...');
    }

    // Fallback: try the other provider
    try {
      if (!isOpenAIModel && this.openaiApiKey) {
        this.logger.log('Falling back to OpenAI GPT-4o...');
        return await this.callOpenAI(effectivePrompt, 'gpt-4o', maxTokens, temperature);
      }
      if (isOpenAIModel && this.anthropicApiKey) {
        this.logger.log('Falling back to Anthropic Claude...');
        return await this.callAnthropic(effectivePrompt, 'claude-sonnet-4-6', maxTokens, temperature);
      }
    } catch (fallbackErr) {
      this.logger.error(
        `Fallback LLM API also failed: ${(fallbackErr as Error).message?.slice(0, 200)}`,
      );
      throw new Error(
        `모든 AI API 호출이 실패했습니다.\n` +
          `1차 시도: ${isOpenAIModel ? 'OpenAI' : 'Anthropic'} — 실패\n` +
          `2차 시도: ${isOpenAIModel ? 'Anthropic' : 'OpenAI'} — 실패\n\n` +
          `API 키와 크레딧 잔액을 확인하세요.\n` +
          `- Anthropic: https://console.anthropic.com/settings/billing\n` +
          `- OpenAI: https://platform.openai.com/account/billing`,
      );
    }

    // No fallback API key available
    throw new Error(
      `AI API 호출 실패. 대체 API 키가 설정되지 않았습니다.\n` +
        `현재 설정: Anthropic=${this.anthropicApiKey ? '있음' : '없음'}, OpenAI=${this.openaiApiKey ? '있음' : '없음'}\n` +
        `.env 파일에서 ANTHROPIC_API_KEY 또는 OPENAI_API_KEY를 확인하세요.`,
    );
  }

  private async callAnthropic(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number,
  ): Promise<string> {
    if (!this.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다. 환경변수를 확인하세요.');
    }

    // Normalize model name
    const modelId = model
      .replace('claude-opus-4.6', 'claude-opus-4-6')
      .replace('claude-sonnet-4.6', 'claude-sonnet-4-6')
      .replace('claude-haiku-4.5', 'claude-haiku-4-5-20251001');

    // F5 (security): redact obvious secrets before external egress.
    const safePrompt = redactSecrets(prompt);

    // F2-2 (FinOps): Anthropic prompt-caching auto-injection.
    // When the prompt carries a stable prefix (the knowledge preamble repeats
    // verbatim across calls) and that prefix is large enough to qualify
    // (≥1024 tokens ≈ 4096 chars), split it into its own content block marked
    // cache_control:ephemeral — cached reads are billed at 10% of input price.
    // Disable with FINOPS_PROVIDER_CACHE=false.
    // NOTE: only a prompt that BEGINS with the knowledge preamble has a stable
    // prefix worth caching (the preamble repeats verbatim across calls). When
    // the preamble is appended at the end (this executor's default), a
    // breakpoint would cache the variable part too — wasted cache writes — so
    // we require the marker at position 0.
    const providerCacheEnabled = (process.env.FINOPS_PROVIDER_CACHE ?? 'true') !== 'false';
    const PREAMBLE_END_MARKER = '=== 참고 지식 끝 ===';
    let content: unknown = safePrompt;
    if (providerCacheEnabled && safePrompt.startsWith('=== 참고 지식')) {
      const markerIdx = safePrompt.indexOf(PREAMBLE_END_MARKER);
      if (markerIdx > 0) {
        const splitAt = markerIdx + PREAMBLE_END_MARKER.length;
        const stablePrefix = safePrompt.slice(0, splitAt);
        const variableRest = safePrompt.slice(splitAt) || ' ';
        if (stablePrefix.length >= 4096) {
          content = [
            { type: 'text', text: stablePrefix, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: variableRest },
          ];
          this.logger.debug(
            `[FinOps] Anthropic prompt-cache breakpoint injected (prefix ${stablePrefix.length} chars)`,
          );
        }
      }
    }

    // FinOps 비용 귀속: ANTHROPIC_BASE_URL 이 게이트웨이(:8400)면 X-Metis-* 헤더로
    // claude 호출의 비용/절감도 run_id(=executionSessionId)·agent 에 귀속된다.
    // 네이티브 Anthropic API 로 직접 갈 때는 무시되는 무해한 헤더다.
    const attribution: Record<string, string> = {};
    if (this.currentInput) {
      const agentName = `ai-analysis-${this.currentInput.settings.stepCategory || 'general'}`;
      if (this.currentInput.executionSessionId)
        attribution['x-metis-run-id'] = this.currentInput.executionSessionId;
      attribution['x-metis-agent'] = agentName;
      if (this.currentInput.tenantId) attribution['x-metis-tenant'] = this.currentInput.tenantId;
      // 노드 테스트 호출은 원장 비용 기록에서 제외(게이트웨이가 env=test 면 ingest 스킵).
      if (this.currentInput.isTest) attribution['x-metis-env'] = 'test';
    }

    const response = await fetch(`${this.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        ...attribution,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Anthropic API 오류 (${response.status}): ${errBody.slice(0, 500)}`);
    }

    const data = (await response.json()) as any;
    return data.content?.[0]?.text || '';
  }

  private async callOpenAI(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number,
  ): Promise<string> {
    if (!this.openaiApiKey) {
      throw new Error('OPENAI_API_KEY가 설정되지 않았습니다. 환경변수를 확인하세요.');
    }

    // F5 (security): redact obvious secrets before external egress.
    const safePrompt = redactSecrets(prompt);

    // FinOps 비용 귀속: OPENAI_BASE_URL 이 게이트웨이(:8400)면 X-Metis-* 헤더로
    // 이 호출의 비용/절감을 run_id(=executionSessionId)·agent 에 귀속시킨다.
    // 평가기의 품질 보고도 동일 run_id 를 쓰므로 한 run 에서 비용+품질이 합쳐진다.
    // 게이트웨이를 경유하지 않으면 무시되는 무해한 헤더다.
    const attribution: Record<string, string> = {};
    if (this.currentInput) {
      const agentName = `ai-analysis-${this.currentInput.settings.stepCategory || 'general'}`;
      if (this.currentInput.executionSessionId)
        attribution['x-metis-run-id'] = this.currentInput.executionSessionId;
      attribution['x-metis-agent'] = agentName;
      if (this.currentInput.tenantId) attribution['x-metis-tenant'] = this.currentInput.tenantId;
      // 노드 테스트 호출은 원장 비용 기록에서 제외(게이트웨이가 env=test 면 ingest 스킵).
      if (this.currentInput.isTest) attribution['x-metis-env'] = 'test';
    }

    const response = await fetch(`${this.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.openaiApiKey}`,
        ...attribution,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: safePrompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenAI API 오류 (${response.status}): ${errBody.slice(0, 500)}`);
    }

    const data = (await response.json()) as any;
    return data.choices?.[0]?.message?.content || '';
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-ai-analysis',
      name: 'AI 분석 / 보안 점검',
      type: 'BUILT_IN',
      description:
        'AI를 활용한 코드 분석, 보안 취약점 점검, 요약 정리를 수행합니다. SAST, Secret Scan, 모의해킹 시뮬레이션을 지원합니다.',
      category: 'analysis',
      inputSchema: {
        scanners: {
          type: 'array',
          description: '사용할 스캐너 목록 (sast, secrets, pentest, sca, license)',
        },
        model: { type: 'string', description: 'AI 모델' },
        minSeverity: { type: 'string', description: '최소 리포트 등급' },
        sourceCode: { type: 'string', description: '분석 대상 소스 코드 (이전 노드에서 전달)' },
      },
      outputSchema: {
        analysisResult: { type: 'string', description: '분석 결과 텍스트' },
        vulnerabilities: { type: 'array', description: '발견된 취약점 목록' },
      },
      capabilities: [
        'sast',
        'dast',
        'sca',
        'secret-scan',
        'pentest',
        'license-check',
        'code-review',
        'summarize',
      ],
    };
  }
}
