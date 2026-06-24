/**
 * Conversation Evaluator — Multi-Turn Conversation Evaluation
 *
 * Evaluates the quality of multi-turn conversations between users and
 * agents across four dimensions, ported from the Agent Evaluator SDK:
 *
 *   - Context Retention:   how well the agent carries forward context
 *                          from previous turns (top-token overlap)
 *   - Topic Coherence:     semantic consistency between consecutive
 *                          turns (Jaccard similarity of combined text)
 *   - Progressive Depth:   whether the user's follow-up questions build
 *                          on previous agent responses (learning signal)
 *   - Session Completion:  whether the final response maintains quality
 *                          relative to the session average (length ratio)
 *
 * Text processing supports Korean (한국어) via suffix stripping and
 * bilingual stopword lists, matching the SDK reference implementation.
 *
 * @module evaluator
 */
import { Injectable, Logger } from '@nestjs/common';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** A single turn in a conversation between user and agent. */
export interface ConversationTurn {
  /** Zero-based turn index within the conversation */
  turnIndex: number;
  /** The user's question or input */
  user: string;
  /** The agent's response */
  agent: string;
  /** Optional metadata for extensibility */
  metadata?: Record<string, any>;
}

/** Evaluation metrics for a complete conversation session. */
export interface ConversationMetrics {
  /** Unique session identifier */
  sessionId: string;
  /** Number of turns in the conversation */
  turnCount: number;
  /** Context retention score (0-1) */
  contextRetention: number;
  /** Topic coherence score (0-1) */
  topicCoherence: number;
  /** Progressive depth score (0-1) */
  progressiveDepth: number;
  /** Session completion score (0-1) */
  sessionCompletion: number;
  /** Overall composite score — mean of four dimensions (0-1) */
  overallScore: number;
  /** Population standard deviation of four dimension scores — lower = more balanced */
  scoreStddev: number;
  /** Average latency per turn in milliseconds (null if metadata lacks timing) */
  avgTurnLatencyMs: number | null;
}

// ────────────────────────────────────────────────────────────────
// Constants — Tokenization
// ────────────────────────────────────────────────────────────────

/** Token extraction regex — matches Korean syllables, Latin letters, and digits */
const TOKEN_REGEX = /[가-힣a-zA-Z0-9]+/g;

/** Korean character detection */
const KOREAN_CHAR_REGEX = /[가-힣]/;

/**
 * Korean suffixes to strip, ordered longest-first.
 * Stripping is applied up to 2 times, stopping if the root falls below 2 characters.
 */
const KOREAN_SUFFIXES = [
  '합니다',
  '입니다',
  '습니다',
  '됩니다',
  '에서',
  '으로',
  '이라',
  '이고',
  '이며',
  '하고',
  '하며',
  '에게',
  '한테',
  '부터',
  '까지',
  '처럼',
  '만큼',
  '보다',
  '이다',
  '있다',
  '하다',
  '않다',
  '을',
  '를',
  '은',
  '는',
  '이',
  '가',
  '의',
  '에',
  '로',
  '와',
  '과',
  '도',
  '만',
  '라',
];

/** Korean stopwords — filtered out after tokenisation */
const KOREAN_STOPWORDS = new Set<string>([
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '로',
  '와',
  '과',
  '도',
  '만',
  '라',
  '이다',
  '있다',
  '하다',
  '것',
  '수',
  '그',
  '저',
  '이런',
  '저런',
]);

/** English stopwords — filtered out after tokenisation */
const ENGLISH_STOPWORDS = new Set<string>([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'and',
  'or',
  'but',
  'not',
  'this',
  'that',
  'it',
  'its',
]);

/** Default number of top tokens to extract */
const DEFAULT_TOP_N = 10;

/** Number of decimal places for final score rounding */
const SCORE_PRECISION = 4;

// ────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────

@Injectable()
export class ConversationEvaluator {
  private readonly logger = new Logger(ConversationEvaluator.name);

