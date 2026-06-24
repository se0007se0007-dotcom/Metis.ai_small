/**
 * SCENARIO 2 unit tests — pure effectiveness/trend logic.
 *
 * Tests apps/api/src/modules/dashboard/effectiveness.ts WITHOUT a DB.
 * The TS source has no NestJS/Prisma imports, so we transpile it on the fly
 * with the local TypeScript and import the emitted JS.
 *
 * Run:  node scripts/test-effectiveness.mjs
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

const srcPath = new URL('../apps/api/src/modules/dashboard/effectiveness.ts', import.meta.url);
const src = readFileSync(srcPath, 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: { module: 'ESNext', target: 'ES2020' },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), 'eff-'));
const jsPath = join(dir, 'effectiveness.mjs');
writeFileSync(jsPath, out, 'utf8');
const { computeEffectiveness, computeTrend } = await import(jsPath);

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

// ---- computeEffectiveness ----

check('time saved math: 10 successful runs * 30min manual = 5h human, minus 1h agent = 4h', () => {
  // 10 success * 30 min = 300 human-min = 5h. actualAgentMinutes 60 = 1h. saved = 4h.
  const r = computeEffectiveness(
    { executions: 12, successCount: 10, actualAgentMinutes: 60, costUsd: 20 },
    { manualMinutesPerRun: 30 },
  );
  assert.equal(r.timeSavedHours, 4);
  assert.equal(r.actualAgentHours, 1);
  assert.equal(r.successCount, 10);
  assert.equal(r.manualMinutesPerRun, 30);
});

check('ROI: 4h saved * $50/h = $200 labor; net = 200 - 20 = 180; ratio = 10', () => {
  const r = computeEffectiveness(
    { executions: 12, successCount: 10, actualAgentMinutes: 60, costUsd: 20 },
    { manualMinutesPerRun: 30 },
  );
  assert.equal(r.roi.hourlyRateUsd, 50);
  assert.equal(r.roi.laborValueUsd, 200);
  assert.equal(r.roi.netValueUsd, 180);
  assert.equal(r.roi.ratio, 10);
});

check('floor at 0: agent slower than manual yields 0 saved (never negative)', () => {
  // 1 success * 10 min = 10 human-min; agent ran 600 min. saved would be negative -> floored 0.
  const r = computeEffectiveness(
    { executions: 1, successCount: 1, actualAgentMinutes: 600, costUsd: 5 },
    { manualMinutesPerRun: 10 },
  );
  assert.equal(r.timeSavedHours, 0);
  assert.equal(r.roi.laborValueUsd, 0);
});

check('cost 0 -> ratio null (no divide-by-zero)', () => {
  const r = computeEffectiveness(
    { executions: 5, successCount: 5, actualAgentMinutes: 0, costUsd: 0 },
    { manualMinutesPerRun: 60 },
  );
  assert.equal(r.roi.ratio, null);
  assert.equal(r.costUsd, 0);
});

check('custom hourly rate honored', () => {
  const r = computeEffectiveness(
    { executions: 2, successCount: 2, actualAgentMinutes: 0, costUsd: 10 },
    { manualMinutesPerRun: 60, hourlyRateUsd: 100 },
  );
  // 2 * 60 min = 2h * $100 = $200
  assert.equal(r.roi.laborValueUsd, 200);
  assert.equal(r.roi.hourlyRateUsd, 100);
});

check('targets pass through, labeled (coverageTargetX/mttdTargetPct/valueLabel)', () => {
  const r = computeEffectiveness(
    { executions: 1, successCount: 1, actualAgentMinutes: 0, costUsd: 1 },
    { manualMinutesPerRun: 30, coverageTargetX: 3, mttdTargetPct: 40, valueLabel: 'sec' },
  );
  assert.equal(r.coverageTargetX, 3);
  assert.equal(r.mttdTargetPct, 40);
  assert.equal(r.valueLabel, 'sec');
});

check('missing targets -> null', () => {
  const r = computeEffectiveness(
    { executions: 1, successCount: 1, actualAgentMinutes: 0, costUsd: 1 },
    { manualMinutesPerRun: 30 },
  );
  assert.equal(r.coverageTargetX, null);
  assert.equal(r.mttdTargetPct, null);
  assert.equal(r.valueLabel, null);
});

// ---- computeTrend ----

check('quality up = improving', () => {
  const t = computeTrend({
    current: { overallScore: [90, 90], securityScore: [], costPerRun: [], successRate: 0 },
    previous: { overallScore: [80, 80], securityScore: [], costPerRun: [], successRate: 0 },
  });
  assert.equal(t.quality.current, 90);
  assert.equal(t.quality.previous, 80);
  assert.equal(t.quality.direction, 'up');
  assert.equal(t.quality.deltaPct, 12.5); // (90-80)/80*100
});

check('quality down', () => {
  const t = computeTrend({
    current: { overallScore: [70], securityScore: [], costPerRun: [], successRate: 0 },
    previous: { overallScore: [80], securityScore: [], costPerRun: [], successRate: 0 },
  });
  assert.equal(t.quality.direction, 'down');
  assert.equal(t.quality.deltaPct, -12.5);
});

check('flat when equal', () => {
  const t = computeTrend({
    current: { overallScore: [80], securityScore: [], costPerRun: [], successRate: 0 },
    previous: { overallScore: [80], securityScore: [], costPerRun: [], successRate: 0 },
  });
  assert.equal(t.quality.direction, 'flat');
  assert.equal(t.quality.deltaPct, 0);
});

check('cost direction down is improving (costInverted note exposed)', () => {
  const t = computeTrend({
    current: { overallScore: [], securityScore: [], costPerRun: [1, 1], successRate: 0 },
    previous: { overallScore: [], securityScore: [], costPerRun: [2, 2], successRate: 0 },
  });
  // cost went 2 -> 1: direction 'down' (which is GOOD for cost)
  assert.equal(t.cost.direction, 'down');
  assert.equal(t.costImprovingDirection, 'down');
});

check('security + success trend computed', () => {
  const t = computeTrend({
    current: { overallScore: [], securityScore: [95], costPerRun: [], successRate: 99 },
    previous: { overallScore: [], securityScore: [90], costPerRun: [], successRate: 90 },
  });
  assert.equal(t.security.direction, 'up');
  assert.equal(t.success.direction, 'up');
  assert.equal(t.success.current, 99);
});

check('empty series safe: all flat, deltaPct null (previous 0)', () => {
  const t = computeTrend({
    current: { overallScore: [], securityScore: [], costPerRun: [], successRate: 0 },
    previous: { overallScore: [], securityScore: [], costPerRun: [], successRate: 0 },
  });
  assert.equal(t.quality.direction, 'flat');
  assert.equal(t.quality.deltaPct, null);
  assert.equal(t.cost.deltaPct, null);
});

check('previous 0 but current >0 -> direction up, deltaPct null (cannot divide)', () => {
  const t = computeTrend({
    current: { overallScore: [50], securityScore: [], costPerRun: [], successRate: 0 },
    previous: { overallScore: [0], securityScore: [], costPerRun: [], successRate: 0 },
  });
  assert.equal(t.quality.direction, 'up');
  assert.equal(t.quality.deltaPct, null);
});

check('undefined series handled without throwing', () => {
  const t = computeTrend(undefined);
  assert.equal(t.quality.direction, 'flat');
});

console.log(`\nSCENARIO 2 effectiveness unit tests: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
