/**
 * Hermes Autonomy Governance — pure risk model (no Prisma, no NestJS).
 *
 * The METIS ingestion on-ramp evaluates EVERY run through the shared
 * EvaluatorService (quality / security / anomaly / cost). For autonomous
 * "Hermes" agents that can self-create skills, read & write persistent
 * memory, and fire tool calls on their own, the standard evaluation is not
 * enough — METIS must ALSO reason about how much autonomy a single run
 * exercised, so a self-improving agent stays governable.
 *
 * `computeAutonomyRisk` is the deterministic core of that extra layer. It is
 * intentionally pure (same input → same output, no I/O) so it can be unit
 * tested in isolation and reused from the ingest path.
 *
 * ── Risk model (documented so reviewers can audit the weights) ───────────
 *   A tool call is "risky" when EITHER:
 *     - its name is in the high-impact set
 *       { execute_code, shell, browser, browser_use, file_write, http }, OR
 *     - the caller explicitly flagged it (toolCall.risky === true).
 *
 *   autonomyRiskScore (0..100, higher = riskier) =
 *       min(50, newSkillCount      * 25)   // self-created skills dominate
 *     + min(45, riskyToolCallCount * 15)   // autonomous high-impact actions
 *     + min(20, memoryWriteCount   *  5)   // persistent self-modification
 *     + min(10, floor(totalToolCalls / 3) * 2) // sheer autonomous volume
 *
 *   autonomyRiskLevel:  <20 low | <45 medium | <70 high | else critical
 *
 *   signals[]: human-readable Korean strings, one per NON-ZERO contributor,
 *   so an operator can see WHY a run was flagged at a glance.
 *
 * @module ingest
 */
import { detectPromptInjection, redactSecrets } from '../evaluator/prompt-guard';

/** A single autonomous tool invocation reported by the Hermes agent. */
export interface HermesToolCall {
  /** Tool name (e.g. "execute_code", "search", "http"). */
  name: string;
  /** Whether the call succeeded (informational; does not affect score). */
  ok?: boolean;
  /** Explicit risk flag from the caller — forces "risky" regardless of name. */
  risky?: boolean;
  /** Evidence: the actual arguments/code passed to the tool (e.g. code for execute_code). */
  args?: string;
  /** Evidence: the actual target the tool acted on (URL for browser/http, path for file_write). */
  target?: string;
}

/** The autonomous-agent extras carried alongside a standard Hermes run. */
export interface HermesMeta {
  /** Names of skills the agent USED (pre-existing). Informational. */
  skillsUsed?: string[];
  /** Names of skills the agent CREATED for itself during this run. */
  skillsCreated?: string[];
  /** Count of persistent-memory reads. */
  memoryReads?: number;
  /** Count of persistent-memory writes (self-modification). */
  memoryWrites?: number;
  /** Autonomous tool calls the agent made on its own. */
  toolCalls?: HermesToolCall[];
  /** Evidence: definitions/code of self-created skills, for content inspection. */
  skillDefs?: { name?: string; code?: string }[];
  /** Evidence: samples of content written to persistent memory (PII/secret/poison scan). */
  memoryWriteSamples?: string[];
  /** Owning ExecutionSession id (used as the alert subjectId / correlation). */
  sessionId?: string;
  /** Inline policy (Lab/testing). In production, policy is loaded from the Workflow. */
  policy?: AutonomyPolicy;
}

/** Optional per-agent policy used to verify whether autonomous actions were ALLOWED. */
export interface AutonomyPolicy {
  /** Allowed tool names. If provided, any tool NOT listed is a policy violation. */
  allowedTools?: string[];
  /** Allowed external domains for browser/http. Any other host = policy violation. */
  allowedDomains?: string[];
}

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AutonomyFinding {
  id: string;
  source: 'tool' | 'skill' | 'memory' | 'policy';
  kind: string; // e.g. 'ssrf', 'dangerous_code', 'secret_leak', 'prompt_injection', 'policy_violation', 'sensitive_path'
  severity: FindingSeverity;
  /** Redacted snippet of the actual evidence (code/url/content). */
  evidence: string;
  /** Human-readable Korean reason. */
  reason: string;
}