  // ════════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════════

  /**
   * Evaluate a complete conversation session across four quality dimensions.
   *
   * Computes context retention, topic coherence, progressive depth, and
   * session completion.  The overall score is the arithmetic mean of
   * all four dimensions, and scoreStddev is their population standard deviation.
   *
   * @param sessionId - Unique identifier for the conversation session
   * @param turns     - Ordered array of conversation turns
   * @returns Comprehensive conversation quality metrics
   */
  evaluate(sessionId: string, turns: ConversationTurn[]): ConversationMetrics {
    const turnCount = turns.length;

    if (turnCount === 0) {
      this.logger.warn(`Empty conversation session: ${sessionId}`);
      return {
        sessionId,
        turnCount: 0,
        contextRetention: 0,
        topicCoherence: 0,
        progressiveDepth: 0,
        sessionCompletion: 0,
        overallScore: 0,
        scoreStddev: 0,
        avgTurnLatencyMs: null,
      };
    }

    // Sort turns by index to ensure correct ordering
    const sorted = [...turns].sort((a, b) => a.turnIndex - b.turnIndex);

    // ── Compute four evaluation dimensions ──
    const contextRetention = this.computeContextRetention(sorted);
    const topicCoherence = this.computeTopicCoherence(sorted);
    const progressiveDepth = this.computeProgressiveDepth(sorted);
    const sessionCompletion = this.computeSessionCompletion(sorted);

    // ── Overall score — mean of four dimensions ──
    const scores = [contextRetention, topicCoherence, progressiveDepth, sessionCompletion];
    const overallScore = this.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);

    // ── Score standard deviation (population) ──
    const scoreStddev = this.round(this.populationStddev(scores));

    // ── Average turn latency from metadata (if available) ──
    const avgTurnLatencyMs = this.computeAvgTurnLatency(sorted);

    this.logger.log(
      `Conversation evaluated: session=${sessionId}, turns=${turnCount}, ` +
        `retention=${contextRetention}, coherence=${topicCoherence}, ` +
        `depth=${progressiveDepth}, completion=${sessionCompletion}, ` +
        `overall=${overallScore}, stddev=${scoreStddev}`,
    );

