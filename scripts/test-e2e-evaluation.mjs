/**
 * Phase 4 — E2E 전수 평가 테스트 (실 서버 대상)
 *
 * 14 Agent × 4 시나리오 × N회(기본 3) = 168건을 POST /evaluator/demo 로 평가하고
 * Golden Dataset의 기대치와 비교해 다음을 리포트한다:
 *   1) 정확도   : good=A(80+), hallucination/security/poor=F(<45)
 *   2) 일관성   : 동일 (agent,scenario) 반복 점수 편차 ≤ 5점
 *   3) 보안 탐지율 : security 시나리오에서 securityRiskLevel high/critical 비율
 *   4) 품질 구분력 : good 평균 - poor 평균 ≥ 50점
 *   5) 비용     : LLM Judge 호출 비용(있으면) 집계
 *
 * 사용법 (start-metis.bat 기동 후):
 *   node scripts/test-e2e-evaluation.mjs
 *   node scripts/test-e2e-evaluation.mjs --repeat 3 --out e2e-report.json
 *
 * 주의: LLM Judge가 실제로 동작하려면 .env에 ANTHROPIC_API_KEY 또는 OPENAI_API_KEY가
 * 설정돼 있어야 합니다. 키가 없으면 Layer 0(통계) 기준으로 평가되며, 환각 판정 정확도가
 * 낮아질 수 있습니다(리포트에 judgeAvailable=false로 표기).
 */

import { GOLDEN_CASES, SCENARIOS, AGENTS } from './golden-dataset.mjs';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = arg('base', 'http://localhost:4000/v1');
const EMAIL = arg('email', 'admin@metis.ai');
const PASSWORD = arg('password', 'metis1234');
const REPEAT = Math.max(1, parseInt(arg('repeat', '3'), 10));
const OUT = arg('out', null);

let token = null;
async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}
async function login() {
  const { status, json } = await req('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  if (status >= 200 && status < 300 && json) {
    token = json.accessToken || json.access_token || json.token || null;
    return !!token;
  }
  return false;
}

function gradeFromOverall(o) {
  return o >= 90 ? 'A' : o >= 80 ? 'B' : o >= 70 ? 'C' : o >= 60 ? 'D' : 'F';
}
function avg(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function stdev(a) {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)));
}
function range(a) {
  return a.length ? Math.max(...a) - Math.min(...a) : 0;
}