export interface AutonomyVerdict extends AutonomyRisk {
  /** Evidence-based findings (the REAL risk, not just surface counts). */
  findings: AutonomyFinding[];
  /** Worst finding severity (real). 'low' when no findings. */
  verifiedRiskLevel: FindingSeverity;
  /** 'verified-risk' (findings exist) | 'surface-only' (autonomous but no evidence of harm) | 'clean'. */
  verdict: 'verified-risk' | 'surface-only' | 'clean';
}

export type AutonomyRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface AutonomyRisk {
  newSkillCount: number;
  riskyToolCallCount: number;
  totalToolCalls: number;
  memoryWriteCount: number;
  memoryReadCount: number;
  /** 0..100, higher = riskier. */
  autonomyRiskScore: number;
  autonomyRiskLevel: AutonomyRiskLevel;
  /** Human-readable Korean explanations for each non-zero contributor. */
  signals: string[];
}

/** High-impact tool names that count as "risky" autonomous actions. */
export const RISKY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'execute_code',
  'shell',
  'browser',
  'browser_use',
  'file_write',
  'http',
]);

/** True when a tool call is high-impact (by name) or explicitly flagged. */
export function isRiskyToolCall(call: HermesToolCall | null | undefined): boolean {
  if (!call || typeof call !== 'object') return false;
  if (call.risky === true) return true;
  const name = typeof call.name === 'string' ? call.name.trim().toLowerCase() : '';
  return RISKY_TOOL_NAMES.has(name);
}

function clampCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Deterministically score the autonomy a single Hermes run exercised.
 * Pure: same `meta` always yields the same result. Tolerant of partial /
 * missing fields (treated as zero / empty).
 */
export function computeAutonomyRisk(meta: HermesMeta | null | undefined): AutonomyRisk {
  const m: HermesMeta = meta && typeof meta === 'object' ? meta : {};

  const skillsCreated = Array.isArray(m.skillsCreated) ? m.skillsCreated : [];
  const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];

  const newSkillCount = skillsCreated.length;
  const totalToolCalls = toolCalls.length;
  const riskyToolCallCount = toolCalls.filter((c) => isRiskyToolCall(c)).length;
  const memoryWriteCount = clampCount(m.memoryWrites);
  const memoryReadCount = clampCount(m.memoryReads);

  // ── Weighted, capped contributions (see module doc) ──
  const skillScore = Math.min(50, newSkillCount * 25);
  const riskyToolScore = Math.min(45, riskyToolCallCount * 15);
  const memoryScore = Math.min(20, memoryWriteCount * 5);
  const volumeScore = Math.min(10, Math.floor(totalToolCalls / 3) * 2);

  const autonomyRiskScore = Math.min(100, skillScore + riskyToolScore + memoryScore + volumeScore);

  let autonomyRiskLevel: AutonomyRiskLevel;
  if (autonomyRiskScore < 20) autonomyRiskLevel = 'low';
  else if (autonomyRiskScore < 45) autonomyRiskLevel = 'medium';
  else if (autonomyRiskScore < 70) autonomyRiskLevel = 'high';
  else autonomyRiskLevel = 'critical';

  // ── Human-readable signals (one per non-zero contributor) ──
  const signals: string[] = [];
  if (newSkillCount > 0) {
    signals.push(`신규 스킬 ${newSkillCount}개 자동 생성`);
  }
  if (riskyToolCallCount > 0) {
    const riskyNames = toolCalls
      .filter((c) => isRiskyToolCall(c))
      .map((c) => (typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'unknown'));
    const uniqueNames = Array.from(new Set(riskyNames));
    signals.push(`위험 툴 ${uniqueNames.join(', ')} 호출 (${riskyToolCallCount}건)`);
  }
  if (memoryWriteCount > 0) {
    signals.push(`메모리 쓰기 ${memoryWriteCount}건`);
  }
  if (memoryReadCount > 0) {
    signals.push(`메모리 읽기 ${memoryReadCount}건`);
  }
  if (totalToolCalls > 0) {
    signals.push(`자율 툴 호출 ${totalToolCalls}건`);
  }

  return {
    newSkillCount,
    riskyToolCallCount,
    totalToolCalls,
    memoryWriteCount,
    memoryReadCount,
    autonomyRiskScore,
    autonomyRiskLevel,
    signals,
  };
}


