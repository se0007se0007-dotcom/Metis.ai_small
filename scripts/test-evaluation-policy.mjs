/**
 * Phase 1 통합 스모크 테스트 — 평가 Gate 정책 API
 *
 * 실제로 기동 중인 Metis API 서버를 대상으로 정책 엔드포인트를 검증한다.
 *   1) 로그인 → JWT 획득
 *   2) GET  /governance/evaluation-policy            (기본 정책 자동 생성 확인)
 *   3) PUT  /governance/evaluation-policy            (가중치/임계값 수정 반영 확인)
 *   4) GET  again                                    (수정값 영속 확인)
 *   5) POST /governance/evaluation-policy/reset       (기본값 복원 확인)
 *   6) agentGroup 스코프(운영) 별도 정책 확인
 *   7) 잘못된 입력(가중치>1) 거부 확인
 *
 * 사용법 (start-metis.bat 로 서버 기동 후):
 *   node scripts/test-evaluation-policy.mjs
 *   node scripts/test-evaluation-policy.mjs --base http://localhost:4000/v1 --email admin@metis.ai --password metis1234
 */

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const BASE = arg('base', 'http://localhost:4000/v1');
const EMAIL = arg('email', 'admin@metis.ai');
const PASSWORD = arg('password', 'metis1234');

let pass = 0,
  fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}  ${extra}`);
  }
}

let token = null;

async function req(method, path, body) {
  // Bearer JWT requests are exempt from CSRF (see csrf.middleware.ts), so no
  // X-CSRF-Token header is needed here.
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
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function login() {
  // Try common auth shapes; adjust here if your login route differs.
  const candidates = [{ path: '/auth/login', body: { email: EMAIL, password: PASSWORD } }];
  for (const c of candidates) {
    const { status, json } = await req('POST', c.path, c.body);
    if (status >= 200 && status < 300 && json) {
      token =
        json.accessToken ||
        json.access_token ||
        json.token ||
        json.data?.accessToken ||
        json.data?.token ||
        null;
      if (token) return true;
    }
  }
  return false;
}

function expectPolicy(p) {
  return (
    p &&
    typeof p === 'object' &&
    'qualityWeight' in p &&
    'securityWeight' in p &&
    'qualityHardGateMin' in p &&
    'llmJudgeEnabled' in p
  );
}

async function main() {
  console.log(`\n▶ Base: ${BASE}`);
  console.log(`▶ Login as: ${EMAIL}\n`);

  const ok = await login();
  if (!ok) {
    console.error('❌ 로그인 실패 — 서버가 켜져 있는지, 계정/로그인 경로가 맞는지 확인하세요.');
    console.error('   (스크립트의 login() 후보 경로/필드를 환경에 맞게 수정하면 됩니다.)');
    process.exit(2);
  }
  console.log('🔑 로그인 성공\n');

  // 2) GET — 기본 정책 자동 생성
  console.log('=== GET /governance/evaluation-policy (기본) ===');
  {
    const { status, json } = await req('GET', '/governance/evaluation-policy');
    check('GET 200', status === 200, `status=${status}`);
    check('policy 객체 반환', expectPolicy(json?.policy), JSON.stringify(json).slice(0, 200));
    check('기본 qualityWeight=0.4', approxField(json?.policy?.qualityWeight, 0.4));
    check('기본 hardGate=50', json?.policy?.qualityHardGateMin === 50);
  }

  // 3) PUT — 수정
  console.log('\n=== PUT /governance/evaluation-policy (수정) ===');
  {
    const patch = {
      name: 'default',
      qualityWeight: 0.5,
      securityWeight: 0.25,
      costWeight: 0.15,
      anomalyWeight: 0.1,
      qualityHardGateMin: 60,
      securityCriticalCap: 35,
      llmJudgeEnabled: false,
    };
    const { status, json } = await req('PUT', '/governance/evaluation-policy', patch);
    check('PUT 200', status === 200, `status=${status}`);
    check(
      'qualityWeight=0.5 반영',
      approxField(json?.policy?.qualityWeight, 0.5),
      `got ${json?.policy?.qualityWeight}`,
    );
    check(
      'hardGate=60 반영',
      json?.policy?.qualityHardGateMin === 60,
      `got ${json?.policy?.qualityHardGateMin}`,
    );
    check(
      'llmJudgeEnabled=false 반영',
      json?.policy?.llmJudgeEnabled === false,
      `got ${json?.policy?.llmJudgeEnabled}`,
    );
  }

  // 4) GET again — 영속 확인
  console.log('\n=== GET again (영속 확인) ===');
  {
    const { json } = await req('GET', '/governance/evaluation-policy');
    check(
      '수정값 영속됨 (qualityWeight=0.5)',
      approxField(json?.policy?.qualityWeight, 0.5),
      `got ${json?.policy?.qualityWeight}`,
    );
    check('수정값 영속됨 (hardGate=60)', json?.policy?.qualityHardGateMin === 60);
  }

  // 5) RESET
  console.log('\n=== POST /governance/evaluation-policy/reset (기본값 복원) ===');
  {
    const { status, json } = await req('POST', '/governance/evaluation-policy/reset?name=default');
    check('RESET 200', status === 200, `status=${status}`);
    check(
      'qualityWeight 0.4로 복원',
      approxField(json?.policy?.qualityWeight, 0.4),
      `got ${json?.policy?.qualityWeight}`,
    );
    check(
      'hardGate 50으로 복원',
      json?.policy?.qualityHardGateMin === 50,
      `got ${json?.policy?.qualityHardGateMin}`,
    );
    check('llmJudgeEnabled true로 복원', json?.policy?.llmJudgeEnabled === true);
  }

  // 6) agentGroup 스코프
  console.log('\n=== agentGroup="운영" 스코프 분리 ===');
  {
    const put = await req('PUT', '/governance/evaluation-policy', {
      name: '운영',
      agentGroup: '운영',
      qualityWeight: 0.7,
      securityWeight: 0.1,
      costWeight: 0.1,
      anomalyWeight: 0.1,
    });
    check('운영 정책 PUT 200', put.status === 200, `status=${put.status}`);
    check(
      '운영 qualityWeight=0.7',
      approxField(put.json?.policy?.qualityWeight, 0.7),
      `got ${put.json?.policy?.qualityWeight}`,
    );

    const def = await req('GET', '/governance/evaluation-policy?name=default');
    check(
      '기본 정책은 여전히 0.4 (간섭 없음)',
      approxField(def.json?.policy?.qualityWeight, 0.4),
      `got ${def.json?.policy?.qualityWeight}`,
    );
  }

  // 7) 잘못된 입력 거부 (가중치 > 1)
  console.log('\n=== 유효성 검증 (가중치 > 1 거부) ===');
  {
    const { status } = await req('PUT', '/governance/evaluation-policy', { qualityWeight: 5 });
    check('가중치 5 → 400 거부', status === 400, `status=${status} (DTO @Max(1) 동작 확인)`);
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`결과: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) {
    console.log('실패:', failures.join(', '));
    process.exit(1);
  }
  console.log('통합 테스트 전체 통과 ✅');
}

function approxField(v, target, eps = 0.001) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Math.abs(n - target) <= eps;
}

main().catch((e) => {
  console.error('스크립트 오류:', e.message);
  process.exit(2);
});
