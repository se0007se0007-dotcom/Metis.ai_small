/**
 * Effectiveness Signal unit tests (MEASURED MTTD + coverage source data).
 *
 * Tests (no DB; transpile the pure TS sources on the fly):
 *   - effectiveness-ops.ts : computeMttdFromSignals (avg seconds -> minutes),
 *                            computeCoverageFromSignals (avg pct + summed tests)
 *   - effectiveness-signal.service.ts : parseSignalFromOutput (full + shorthand
 *                            shapes) and detectSeconds derivation logic.
 *
 * Run:  node scripts/test-effectiveness-signals.mjs   (ASCII-only output)
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

function transpile(src) {
  return ts.transpileModule(src, { compilerOptions: { module: 'ESNext', target: 'ES2020' } })
    .outputText;
}
function loadSrc(src, name) {
  const dir = mkdtempSync(join(tmpdir(), name + '-'));
  const jsPath = join(dir, name + '.mjs');
  writeFileSync(jsPath, transpile(src), 'utf8');
  return import(jsPath);
}

// effectiveness-ops.ts is pure — load directly.
const opsSrc = readFileSync(
  new URL('../apps/api/src/modules/dashboard/effectiveness-ops.ts', import.meta.url),
  'utf8',
);
const { computeMttdFromSignals, computeCoverageFromSignals } = await loadSrc(opsSrc, 'eff-ops');

// effectiveness-signal.service.ts has NestJS decorators / imports — extract the
// pure exported helper parseSignalFromOutput (and the local toNum it uses) into
// a standalone module so we can test it without a DI container.
const svcSrc = readFileSync(
  new URL('../apps/api/src/modules/metrics/effectiveness-signal.service.ts', import.meta.url),
  'utf8',
);
// Keep only: the toNum/toDate helpers + parseSignalFromOutput (up to its closing).
const startIdx = svcSrc.indexOf('const toDate');
const endMarker = '\n@Injectable()';
const endIdx = svcSrc.indexOf(endMarker);
assert.ok(startIdx >= 0 && endIdx > startIdx, 'could not slice parseSignalFromOutput');
const pureSlice = svcSrc.slice(startIdx, endIdx);
const { parseSignalFromOutput } = await loadSrc(pureSlice, 'eff-sig-pure');

let pass = 0,
  fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ': ' + e.message);
    console.log('FAIL  ' + name + ' -> ' + e.message);
  }
}

// ── computeMttdFromSignals ──
check('computeMttdFromSignals: avg seconds -> minutes (2dp) + samples', () => {
  const r = computeMttdFromSignals([
    { workflowKey: 'a', detectSeconds: 60 },
    { workflowKey: 'a', detectSeconds: 120 },
    { workflowKey: 'a', detectSeconds: null },
  ]);
  // avg of 60,120 = 90s -> 1.5 min ; null skipped from samples
  assert.equal(r.a.mttdMinutes, 1.5);
  assert.equal(r.a.samples, 2);
});
check('computeMttdFromSignals: no valid seconds -> null mttd, 0 samples', () => {
  const r = computeMttdFromSignals([{ workflowKey: 'b', detectSeconds: null }]);
  assert.equal(r.b.mttdMinutes, null);
  assert.equal(r.b.samples, 0);
});
check('computeMttdFromSignals: groups by workflowKey', () => {
  const r = computeMttdFromSignals([
    { workflowKey: 'x', detectSeconds: 300 },
    { workflowKey: 'y', detectSeconds: 600 },
  ]);
  assert.equal(r.x.mttdMinutes, 5);
  assert.equal(r.y.mttdMinutes, 10);
});

// ── computeCoverageFromSignals ──
check('computeCoverageFromSignals: avg pct + summed tests + samples', () => {
  const r = computeCoverageFromSignals([
    { workflowKey: 'c', coveragePct: 80, testsTotal: 100, testsPassed: 90 },
    { workflowKey: 'c', coveragePct: 90, testsTotal: 200, testsPassed: 180 },
  ]);
  assert.equal(r.c.coveragePct, 85); // avg(80,90)
  assert.equal(r.c.testsTotal, 300);
  assert.equal(r.c.testsPassed, 270);
  assert.equal(r.c.samples, 2);
});
check('computeCoverageFromSignals: null pct skipped from avg, sums still add', () => {
  const r = computeCoverageFromSignals([
    { workflowKey: 'd', coveragePct: null, testsTotal: 50, testsPassed: 50 },
    { workflowKey: 'd', coveragePct: 70, testsTotal: 50, testsPassed: 40 },
  ]);
  assert.equal(r.d.coveragePct, 70); // only the one present value
  assert.equal(r.d.testsTotal, 100);
  assert.equal(r.d.testsPassed, 90);
  assert.equal(r.d.samples, 2);
});

// ── parseSignalFromOutput ──
check('parseSignalFromOutput: full COVERAGE shape', () => {
  const s = parseSignalFromOutput({
    effectivenessSignal: { kind: 'COVERAGE', testsTotal: 100, testsPassed: 95, coveragePct: 88 },
  });
  assert.equal(s.kind, 'COVERAGE');
  assert.equal(s.testsTotal, 100);
  assert.equal(s.testsPassed, 95);
  assert.equal(s.coveragePct, 88);
});
check('parseSignalFromOutput: full DETECTION shape', () => {
  const s = parseSignalFromOutput({
    effectivenessSignal: {
      kind: 'DETECTION',
      occurredAt: '2026-01-01T00:00:00Z',
      detectedAt: '2026-01-01T00:05:00Z',
    },
  });
  assert.equal(s.kind, 'DETECTION');
  assert.equal(s.occurredAt, '2026-01-01T00:00:00Z');
  assert.equal(s.detectedAt, '2026-01-01T00:05:00Z');
});
check('parseSignalFromOutput: coverage shorthand', () => {
  const s = parseSignalFromOutput({
    coverage: { testsTotal: 10, testsPassed: 9, coveragePct: 75 },
  });
  assert.equal(s.kind, 'COVERAGE');
  assert.equal(s.testsTotal, 10);
});
check('parseSignalFromOutput: detection shorthand', () => {
  const s = parseSignalFromOutput({ detection: { occurredAt: 'x', detectedAt: 'y' } });
  assert.equal(s.kind, 'DETECTION');
});
check('parseSignalFromOutput: returns null when nothing usable', () => {
  assert.equal(parseSignalFromOutput({ foo: 1 }), null);
  assert.equal(parseSignalFromOutput(null), null);
  assert.equal(parseSignalFromOutput('str'), null);
});
check('parseSignalFromOutput: unknown kind -> null', () => {
  assert.equal(parseSignalFromOutput({ effectivenessSignal: { kind: 'BOGUS' } }), null);
});

// ── detectSeconds derivation (mirror service.record logic) ──
check('detectSeconds derivation: (detectedAt - occurredAt)/1000', () => {
  const occurredAt = new Date('2026-01-01T00:00:00Z');
  const detectedAt = new Date('2026-01-01T00:02:30Z'); // +150s
  const detectSeconds = Math.max(
    0,
    Math.round((detectedAt.getTime() - occurredAt.getTime()) / 1000),
  );
  assert.equal(detectSeconds, 150);
});
check('coveragePct derivation: 100*passed/total', () => {
  const testsTotal = 200,
    testsPassed = 180;
  const coveragePct = Math.round((testsPassed / testsTotal) * 10000) / 100;
  assert.equal(coveragePct, 90);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.log('FAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