async function main() {
  console.log(`\n▶ E2E 평가 전수 테스트`);
  console.log(
    `  Base: ${BASE} | 케이스: ${GOLDEN_CASES.length} × ${REPEAT}회 = ${GOLDEN_CASES.length * REPEAT}건\n`,
  );

  if (!(await login())) {
    console.error('❌ 로그인 실패');
    process.exit(2);
  }
  console.log('🔑 로그인 성공\n실행 중...\n');

  // raw results keyed by "agentId::scenario"
  const runs = new Map();
  let judgeUsedCount = 0,
    totalCost = 0,
    judgeAvailable = false;
  let done = 0;
  const total = GOLDEN_CASES.length * REPEAT;

  for (const c of GOLDEN_CASES) {
    const key = `${c.agentId}::${c.scenario}`;
    if (!runs.has(key)) runs.set(key, []);
    for (let r = 0; r < REPEAT; r++) {
      const { status, json } = await req('POST', '/evaluator/demo', {
        input: c.input,
        output: c.output,
        context: c.context,
        agentName: c.agentName,
      });
      if (status === 200 && json) {
        runs.get(key).push(json);
        if (Array.isArray(json.gatesApplied) && json.gatesApplied.includes('llm-judge')) {
          judgeUsedCount++;
          judgeAvailable = true;
        }
        if (typeof json.estimatedCostUsd === 'number') totalCost += json.estimatedCostUsd;
      } else {
        runs.get(key).push({ error: true, status });
      }
      done++;
      if (done % 20 === 0) process.stdout.write(`  ...${done}/${total}\n`);
    }
  }

  // ── Aggregate per (agent,scenario) ──
  const perCase = [];
  for (const c of GOLDEN_CASES) {
    const key = `${c.agentId}::${c.scenario}`;
    const results = (runs.get(key) || []).filter((x) => !x.error);
    const scores = results.map((x) => x.overallScore).filter((n) => typeof n === 'number');
    const secLevels = results.map((x) => x.securityRiskLevel);
    const meanScore = avg(scores);
    const grade = gradeFromOverall(meanScore);

    const exp = c.expected;
    const accuratePass =
      c.scenario === 'good' ? meanScore >= exp.overallMin : meanScore <= exp.overallMax;
    const securityPass = exp.securityHigh
      ? secLevels.some((l) => l === 'high' || l === 'critical')
      : true;
    const consistencyPass = range(scores) <= 5;

    perCase.push({
      agentId: c.agentId,
      scenario: c.scenario,
      meanScore: Math.round(meanScore * 10) / 10,
      grade,
      scoreRange: Math.round(range(scores) * 10) / 10,
      stdev: Math.round(stdev(scores) * 100) / 100,
      securityDetected: secLevels.filter((l) => l === 'high' || l === 'critical').length,
      runCount: results.length,
      accuratePass,
      securityPass,
      consistencyPass,
      expectedGrade: exp.grade,
    });
  }

  // ── Metrics ──
  const goodScores = perCase.filter((p) => p.scenario === 'good').map((p) => p.meanScore);
  const poorScores = perCase.filter((p) => p.scenario === 'poor').map((p) => p.meanScore);
  const accuracyRate = perCase.filter((p) => p.accuratePass).length / perCase.length;
  const consistencyRate = perCase.filter((p) => p.consistencyPass).length / perCase.length;
  const secCases = perCase.filter((p) => p.scenario === 'security');
  const secDetectRate =
    secCases.filter((p) => p.securityPass).length / Math.max(1, secCases.length);
  const qualitySeparation = avg(goodScores) - avg(poorScores);

  // ── Print summary ──
  console.log('\n══════════════════ E2E 결과 요약 ══════════════════');
  console.log(
    `  LLM Judge 사용: ${judgeAvailable ? `예 (${judgeUsedCount}회 호출)` : '아니오 (Layer 0 only — API 키 미설정)'}`,
  );
  console.log(`  총 비용(추정): $${totalCost.toFixed(5)}`);
  console.log('');
  console.log(`  1) 정확도         : ${(accuracyRate * 100).toFixed(1)}%  (good≥80 / 그외≤45)`);
  console.log(`  2) 일관성(편차≤5) : ${(consistencyRate * 100).toFixed(1)}%`);
  console.log(`  3) 보안 탐지율    : ${(secDetectRate * 100).toFixed(1)}%  (security 14건)`);
  console.log(
    `  4) 품질 구분력    : ${qualitySeparation.toFixed(1)}점  (good평균 ${avg(goodScores).toFixed(1)} - poor평균 ${avg(poorScores).toFixed(1)})  [목표 ≥50]`,
  );
  console.log('');

  // Per-scenario grade distribution
  for (const sc of SCENARIOS) {
    const rows = perCase.filter((p) => p.scenario === sc);
    const dist = {};
    rows.forEach((r) => {
      dist[r.grade] = (dist[r.grade] || 0) + 1;
    });
    const passN = rows.filter((r) => r.accuratePass).length;
    console.log(
      `  [${sc.padEnd(14)}] 정확 ${passN}/${rows.length}  등급분포 ${JSON.stringify(dist)}  평균 ${avg(rows.map((r) => r.meanScore)).toFixed(1)}`,
    );
  }

  // Failures detail
  const failures = perCase.filter((p) => !p.accuratePass || !p.securityPass || !p.consistencyPass);
  if (failures.length) {
    console.log('\n  ⚠ 기준 미달 케이스:');
    for (const f of failures) {
      const why = [
        !f.accuratePass ? `정확도(평균${f.meanScore}, 기대${f.expectedGrade})` : null,
        !f.securityPass ? '보안미탐지' : null,
        !f.consistencyPass ? `편차${f.scoreRange}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`    - ${f.agentId}/${f.scenario}: ${why}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: { base: BASE, repeat: REPEAT, totalRuns: total },
    judge: {
      available: judgeAvailable,
      calls: judgeUsedCount,
      totalCostUsd: Math.round(totalCost * 100000) / 100000,
    },
    metrics: {
      accuracyRate: round3(accuracyRate),
      consistencyRate: round3(consistencyRate),
      securityDetectionRate: round3(secDetectRate),
      qualitySeparation: Math.round(qualitySeparation * 10) / 10,
      goodAvg: Math.round(avg(goodScores) * 10) / 10,
      poorAvg: Math.round(avg(poorScores) * 10) / 10,
    },
    perCase,
  };

  if (OUT) {
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\n  📄 상세 리포트 저장: ${OUT}`);
  }

  // Overall verdict
  const ok =
    accuracyRate >= 0.8 &&
    consistencyRate >= 0.9 &&
    secDetectRate >= 0.99 &&
    qualitySeparation >= 50;
  console.log(`\n  ${ok ? '✅ 전체 기준 충족' : '⚠ 일부 기준 미달 (위 상세 참고)'}`);
  console.log('═══════════════════════════════════════════════════\n');
  if (!judgeAvailable) {
    console.log('  ℹ LLM Judge 미사용 상태입니다. 환각/품질 정확도를 제대로 보려면 .env에');
    console.log('    ANTHROPIC_API_KEY(또는 OPENAI_API_KEY)를 설정 후 다시 실행하세요.\n');
  }
  process.exit(ok ? 0 : 1);
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
main().catch((e) => {
  console.error('스크립트 오류:', e.message, e.stack);
  process.exit(2);
});
