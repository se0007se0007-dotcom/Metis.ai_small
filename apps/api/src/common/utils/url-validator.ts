/**
 * URL validation utilities to prevent SSRF attacks.
 * Blocks requests to internal/private/loopback/link-local/reserved IP ranges
 * (IPv4 + IPv6) and cloud metadata endpoints. Resolves both A and AAAA records.
 */
import { URL } from 'url';
import * as dns from 'dns';
import * as net from 'net';
import { promisify } from 'util';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);
const dnsLookup = promisify(dns.lookup);

const PRIVATE_IPV4_RANGES = [
  /^0\./, // "this" network / unspecified
  /^10\./, // Class A private
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^127\./, // Loopback
  /^169\.254\./, // Link-local (incl. cloud metadata 169.254.169.254)
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // Class B private
  /^192\.0\.0\./, // IETF protocol assignments
  /^192\.0\.2\./, // TEST-NET-1
  /^192\.88\.99\./, // 6to4 relay anycast
  /^192\.168\./, // Class C private
  /^198\.(1[89])\./, // Benchmarking 198.18.0.0/15
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^22[4-9]\./, // Multicast / reserved 224.0.0.0+
  /^2[3-5][0-9]\./, // 224-255 reserved/multicast/broadcast
];

function isPrivateIPv4(ip: string): boolean {
  return PRIVATE_IPV4_RANGES.some((pattern) => pattern.test(ip));
}

function isPrivateIPv6(raw: string): boolean {
  let ip = raw.toLowerCase().trim();
  // Strip zone id and brackets
  ip = ip.replace(/^\[/, '').replace(/\]$/, '').split('%')[0];

  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  if (/^fe80:/i.test(ip)) return true; // link-local
  if (/^fe[c-f][0-9a-f]:/i.test(ip)) return true; // site-local (deprecated)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // unique local fc00::/7
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true; // multicast

  // IPv4-mapped / IPv4-compatible IPv6 → check the embedded IPv4
  const v4 = ip.match(/(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/i);
  if (v4 && isPrivateIPv4(v4[1])) return true;
  // 169.254.169.254 mapped form
  if (ip.includes('169.254.169.254')) return true;

  return false;
}

/**
 * True if the given hostname/IP literal points at an internal/blocked target.
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().trim().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '' || h === '0.0.0.0') return true;
  // Cloud metadata aliases
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;

  if (net.isIPv4(h)) return isPrivateIPv4(h);
  if (net.isIPv6(h)) return isPrivateIPv6(h);
  return false;
}

/**
 * Validate a URL is safe for server-side requests (no SSRF).
 * Rejects non-http(s) schemes, internal/private/loopback/link-local/reserved
 * IPv4 + IPv6, and cloud metadata endpoints. Resolves both A and AAAA records.
 */
export async function validateExternalUrl(
  urlString: string,
): Promise<{ safe: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, error: '유효하지 않은 URL 형식입니다.' };
  }

  // Only allow HTTP(S)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { safe: false, error: `허용되지 않는 프로토콜: ${parsed.protocol}` };
  }

  // Check hostname literal directly (covers IP literals + localhost)
  if (isBlockedHost(parsed.hostname)) {
    return { safe: false, error: '내부 네트워크 주소는 허용되지 않습니다.' };
  }

  // Resolve BOTH A and AAAA records; block if any resolves to a private range.
  let resolvedAny = false;
  try {
    const ips = await dnsResolve4(parsed.hostname);
    resolvedAny = resolvedAny || ips.length > 0;
    for (const ip of ips) {
      if (isPrivateIPv4(ip)) {
        return {
          safe: false,
          error: `호스트 ${parsed.hostname}이(가) 내부 IP(${ip})로 확인되어 차단되었습니다.`,
        };
      }
    }
  } catch {
    // no A record — fall through to AAAA
  }

  try {
    const ips6 = await dnsResolve6(parsed.hostname);
    resolvedAny = resolvedAny || ips6.length > 0;
    for (const ip of ips6) {
      if (isPrivateIPv6(ip)) {
        return {
          safe: false,
          error: `호스트 ${parsed.hostname}이(가) 내부 IPv6(${ip})로 확인되어 차단되었습니다.`,
        };
      }
    }
  } catch {
    // no AAAA record
  }

  // Fallback: 일부 환경(사내 DNS, split-horizon, c-ares 차단)에서는 정상 공인 호스트도
  // dns.resolve4/6 가 빈 결과를 낸다(예: CDN/CNAME). 이때 OS 리졸버(dns.lookup — fetch/http 와
  // 동일 경로)로 다시 조회하되, 해석된 IP 가 사설/내부 대역이 아님을 반드시 재검증한다.
  if (!resolvedAny && !net.isIP(parsed.hostname)) {
    try {
      const looked = (await dnsLookup(parsed.hostname, { all: true })) as Array<{
        address: string;
        family: number;
      }>;
      for (const { address, family } of looked) {
        if (
          (family === 4 && isPrivateIPv4(address)) ||
          (family === 6 && isPrivateIPv6(address))
        ) {
          return {
            safe: false,
            error: `호스트 ${parsed.hostname}이(가) 내부 IP(${address})로 확인되어 차단되었습니다.`,
          };
        }
      }
      resolvedAny = resolvedAny || looked.length > 0;
    } catch {
      // OS 리졸버도 실패
    }
  }

  // If hostname is not an IP literal and DNS resolved nothing, reject —
  // we cannot prove it is external.
  if (!resolvedAny && !net.isIP(parsed.hostname)) {
    return { safe: false, error: `호스트 ${parsed.hostname}을(를) 확인할 수 없습니다.` };
  }

  return { safe: true };
}

