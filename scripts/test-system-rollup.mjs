/**
 * Per-system OPS rollup unit tests (usage / error / security).
 *
 * Tests rollupSystemsOps from effectiveness-ops.ts (no DB; transpile pure TS):
 *   - executions summed per system
 *   - successRate = sum(successful)/sum(executions)*100 (1dp)
 *   - failedCount summed; errorRate = failed/executions*100 (1dp)
 *   - securityIssueCount + criticalSecurityCount summed
 *   - agentCount = distinct workflowKeys per system
 *   - UNASSIGNED fallback for blank system
 *   - zero-execution system => successRate/errorRate 0
 *
 * Run:  node scripts/test-system-rollup.mjs   (ASCII-only output)
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

function loadTs(rel, name) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: 'ESNext', target: 'ES2020' },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), name + '-'));
  const jsPath = join(dir, name + '.mjs');
  writeFileSync(jsPath, out, 'utf8');
  return import(jsPath);
}

const { rollupSystemsOps } = await loadTs(
  '../apps/api/src/modules/dashboard/effectiveness-ops.ts',
  'effectiveness-ops',
);

let pass = 0;
function ok(name) {
  pass++;
  console.log('  PASS - ' + name);
}

// ── fixture: 2 agents in "CICD", 1 in "Monitor", 1 blank (=> UNASSIGNED) ──
const stats = [
  {
    workflowKey: 'a1',
    system: 'CICD',
    executions: 100,
    successfulCount: 90,
    failedCount: 10,
    securityIssueCount: 3,
    criticalSecurityCount: 1,
  },
  {
    workflowKey: 'a2',
    system: 'CICD',
    executions: 100,
    successfulCount: 80,
    failedCount: 20,
    securityIssueCount: 2,
    criticalSecurityCount: 0,
  },
  {
    workflowKey: 'b1',
    system: 'Monitor',
    executions: 50,
    successfulCount: 50,
    failedCount: 0,
    securityIssueCount: 0,
    criticalSecurityCount: 0,
  },
  {
    workflowKey: 'c1',
    system: '',
    executions: 0,
    successfulCount: 0,
    failedCount: 0,
    securityIssueCount: 5,
    criticalSecurityCount: 2,
  },
];

const out = rollupSystemsOps(stats);

// CICD
assert.equal(out['CICD'].executions, 200, 'CICD executions sum');
ok('CICD executions summed (100+100=200)');
assert.equal(out['CICD'].failedCount, 30, 'CICD failed sum');
ok('CICD failedCount summed (10+20=30)');
// successRate = (90+80)/200*100 = 85.0
assert.equal(out['CICD'].successRate, 85, 'CICD successRate');
ok('CICD successRate = 85.0');
// errorRate = 30/200*100 = 15.0
assert.equal(out['CICD'].errorRate, 15, 'CICD errorRate');
ok('CICD errorRate = 15.0');
assert.equal(out['CICD'].securityIssueCount, 5, 'CICD sec issues 3+2');
ok('CICD securityIssueCount = 5');
assert.equal(out['CICD'].criticalSecurityCount, 1, 'CICD critical 1+0');
ok('CICD criticalSecurityCount = 1');
assert.equal(out['CICD'].agentCount, 2, 'CICD agentCount distinct keys');
ok('CICD agentCount = 2 (distinct workflowKeys)');

// Monitor: 50 exec, 0 failed => successRate 100, errorRate 0
assert.equal(out['Monitor'].successRate, 100, 'Monitor successRate 100');
assert.equal(out['Monitor'].errorRate, 0, 'Monitor errorRate 0');
ok('Monitor successRate=100 errorRate=0');

// blank system => UNASSIGNED bucket, 0 exec => rates 0, but security still counted
assert.ok(out['미지정'], 'UNASSIGNED bucket exists');
assert.equal(out['미지정'].executions, 0, 'UNASSIGNED 0 exec');
assert.equal(out['미지정'].successRate, 0, 'UNASSIGNED successRate 0 (no exec)');
assert.equal(out['미지정'].errorRate, 0, 'UNASSIGNED errorRate 0 (no exec)');
assert.equal(out['미지정'].securityIssueCount, 5, 'UNASSIGNED sec counted');
assert.equal(out['미지정'].criticalSecurityCount, 2, 'UNASSIGNED critical counted');
ok('blank system => UNASSIGNED, 0-exec rates=0, security still counted');

// rounding: 1 success of 3 => 33.3
const r = rollupSystemsOps([
  {
    workflowKey: 'x',
    system: 'S',
    executions: 3,
    successfulCount: 1,
    failedCount: 2,
    securityIssueCount: 0,
    criticalSecurityCount: 0,
  },
]);
assert.equal(r['S'].successRate, 33.3, 'rounding successRate 1dp');
assert.equal(r['S'].errorRate, 66.7, 'rounding errorRate 1dp');
ok('rounding to 1 decimal (33.3 / 66.7)');

// empty input => empty object
assert.deepEqual(rollupSystemsOps([]), {}, 'empty in => empty out');
ok('empty input => empty rollup');

console.log('\nALL ' + pass + ' system-rollup assertions passed.');
