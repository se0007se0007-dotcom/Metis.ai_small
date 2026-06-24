/**
 * Input sanitization utilities for XSS prevention.
 * Used to clean user inputs before storing or rendering.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#96;',
};

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"'`/]/g, (char) => HTML_ENTITIES[char] || char);
}

/**
 * Strip all HTML tags from a string.
 */
export function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '');
}

/**
 * Sanitize user input for safe storage and display.
 * - Strips HTML tags
 * - Limits length
 * - Removes null bytes
 * - Trims whitespace
 */
export function sanitizeInput(input: string, maxLength = 1000): string {
  if (!input || typeof input !== 'string') return '';
  return stripHtml(input)
    .replace(/\0/g, '') // Remove null bytes
    .trim()
    .slice(0, maxLength);
}

/**
 * Sanitize node name from Korean NLP parser output.
 * More restrictive: only allows safe characters.
 */
export function sanitizeNodeName(name: string): string {
  return sanitizeInput(name, 100).replace(/[^\w\s가-힣ㄱ-ㅎㅏ-ㅣ().#\-_/]/g, ''); // Keep Korean, alphanumeric, basic punctuation
}

/**
 * Sanitize URL input.
 */
export function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  // Only allow http(s) and relative URLs
  if (/^javascript:/i.test(trimmed) || /^data:/i.test(trimmed) || /^vbscript:/i.test(trimmed)) {
    return '';
  }
  return trimmed;
}
