/**
 * Streaming Evaluator — Real-Time Sliding Window Metrics
 *
 * Provides real-time evaluation metrics across three configurable sliding
 * time windows (1 minute, 5 minutes, 1 hour).  Each window maintains an
 * internal deque of {@link StreamingRecord} entries and lazily evicts
 * expired records on every read/write operation.
 *
 * Metrics computed per window:
 *   - Task Completion Rate (TCR)   — percentage of successful tasks
 *   - Average latency              — mean execution time in milliseconds
 *   - P95 latency                  — 95th-percentile execution time
 *   - Error rate                   — percentage of records with errors
 *   - Average tokens               — mean token consumption per task
 *
 * Design principles:
 *   - Zero external dependencies — pure in-memory computation
 *   - Lazy eviction — expired records are pruned on each add/read
 *   - Safe defaults — empty windows return all-zero stats
 *   - Thread-safe within Node.js single-threaded event loop
 *
 * @module evaluator
 */
import { Injectable, Logger } from '@nestjs/common';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** A single evaluation event recorded into the sliding windows. */
export interface StreamingRecord {
  /** Unique task identifier */
  taskId: string;
  /** Whether the task completed successfully */
  success: boolean;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** Number of tokens consumed */
  tokensUsed: number;
  /** Record timestamp as epoch milliseconds */
  timestamp: number;
  /** Accuracy score from the quality evaluator (0-1) */
  accuracyScore: number;
  /** Whether the execution encountered an error */
  hasError: boolean;
}

/** Aggregated statistics for a single sliding window. */
export interface WindowStats {
  /** Number of records currently in the window */
  count: number;
  /** Task Completion Rate — percentage of successful tasks (0-100, 1 decimal) */
  tcr: number;
  /** Average execution latency in milliseconds (3 decimals) */
  avgLatencyMs: number;
  /** 95th-percentile execution latency in milliseconds (3 decimals) */
  p95LatencyMs: number;
  /** Error rate — percentage of records with errors (0-100, 1 decimal) */
  errorRate: number;
  /** Average token consumption per record (1 decimal) */
  avgTokens: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Default limit for getRecentRecords when no explicit limit is provided. */
const DEFAULT_RECENT_LIMIT = 50;

// ────────────────────────────────────────────────────────────────
// SlidingWindow — Internal Data Structure
// ────────────────────────────────────────────────────────────────

/**
 * Internal sliding window backed by an array-based deque.
 *
 * Records are appended chronologically and expired entries are
 * lazily evicted from the front of the deque.
 */
class SlidingWindow {
  /** Window duration in milliseconds */
  private readonly windowMs: number;

  /** Ordered deque of records (oldest first) */
  private readonly records: StreamingRecord[] = [];

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /**
   * Add a new record to the window and evict expired entries.
   *
   * @param record - The streaming record to add
   */
  add(record: StreamingRecord): void {
    this.records.push(record);
    this.evict();
  }

  /**
   * Remove all records whose timestamp falls outside the current window.
   * Records are evicted from the front since they are ordered chronologically.
   */
  evict(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.records.length > 0 && this.records[0].timestamp < cutoff) {
      this.records.shift();
    }
  }

