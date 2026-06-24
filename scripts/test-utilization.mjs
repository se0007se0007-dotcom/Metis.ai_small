/**
 * SCENARIO 4 unit tests -- pure utilization-ranking logic.
 *
 * Tests buildUtilization() in apps/api/src/modules/dashboard/dashboard-aggregate.ts
 * WITHOUT a DB. The aggregate imports ./effectiveness, so we transpile both on
 * the fly with the local TypeScript and import the emitted JS.
 *
 * Run:  node scripts/test-utilization.mjs
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

function transpile(relPath, outName, dir) {
  const srcPath = new URL(relPath, import.meta.url);
  const src = readFileSync(srcPath, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: 'ESNext', target: 'ES2020' },
  }).outputText;
  const jsPath = join(dir, outName);
  writeFileSync(jsPath, out, 'utf8');
  return jsPath;
}

const dir = mkdtempSync(join(tmpdir(), 'util-'));
// effectiveness.mjs must exist next to the aggregate (it imports './effectiveness').
transpile('../apps/api/src/modules/dashboard/effectiveness.ts', 'effectiveness.mjs', dir);
// Patch the relative import so it resolves to the emitted .mjs file.
{
  const srcPath = new URL(
    '../apps/api/src/modules/dashboard/dashboard-aggregate.ts',
    import.meta.url,
  );
  const src = readFileSync(srcPath, 'utf8');
  let out = ts.transpileModule(src, {
    compilerOptions: { module: 'ESNext', target: 'ES2020' },
  }).outputText;
  out = out.replace(/(['"])\.\/effectiveness\1/g, "$1./effectiveness.mjs$1");
  writeFileSync(join(dir, 'dashboard-aggregate.mjs'), out, 'utf8');
}
const aggPath = join(dir, 'dashboard-aggregate.mjs');
const { buildUtilization } = await import(aggPath);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (err) {
    fail++;
    failures.push(name + ': ' + err.message);
    console.log('  FAIL  ' + name + ' -- ' + err.message);
  }
}

const mk = (key, executions, successRate = 90, avgScore = 80) => ({
  workflowKey: key,
  executions,
  successRate,
  avgScore,
});
const reg = (key, name) => ({ workflowKey: key, name });

console.log('SCENARIO 4 -- buildUtilization unit tests\n');

check('mostUsed = top 3 by executions desc', () => {
  const rolls = [mk('a', 10), mk('b', 50), mk('c', 30), mk('d', 5), mk('e', 100)];
  const regs = ['a', 'b', 'c', 'd', 'e'].map((k) => reg(k, 'name-' + k));
  const { mostUsed } = buildUtilization(rolls, regs);
  assert.deepEqual(
    mostUsed.map((m) => m.workflowKey),
    ['e', 'b', 'c'],
  );
  assert.equal(mostUsed[0].executions, 100);
  assert.equal(mostUsed[0].name, 'name-e');
});

check('leastUsed = bottom 3 by executions asc', () => {
  const rolls = [mk('a', 10), mk('b', 50), mk('c', 30), mk('d', 5), mk('e', 100)];
  const regs = ['a', 'b', 'c', 'd', 'e'].map((k) => reg(k, 'name-' + k));
  const { leastUsed } = buildUtilization(rolls, regs);
  assert.deepEqual(
    leastUsed.map((m) => m.workflowKey),
    ['d', 'a', 'c'],
  );
});

check('zero-execution (unused) registered agents surface in leastUsed', () => {
  // Only 'a' has executions; b,c,d are registered but never run.
  const rolls = [mk('a', 25)];
  const regs = [reg('a', 'Active'), reg('b', 'Unused-B'), reg('c', 'Unused-C'), reg('d', 'Unused-D')];
  const { leastUsed, mostUsed } = buildUtilization(rolls, regs);
  // bottom 3 should all be the 0-execution agents (b,c,d sorted by key)
  assert.deepEqual(
    leastUsed.map((m) => m.workflowKey),
    ['b', 'c', 'd'],
  );
  assert.equal(leastUsed.every((m) => m.executions === 0), true);
  // most used still has the active one first
  assert.equal(mostUsed[0].workflowKey, 'a');
  assert.equal(mostUsed[0].executions, 25);
});

check('tie-break is stable by workflowKey asc (most + least)', () => {
  // All equal executions -> deterministic ordering by key.
  const rolls = [mk('z', 7), mk('m', 7), mk('a', 7), mk('q', 7)];
  const regs = ['z', 'm', 'a', 'q'].map((k) => reg(k, k));
  const { mostUsed, leastUsed } = buildUtilization(rolls, regs);
  // mostUsed: executions equal -> key asc
  assert.deepEqual(
    mostUsed.map((m) => m.workflowKey),
    ['a', 'm', 'q'],
  );
  // leastUsed: executions equal -> key asc (same first three)
  assert.deepEqual(
    leastUsed.map((m) => m.workflowKey),
    ['a', 'm', 'q'],
  );
});

check('fewer than 3 agents -> safe (no padding, no crash)', () => {
  const rolls = [mk('a', 5), mk('b', 2)];
  const regs = [reg('a', 'A'), reg('b', 'B')];
  const { mostUsed, leastUsed } = buildUtilization(rolls, regs);
  assert.equal(mostUsed.length, 2);
  assert.equal(leastUsed.length, 2);
  assert.deepEqual(mostUsed.map((m) => m.workflowKey), ['a', 'b']);
  assert.deepEqual(leastUsed.map((m) => m.workflowKey), ['b', 'a']);
});

check('empty input -> empty rankings (no crash)', () => {
  const { mostUsed, leastUsed } = buildUtilization([], []);
  assert.equal(mostUsed.length, 0);
  assert.equal(leastUsed.length, 0);
});

check('registered agent with no rollup gets zeroed fields + name', () => {
  const { leastUsed } = buildUtilization([], [reg('ghost', 'Ghost Agent')]);
  assert.equal(leastUsed.length, 1);
  assert.equal(leastUsed[0].workflowKey, 'ghost');
  assert.equal(leastUsed[0].name, 'Ghost Agent');
  assert.equal(leastUsed[0].executions, 0);
  assert.equal(leastUsed[0].successRate, 0);
  assert.equal(leastUsed[0].avgScore, 0);
});

check('falls back to workflowKey as name when name missing', () => {
  // rollup-only agent not in registered list -> name == key
  const { mostUsed } = buildUtilization([mk('orphan', 99)], []);
  assert.equal(mostUsed[0].name, 'orphan');
});

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
