// Pure-logic tests for FinOps semantic-cache cosine matching.
// ASCII only. Mirrors cosineSimilarity / bestCosineMatch in finops-pricing.ts.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function bestCosineMatch(q, cands) {
  let bi = -1, bs = -Infinity;
  for (let i = 0; i < (cands?.length || 0); i++) {
    const s = cosineSimilarity(q, cands[i]);
    if (s > bs) { bs = s; bi = i; }
  }
  return bi === -1 ? { index: -1, score: 0 } : { index: bi, score: bs };
}

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name); } }
function approx(a, b, eps=1e-9) { return Math.abs(a-b) <= eps; }

console.log("== cosineSimilarity ==");
ok("identical vectors -> 1", approx(cosineSimilarity([1,2,3],[1,2,3]), 1));
ok("scaled vector -> 1 (direction)", approx(cosineSimilarity([1,2,3],[2,4,6]), 1));
ok("orthogonal -> 0", approx(cosineSimilarity([1,0],[0,1]), 0));
ok("opposite -> -1", approx(cosineSimilarity([1,0],[-1,0]), -1));
ok("empty -> 0", cosineSimilarity([], []) === 0);
ok("length mismatch -> 0", cosineSimilarity([1,2],[1,2,3]) === 0);
ok("zero vector -> 0", cosineSimilarity([0,0],[1,1]) === 0);

console.log("== threshold (HIT/MISS @0.93) ==");
const THRESH = 0.93;
// near-duplicate (high cosine) should HIT
const q = [0.9, 0.1, 0.2, 0.05];
const near = [0.88, 0.12, 0.18, 0.06];
const far = [0.1, 0.9, -0.3, 0.4];
ok("near-duplicate cosine >= 0.93 -> HIT", cosineSimilarity(q, near) >= THRESH);
ok("dissimilar cosine < 0.93 -> MISS", cosineSimilarity(q, far) < THRESH);

console.log("== bestCosineMatch picks closest ==");
const cands = [far, near, [0.5,0.5,0.5,0.5]];
const best = bestCosineMatch(q, cands);
ok("best index = 1 (near)", best.index === 1);
ok("best score >= 0.93", best.score >= THRESH);
ok("no candidates -> index -1", bestCosineMatch(q, []).index === -1);

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