  /**
   * Compute aggregated statistics for the current window.
   *
   * Performs eviction before computing to ensure only valid records
   * are included.  Returns all-zero stats (with the correct windowSeconds)
   * when the window is empty.
   *
   * @returns Aggregated window statistics
   */
  getStats(): WindowStats {
    this.evict();

    const windowSeconds = this.windowMs / 1000;
    const count = this.records.length;

    if (count === 0) {
      return {
        count: 0,
        tcr: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        errorRate: 0,
        avgTokens: 0,
        windowSeconds,
      };
    }

    // Task Completion Rate — percentage of successful records
    const successCount = this.records.filter((r) => r.success).length;
    const tcr = Math.round((successCount / count) * 1000) / 10;

    // Average latency
    const totalLatency = this.records.reduce((sum, r) => sum + r.executionTimeMs, 0);
    const avgLatencyMs = Math.round((totalLatency / count) * 1000) / 1000;

    // P95 latency — sort execution times ascending, pick index at 95th percentile
    const sortedLatencies = this.records.map((r) => r.executionTimeMs).sort((a, b) => a - b);
    const p95Idx = Math.max(0, Math.floor(count * 0.95) - 1);
    const p95LatencyMs = Math.round(sortedLatencies[p95Idx] * 1000) / 1000;

    // Error rate — percentage of records with errors
    const errorCount = this.records.filter((r) => r.hasError).length;
    const errorRate = Math.round((errorCount / count) * 1000) / 10;

    // Average tokens
    const totalTokens = this.records.reduce((sum, r) => sum + r.tokensUsed, 0);
    const avgTokens = Math.round((totalTokens / count) * 10) / 10;

    return {
      count,
      tcr,
      avgLatencyMs,
      p95LatencyMs,
      errorRate,
      avgTokens,
      windowSeconds,
    };
  }

  /**
   * Return a snapshot of all records currently in the window.
   * Performs eviction before returning to exclude expired entries.
   *
   * @returns Array of records (oldest first)
   */
  getRecords(): StreamingRecord[] {
    this.evict();
    return [...this.records];
  }
}

// ────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class StreamingEvaluatorService {
  private readonly logger = new Logger(StreamingEvaluatorService.name);

  /** Three pre-configured sliding windows keyed by duration label. */
  private readonly windows: Record<string, SlidingWindow>;

  constructor() {
    this.windows = {
      '1m': new SlidingWindow(60_000),
      '5m': new SlidingWindow(300_000),
      '1h': new SlidingWindow(3_600_000),
    };

    this.logger.log('StreamingEvaluatorService initialised with windows: 1m, 5m, 1h');
  }

  // ════════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════════

  /**
   * Record a new evaluation event into all sliding windows.
   *
   * The record is pushed into each of the three windows (1m, 5m, 1h),
   * and expired entries are lazily evicted during the push.
   *
   * @param record - The streaming evaluation record to add
   */
  record(record: StreamingRecord): void {
    for (const [key, window] of Object.entries(this.windows)) {
      window.add(record);
    }

    this.logger.debug(
      `Recorded task=${record.taskId}, success=${record.success}, ` +
        `latency=${record.executionTimeMs}ms, tokens=${record.tokensUsed}`,
    );
  }

  /**
   * Get aggregated statistics for a specific sliding window.
   *
   * @param windowKey - The window to query ('1m', '5m', or '1h')
   * @returns Aggregated window statistics
   * @throws Error if the window key is not recognised
   */
  getWindowStats(windowKey: '1m' | '5m' | '1h'): WindowStats {
    const window = this.windows[windowKey];
    if (!window) {
      this.logger.warn(`Unknown window key: ${windowKey}`);
      throw new Error(`Unknown window key: ${windowKey}. Valid keys: 1m, 5m, 1h`);
    }

    return window.getStats();
  }

  /**
   * Get aggregated statistics for all three sliding windows at once.
   *
   * Useful for dashboard displays that show real-time metrics across
   * multiple time horizons simultaneously.
   *
   * @returns Map of window key to aggregated statistics
   */
  getAllStats(): Record<string, WindowStats> {
    const stats: Record<string, WindowStats> = {};

    for (const [key, window] of Object.entries(this.windows)) {
      stats[key] = window.getStats();
    }

    return stats;
  }

  /**
   * Get the most recent records across all windows.
   *
   * Returns records from the longest window (1h) sorted by timestamp
   * descending (newest first), limited to the specified count.
   *
   * @param limit - Maximum number of records to return (default: 50)
   * @returns Array of recent records, newest first
   */
  getRecentRecords(limit: number = DEFAULT_RECENT_LIMIT): StreamingRecord[] {
    // Use the 1h window as it contains the broadest set of records
    const allRecords = this.windows['1h'].getRecords();

    // Sort newest first and apply limit
    return allRecords.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
}
