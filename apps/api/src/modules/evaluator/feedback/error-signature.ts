/**
 * Error Signature — Pure Knowledge-ification Helpers (Scenario 1, Part A)
 *
 * Pure, dependency-free functions that turn an execution error / evaluation
 * problem into:
 *   1. a STABLE dedup `signature` — so the same kind of failure observed many
 *      times collapses into a single ErrorPattern row (occurrences++), and
 *   2. a `classify()` mapping that derives {category, severity, recommendation}
 *      from an evaluation/step outcome.
 *
 * NO NestJS / Prisma imports — fully unit-testable in isolation.
 *
 * Design goals for the signature:
 *   - Two errors that differ ONLY by ids / numbers / uuids / timestamps / hex
 *     / paths produce the SAME signature (dedup stability).
 *   - Case-insensitive, whitespace-collapsed, length-bounded.
 *   - Shape: `${category}:${workflowKey}:${stepKey}:${normalizedMessage}`
 *
 * @module evaluator/feedback
 */

export type ErrorCategory = 'execution' | 'quality' | 'security' | 'anomaly';
export type ErrorSeverity = 'info' | 'warning' | 'critical';

/** Input to {@link buildSignature}. */
export interface SignatureInput {
  category: ErrorCategory | string;
  workflowKey?: string | null;
  stepKey?: string | null;
  /** Raw error / problem message (may contain volatile ids, numbers, etc.). */
  message?: string | null;
}

/** Result of {@link classify}. */
export interface Classification {
  category: ErrorCategory;
  severity: ErrorSeverity;
  recommendation?: string;
}

/** Input to {@link classify} — a flattened view of an evaluation/step outcome. */
export interface ClassifyInput {
  /** True when this comes from a hard step failure (executor threw / FAILED). */
  stepFailed?: boolean;
  /** Raw error message, if any. */
  errorMessage?: string | null;
  /** Quality grade letter (A..F). */
  qualityGrade?: string | null;
  /** Security risk level (low|medium|high|critical). */
  securityRiskLevel?: string | null;
  /** Whether anomaly detection flagged this run. */
  anomalyDetected?: boolean;
}

const MAX_SIGNATURE_LEN = 200;
const MAX_MESSAGE_LEN = 160;

/**
 * Normalize a free-text error message into a stable, volatile-data-free token.
 *
 * Order matters: strip the most specific volatile shapes (uuids, timestamps,
 * hex, paths) BEFORE collapsing generic digit runs, so e.g. a uuid does not
 * survive as a string of `*` fragments.
 */
