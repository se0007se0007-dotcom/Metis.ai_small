/**
 * OpenAI(호환) Planner Adapter — LLM이 사용자 의도를 이해해 워크플로우를 설계한다.
 *
 * 동작:
 *   1) 휴리스틱 어댑터로 baseline(capability 매핑·노드 순서)을 만든다.
 *   2) LLM에게 "사용자 의도 + 사용 가능한 capability 목록"을 주고, 이 업무에
 *      필요한 capability를 골라 순서대로 배열하게 한다(JSON).
 *   3) LLM이 고른 키가 실제 목록에 있으면 그 선택으로 노드를 재구성하고,
 *      비정상/빈 응답이면 baseline으로 안전 폴백한다.
 *
 * 프로바이더: OpenAI 호환 엔드포인트(Azure OpenAI·사내 QWEN 서빙 포함)를
 *   OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_PLANNER_MODEL 로 설정. 호출은
 *   타임아웃(기본 20초)으로 보호되어 네트워크 지연 시 즉시 휴리스틱 폴백.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LLMPlannerAdapter,
  PlannerContext,
  PlannerSuggestion,
} from './planner-adapter.interface';
import { HeuristicPlannerAdapter } from './heuristic-planner-adapter';

const PLANNER_TIMEOUT_MS = 20_000;

@Injectable()
export class OpenAIPlannerAdapter implements LLMPlannerAdapter {
  readonly name = 'openai-planner';
  readonly version = '2.0.0';
  private readonly logger = new Logger(OpenAIPlannerAdapter.name);
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fallback = new HeuristicPlannerAdapter();

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('OPENAI_API_KEY') || undefined;
    this.baseUrl = (
      config.get<string>('OPENAI_BASE_URL') || 'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
    this.model = config.get<string>('OPENAI_PLANNER_MODEL') || 'gpt-5';
  }

  async isHealthy() {
    return !!this.apiKey;
  }

  async suggest(ctx: PlannerContext): Promise<PlannerSuggestion> {
    const baseline = await this.fallback.suggest(ctx);

    if (!this.apiKey) {
      return {
        ...baseline,
        warnings: [...(baseline.warnings ?? []), 'OPENAI_API_KEY 미설정 — heuristic 폴백'],
      };
    }

    try {
      const llm = await this.callLLM(ctx, baseline);

      // LLM이 고른 capability 키 중 실제 목록에 존재하는 것만 채택.
      const valid = new Set(ctx.availableCapabilities.map((c) => c.key));
      const selected = (llm.selectedCapabilityKeys ?? []).filter((k) => valid.has(k));

      if (selected.length === 0) {
        // 유효 선택이 없으면 baseline 유지 (도메인·설명만 보강).
        return {
          ...baseline,
          domain: llm.domain || baseline.domain,
          explanation: llm.explanation || baseline.explanation,
          confidence: Math.min(1, baseline.confidence + 0.1),
        };
      }

      // LLM 선택으로 노드 순서 재구성 (start → capability 노드들 → end).
      const nodeOrder = this.buildNodeOrder(selected, llm.rationales ?? {});
      return {
        domain: llm.domain || baseline.domain,
        selectedCapabilityKeys: selected,
        nodeOrder,
        confidence: Math.min(1, Math.max(baseline.confidence, 0.75) + 0.15),
        explanation:
          llm.explanation ||
          `AI가 "${ctx.intent}" 의도를 분석해 ${selected.length}개 단계로 구성했습니다.`,
        warnings: baseline.warnings,
      };
    } catch (e: any) {
      this.logger.warn(`LLM planning failed, using heuristic: ${e?.message ?? e}`);
      return {
        ...baseline,
        warnings: [...(baseline.warnings ?? []), `LLM planning failed: ${e?.message ?? e}`],
      };
    }
  }

  /** start → 선택 capability 노드 → end 로 직렬 DAG 구성. */
  private buildNodeOrder(
    keys: string[],
    rationales: Record<string, string>,
  ): PlannerSuggestion['nodeOrder'] {
    const order: PlannerSuggestion['nodeOrder'] = [
      { id: 'start', type: 'start' },
    ];
    let prev = 'start';
    keys.forEach((key, i) => {
      const id = `n${i + 1}`;
      order.push({
        id,
        type: 'agent',
        capability: key,
        dependsOn: [prev],
        rationale: rationales[key],
      });
      prev = id;
    });
    order.push({ id: 'end', type: 'end', dependsOn: [prev] });
    return order;
  }

  /**
   * OpenAI 호환 Chat Completions 호출 — 타임아웃 보호.
   * 응답: { domain, selectedCapabilityKeys: string[], rationales?, explanation }
   */
  private async callLLM(
    ctx: PlannerContext,
    baseline: PlannerSuggestion,
  ): Promise<{
    domain: string;
    selectedCapabilityKeys: string[];
    rationales?: Record<string, string>;
    explanation: string;
  }> {
    const catalog = ctx.availableCapabilities
      .slice(0, 120)
      .map((c) => `- ${c.key}: ${(c as any).description ?? (c as any).name ?? ''}`.trim())
      .join('\n');

    const system =
      '당신은 ITO 업무 자동화 워크플로우 설계 어시스턴트입니다. ' +
      '사용자의 자연어 요청을 읽고, 제공된 capability 목록에서 이 업무를 수행하는 데 필요한 ' +
      'capability만 골라 실행 순서대로 배열하세요. 목록에 없는 키는 절대 만들지 마세요. ' +
      '반드시 다음 JSON 형식으로만 답하세요: ' +
      '{ "domain": "ap|risk|ops|deployment|security|general", ' +
      '"selectedCapabilityKeys": ["key1","key2",...], ' +
      '"rationales": { "key1": "왜 필요한지 한 문장" }, ' +
      '"explanation": "전체 흐름 요약 한국어 2~3문장" }';

    const user = JSON.stringify({
      intent: ctx.intent,
      hint_domain: ctx.hints?.domain ?? null,
      heuristic_baseline: baseline.selectedCapabilityKeys,
      available_capabilities: catalog,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLANNER_TIMEOUT_MS);
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`planner LLM ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
      }
      const body: any = await resp.json();
      const content = body?.choices?.[0]?.message?.content;
      if (!content) throw new Error('empty planner response');
      const parsed = JSON.parse(content);
      return {
        domain: String(parsed.domain ?? baseline.domain),
        selectedCapabilityKeys: Array.isArray(parsed.selectedCapabilityKeys)
          ? parsed.selectedCapabilityKeys.map(String)
          : [],
        rationales:
          parsed.rationales && typeof parsed.rationales === 'object'
            ? parsed.rationales
            : undefined,
        explanation: String(parsed.explanation ?? ''),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
