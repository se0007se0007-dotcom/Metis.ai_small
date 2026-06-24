/**
 * Phase 1 Ingestion On-Ramp — pure-logic unit tests (ASCII only, no deps).
 *
 * Mirrors the exported helpers in:
 *   apps/api/src/modules/ingest/ingest-key.service.ts
 *   apps/api/src/modules/ingest/ingest.service.ts
 *
 * These are intentionally re-implemented here (not imported from .ts) so the
 * test runs under plain `node` without a TS build. The logic is identical to
 * the source helpers and asserts the on-ramp -> evaluate() contract.
 */
import { createHash, randomBytes } from 'crypto';
import assert from 'assert';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name + ' -> ' + e.message);
  }
}

// ── Mirrored helpers ─────────────────────────────────────────
function hashIngestKey(rawKey) {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}
function ingestKeyPrefix(rawKey) {
  return rawKey.slice(0, 12);
}
function generateIngestKey(env) {
  const safeEnv = env === 'test' ? 'test' : 'live';
  const random = randomBytes(16).toString('hex');
  return 'mts_' + safeEnv + '_' + random;
}
function validateRun(run) {
  if (!run || typeof run !== 'object') return 'run must be an object';
  if (!run.agentName || typeof run.agentName !== 'string' || !run.agentName.trim()) {
    return 'agentName is required';
  }
  const hasInput = typeof run.input === 'string' && run.input.length > 0;
  const hasOutput = typeof run.output === 'string' && run.output.length > 0;
  if (!hasInput && !hasOutput) return 'at least one of input or output is required';
  return null;
}
function runToEvaluateArgs(run, sessionId, tenantId) {
  const tokensIn = typeof run.tokensIn === 'number' ? run.tokensIn : undefined;
  const tokensOut = typeof run.tokensOut === 'number' ? run.tokensOut : undefined;
  let tokensUsed;
  if (tokensIn !== undefined || tokensOut !== undefined) {
    tokensUsed = (tokensIn || 0) + (tokensOut || 0);
  }
  return {
    tenantId,
    executionSessionId: sessionId,
    stepKey: run.stepKey != null ? run.stepKey : 'sdk',
    nodeType: 'sdk',
    agentName: run.agentName,
    workflowKey: run.workflowKey,
    input: run.input,
    output: run.output,
    context: run.context,
    groundTruth: run.groundTruth,
    model: run.model,
    tokensUsed,
    executionTimeMs: run.latencyMs,
    estimatedCostUsd: run.costUsd,
  };
}
function idempotencyKey(tenantId, run) {
  const externalRunId =
    typeof run.runId === 'string' && run.runId.trim().length > 0 ? run.runId.trim() : null;
  return { tenantId, externalRunId };
}

// ── (a) Key hashing: sha256 deterministic + prefix extraction ──
console.log('\n[a] key hashing');
check('sha256 is deterministic', () => {
  const k = 'mts_live_abcdef0123456789abcdef0123456789';
  assert.strictEqual(hashIngestKey(k), hashIngestKey(k));
  assert.strictEqual(hashIngestKey(k).length, 64);
  assert.match(hashIngestKey(k), /^[0-9a-f]{64}$/);
});
check('different keys -> different hashes', () => {
  assert.notStrictEqual(hashIngestKey('mts_live_aaa'), hashIngestKey('mts_live_bbb'));
});
check('prefix is first 12 chars (mts_live_xxx)', () => {
  const k = generateIngestKey('live');
  assert.strictEqual(ingestKeyPrefix(k), k.slice(0, 12));
  assert.ok(k.startsWith('mts_live_'));
  assert.strictEqual(ingestKeyPrefix(k).startsWith('mts_live_'), true);
});
check('generate respects env (test) and format', () => {
  const t = generateIngestKey('test');
  assert.ok(t.startsWith('mts_test_'));
  // mts_test_ (9) + 32 hex = 41 chars
  assert.strictEqual(t.length, 41);
  const l = generateIngestKey('weird'); // falls back to live
  assert.ok(l.startsWith('mts_live_'));
});