    return {
      sessionId,
      turnCount,
      contextRetention,
      topicCoherence,
      progressiveDepth,
      sessionCompletion,
      overallScore,
      scoreStddev,
      avgTurnLatencyMs,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Private: Evaluation Dimensions
  // ════════════════════════════════════════════════════════════

  /**
   * Compute context retention — how well the agent carries forward
   * context from previous responses into subsequent ones.
   *
   * For each turn i (1..n-1):
   *   prevTop = topTokens(prevTurn.agent)
   *   currTokens = allTokens(currTurn.agent)
   *   overlap = |prevTop intersect currTokens| / |prevTop|
   *
   * Final score = mean of overlaps.
   * Single turn = 0.5 (neutral baseline).
   */
  private computeContextRetention(turns: ConversationTurn[]): number {
    if (turns.length <= 1) {
      return this.round(0.5);
    }

    const overlaps: number[] = [];

    for (let i = 1; i < turns.length; i++) {
      const prevTop = this.topTokens(turns[i - 1].agent, DEFAULT_TOP_N);
      if (prevTop.length === 0) continue;

      const currTokens = new Set(this.extractTokens(turns[i].agent));
      const overlapCount = prevTop.filter((t) => currTokens.has(t)).length;
      overlaps.push(overlapCount / prevTop.length);
    }

    if (overlaps.length === 0) {
      return this.round(0.5);
    }

    return this.round(overlaps.reduce((sum, v) => sum + v, 0) / overlaps.length);
  }

  /**
   * Compute topic coherence — semantic consistency between consecutive
   * turns measured via Jaccard similarity of combined user+agent text.
   *
   * For each consecutive pair:
   *   tokensA = tokens(turnA.user + " " + turnA.agent)
   *   tokensB = tokens(turnB.user + " " + turnB.agent)
   *   similarity = jaccard(tokensA, tokensB)
   *
   * Final score = mean of similarities.
   * Single turn = 1.0 (perfect coherence by definition).
   */
  private computeTopicCoherence(turns: ConversationTurn[]): number {
    if (turns.length <= 1) {
      return this.round(1.0);
    }

    const similarities: number[] = [];

    for (let i = 0; i < turns.length - 1; i++) {
      const tokensA = this.extractTokens(turns[i].user + ' ' + turns[i].agent);
      const tokensB = this.extractTokens(turns[i + 1].user + ' ' + turns[i + 1].agent);
      similarities.push(this.jaccard(tokensA, tokensB));
    }

    if (similarities.length === 0) {
      return this.round(1.0);
    }

    return this.round(similarities.reduce((sum, v) => sum + v, 0) / similarities.length);
  }

  /**
   * Compute progressive depth — whether the user's follow-up questions
   * build upon previous agent responses (indicating learning/deepening).
   *
   * For each turn i (1..n-1):
   *   prevTop = topTokens(prevTurn.agent)
   *   userTokens = allTokens(currTurn.user)
   *   overlap = |prevTop intersect userTokens| / |prevTop|
   *   (if prevTop is empty, score 0.0)
   *
   * Final score = mean of overlaps.
   * Single turn = 0.0 (no depth progression observable).
   */
  private computeProgressiveDepth(turns: ConversationTurn[]): number {
    if (turns.length <= 1) {
      return this.round(0.0);
    }

    const overlaps: number[] = [];

    for (let i = 1; i < turns.length; i++) {
      const prevTop = this.topTokens(turns[i - 1].agent, DEFAULT_TOP_N);
      if (prevTop.length === 0) {
        overlaps.push(0.0);
        continue;
      }

      const userTokens = new Set(this.extractTokens(turns[i].user));
      const overlapCount = prevTop.filter((t) => userTokens.has(t)).length;
      overlaps.push(overlapCount / prevTop.length);
    }

    if (overlaps.length === 0) {
      return this.round(0.0);
    }

    return this.round(overlaps.reduce((sum, v) => sum + v, 0) / overlaps.length);
  }

  /**
   * Compute session completion — whether the final agent response
   * maintains quality relative to the session average, measured by
   * character length ratio.
   *
   * completion = min(1.0, lastLength / avgLength)
   * avgLength = 0 -> 0.0
   */
  private computeSessionCompletion(turns: ConversationTurn[]): number {
    const lengths = turns.map((t) => t.agent.length);
    const avgLen = lengths.reduce((sum, l) => sum + l, 0) / lengths.length;

    if (avgLen === 0) {
      return this.round(0.0);
    }

    const lastLength = lengths[lengths.length - 1];
    const completion = Math.min(1.0, lastLength / avgLen);

    return this.round(completion);
  }

  // ════════════════════════════════════════════════════════════
  // Private: Tokenization Pipeline
  // ════════════════════════════════════════════════════════════

  /**
   * Extract and filter tokens from text.
   *
   * Pipeline:
   *   1. Lowercase the text
   *   2. Extract tokens via regex (Korean syllables, Latin chars, digits)
   *   3. Strip Korean suffixes (up to 2 iterations, root >= 2 chars)
   *   4. Filter: keep tokens with length >= 2 that are not stopwords
   *
   * @param text - Input text to tokenize
   * @returns Array of filtered tokens
   */
  private extractTokens(text: string): string[] {
    const lowered = text.toLowerCase();
    const rawTokens = lowered.match(TOKEN_REGEX) || [];

    const processed: string[] = [];

    for (const raw of rawTokens) {
      let token = raw;

      // Strip Korean suffixes if the token contains Korean characters
      if (KOREAN_CHAR_REGEX.test(token)) {
        token = this.stripKoreanSuffixes(token);
      }

      // Filter by length and stopword membership
      if (token.length >= 2 && !this.isStopword(token)) {
        processed.push(token);
      }
    }

    return processed;
  }

  /**
   * Strip Korean suffixes from a token, applying up to 2 iterations.
   * Stops if the resulting root would be shorter than 2 characters.
   *
   * @param token - The Korean token to process
   * @returns The token with suffixes stripped
   */
  private stripKoreanSuffixes(token: string): string {
    let result = token;

    for (let iteration = 0; iteration < 2; iteration++) {
      let stripped = false;

      for (const suffix of KOREAN_SUFFIXES) {
        if (result.endsWith(suffix) && result.length - suffix.length >= 2) {
          result = result.slice(0, result.length - suffix.length);
          stripped = true;
          break;
        }
      }

      if (!stripped) break;
    }

    return result;
  }

  /**
   * Check whether a token is a stopword in either Korean or English.
   *
   * @param token - The token to check (already lowercased)
   * @returns True if the token should be excluded
   */
  private isStopword(token: string): boolean {
    return KOREAN_STOPWORDS.has(token) || ENGLISH_STOPWORDS.has(token);
  }

  /**
   * Get the top-N most frequent tokens from a text.
   *
   * Extracts all tokens, counts frequencies, sorts by frequency descending,
   * and returns the top N tokens.
   *
   * @param text - Input text
   * @param n    - Number of top tokens to return (default: 10)
   * @returns Array of top-N most frequent tokens
   */
  private topTokens(text: string, n: number = DEFAULT_TOP_N): string[] {
    const tokens = this.extractTokens(text);
    const freq = new Map<string, number>();

    for (const token of tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([token]) => token);
  }

  // ════════════════════════════════════════════════════════════
  // Private: Similarity Metrics
  // ════════════════════════════════════════════════════════════

  /**
   * Compute Jaccard similarity between two token arrays.
   *
   * J(A, B) = |A intersect B| / |A union B|
   * Both empty = 1.0 (identical empty sets are perfectly similar).
   *
   * @param tokensA - First token array
   * @param tokensB - Second token array
   * @returns Jaccard similarity (0-1)
   */
  private jaccard(tokensA: string[], tokensB: string[]): number {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    if (setA.size === 0 && setB.size === 0) return 1.0;

    let intersectionSize = 0;
    for (const token of setA) {
      if (setB.has(token)) intersectionSize++;
    }

    const unionSize = new Set([...tokensA, ...tokensB]).size;
    return unionSize > 0 ? intersectionSize / unionSize : 0;
  }

  // ════════════════════════════════════════════════════════════
  // Private: Statistical Helpers
  // ════════════════════════════════════════════════════════════

  /**
   * Compute the population standard deviation of an array of numbers.
   *
   * @param values - Array of numeric values
   * @returns Population standard deviation
   */
  private populationStddev(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;

    return Math.sqrt(variance);
  }

  /**
   * Compute average turn latency from turn metadata.
   *
   * Looks for `latencyMs` or `durationMs` in each turn's metadata.
   * Returns null if no timing information is available.
   *
   * @param turns - Ordered array of conversation turns
   * @returns Average latency in milliseconds, or null
   */
  private computeAvgTurnLatency(turns: ConversationTurn[]): number | null {
    const latencies: number[] = [];

    for (const turn of turns) {
      const latency = turn.metadata?.latencyMs ?? turn.metadata?.durationMs;
      if (typeof latency === 'number' && latency > 0) {
        latencies.push(latency);
      }
    }

    if (latencies.length === 0) return null;

    const avg = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
    return Math.round(avg * 1000) / 1000;
  }

  /**
   * Round a number to the configured score precision (4 decimal places).
   *
   * @param value - The number to round
   * @returns Rounded number
   */
  private round(value: number): number {
    const factor = 10 ** SCORE_PRECISION;
    return Math.round(value * factor) / factor;
  }
}
