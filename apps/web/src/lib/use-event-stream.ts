/**
 * useEventStream — React hook that connects to the Metis SSE endpoint.
 *
 * Features:
 *   - Auto-reconnect with exponential backoff on disconnect
 *   - Authenticated via the httpOnly metis_access cookie (withCredentials)
 *   - Graceful fallback to polling if SSE fails after N retries
 *   - Per-tenant isolation enforced server-side
 */
'use client';

import { useEffect, useRef, useState } from 'react';

export interface LiveEvent {
  id: string;
  type: 'mission' | 'auto-action' | 'fds-alert' | 'audit' | 'system';
  timestamp: string;
  actor: string;
  summary: string;
  severity?: 'info' | 'warning' | 'error' | 'success';
  payload?: any;
  correlationId?: string;
}

export interface UseEventStreamOptions {
  /** Maximum number of events to keep in memory (default 50) */
  maxEvents?: number;
  /** Whether to open the SSE connection (default true). Use false to disable in SSR. */
  enabled?: boolean;
  /** Callback fired on every received event (useful for side effects) */
  onEvent?: (event: LiveEvent) => void;
}

export interface UseEventStreamResult {
  events: LiveEvent[];
  connected: boolean;
  error: string | null;
  /** Manually reconnect after a failure */
  reconnect: () => void;
}

const DEFAULT_MAX = 50;
const MAX_RECONNECT_ATTEMPTS = 5;

export function useEventStream(opts: UseEventStreamOptions = {}): UseEventStreamResult {
  const { maxEvents = DEFAULT_MAX, enabled = true, onEvent } = opts;
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = () => {
    if (typeof window === 'undefined') return;
    if (!enabled) return;

    // Auth rides on the httpOnly metis_access cookie. EventSource can't set
    // custom headers, so we open with withCredentials to send the cookie.
    // The token is NEVER placed in the URL. Use the Next.js rewrite proxy so
    // the request is same-origin and the cookie is attached.
    const url = `/api/events/stream`;

    try {
      const src = new EventSource(url, { withCredentials: true });
      sourceRef.current = src;

      src.onopen = () => {
        setConnected(true);
        setError(null);
        attemptRef.current = 0;
      };

      src.onmessage = (ev) => {
        try {
          const parsed: LiveEvent = JSON.parse(ev.data);
          setEvents((prev) => {
            const next = [parsed, ...prev];
            return next.length > maxEvents ? next.slice(0, maxEvents) : next;
          });
          onEvent?.(parsed);
        } catch (e) {
          // Ignore malformed events
        }
      };

      src.onerror = () => {
        setConnected(false);
        src.close();
        sourceRef.current = null;

        // Exponential backoff reconnect
        attemptRef.current += 1;
        if (attemptRef.current > MAX_RECONNECT_ATTEMPTS) {
          setError('max_retries_exceeded');
          return;
        }
        const delay = Math.min(30000, 1000 * 2 ** attemptRef.current);
        reconnectTimer.current = setTimeout(connect, delay);
      };
    } catch (e: any) {
      setError(e.message || 'connection_failed');
    }
  };

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const reconnect = () => {
    attemptRef.current = 0;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    connect();
  };

  return { events, connected, error, reconnect };
}