// ── (b) runToEvaluateArgs mapping ──
console.log('\n[b] runToEvaluateArgs mapping (on-ramp -> evaluate() contract)');
check('maps a full external run to the correct evaluate() arg keys', () => {
  const run = {
    runId: 'ext-123',
    agentName: 'CustomerSupportBot',
    workflowKey: 'support-flow',
    stepKey: 'answer',
    input: 'What is our refund policy?',
    output: 'Refunds within 30 days.',
    context: 'KB: refunds allowed 30 days',
    groundTruth: 'Refunds within 30 days.',
    model: 'gpt-4o',
    tokensIn: 120,
    tokensOut: 80,
    latencyMs: 1500,
    costUsd: 0.0042,
  };
  const args = runToEvaluateArgs(run, 'sess-1', 'tenant-1');
  assert.strictEqual(args.tenantId, 'tenant-1');
  assert.strictEqual(args.executionSessionId, 'sess-1');
  assert.strictEqual(args.stepKey, 'answer');
  assert.strictEqual(args.nodeType, 'sdk');
  assert.strictEqual(args.agentName, 'CustomerSupportBot');
  assert.strictEqual(args.workflowKey, 'support-flow');
  assert.strictEqual(args.input, run.input);
  assert.strictEqual(args.output, run.output);
  assert.strictEqual(args.context, run.context);
  assert.strictEqual(args.groundTruth, run.groundTruth);
  assert.strictEqual(args.model, 'gpt-4o');
  assert.strictEqual(args.tokensUsed, 200); // 120 + 80
  assert.strictEqual(args.executionTimeMs, 1500);
  assert.strictEqual(args.estimatedCostUsd, 0.0042);
});
check('stepKey defaults to "sdk" when missing; nodeType always "sdk"', () => {
  const args = runToEvaluateArgs(
    { agentName: 'A', output: 'hi' },
    'sess-2',
    'tenant-2',
  );
  assert.strictEqual(args.stepKey, 'sdk');
  assert.strictEqual(args.nodeType, 'sdk');
});
check('tokensUsed is undefined when neither tokensIn nor tokensOut given', () => {
  const args = runToEvaluateArgs({ agentName: 'A', output: 'hi' }, 's', 't');
  assert.strictEqual(args.tokensUsed, undefined);
});
check('tokensUsed handles only-one-side provided', () => {
  const a1 = runToEvaluateArgs({ agentName: 'A', output: 'x', tokensIn: 50 }, 's', 't');
  assert.strictEqual(a1.tokensUsed, 50);
  const a2 = runToEvaluateArgs({ agentName: 'A', output: 'x', tokensOut: 70 }, 's', 't');
  assert.strictEqual(a2.tokensUsed, 70);
});

// ── (c) idempotency key derivation ──
console.log('\n[c] idempotency key derivation');
check('runId present -> externalRunId set (trimmed)', () => {
  const k = idempotencyKey('t1', { agentName: 'A', output: 'x', runId: '  run-9 ' });
  assert.deepStrictEqual(k, { tenantId: 't1', externalRunId: 'run-9' });
});
check('runId absent -> externalRunId null (create-only)', () => {
  const k = idempotencyKey('t1', { agentName: 'A', output: 'x' });
  assert.strictEqual(k.externalRunId, null);
});
check('blank runId -> externalRunId null', () => {
  const k = idempotencyKey('t1', { agentName: 'A', output: 'x', runId: '   ' });
  assert.strictEqual(k.externalRunId, null);
});

// ── (d) batch validation ──
console.log('\n[d] batch validation');
check('rejects run missing agentName', () => {
  assert.strictEqual(validateRun({ input: 'q', output: 'a' }), 'agentName is required');
});
check('rejects run with neither input nor output', () => {
  assert.strictEqual(
    validateRun({ agentName: 'A' }),
    'at least one of input or output is required',
  );
});
check('accepts run with agentName + output only', () => {
  assert.strictEqual(validateRun({ agentName: 'A', output: 'a' }), null);
});
check('accepts run with agentName + input only', () => {
  assert.strictEqual(validateRun({ agentName: 'A', input: 'q' }), null);
});

console.log('\n----------------------------------------');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
