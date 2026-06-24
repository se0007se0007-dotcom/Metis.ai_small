/**
 * Next.js middleware — security headers (M-7).
 *
 * Applies a baseline set of security headers to every response:
 *   - Content-Security-Policy
 *       - production: strict per-request nonce + 'strict-dynamic' for scripts
 *         (no script 'unsafe-inline'); style-src keeps 'unsafe-inline' (Tailwind).
 *       - development: relaxed (allows 'unsafe-eval' + 'unsafe-inline' for
 *         scripts and ws:/wss: connections) so Next dev server / HMR / the dev
 *         error overlay keep working. NO nonce/strict-dynamic in dev — they
 *         interfere with the dev server's own inline scripts.
 *   - X-Frame-Options: DENY
 *   - X-Content-Type-Options: nosniff
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *   - Strict-Transport-Security (production only)
 *
 * Follows the official Next.js nonce-CSP pattern: a per-request nonce is
 * generated in the Edge runtime, exposed to the app via the `x-nonce` request
 * header (so Server Components can read it and Next auto-nonces its own
 * framework scripts), and the CSP is set on the response headers.
 *
 * @see https://nextjs.org/docs/app/guides/content-security-policy
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Generate a per-request nonce. Uses the Web Crypto API
 * (`globalThis.crypto.getRandomValues`) which is available in the Edge
 * runtime, then base64-encodes the random bytes.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Build the production CSP using a per-request nonce + 'strict-dynamic'.
 * Dropping script 'unsafe-inline': only scripts carrying the nonce (and, via
 * 'strict-dynamic', scripts they load) are allowed to execute.
 */
function buildProdCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Tailwind / inline styles still require 'unsafe-inline' for styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // FinOps 통합 대시보드(게이트웨이/컨트롤플레인) iframe 임베드 허용
    "frame-src 'self' http://localhost:8500 http://localhost:8400",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Build the development CSP. Intentionally permissive so the Next dev server,
 * HMR, and the error overlay keep working: no nonce, scripts allow
 * 'unsafe-eval'/'unsafe-inline', and connect-src allows websockets.
 */
function buildDevCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss: http://localhost:* https://localhost:*",
    // FinOps 통합 대시보드 iframe 임베드 허용 (개발: 모든 localhost 포트)
    "frame-src 'self' http://localhost:*",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function middleware(request: NextRequest) {
  let csp: string;
  const requestHeaders = new Headers(request.headers);

  if (isProd) {
    const nonce = generateNonce();
    csp = buildProdCsp(nonce);
    // Expose the nonce to the app (Server Components + Next's own scripts) via
    // the request headers — Next reads `x-nonce` / the CSP request header to
    // auto-nonce its framework scripts.
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
  } else {
    csp = buildDevCsp();
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isProd) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

export const config = {
  /*
   * Apply to all routes except Next internals and static assets.
   * Match all request paths except for the ones starting with:
   * - _next/static (static files)
   * - _next/image (image optimization files)
   * - favicon.ico (favicon file)
   * (per the Next.js CSP docs recommendation)
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