export function normalizeMessage(raw?: string | null): string {
  if (!raw) return '';
  let s = String(raw);

  // Lowercase first — case should not affect the signature.
  s = s.toLowerCase();

  // ISO-8601 timestamps: 2026-05-31t12:34:56(.123)(z|+09:00)
  s = s.replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?(z|[+-]\d{2}:?\d{2})?/g, '*');
  // Bare dates / times
  s = s.replace(/\d{4}-\d{2}-\d{2}/g, '*');
  s = s.replace(/\d{2}:\d{2}:\d{2}(\.\d+)?/g, '*');

  // UUIDs
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '*');

  // cuid-like / long alphanumeric ids (>= 16 chars, mixed letters+digits)
  s = s.replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{16,}\b/g, '*');

  // Long hex blobs (hashes, keys) — >= 8 hex chars
  s = s.replace(/\b[0-9a-f]{8,}\b/g, '*');

  // Windows + POSIX file paths -> collapse to '*'
  s = s.replace(/[a-z]:\\[^\s"')]+/g, '*');
  s = s.replace(/\/[^\s"')]*\/[^\s"')]*/g, '*');

  // URLs
  s = s.replace(/https?:\/\/[^\s"')]+/g, '*');

  // Quoted literals -> '*' (values vary run to run)
  s = s.replace(/"[^"]*"/g, '*');
  s = s.replace(/'[^']*'/g, '*');

  // Any remaining standalone number runs (ints, decimals, http codes, etc.)
  s = s.replace(/\b\d[\d.,]*\b/g, '*');

  // Collapse runs of the wildcard + adjacent punctuation noise
  s = s.replace(/\*(?:[\s:_.-]*\*)+/g, '*');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  if (s.length > MAX_MESSAGE_LEN) {
    s = s.slice(0, MAX_MESSAGE_LEN);
  }
  return s;
}

/** Normalize a key segment (workflowKey/stepKey) for signature inclusion. */
function normalizeKey(key?: string | null): string {
  if (!key) return '*';
  let s = String(key).toLowerCase().trim();
  // adhoc-1717142400000 style runtime keys -> stable
  s = s.replace(/\b\d[\d.,]*\b/g, '*');
  s = s.replace(/\*(?:[\s:_.-]*\*)+/g, '*');
  s = s.replace(/\s+/g, '-');
  return s || '*';
}

/**
 * Build a stable dedup signature for an error/anomaly.
 *
 * Shape: `${category}:${workflowKey}:${stepKey}:${normalizedMessage}`,
 * lowercased, volatile data stripped, truncated to {@link MAX_SIGNATURE_LEN}.
 */
export function buildSignature(input: SignatureInput): string {
  const category = String(input.category || 'execution')
    .toLowerCase()
    .trim();
  const wf = normalizeKey(input.workflowKey);
  const step = normalizeKey(input.stepKey);
  const msg = normalizeMessage(input.message) || 'unknown';

  let sig = `${category}:${wf}:${step}:${msg}`;
  if (sig.length > MAX_SIGNATURE_LEN) {
    sig = sig.slice(0, MAX_SIGNATURE_LEN);
  }
  return sig;
}

/**
 * Deterministic short hash of a signature (for use as a KnowledgeArtifact key).
 * Simple FNV-1a-ish 32-bit hash rendered as base36 — no crypto dependency.
 */
export function signatureHash(signature: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/**
 * Map an evaluation/step outcome into {category, severity, recommendation}.
 *
 * Priority (most severe first): hard step failure > security high/critical >
 * quality grade F > anomaly. Returns the dominant problem so a single
 * ErrorPattern represents the primary issue.
 */
export function classify(input: ClassifyInput): Classification {
  // 1) Hard execution failure (executor threw / step FAILED)
  if (input.stepFailed) {
    return {
      category: 'execution',
      severity: 'critical',
      recommendation:
        '실행 단계가 실패했습니다. 입력 데이터/이전 노드 출력과 외부 API 키·크레딧 상태를 점검하고, 재시도(failureAction=retry) 또는 입력 검증을 추가하세요.',
    };
  }

  // 2) Security risk
  const risk = (input.securityRiskLevel || '').toLowerCase();
  if (risk === 'critical' || risk === 'high') {
    return {
      category: 'security',
      severity: risk === 'critical' ? 'critical' : 'warning',
      recommendation:
        '보안 위험이 감지되었습니다. 프롬프트 인젝션/민감정보 유출 가능성을 검토하고, 입력 정제와 출력 마스킹 규칙을 강화하세요.',
    };
  }

  // 3) Quality grade F
  const grade = (input.qualityGrade || '').toUpperCase();
  if (grade === 'F') {
    return {
      category: 'quality',
      severity: 'warning',
      recommendation:
        '응답 품질이 기준 미달(F)입니다. 프롬프트에 근거/제약을 추가하고, 환각 여부와 사실 정확성을 재검토하세요.',
    };
  }

  // 4) Anomaly
  if (input.anomalyDetected) {
    return {
      category: 'anomaly',
      severity: 'warning',
      recommendation:
        '이상치가 감지되었습니다(지연/토큰/오류율). 트래픽 급증 또는 모델 응답 변화 가능성을 모니터링하세요.',
    };
  }

  // Fallback — generic execution info
  return {
    category: 'execution',
    severity: 'info',
    recommendation: undefined,
  };
}
