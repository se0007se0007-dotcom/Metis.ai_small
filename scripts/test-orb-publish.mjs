/**
 * SCENARIO 3 unit tests -- pure ORB approve->publish->visible logic.
 *
 * Mirrors (without a DB) two backend rules wired in this scenario:
 *   1) Catalog gate: dashboard.getAgents() filters workflow.findMany by
 *      { listed: true } unless includeUnlisted=true.
 *      (apps/api/src/modules/dashboard/dashboard.service.ts)
 *   2) Publish-on-verdict: orb.setVerdict() maps the ORB verdict to a
 *      Workflow lifecycle update keyed by OrbReview.agentKey == Workflow.key.
 *      (apps/api/src/modules/orb/orb.service.ts)
 *
 * These are extracted as pure functions here and asserted, then a tiny
 * end-to-end state machine proves: create(unlisted) -> submit -> approve ->
 * listed=true -> appears in catalog.
 *
 * Run:  node scripts/test-orb-publish.mjs
 * ASCII-only output.
 */
import assert from 'node:assert/strict';

// --- pure mirror of the catalog gate (dashboard.getAgents where-clause) ---
function catalogFilter(workflows, includeUnlisted = false) {
  return workflows.filter((w) => {
    if (w.deletedAt) return false;
    if (!includeUnlisted && w.listed !== true) return false;
    return true;
  });
}

// --- pure mirror of the verdict -> workflow update mapping (setVerdict) ---
function workflowPatchForVerdict(verdict) {
  const v = String(verdict).toLowerCase();
  if (v === 'approved') return { status: 'PUBLISHED', listed: true };
  if (v === 'rejected') return { listed: false };
  return null; // conditional: unchanged
}

let pass = 0;
const ok = (name) => {
  pass++;
  console.log('  PASS: ' + name);
};

console.log('SCENARIO 3 -- ORB approve->publish->visible (pure logic)\n');

// 1) catalog gate hides unlisted by default
{
  const wfs = [
    { key: 'seeded-a', listed: true, deletedAt: null },
    { key: 'user-b', listed: false, deletedAt: null },
    { key: 'deleted-c', listed: true, deletedAt: new Date() },
  ];
  const visible = catalogFilter(wfs).map((w) => w.key);
  assert.deepEqual(visible, ['seeded-a'], 'only listed & non-deleted appear');
  ok('catalog shows only listed=true (user-b hidden until approved)');

  const all = catalogFilter(wfs, true).map((w) => w.key);
  assert.deepEqual(all, ['seeded-a', 'user-b'], 'includeUnlisted shows unlisted too');
  ok('includeUnlisted=true still excludes deleted but shows unlisted (admin view)');
}

// 2) verdict mapping
{
  assert.deepEqual(workflowPatchForVerdict('approved'), { status: 'PUBLISHED', listed: true });
  assert.deepEqual(workflowPatchForVerdict('APPROVED'), { status: 'PUBLISHED', listed: true });
  ok('APPROVED -> { status: PUBLISHED, listed: true }');

  assert.deepEqual(workflowPatchForVerdict('rejected'), { listed: false });
  ok('REJECTED -> { listed: false }');

  assert.equal(workflowPatchForVerdict('conditional'), null);
  ok('CONDITIONAL -> no listing change');
}

// 3) end-to-end state machine: create -> submit -> approve -> visible
{
  // a) user builds a workflow (create path sets listed=false)
  let wf = { key: 'my-new-agent', status: 'DRAFT', listed: false, deletedAt: null };
  assert.equal(catalogFilter([wf]).length, 0, 'not visible before approval');
  ok('TEMP-REGISTER: new user workflow is DRAFT + listed=false (not in catalog)');

  // b) ORB review submitted (agentKey == workflow.key) and APPROVED
  const review = { agentKey: 'my-new-agent', verdict: 'approved' };
  assert.equal(review.agentKey, wf.key, 'review targets the workflow by key');
  const patch = workflowPatchForVerdict(review.verdict);
  wf = { ...wf, ...patch };

  // c) now visible to ALL in the Ops.AI catalog
  assert.equal(wf.status, 'PUBLISHED');
  assert.equal(wf.listed, true);
  assert.equal(catalogFilter([wf]).length, 1, 'visible after approval');
  ok('APPROVE -> PUBLISHED + listed -> appears in Ops.AI catalog for everyone');

  // d) a later REJECT delists it again
  const wf2 = { ...wf, ...workflowPatchForVerdict('rejected') };
  assert.equal(wf2.listed, false);
  assert.equal(catalogFilter([wf2]).length, 0, 'delisted on reject');
  ok('REJECT -> listed=false -> removed from catalog');
}

console.log('\nAll ' + pass + ' assertions passed.');
