#!/usr/bin/env node
/**
 * check-secrets.mjs — fail-fast guard against committing secrets.
 *
 * Run manually or from a pre-commit hook:
 *   node scripts/check-secrets.mjs
 *
 * Checks two things:
 *   1. No `.env` (or `.env.*` except *.example) is tracked by git.
 *   2. No high-signal secret patterns appear in git-staged files.
 *
 * Exit code 1 on any finding so it can block a commit/push. This does NOT
 * read or print secret values — only file paths and the matched pattern name.
 */
import { execSync } from 'node:child_process';

const SECRET_PATTERNS = [
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'OpenAI key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Generic password=', re: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/i },
];

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

let failed = false;

// 1. Tracked .env files (excluding *.example)
const tracked = sh('git ls-files').split('\n').filter(Boolean);
const trackedEnv = tracked.filter(
  (f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.example'),
);
if (trackedEnv.length > 0) {
  failed = true;
  console.error('✗ .env file(s) are tracked by git (must be gitignored):');
  trackedEnv.forEach((f) => console.error(`    ${f}`));
}

// 2. Staged content scan
const staged = sh('git diff --cached --name-only').split('\n').filter(Boolean);
for (const file of staged) {
  if (file.endsWith('.example') || file.startsWith('scripts/check-secrets')) continue;
  const content = sh(`git show :${file}`);
  if (!content) continue;
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      failed = true;
      console.error(`✗ Possible ${name} in staged file: ${file}`);
    }
  }
}

if (failed) {
  console.error('\nSecret check FAILED. Unstage the offending content before committing.');
  process.exit(1);
}
console.log('✓ Secret check passed — no tracked .env and no secrets in staged files.');
