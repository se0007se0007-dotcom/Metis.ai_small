/**
 * Phase 2 통합 스모크 테스트 — 정책 피드백 루프 API
 *
 * 기동 중인 Metis API 서버를 대상으로:
 *   1) 로그인
 *   2) POST /governance/policy-suggestions/analyze?days=30   (분석 실행)
 *   3) GET  /governance/policy-suggestions?status=PENDING    (제안 목록)
 *   4) (제안이 있으면) POST .../:id/approve 또는 reject
 *   5) GET  /governance/policy-suggestions/sampling          (적응형 샘플링 스냅샷)
 *
 * 사용법 (start-metis.bat 기동 후):
 *   node scripts/test-policy-feedback.mjs
 *   node scripts/test-policy-feedback.mjs --approve   # 첫 제안 자동 승인까지 시도
 */

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const flag = (n) => args.includes(`--${n}`);

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

async function main() {
  console.log(`\n▶ Base: ${BASE}\n▶ Login: ${EMAIL}\n`);
  if (!(await login())) {
    console.error('❌ 로그인 실패 — 서버/계정 확인');
    process.exit(2);
  }
  console.log('🔑 로그인 성공\n');

  console.log('=== POST /analyze (최근 30일 패턴 분석) ===');
  let firstId = null;
  {
    const { status, json } = await req('POST', '/governance/policy-suggestions/analyze?days=30');
    check('analyze 200/201', status === 200 || status === 201, `status=${status}`);
    check(
      'count 필드 존재',
      json && typeof json.count === 'number',
      JSON.stringify(json).slice(0, 200),
    );
    console.log(`    → 새 제안 ${json?.count ?? 0}건 생성`);
  }

  console.log('\n=== GET ?status=PENDING (제안 목록) ===');
  {
    const { status, json } = await req('GET', '/governance/policy-suggestions?status=PENDING');
    check('list 200', status === 200, `status=${status}`);
    check('items 배열', Array.isArray(json?.items), JSON.stringify(json).slice(0, 200));
    if (json?.items?.length) {
      firstId = json.items[0].id;
      const s = json.items[0];
      check('제안에 patternType 존재', !!s.patternType);
      check('제안에 proposedChanges 배열', Array.isArray(s.proposedChanges));
      console.log(`    → 예시 제안: [${s.patternType}] ${s.title}`);
    } else {
      console.log('    → PENDING 제안 없음 (평가 이력이 적거나 패턴 없음 — 정상일 수 있음)');
    }
  }

  console.log('\n=== GET /sampling (적응형 샘플링 스냅샷) ===');
  {
    const { status, json } = await req('GET', '/governance/policy-suggestions/sampling');
    check('sampling 200', status === 200, `status=${status}`);
    check('rates 배열', Array.isArray(json?.rates), JSON.stringify(json).slice(0, 200));
    console.log(`    → 추적 중인 샘플링 키 ${json?.rates?.length ?? 0}개`);
  }

  if (flag('approve') && firstId) {
    console.log('\n=== POST /:id/approve (첫 제안 승인·적용) ===');
    const { status, json } = await req('POST', `/governance/policy-suggestions/${firstId}/approve`);
    check('approve 200/201', status === 200 || status === 201, `status=${status}`);
    check(
      'suggestion 상태 APPLIED/APPROVED',
      ['APPLIED', 'APPROVED'].includes(json?.suggestion?.status),
      JSON.stringify(json?.suggestion?.status),
    );
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`결과: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) {
    console.log('실패:', failures.join(', '));
    process.exit(1);
  }
  console.log('통합 스모크 통과 ✅');
}
main().catch((e) => {
  console.error('스크립트 오류:', e.message);
  process.exit(2);
});
