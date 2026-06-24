/**
 * Hermes Autonomy Governance -- pure-logic unit tests (ASCII only, no deps).
 *
 * Mirrors the exported computeAutonomyRisk() in:
 *   apps/api/src/modules/ingest/hermes-governance.ts
 *
 * The risk model is re-implemented here (not imported from .ts) so the test
 * runs under plain `node` without a TS build. The logic and weights are
 * IDENTICAL to the source -- if you change one, change both.
 *
 * Run: node scripts/test-hermes-governance.mjs
 */
import assert from 'assert';

const RISKY_TOOL_NAMES = new Set([
  'execute_code',
  'shell',
  'browser',
  'browser_use',
  'file_write',
  'http',
]);

function isRiskyToolCall(call) {
  if (!call || typeof call !== 'object') return false;
  if (call.risky === true) return true;
  const name = typeof call.name === 'string' ? call.name.trim().toLowerCase() : '';
  return RISKY_TOOL_NAMES.has(name);
}

function clampCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function computeAutonomyRisk(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const skillsCreated = Array.isArray(m.skillsCreated) ? m.skillsCreated : [];
  const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];

  const newSkillCount = skillsCreated.length;
  const totalToolCalls = toolCalls.length;
  const riskyToolCallCount = toolCalls.filter((c) => isRiskyToolCall(c)).length;
  const memoryWriteCount = clampCount(m.memoryWrites);
  const memoryReadCount = clampCount(m.memoryReads);

  const skillScore = Math.min(50, newSkillCount * 25);
  const riskyToolScore = Math.min(45, riskyToolCallCount * 15);
  const memoryScore = Math.min(20, memoryWriteCount * 5);
  const volumeScore = Math.min(10, Math.floor(totalToolCalls / 3) * 2);

  const autonomyRiskScore = Math.min(
    100,
    skillScore + riskyToolScore + memoryScore + volumeScore,
  );

  let autonomyRiskLevel;
  if (autonomyRiskScore < 20) autonomyRiskLevel = 'low';
  else if (autonomyRiskScore < 45) autonomyRiskLevel = 'medium';
  else if (autonomyRiskScore < 70) autonomyRiskLevel = 'high';
  else autonomyRiskLevel = 'critical';

  const signals = [];
  if (newSkillCount > 0) signals.push('newskill:' + newSkillCount);
  if (riskyToolCallCount > 0) signals.push('riskytool:' + riskyToolCallCount);
  if (memoryWriteCount > 0) signals.push('memwrite:' + memoryWriteCount);
  if (memoryReadCount > 0) signals.push('memread:' + memoryReadCount);
  if (totalToolCalls > 0) signals.push('tools:' + totalToolCalls);

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

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + ' -- ' + e.message);
  }
}

console.log('Hermes Autonomy Governance -- computeAutonomyRisk');

// (a) benign run: no skills, only safe tools -> low, small score
check('(a) benign run is low risk', () => {
  const r = computeAutonomyRisk({
    skillsUsed: ['summarize'],
    skillsCreated: [],
    memoryReads: 1,
    memoryWrites: 0,
    toolCalls: [
      { name: 'search', ok: true },
      { name: 'calculator', ok: true },
    ],
  });
  assert.strictEqual(r.newSkillCount, 0);
  assert.strictEqual(r.riskyToolCallCount, 0);
  assert.strictEqual(r.totalToolCalls, 2);
  assert.strictEqual(r.memoryWriteCount, 0);
  assert.strictEqual(r.autonomyRiskLevel, 'low');
  // 2 tool calls -> floor(2/3)=0 volume -> score 0
  assert.strictEqual(r.autonomyRiskScore, 0);
});

// (b) 2 new skills + execute_code + 3 memory writes -> high/critical
check('(b) self-improving run is high/critical with correct counts', () => {
  const r = computeAutonomyRisk({
    skillsCreated: ['parse_invoice', 'auto_retry'],
    memoryReads: 2,
    memoryWrites: 3,
    toolCalls: [
      { name: 'execute_code', ok: true },
      { name: 'search', ok: true },
      { name: 'http', ok: true },
    ],
    sessionId: 'sess_b',
  });
  assert.strictEqual(r.newSkillCount, 2);
  assert.strictEqual(r.riskyToolCallCount, 2); // execute_code + http
  assert.strictEqual(r.totalToolCalls, 3);
  assert.strictEqual(r.memoryWriteCount, 3);
  // skill min(50,50)=50 + risky min(45,30)=30 + mem min(20,15)=15 + vol min(10,floor(3/3)*2=2)=2 = 97
  assert.strictEqual(r.autonomyRiskScore, 97);
  assert.strictEqual(r.autonomyRiskLevel, 'critical');
  assert.ok(r.signals.includes('newskill:2'));
  assert.ok(r.signals.includes('riskytool:2'));
  assert.ok(r.signals.includes('memwrite:3'));
});

// (b2) high (not critical) boundary
check('(b2) 1 new skill + 1 risky tool -> medium/high band', () => {
  const r = computeAutonomyRisk({
    skillsCreated: ['x'],
    toolCalls: [{ name: 'shell' }],
  });
  // 25 + 15 + 0 + 0 = 40 -> medium (<45)
  assert.strictEqual(r.autonomyRiskScore, 40);
  assert.strictEqual(r.autonomyRiskLevel, 'medium');
});

// (c) risky flag via meta.risky === true (name not in set)
check('(c) explicit risky flag forces risky tool', () => {
  const r = computeAutonomyRisk({
    skillsCreated: [],
    toolCalls: [
      { name: 'custom_internal_tool', risky: true },
      { name: 'custom_internal_tool', risky: false },
      { name: 'safe' },
    ],
  });
  assert.strictEqual(r.riskyToolCallCount, 1);
  assert.strictEqual(r.totalToolCalls, 3);
  // risky 15 + vol floor(3/3)*2=2 = 17 -> low (<20)
  assert.strictEqual(r.autonomyRiskScore, 17);
  assert.strictEqual(r.autonomyRiskLevel, 'low');
});

// (d) caps: 5 new skills capped at 50; risky capped at 45; mem capped at 20
check('(d) contributions are capped', () => {
  const r = computeAutonomyRisk({
    skillsCreated: ['a', 'b', 'c', 'd', 'e'], // 5*25=125 -> cap 50
    memoryWrites: 10, // 10*5=50 -> cap 20
    toolCalls: [
      { name: 'execute_code' },
      { name: 'shell' },
      { name: 'browser' },
      { name: 'http' }, // 4 risky * 15 = 60 -> cap 45
      { name: 'file_write' },
      { name: 'safe1' },
      { name: 'safe2' },
      { name: 'safe3' }, // total 8 -> vol floor(8/3)*2 = 2*2=4
    ],
  });
  assert.strictEqual(r.newSkillCount, 5);
  assert.strictEqual(r.riskyToolCallCount, 5);
  assert.strictEqual(r.totalToolCalls, 8);
  assert.strictEqual(r.memoryWriteCount, 10);
  // 50 + 45 + 20 + 4 = 119 -> cap 100
  assert.strictEqual(r.autonomyRiskScore, 100);
  assert.strictEqual(r.autonomyRiskLevel, 'critical');
});

// (e) tolerant of empty/missing meta
check('(e) empty meta yields zeroed low result', () => {
  const r = computeAutonomyRisk(undefined);
  assert.strictEqual(r.autonomyRiskScore, 0);
  assert.strictEqual(r.autonomyRiskLevel, 'low');
  assert.deepStrictEqual(r.signals, []);
});

console.log('');
console.log('pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