// ───────────────────────────────────────────────────────────────────────────
// Evidence-based autonomy verdict — moves from "risk surface" (counts) to
// "actual risk" by inspecting the CONTENT/TARGET of autonomous actions:
//   tool args/targets, self-created skill code, memory writes.
// Reuses prompt-guard (secrets/injection) + static SSRF/dangerous-code checks.
// Pure & deterministic (no Prisma / network).
// ───────────────────────────────────────────────────────────────────────────

/** Dangerous shell/code patterns (destructive, exfiltration, RCE, key access). */
const DANGEROUS_CODE_PATTERNS: { re: RegExp; sev: FindingSeverity; label: string }[] = [
  { re: /rm\s+-rf?\s+[\/~]/i, sev: 'critical', label: '파괴적 삭제 (rm -rf)' },
  { re: /\bmkfs\b|\bdd\s+if=/i, sev: 'critical', label: '디스크 포맷/덮어쓰기' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i, sev: 'critical', label: '포크 폭탄' },
  { re: /(curl|wget)\s+[^\n|]*\|\s*(sh|bash|python)/i, sev: 'critical', label: '원격 스크립트 다운로드 후 실행' },
  { re: /\bnc\b\s+-e|\/dev\/tcp\//i, sev: 'critical', label: '리버스 셸' },
  { re: /\b(os\.system|subprocess\.(Popen|run|call)|child_process|exec\()/i, sev: 'high', label: '임의 명령 실행' },
  { re: /\beval\s*\(|new\s+Function\s*\(/i, sev: 'high', label: '동적 코드 평가(eval)' },
  { re: /\/etc\/(passwd|shadow)|~\/\.ssh\/|id_rsa|\.aws\/credentials|\.env\b/i, sev: 'high', label: '민감 파일/자격증명 접근' },
  { re: /requests\.(post|put)\(|fetch\(['"]https?:\/\//i, sev: 'medium', label: '외부 전송 시도' },
];

/** Sensitive file-write targets. */
const SENSITIVE_PATHS = [/\/etc\//i, /\.ssh\//i, /\.env\b/i, /system32/i, /\/root\//i, /\.aws\//i];

function hasSecret(text: string): boolean {
  if (!text) return false;
  return redactSecrets(text) !== text; // redaction changed it → a secret was present
}

function isPrivateOrInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true; // cloud metadata
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  if (h === '0.0.0.0' || h === '::1') return true;
  return false;
}

function hostOf(target: string): string | null {
  try {
    const u = new URL(target.includes('://') ? target : `http://${target}`);
    return u.hostname;
  } catch {
    return null;
  }
}

const snip = (t: string, n = 160): string => redactSecrets(String(t ?? '')).slice(0, n);

const SEV_ORDER: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];
function worstSeverity(findings: AutonomyFinding[]): FindingSeverity {
  let worst: FindingSeverity = 'low';
  for (const f of findings) {
    if (SEV_ORDER.indexOf(f.severity) > SEV_ORDER.indexOf(worst)) worst = f.severity;
  }
  return worst;
}

/**
 * Inspect the CONTENT of autonomous actions and return concrete findings
 * (what is risky + why), plus a verified verdict. Layers on top of the surface
 * autonomy score so the UI can show "왜 위험한지" with evidence.
 */
export function evaluateAutonomyEvidence(
  meta: HermesMeta | null | undefined,
  policy?: AutonomyPolicy,
): AutonomyVerdict {
  const surface = computeAutonomyRisk(meta);
  const m: HermesMeta = meta && typeof meta === 'object' ? meta : {};
  const findings: AutonomyFinding[] = [];
  let n = 0;
  const allowedTools = policy?.allowedTools?.map((t) => t.toLowerCase());
  const allowedDomains = policy?.allowedDomains?.map((d) => d.toLowerCase());

  // 1) Tool calls — inspect args/targets
  for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
    if (!call || typeof call !== 'object') continue;
    const name = (call.name ?? '').toLowerCase();
    const args = typeof call.args === 'string' ? call.args : '';
    const target = typeof call.target === 'string' ? call.target : '';

    // 1a) SSRF / disallowed domain (browser/http/web tools with a URL target)
    if (target && /^(browser|browser_use|http|web_search|fetch|request)$/.test(name)) {
      const host = hostOf(target);
      if (host && isPrivateOrInternalHost(host)) {
        findings.push({ id: `f${++n}`, source: 'tool', kind: 'ssrf', severity: 'critical',
          evidence: snip(target), reason: `내부망/메타데이터 주소 접근 (SSRF): ${host}` });
      } else if (host && allowedDomains && !allowedDomains.some((d) => host === d || host.endsWith('.' + d))) {
        findings.push({ id: `f${++n}`, source: 'policy', kind: 'policy_violation', severity: 'high',
          evidence: snip(target), reason: `허용되지 않은 외부 도메인 접근: ${host}` });
      }
    }

    // 1b) dangerous code in execute_code/shell args
    if (args && /^(execute_code|shell|code|python|bash)$/.test(name)) {
      for (const dp of DANGEROUS_CODE_PATTERNS) {
        if (dp.re.test(args)) {
          findings.push({ id: `f${++n}`, source: 'tool', kind: 'dangerous_code', severity: dp.sev,
            evidence: snip(args), reason: `위험 코드 실행: ${dp.label}` });
          break;
        }
      }
      if (hasSecret(args)) {
        findings.push({ id: `f${++n}`, source: 'tool', kind: 'secret_leak', severity: 'high',
          evidence: snip(args), reason: '코드 인자에 시크릿(키/토큰) 포함' });
      }
    }

    // 1c) sensitive file write
    if (target && /^(file_write|write_file|fs_write)$/.test(name) && SENSITIVE_PATHS.some((re) => re.test(target))) {
      findings.push({ id: `f${++n}`, source: 'tool', kind: 'sensitive_path', severity: 'high',
        evidence: snip(target), reason: `민감 경로에 쓰기: ${target}` });
    }

    // 1d) tool allowlist
    if (allowedTools && name && !allowedTools.includes(name)) {
      findings.push({ id: `f${++n}`, source: 'policy', kind: 'policy_violation',
        severity: RISKY_TOOL_NAMES.has(name) ? 'high' : 'medium',
        evidence: snip(name), reason: `허용 목록에 없는 툴 사용: ${name}` });
    }
  }

  // 2) Self-created skill code
  for (const sk of Array.isArray(m.skillDefs) ? m.skillDefs : []) {
    const code = sk && typeof sk.code === 'string' ? sk.code : '';
    if (!code) continue;
    const nm = sk?.name ?? 'skill';
    for (const dp of DANGEROUS_CODE_PATTERNS) {
      if (dp.re.test(code)) {
        findings.push({ id: `f${++n}`, source: 'skill', kind: 'dangerous_code', severity: dp.sev,
          evidence: snip(code), reason: `자동 생성 스킬 '${nm}'에 위험 기능: ${dp.label}` });
        break;
      }
    }
    if (hasSecret(code)) {
      findings.push({ id: `f${++n}`, source: 'skill', kind: 'secret_leak', severity: 'high',
        evidence: snip(code), reason: `자동 생성 스킬 '${nm}'에 시크릿 포함` });
    }
    const inj = detectPromptInjection(code);
    if (inj.length) {
      findings.push({ id: `f${++n}`, source: 'skill', kind: 'prompt_injection', severity: 'high',
        evidence: snip(code), reason: `자동 생성 스킬 '${nm}'에 인젝션 패턴: ${inj.slice(0, 2).join(', ')}` });
    }
  }

  // 3) Memory write content
  for (const sample of Array.isArray(m.memoryWriteSamples) ? m.memoryWriteSamples : []) {
    const text = typeof sample === 'string' ? sample : '';
    if (!text) continue;
    if (hasSecret(text)) {
      findings.push({ id: `f${++n}`, source: 'memory', kind: 'secret_leak', severity: 'critical',
        evidence: snip(text), reason: '메모리에 시크릿/자격증명 저장 (유출·잔존 위험)' });
    }
    const inj = detectPromptInjection(text);
    if (inj.length) {
      findings.push({ id: `f${++n}`, source: 'memory', kind: 'prompt_injection', severity: 'high',
        evidence: snip(text), reason: `메모리 오염(주입) 가능: ${inj.slice(0, 2).join(', ')}` });
    }
  }

  const verifiedRiskLevel = findings.length ? worstSeverity(findings) : 'low';
  const verdict: AutonomyVerdict['verdict'] = findings.length
    ? 'verified-risk'
    : surface.autonomyRiskLevel === 'low'
      ? 'clean'
      : 'surface-only';

  return { ...surface, findings, verifiedRiskLevel, verdict };
}
