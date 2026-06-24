/**
 * OPS effectiveness unit tests (per-agent + per-system metrics).
 *
 * Tests (no DB; transpile the pure TS sources on the fly):
 *   - effectiveness.ts        : timeSavedPct (30->10 => 66.7), aiMinutesPerRun
 *   - effectiveness-ops.ts     : computeMttrByAgent (avg hours + resolved/open),
 *                                computeMttdMinutes
 *   - bySystem rollup (re-implemented inline to mirror the service)
 *
 * Run:  node scripts/test-effectiveness-ops.mjs   (ASCII-only output)
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

const { computeEffectiveness } = await loadTs(
  '../apps/api/src/modules/dashboard/effectiveness.ts',
  'effectiveness',
);
const { computeMttrByAgent, computeMttdMinutes } = await loadTs(
  '../apps/api/src/modules/dashboard/effectiveness-ops.ts',
  'effectiveness-ops',
);

let pass = 0;
let fail = 0;
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

// 1) timeSavedPct: manual 30min, 5 runs, agent total 50min => 10min/run => 66.7%
check('timeSavedPct 30->10 = 66.7 and aiMinutesPerRun=10', () => {
  const r = computeEffectiveness(
    { executions: 5, successCount: 5, actualAgentMinutes: 50, costUsd: 0 },
    { manualMinutesPerRun: 30 },
  );
  assert.equal(r.aiMinutesPerRun, 10);
  assert.equal(r.timeSavedPct, 66.7);
});

// 2) timeSavedPct clamps to 0 when agent slower than manual baseline
check('timeSavedPct clamped to 0 when slower', () => {
  const r = computeEffectiveness(
    { executions: 2, successCount: 2, actualAgentMinutes: 200, costUsd: 0 },
    { manualMinutesPerRun: 30 },
  );
  assert.equal(r.aiMinutesPerRun, 100);
  assert.equal(r.timeSavedPct, 0);
});

// 3) system passthrough
check('system passthrough', () => {
  const r = computeEffectiveness(
    { executions: 1, successCount: 1, actualAgentMinutes: 5, costUsd: 0 },
    { manualMinutesPerRun: 30, system: 'CI/CD' },
  );
  assert.equal(r.system, 'CI/CD');
  const r2 = computeEffectiveness(
    { executions: 1, successCount: 1, actualAgentMinutes: 5, costUsd: 0 },
    { manualMinutesPerRun: 30 },
  );
  assert.equal(r2.system, null);
});

// 4) aiMinutesPerRun 0 when no executions
check('aiMinutesPerRun=0 when executions=0', () => {
  const r = computeEffectiveness(
    { executions: 0, successCount: 0, actualAgentMinutes: 0, costUsd: 0 },
    { manualMinutesPerRun: 30 },
  );
  assert.equal(r.aiMinutesPerRun, 0);
  assert.equal(r.timeSavedPct, 0);
});

// 5) computeMttrByAgent: avg hours + resolved/open counts grouped by workflowKey
check('computeMttrByAgent avg + counts', () => {
  const base = new Date('2026-06-01T00:00:00Z').getTime();
  const h = (n) => new Date(base + n * 3600000);
  const alerts = [
    // agent A: two resolved (2h and 4h => avg 3h), one open
    { status: 'RESOLVED', createdAt: h(0), resolvedAt: h(2), detailsJson: { workflowKey: 'A' } },
    { status: 'RESOLVED', createdAt: h(0), resolvedAt: h(4), detailsJson: { workflowKey: 'A' } },
    { status: 'OPEN', createdAt: h(0), resolvedAt: null, detailsJson: { workflowKey: 'A' } },
    // agent B: one open only -> mttrHours null
    { status: 'OPEN', createdAt: h(0), resolvedAt: null, detailsJson: { workflowKey: 'B' } },
    // no workflowKey -> skipped
    { status: 'RESOLVED', createdAt: h(0), resolvedAt: h(1), detailsJson: {} },
  ];
  const m = computeMttrByAgent(alerts);
  assert.equal(m.A.mttrHours, 3);
  assert.equal(m.A.resolvedCount, 2);
  assert.equal(m.A.openCount, 1);
  assert.equal(m.B.mttrHours, null);
  assert.equal(m.B.resolvedCount, 0);
  assert.equal(m.B.openCount, 1);
  assert.equal(Object.keys(m).length, 2);
});

// 6) computeMttdMinutes: mean latency ms -> minutes; null on empty
check('computeMttdMinutes mean ms->min', () => {
  // 60000ms=1min, 120000ms=2min => avg 1.5 min
  assert.equal(computeMttdMinutes([60000, 120000]), 1.5);
  assert.equal(computeMttdMinutes([]), null);
  assert.equal(computeMttdMinutes([null, undefined, -5]), null);
});

// 7) bySystem rollup (mirror of service logic)
check('bySystem rollup sums/avgs', () => {
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;
  const agents = [
    { system: 'S1', timeSavedPct: 60, timeSavedHours: 2, roi: { netValueUsd: 100 }, mttr: { actualHours: 2 } },
    { system: 'S1', timeSavedPct: 80, timeSavedHours: 3, roi: { netValueUsd: 50 }, mttr: { actualHours: 4 } },
    { system: 'S2', timeSavedPct: 40, timeSavedHours: 1, roi: { netValueUsd: 25 }, mttr: { actualHours: null } },
  ];
  const sysMap = new Map();
  for (const a of agents) {
    let g = sysMap.get(a.system);
    if (!g) { g = { agentCount: 0, totalTimeSavedHours: 0, pcts: [], totalNetValueUsd: 0, mttrs: [] }; sysMap.set(a.system, g); }
    g.agentCount += 1;
    g.totalTimeSavedHours += a.timeSavedHours;
    g.pcts.push(a.timeSavedPct);
    g.totalNetValueUsd += a.roi.netValueUsd;
    if (a.mttr.actualHours != null) g.mttrs.push(a.mttr.actualHours);
  }
  const bySystem = Array.from(sysMap.entries()).map(([system, g]) => ({
    system,
    agentCount: g.agentCount,
    totalTimeSavedHours: r2(g.totalTimeSavedHours),
    avgTimeSavedPct: g.pcts.length ? r1(g.pcts.reduce((s, x) => s + x, 0) / g.pcts.length) : 0,
    totalNetValueUsd: r2(g.totalNetValueUsd),
    avgMttrHours: g.mttrs.length ? r2(g.mttrs.reduce((s, x) => s + x, 0) / g.mttrs.length) : null,
  }));
  const s1 = bySystem.find((x) => x.system === 'S1');
  const s2 = bySystem.find((x) => x.system === 'S2');
  assert.equal(s1.agentCount, 2);
  assert.equal(s1.totalTimeSavedHours, 5);
  assert.equal(s1.avgTimeSavedPct, 70);
  assert.equal(s1.totalNetValueUsd, 150);
  assert.equal(s1.avgMttrHours, 3);
  assert.equal(s2.avgMttrHours, null);
});

console.log('');
console.log('RESULT  pass=' + pass + ' fail=' + fail);
if (fail) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
