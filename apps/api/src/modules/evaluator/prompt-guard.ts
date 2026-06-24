/**
 * Prompt Guard — shared pure security helpers (no Nest / no DB).
 *
 * Centralizes the prompt-injection detection regex list and a secret-redaction
 * helper so they can be reused by:
 *   - security-evaluator.ts        (input scanning)
 *   - knowledge-retrieval.service  (quarantine injected knowledge)
 *   - knowledge-capture.service    (quarantine captured knowledge)
 *   - ai-analysis.executor.ts      (egress redaction)
 *   - llm-judge.ts                 (egress redaction)
 *
 * Pure functions only — fully unit-testable and mirrored in
 * scripts/test-prompt-guard.mjs.
 *
 * @module evaluator/prompt-guard
 */

/**
 * Prompt-injection / jailbreak patterns. Multilingual (English + Korean) plus
 * delimiter-breakout and self-scoring-manipulation vectors. Kept as a flat list
 * so both the Nest SecurityEvaluator and the pure quarantine path share ONE
 * source of truth.
 */
export const PROMPT_INJECTION_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  // ── English: instruction override ──
  {
    pattern: /ignore\s+(the\s+)?(previous|above|prior|all)/i,
    label: 'ignore previous/above',
  },
  {
    pattern: /disregard\s+(the\s+)?(previous|above|prior|all)/i,
    label: 'disregard previous',
  },
  {
    pattern: /forget\s+(your|the|all|everything)/i,
    label: 'forget your instructions',
  },
  { pattern: /new\s+instructions/i, label: 'new instructions override' },
  { pattern: /you\s+are\s+now/i, label: 'role reassignment (you are now)' },
  { pattern: /act\s+as\b/i, label: 'act as (role hijack)' },
  { pattern: /system\s+prompt/i, label: 'system prompt reference' },
  { pattern: /developer\s+mode/i, label: 'developer mode' },
  { pattern: /\bDAN\b/, label: 'DAN jailbreak' },
  { pattern: /jailbreak/i, label: 'jailbreak attempt' },
  { pattern: /output\s+verbatim/i, label: 'output verbatim' },
  { pattern: /mark\s+(this\s+)?as\s+safe/i, label: 'mark as safe' },
  { pattern: /rate\s+this\s+5/i, label: 'rate this 5 (score manipulation)' },
  {
    pattern: /score\s+(this\s+)?(a\s+)?5/i,
    label: 'score this 5 (score manipulation)',
  },
  // ── Korean: instruction override ──
  {
    pattern: /이전\s*지시\s*무시/,
    label: 'ignore previous (KO: 이전 지시 무시)',
  },
  {
    pattern: /(위|앞)\s*(의|에)?\s*내용\s*무시/,
    label: 'ignore above (KO: 위/앞 내용 무시)',
  },
  {
    pattern: /시스템\s*프롬프트/,
    label: 'system prompt (KO: 시스템 프롬프트)',
  },
  { pattern: /너는\s*이제/, label: 'role reassignment (KO: 너는 이제)' },
  { pattern: /역할을\s*잊어/, label: 'forget role (KO: 역할을 잊어)' },
  { pattern: /규칙\s*무시/, label: 'ignore rules (KO: 규칙 무시)' },
  { pattern: /무조건\s*승인/, label: 'force approve (KO: 무조건 승인)' },
  { pattern: /모두\s*안전/, label: 'mark all safe (KO: 모두 안전)' },
  { pattern: /점수를?\s*5/, label: 'score 5 (KO: 점수를 5)' },
  // ── Delimiter-breakout tokens ──
  { pattern: /<\/system>/i, label: 'delimiter breakout (</system>)' },
  { pattern: /\[\/?INST\]/i, label: 'delimiter breakout ([INST])' },
  { pattern: /<<<+/, label: 'delimiter breakout (<<<)' },
  { pattern: /"""/, label: 'delimiter breakout (""")' },
];

/**
 * Pure injection scan. Returns the labels of any matched patterns.
 * Empty array means "no injection detected".
 */
export function detectPromptInjection(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const { pattern, label } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}

/** Convenience boolean wrapper around {@link detectPromptInjection}. */
export function hasPromptInjection(text: string): boolean {
  return detectPromptInjection(text).length > 0;
}

// ── Secret redaction (egress safety, F5) ──

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]{10,}/g, // Anthropic (check before generic sk-)
  /sk-[a-zA-Z0-9_-]{20,}/g, // OpenAI
  /AKIA[A-Z0-9]{16}/g, // AWS access key id
  /ghp_[a-zA-Z0-9]{30,}/g, // GitHub PAT
  /xoxb-[a-zA-Z0-9-]{10,}/g, // Slack bot token
];

// Long high-entropy token: >=32 chars mixing letters+digits (likely a secret).
const HIGH_ENTROPY_TOKEN =
  /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}\b/g;

/**
 * Redact obvious secrets from text before it is sent to an external LLM API.
 * Replaces known key formats and long high-entropy tokens with [REDACTED].
 * Source-code analysis still works; only secret-looking substrings are masked.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(HIGH_ENTROPY_TOKEN, '[REDACTED]');
  return out;
}
