/**
 * Pure-logic unit tests for Operational Knowledge Management.
 *
 * Mirrors the pure functions in:
 *   - knowledge-retrieval.service.ts  (matchesScope, renderKnowledgeForPrompt)
 *   - knowledge.service.ts            (utilization classification, mapCategoryToPolicyType)
 *
 * No DB / Nest required — validates the decision logic in isolation.
 * Run: node scripts/test-knowledge.mjs
 */

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── replicated pure logic ──────────────────────────────────────────
function matchesScope(scopeJson, ctx) {
  // F2 (security): missing/empty scope is workflow-LOCAL (matches nothing), not global.
  if (!scopeJson || typeof scopeJson !== 'object') return false;
  if (scopeJson.global === true) return true;
  if (
    ctx.workflowKey &&
    Array.isArray(scopeJson.workflowKeys) &&
    scopeJson.workflowKeys.includes(ctx.workflowKey)
  )
    return true;
  if (
    ctx.category &&
    Array.isArray(scopeJson.categories) &&
    scopeJson.categories.includes(ctx.category)
  )
    return true;
  if (
    ctx.capabilityKey &&
    Array.isArray(scopeJson.capabilityKeys) &&
    scopeJson.capabilityKeys.includes(ctx.capabilityKey)
  )
    return true;
  return false;
}

function renderKnowledgeForPrompt(retrieved) {
  const artifacts = retrieved?.artifacts ?? [];
  const errorPatterns = retrieved?.errorPatterns ?? [];
  if (artifacts.length === 0 && errorPatterns.length === 0) return '';
  const parts = [];
  parts.push('=== 참고 지식 (운영지식관리) ===');
  parts.push('아래는 본 작업과 관련된 사내 운영 지식입니다. 분석/응답 시 반드시 반영하세요.');
  if (artifacts.length > 0) {
    parts.push('\n[지식 항목]');
    artifacts.forEach((a, idx) => {
      const title = a?.title || '(제목 없음)';
      const cat = a?.category ? ` <${a.category}>` : '';
      const body = (a?.content || a?.description || '').toString().trim().slice(0, 600);
      parts.push(`${idx + 1}. ${title}${cat}`);
      if (body) parts.push(`   ${body}`);
    });
  }
  if (errorPatterns.length > 0) {
    parts.push('\n[과거 오류/주의사항 — 반복하지 마세요]');
    errorPatterns.forEach((p, idx) => {
      const sev = (p?.severity || 'warning').toString().toUpperCase();
      const cat = p?.category || 'execution';
      const occ = p?.occurrences ?? 1;
      const sample = (p?.sampleMessage || '').toString().slice(0, 180);
      const rec = p?.recommendation ? ` / 권고: ${p.recommendation}` : '';
      parts.push(`${idx + 1}. [${sev}/${cat}] (발생 ${occ}회) ${sample}${rec}`);
    });
  }
  parts.push('=== 참고 지식 끝 ===\n');
  return parts.join('\n') + '\n';
}

function mapCategoryToPolicyType(category) {
  const c = (category || '').toUpperCase();
  if (c.includes('SECURITY')) return 'SECURITY';
  if (c.includes('COST') || c.includes('FINOPS')) return 'COST';
  if (c.includes('QUALITY')) return 'QUALITY';
  if (c.includes('ERROR')) return 'RELIABILITY';
  return 'COMPLIANCE';
}

// classifyUnused mirrors getUtilization's unused predicate
function classifyUnused(artifact, sinceMs) {
  return (
    (artifact.usageCount ?? 0) === 0 ||
    !artifact.lastUsedAt ||
    new Date(artifact.lastUsedAt).getTime() < sinceMs
  );
}

// ── tests ──────────────────────────────────────────────────────────
console.log('\n[1] matchesScope');
assert(matchesScope(null, {}) === false, 'no scope → NOT global (F2)');
assert(matchesScope({}, {}) === false, 'empty scope object → NOT global (F2)');
assert(matchesScope({ global: true }, { workflowKey: 'x' }) === true, 'global:true → match');
assert(
  matchesScope({ workflowKeys: ['wf-a'] }, { workflowKey: 'wf-a' }) === true,
  'workflowKey match',
);
assert(
  matchesScope({ workflowKeys: ['wf-a'] }, { workflowKey: 'wf-b' }) === false,
  'workflowKey miss',
);
assert(
  matchesScope({ categories: ['security'] }, { category: 'security' }) === true,
  'category match',
);
assert(
  matchesScope({ capabilityKeys: ['sast'] }, { capabilityKey: 'sast' }) === true,
  'capability match',
);
assert(
  matchesScope({ workflowKeys: ['wf-a'] }, { category: 'security' }) === false,
  'scoped but no ctx match → miss',
);
assert(
  matchesScope({ workflowKeys: ['wf-a'], categories: ['q'] }, { category: 'q' }) === true,
  'multi-scope OR match',
);

console.log('\n[2] renderKnowledgeForPrompt');
assert(
  renderKnowledgeForPrompt({ artifacts: [], errorPatterns: [] }) === '',
  'empty → empty string',
);
const rendered = renderKnowledgeForPrompt({
  artifacts: [
    { title: 'SQL 안전 가이드', category: 'security', content: 'prepared statement 사용' },
  ],
  errorPatterns: [
    {
      severity: 'critical',
      category: 'security',
      occurrences: 4,
      sampleMessage: 'SQLi 발견',
      recommendation: '파라미터 바인딩',
    },
  ],
});
assert(rendered.includes('참고 지식 (운영지식관리)'), 'header present');
assert(rendered.includes('SQL 안전 가이드'), 'artifact title present');
assert(rendered.includes('prepared statement 사용'), 'artifact body present');
assert(rendered.includes('<security>'), 'category tag present');
assert(rendered.includes('[CRITICAL/security]'), 'error pattern severity present');
assert(rendered.includes('발생 4회'), 'occurrences present');
assert(rendered.includes('권고: 파라미터 바인딩'), 'recommendation present');
const onlyErr = renderKnowledgeForPrompt({
  artifacts: [],
  errorPatterns: [{ sampleMessage: 'e' }],
});
assert(
  onlyErr.includes('과거 오류/주의사항') && !onlyErr.includes('[지식 항목]'),
  'errors-only omits 지식 항목',
);

console.log('\n[3] utilization classification (unused predicate)');
const since = Date.now() - 30 * 86400000;
assert(
  classifyUnused({ usageCount: 0, lastUsedAt: null }, since) === true,
  'usageCount 0 → unused',
);
assert(
  classifyUnused({ usageCount: 5, lastUsedAt: new Date(Date.now() - 60 * 86400000) }, since) ===
    true,
  'stale (60d) → unused',
);
assert(
  classifyUnused({ usageCount: 5, lastUsedAt: new Date(Date.now() - 5 * 86400000) }, since) ===
    false,
  'recent (5d) → used',
);

console.log('\n[4] mapCategoryToPolicyType');
assert(mapCategoryToPolicyType('SECURITY_RULE') === 'SECURITY', 'security → SECURITY');
assert(mapCategoryToPolicyType('cost_guardrail') === 'COST', 'cost → COST');
assert(mapCategoryToPolicyType('ERROR_PATTERN') === 'RELIABILITY', 'error → RELIABILITY');
assert(mapCategoryToPolicyType('quality_gate') === 'QUALITY', 'quality → QUALITY');
assert(mapCategoryToPolicyType('misc') === 'COMPLIANCE', 'default → COMPLIANCE');

console.log(`\n=== Knowledge unit tests: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