/**
 * Synchronous quick-check (no DNS resolution).
 * Use for initial validation before async full check.
 */
export function quickSsrfCheck(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (isBlockedHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw a clear error if the URL is unsafe for outbound requests.
 * Convenience wrapper around validateExternalUrl for call sites.
 */
export async function assertExternalUrl(urlString: string): Promise<void> {
  const result = await validateExternalUrl(urlString);
  if (!result.safe) {
    throw new Error(`SSRF 차단: ${result.error || '허용되지 않는 URL입니다.'}`);
  }
}

/**
 * Validate a URL AND return the resolved public IP(s) that passed the SSRF
 * checks. Lets call sites PIN the subsequent socket connect to an
 * already-validated IP, closing the DNS-rebinding / TOCTOU gap between
 * "validate hostname" and "open socket" (where DNS could re-resolve to an
 * internal address).
 *
 * - For IP-literal hosts the literal itself is returned.
 * - For hostnames, every resolved A/AAAA record is validated; any private
 *   record causes a throw, and only the safe records are returned.
 */
export async function resolveValidatedExternalIps(
  urlString: string,
): Promise<{ hostname: string; ips: string[] }> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('SSRF 차단: 유효하지 않은 URL 형식입니다.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`SSRF 차단: 허용되지 않는 프로토콜: ${parsed.protocol}`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('SSRF 차단: 내부 네트워크 주소는 허용되지 않습니다.');
  }

  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');

  // IP literal → it already passed isBlockedHost above; pin to it directly.
  if (net.isIP(host)) {
    return { hostname: parsed.hostname, ips: [host] };
  }

  const ips: string[] = [];
  try {
    const v4 = await dnsResolve4(host);
    for (const ip of v4) {
      if (isPrivateIPv4(ip)) {
        throw new Error(`SSRF 차단: 호스트 ${host}이(가) 내부 IP(${ip})로 확인되었습니다.`);
      }
      ips.push(ip);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SSRF 차단')) throw e;
    // no A record — fall through to AAAA
  }
  try {
    const v6 = await dnsResolve6(host);
    for (const ip of v6) {
      if (isPrivateIPv6(ip)) {
        throw new Error(`SSRF 차단: 호스트 ${host}이(가) 내부 IPv6(${ip})로 확인되었습니다.`);
      }
      ips.push(ip);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SSRF 차단')) throw e;
    // no AAAA record
  }

  if (ips.length === 0) {
    throw new Error(`SSRF 차단: 호스트 ${host}을(를) 확인할 수 없습니다.`);
  }
  return { hostname: parsed.hostname, ips };
}

/**
 * Build a Node http/https `lookup` function that ALWAYS returns one of the
 * pre-validated IPs, ignoring any fresh DNS answer. This pins the actual TCP
 * connect to an IP that already passed the SSRF allow-list, so DNS cannot
 * rebind to an internal address between validation and connect.
 *
 * Keep `servername`/Host = the original hostname at the call site so TLS SNI
 * and HTTP vhost routing still work.
 */
export function pinnedLookup(
  ips: string[],
): (
  hostname: string,
  options: any,
  callback: (err: Error | null, address: string, family: number) => void,
) => void {
  const v4 = ips.find((ip) => net.isIPv4(ip));
  const v6 = ips.find((ip) => net.isIPv6(ip));
  return (_hostname, options, callback) => {
    const wantV6 = (options && (options.family === 6 || options.all === false)) || false;
    let chosen: string | undefined;
    let family = 4;
    if (wantV6 && v6) {
      chosen = v6;
      family = 6;
    } else if (v4) {
      chosen = v4;
      family = 4;
    } else if (v6) {
      chosen = v6;
      family = 6;
    }
    if (!chosen) {
      callback(new Error('SSRF 차단: 검증된 IP가 없습니다.'), '', 4);
      return;
    }
    if (options && options.all) {
      // Some callers expect an array form.
      (callback as any)(null, [{ address: chosen, family }]);
      return;
    }
    callback(null, chosen, family);
  };
}
