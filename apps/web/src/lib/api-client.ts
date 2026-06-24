/**
 * Metis.AI API Client
 * Wraps fetch with auth headers, error handling, and base URL.
 *
 * Auth model (G4): access/refresh tokens live in httpOnly cookies set by the
 * backend (metis_access 15m on '/', metis_refresh 1d on '/api/auth').
 * `credentials: 'include'` sends those cookies on every same-origin /api request.
 *
 * Session continuity: the short-lived access cookie expires in 15 minutes. To
 * avoid bouncing an active user to /login, a 401 triggers a SINGLE-FLIGHT silent
 * refresh (POST /auth/refresh using the refresh cookie); on success the original
 * request is retried once. Only if the refresh itself fails do we clear + redirect.
 */

const API_BASE = '/api';

interface ApiError {
  statusCode: number;
  message: string;
  correlationId?: string;
}

class ApiClientError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function isBrowser(): boolean {
  return typeof globalThis !== 'undefined' && 'localStorage' in globalThis;
}

let inMemoryAccessToken: string | null = null;

function getToken(): string | null {
  return inMemoryAccessToken;
}

/** Read CSRF token from cookie (set by backend) */
function getCsrfToken(): string | null {
  if (!isBrowser()) return null;
  const match = document.cookie.match(/(?:^|;\s*)metis_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setToken(token: string): void {
  inMemoryAccessToken = token || null;
}

export function clearToken(): void {
  inMemoryAccessToken = null;
}

/** Endpoints that must NOT trigger a refresh-retry loop. */
const NO_REFRESH = ['/auth/refresh', '/auth/login', '/auth/logout'];

/** Single-flight silent refresh: many concurrent 401s share one refresh call. */
let refreshInFlight: Promise<boolean> | null = null;

function silentRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const csrfToken = getCsrfToken();
  refreshInFlight = fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: '{}',
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function redirectToLogin(): void {
  if (isBrowser()) {
    clearToken();
    (globalThis as any).location.href = '/login';
  }
}

/** Call the backend logout endpoint to clear httpOnly cookies, then redirect. */
export async function logout(redirectTo = '/login'): Promise<void> {
  clearToken();
  const csrfToken = getCsrfToken();
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
    });
  } catch {
    // ignore network errors on logout
  }
  if (isBrowser()) {
    try {
      globalThis.localStorage.removeItem('userEmail');
    } catch {
      // ignore
    }
    (globalThis as any).location.href = redirectTo;
  }
}

async function request<T>(path: string, options: RequestInit = {}, allowRetry = true): Promise<T> {
  const token = getToken();
  const csrfToken = getCsrfToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (csrfToken && options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method)) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });
  } catch (networkError) {
    throw new ApiClientError(
      0,
      `API 서버에 연결할 수 없습니다 (${API_BASE}). 백엔드 서버가 실행 중인지 확인하세요.`,
    );
  }

  if (!response.ok) {
    // 401: try ONE silent refresh + retry before giving up (session continuity).
    if (response.status === 401 && isBrowser() && !NO_REFRESH.includes(path)) {
      if (allowRetry) {
        const refreshed = await silentRefresh();
        if (refreshed) {
          return request<T>(path, options, false); // retry once with new cookies
        }
      }
      // refresh unavailable/failed → session truly expired
      redirectToLogin();
    }

    let error: ApiError;
    try {
      error = (await response.json()) as ApiError;
    } catch {
      error = { statusCode: response.status, message: response.statusText };
    }
    throw new ApiClientError(error.statusCode, error.message, error.correlationId);
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
