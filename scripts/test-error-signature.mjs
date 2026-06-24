/**
 * SCENARIO 1 (Part C) unit tests — pure error-signature logic.
 *
 * Tests apps/api/src/modules/evaluator/feedback/error-signature.ts WITHOUT a DB
 * or NestJS. The TS source has no Nest/Prisma imports, so we transpile it on the
 * fly with the local TypeScript and import the emitted JS.
 *
 * Verifies:
 *   1) Signature dedup STABILITY  — two errors differing only by ids/numbers/
 *      uuids/timestamps/paths collapse to the SAME signature.
 *   2) Signature SENSITIVITY      — genuinely different errors -> different sigs.
 *   3) classify() mapping         — stepFailed/security/quality F/anomaly.
 *   4) Truncation                 — long messages are length-bounded.
 *   5) signatureHash()            — deterministic, stable.
 *
 * Run:  node scripts/test-error-signature.mjs
 * ASCII-only output.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tsPath = new URL(
  '../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js',
  import.meta.url,
);
const ts = require(fileURLToPath(tsPath));

const srcPath = new URL(
  '../apps/api/src/modules/evaluator/feedback/error-signature.ts',
  import.meta.url,
);
const src = readFileSync(srcPath, 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: { module: 'ESNext', target: 'ES2020' },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), 'errsig-'));
const jsPath = join(dir, 'error-signature.mjs');
writeFileSync(jsPath, out, 'utf8');
const { buildSignature, classify, signatureHash, normalizeMessage } = await import(jsPath);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
  }
}

// ---- 1) DEDUP STABILITY ----

check('dedup: differing numeric ids -> same signature', () => {
  const a = buildSignature({
    category: 'execution',
    workflowKey: 'wf-1',
    stepKey: 'node-1',
    message: 'Request failed with status 500 after 1234 ms (attempt 3)',
  });
  const b = buildSignature({
    category: 'execution',
    workflowKey: 'wf-1',
    stepKey: 'node-1',
    message: 'Request failed with status 503 after 9876 ms (attempt 7)',
  });
  assert.equal(a, b);
});

check('dedup: differing uuids/timestamps -> same signature', () => {
  const a = buildSignature({
    category: 'execution',
    workflowKey: 'wf-1',
    stepKey: 'node-1',
    message:
      'session 3f8c1e2a-1b2c-4d5e-8a9b-0c1d2e3f4a5b failed at 2026-05-31T12:34:56.123Z',
  });
  const b = buildSignature({
    category: 'execution',
    workflowKey: 'wf-1',
    stepKey: 'node-1',
    message:
      'session 99887766-aabb-ccdd-eeff-001122334455 failed at 2026-01-02T03:04:05.999Z',
  });
  assert.equal(a, b);
});

check('dedup: differing file paths -> same signature', () => {
  const a = buildSignature({
    category: 'execution',
    workflowKey: 'wf-2',
    stepKey: 'node-2',
    message: 'cannot read file C:\\Users\\alice\\tmp\\input.txt',
  });
  const b = buildSignature({
    category: 'execution',
    workflowKey: 'wf-2',
    stepKey: 'node-2',
    message: 'cannot read file C:\\Users\\bob\\work\\source.txt',
  });
  assert.equal(a, b);
});

check('dedup: case-insensitive + whitespace-collapsed -> same signature', () => {
  const a = buildSignature({ category: 'quality', message: 'Quality   Gate   FAILED' });
  const b = buildSignature({ category: 'quality', message: 'quality gate failed' });
  assert.equal(a, b);
});

check('dedup: runtime adhoc workflowKey numbers normalized -> same signature', () => {
  const a = buildSignature({
    category: 'execution',
    workflowKey: 'adhoc-1717142400000',
    stepKey: 'node-1',
    message: 'timeout',
  });
  const b = buildSignature({
    category: 'execution',
    workflowKey: 'adhoc-1799999999999',
    stepKey: 'node-1',
    message: 'timeout',
  });
  assert.equal(a, b);
});

// ---- 2) SENSITIVITY ----

check('sensitivity: different message text -> different signature', () => {
  const a = buildSignature({ category: 'execution', message: 'connection refused' });
  const b = buildSignature({ category: 'execution', message: 'permission denied' });
  assert.notEqual(a, b);
});

check('sensitivity: different category -> different signature', () => {
  const a = buildSignature({ category: 'security', message: 'risk detected' });
  const b = buildSignature({ category: 'quality', message: 'risk detected' });
  assert.notEqual(a, b);
});

check('signature shape: category:workflow:step:message', () => {
  const sig = buildSignature({
    category: 'security',
    workflowKey: 'WF-A',
    stepKey: 'STEP-B',
    message: 'prompt injection attempt',
  });
  // category is lowercased; segments separated by ':'
  assert.ok(sig.startsWith('security:'), `expected security: prefix, got ${sig}`);
  assert.equal(sig.split(':').length >= 4, true);
});

// ---- 3) classify() ----

check('classify: stepFailed -> execution/critical with recommendation', () => {
  const c = classify({ stepFailed: true, errorMessage: 'boom' });
  assert.equal(c.category, 'execution');
  assert.equal(c.severity, 'critical');
  assert.ok(c.recommendation && c.recommendation.length > 0);
});

check('classify: security critical -> security/critical', () => {
  const c = classify({ securityRiskLevel: 'critical' });
  assert.equal(c.category, 'security');
  assert.equal(c.severity, 'critical');
});

check('classify: security high -> security/warning', () => {
  const c = classify({ securityRiskLevel: 'high' });
  assert.equal(c.category, 'security');
  assert.equal(c.severity, 'warning');
});

check('classify: quality grade F -> quality/warning', () => {
  const c = classify({ qualityGrade: 'F' });
  assert.equal(c.category, 'quality');
  assert.equal(c.severity, 'warning');
});

check('classify: anomaly only -> anomaly/warning', () => {
  const c = classify({ anomalyDetected: true });
  assert.equal(c.category, 'anomaly');
  assert.equal(c.severity, 'warning');
});

check('classify: priority — stepFailed beats security', () => {
  const c = classify({ stepFailed: true, securityRiskLevel: 'critical', qualityGrade: 'F' });
  assert.equal(c.category, 'execution');
});

check('classify: priority — security beats quality F', () => {
  const c = classify({ securityRiskLevel: 'high', qualityGrade: 'F', anomalyDetected: true });
  assert.equal(c.category, 'security');
});

check('classify: clean eval -> execution/info, no recommendation', () => {
  const c = classify({ qualityGrade: 'A', securityRiskLevel: 'low', anomalyDetected: false });
  assert.equal(c.category, 'execution');
  assert.equal(c.severity, 'info');
});

// ---- 4) TRUNCATION ----

check('truncation: signature is length-bounded (<= 200)', () => {
  const longMsg = 'error '.repeat(200);
  const sig = buildSignature({
    category: 'execution',
    workflowKey: 'wf-very-long-key-name-here',
    stepKey: 'step-very-long-key-name-here',
    message: longMsg,
  });
  assert.ok(sig.length <= 200, `signature length ${sig.length} exceeds 200`);
});

check('truncation: normalized message bounded (<= 160)', () => {
  const longMsg = 'alpha beta gamma '.repeat(100);
  const norm = normalizeMessage(longMsg);
  assert.ok(norm.length <= 160, `normalized length ${norm.length} exceeds 160`);
});

// ---- 5) signatureHash() ----

check('signatureHash: deterministic + stable', () => {
  const sig = buildSignature({ category: 'execution', message: 'timeout' });
  assert.equal(signatureHash(sig), signatureHash(sig));
});

check('signatureHash: distinct sigs -> distinct hashes (high probability)', () => {
  const h1 = signatureHash('execution:a:b:timeout');
  const h2 = signatureHash('execution:a:b:refused');
  assert.notEqual(h1, h2);
});

// ---- Summary ----
console.log('');
console.log('========================================');
console.log('  SCENARIO 1 - error-signature unit test');
console.log('========================================');
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
if (failures.length) {
  console.log('  Failures:');
  for (const f of failures) console.log('   - ' + f);
}
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
