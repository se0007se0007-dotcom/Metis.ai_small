/**
 * URL Validator — SSRF Prevention
 * Blocks internal/private network requests and enforces allowlisted domains.
 */

/** Blocked IP ranges (RFC 1918, loopback, link-local, etc.) */
const BLOCKED_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/0\./,
  /^https?:\/\/169\.254\./, // link-local
  /^https?:\/\/\[::1\]/, // IPv6 loopback
  /^https?:\/\/\[fc/i, // IPv6 private
  /^https?:\/\/\[fd/i, // IPv6 private
  /^https?:\/\/\[fe80:/i, // IPv6 link-local
  /^file:\/\//i, // file protocol
  /^ftp:\/\//i, // ftp protocol
  /^gopher:\/\//i, // gopher protocol
];

/** Allowlisted domains for pack sources */
const DOMAIN_ALLOWLIST = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'registry.npmjs.org',
  'www.npmjs.com',
  'raw.githubusercontent.com',
];

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a source URL for safety.
 * @param url - The URL to validate
 * @param strictMode - If true, only allowlisted domains are accepted.
 *                     If false, only blocked patterns are rejected.
 */
export function validateSourceUrl(url: string, strictMode = false): UrlValidationResult {
  if (!url || typeof url !== 'string') {
    return { valid: false, reason: 'URL is empty or not a string' };
  }

  // Block known dangerous patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(url)) {
      return { valid: false, reason: `URL matches blocked pattern: ${pattern.source}` };
    }
  }

  // Must be http or https
  if (!/^https?:\/\//i.test(url)) {
    return { valid: false, reason: 'Only http:// and https:// URLs are allowed' };
  }

  // Strict mode: check domain allowlist
  if (strictMode) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const isDomainAllowed = DOMAIN_ALLOWLIST.some(
        (d) => hostname === d || hostname.endsWith(`.${d}`),
      );
      if (!isDomainAllowed) {
        return {
          valid: false,
          reason: `Domain "${hostname}" is not in the allowlist. Allowed: ${DOMAIN_ALLOWLIST.join(', ')}`,
        };
      }
    } catch {
      return { valid: false, reason: 'Invalid URL format' };
    }
  }

  return { valid: true };
}

/**
 * Add a domain to the runtime allowlist.
 * In production, this would be backed by a database or config service.
 */
export function addAllowedDomain(domain: string): void {
  if (!DOMAIN_ALLOWLIST.includes(domain.toLowerCase())) {
    DOMAIN_ALLOWLIST.push(domain.toLowerCase());
  }
}
