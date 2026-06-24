/**
 * Unit test for FinOps cache-key + savings pure logic.
 *
 * Mirrors apps/api/src/modules/finops/finops-pricing.ts. Run with:
 *   node scripts/test-finops-cache.mjs
 *
 * Verifies:
 *  - identical prompt → identical stored key (cache HIT)
 *  - different prompt → different stored key (cache MISS)
 *  - cache HIT savings = full Tier-2 baseline, 100%
 *  - routed (MISS) savings = Tier-2 baseline − routed-tier cost
 */

const TIER_PRICING = { 1: 0.001 / 1000, 2: 0.005 / 1000, 3: 0.02 / 1000 };
const estimateTokens = (p) => Math.ceil(p.length / 4);

function computeCacheKey(prompt) {
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    const char = prompt.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `cache_${Math.abs(hash).toString(16)}`;
}
// Mirror of redactSecrets (apps/api/src/modules/evaluator/prompt-guard.ts) — the
// stored promptText is redacted so secrets never land in FinOpsTokenLog, while
// the cache key is still hashed from the ORIGINAL prompt (HIT semantics intact).
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
];
const HIGH_ENTROPY_TOKEN =
  /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}\b/g;
function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  out = out.replace(HIGH_ENTROPY_TOKEN, '[REDACTED]');
  return out;
}
const buildStoredPromptText = (p) =>
  `[DEMO:${computeCacheKey(p)}] ${redactSecrets(p.substring(0, 480))}`;
const tier2BaselineCost = (p) => TIER_PRICING[2] * estimateTokens(p);
const cacheHitSavings = (p) => ({ savedUsd: tier2BaselineCost(p), savedPct: 100 });
function routedSavings(p, tier) {
  const tokens = estimateTokens(p);
  const baseline = TIER_PRICING[2] * tokens;
  const actual = (TIER_PRICING[tier] || TIER_PRICING[2]) * tokens;
  const savedUsd = Math.max(0, baseline - actual);
  return { savedUsd, savedPct: baseline > 0 ? (savedUsd / baseline) * 100 : 0 };
}

let pass = 0,
  fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

const A = '다음 이메일이 스팸인지 분류해줘: 신년 세일 50%';
const B = 'Translate to English: 오늘 회의는 3시에 시작합니다';

console.log('FinOps cache-key / savings logic');

// Cache key — same prompt collides, different prompt diverges, seed (null) never matches.
ok('same prompt → same stored key (HIT)', buildStoredPromptText(A) === buildStoredPromptText(A));
ok(
  'different prompt → different stored key (MISS)',
  buildStoredPromptText(A) !== buildStoredPromptText(B),
);
ok(
  'stored key is hash-marked (non-null, excludes seed NULL rows)',
  buildStoredPromptText(A).startsWith('[DEMO:cache_'),
);

// Cache HIT savings.
const hit = cacheHitSavings(A);
ok('cache HIT savedPct === 100', hit.savedPct === 100);
ok('cache HIT savedUsd === full Tier-2 baseline', hit.savedUsd === tier2BaselineCost(A));
ok('cache HIT savedUsd > 0', hit.savedUsd > 0);

// Routed (MISS) savings.
const t1 = routedSavings(A, 1);
ok('Tier-1 routed savedUsd > 0', t1.savedUsd > 0);
ok('Tier-1 routed savedPct === 80', Math.round(t1.savedPct) === 80);
const t2 = routedSavings(A, 2);
ok('Tier-2 routed savedUsd === 0 (no savings vs baseline)', t2.savedUsd === 0);
const t3 = routedSavings(A, 3);
ok('Tier-3 routed savedUsd === 0 (more expensive than baseline)', t3.savedUsd === 0);

// SECRET-AT-REST: a prompt carrying a secret must store REDACTED text, yet the
// SAME prompt must still produce the SAME stored value (cache HIT preserved).
const SECRET_PROMPT = 'deploy with key sk-ant-abcdEFGH1234567890ijklmnop now';
ok(
  'stored promptText redacts sk-ant- secret',
  !buildStoredPromptText(SECRET_PROMPT).includes('sk-ant-abcdEFGH1234567890ijklmnop'),
);
ok(
  'stored promptText contains [REDACTED]',
  buildStoredPromptText(SECRET_PROMPT).includes('[REDACTED]'),
);
ok(
  'redacted prompt still cache-HITs itself (deterministic)',
  buildStoredPromptText(SECRET_PROMPT) === buildStoredPromptText(SECRET_PROMPT),
);
ok(
  'AKIA access-key id redacted in stored text',
  !buildStoredPromptText('cred AKIAIOSFODNN7EXAMPLE end').includes('AKIAIOSFODNN7EXAMPLE'),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
