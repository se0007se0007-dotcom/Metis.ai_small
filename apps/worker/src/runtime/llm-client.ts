/**
 * Worker-side LLM client — performs REAL Anthropic / OpenAI calls and returns
 * the response text together with actual token usage so the execution path can
 * record real cost (replacing the previous simulated step timing).
 *
 * Keys are read from the worker process env (ANTHROPIC_API_KEY / OPENAI_API_KEY).
 * If no key is configured the caller is expected to fall back to a deterministic
 * no-op step rather than fabricating telemetry.
 *
 * Zero external dependencies: uses Node 18+ global fetch.
 */

import { estimateTokens, normalizeModelId } from './pricing';

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResult {
  text: string;
  model: string;
  provider: 'anthropic' | 'openai';
  usage: LlmUsage;
  latencyMs: number;
}

export interface LlmCallOptions {
  model: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

export function llmKeysAvailable(): { anthropic: boolean; openai: boolean } {
  return {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
  };
}

function isOpenAIModel(model: string): boolean {
  const m = normalizeModelId(model);
  return m.startsWith('gpt') || m.startsWith('o3') || m.startsWith('o1');
}

/**
 * Lightweight secret redaction before external egress (mirrors the API-side
 * prompt-guard so the worker never leaks sk-/sk-ant-/AKIA/ghp_/xoxb- tokens).
 */
function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]');
}

/**
 * F2-2 (FinOps): build Anthropic message content with a prompt-cache
 * breakpoint when the prompt BEGINS with the (verbatim-repeating) knowledge
 * preamble and the stable prefix is large enough to qualify (≥1024 tokens ≈
 * 4096 chars). Cached reads bill at 10% of input price. Returns the plain
 * string when no qualifying prefix exists. Disable: FINOPS_PROVIDER_CACHE=false.
 */
export function buildAnthropicContent(safePrompt: string): unknown {
  const enabled = (process.env.FINOPS_PROVIDER_CACHE ?? 'true') !== 'false';
  const END_MARKER = '=== 참고 지식 끝 ===';
  if (!enabled || !safePrompt.startsWith('=== 참고 지식')) return safePrompt;
  const markerIdx = safePrompt.indexOf(END_MARKER);
  if (markerIdx <= 0) return safePrompt;
  const splitAt = markerIdx + END_MARKER.length;
  const stablePrefix = safePrompt.slice(0, splitAt);
  if (stablePrefix.length < 4096) return safePrompt;
  return [
    { type: 'text', text: stablePrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: safePrompt.slice(splitAt) || ' ' },
  ];
}

async function callAnthropic(opts: LlmCallOptions): Promise<LlmResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const start = Date.now();
  const modelId = normalizeModelId(opts.model)
    .replace('claude-haiku-4-5', 'claude-haiku-4-5-20251001');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const response = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
        messages: [{ role: 'user', content: buildAnthropicContent(redactSecrets(opts.prompt)) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errBody.slice(0, 300)}`);
    }
    const data = (await response.json()) as any;
    const text = data?.content?.[0]?.text ?? '';
    const promptTokens = data?.usage?.input_tokens ?? estimateTokens(opts.prompt);
    const completionTokens = data?.usage?.output_tokens ?? estimateTokens(text);
    return {
      text,
      model: modelId,
      provider: 'anthropic',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(opts: LlmCallOptions): Promise<LlmResult> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
        messages: [{ role: 'user', content: redactSecrets(opts.prompt) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errBody.slice(0, 300)}`);
    }
    const data = (await response.json()) as any;
    const text = data?.choices?.[0]?.message?.content ?? '';
    const promptTokens = data?.usage?.prompt_tokens ?? estimateTokens(opts.prompt);
    const completionTokens = data?.usage?.completion_tokens ?? estimateTokens(text);
    return {
      text,
      model: opts.model,
      provider: 'openai',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call an LLM with the configured provider; falls back to the other provider
 * if the preferred one has no key. Throws if neither key is available.
 */
export async function callLlm(opts: LlmCallOptions): Promise<LlmResult> {
  const keys = llmKeysAvailable();
  const preferOpenAI = isOpenAIModel(opts.model);

  if (preferOpenAI && keys.openai) return callOpenAI(opts);
  if (!preferOpenAI && keys.anthropic) return callAnthropic(opts);
  // Fallback to whichever key exists.
  if (keys.anthropic) return callAnthropic({ ...opts, model: 'claude-sonnet-4-6' });
  if (keys.openai) return callOpenAI({ ...opts, model: 'gpt-4o' });

  throw new Error('No LLM API key configured (ANTHROPIC_API_KEY / OPENAI_API_KEY).');
}
