/**
 * Quality Evaluator Service
 *
 * Core evaluation algorithms for LLM response quality assessment.
 * Ported from Agent Evaluator SDK (Python) to TypeScript for NestJS.
 *
 * Responsibilities:
 *   - Accuracy evaluation (token-overlap F1, Jaccard, LCS, char-level)
 *   - Hallucination detection (sentence-level context overlap analysis)
 *   - Response quality scoring (completeness, relevance, coherence, detail)
 *   - Overall grade computation (A/B/C/D/F)
 *
 * Supports Korean text (한국어) via space-based tokenization and
 * Korean character detection for appropriate text splitting.
 */
import { Injectable, Logger } from '@nestjs/common';

/** Weight constants matching Agent Evaluator SDK _QA_WEIGHT */
const QA_WEIGHTS = {
  TOKEN_OVERLAP_F1: 0.4,
  JACCARD: 0.3,
  LCS_RATIO: 0.2,
  CHAR_LEVEL: 0.1,
} as const;

/** Quality dimension weights for scoreResponseQuality */
const QUALITY_WEIGHTS = {
  completeness: 0.35,
  relevance: 0.3,
  coherence: 0.2,
  detail: 0.15,
} as const;

/** Grade thresholds */
const GRADE_THRESHOLDS = [
  { min: 90, grade: 'A' },
  { min: 80, grade: 'B' },
  { min: 70, grade: 'C' },
  { min: 60, grade: 'D' },
  { min: 0, grade: 'F' },
] as const;

/** Overall grade computation weights */
const OVERALL_WEIGHTS = {
  accuracy: 0.45,
  hallucination: 0.25,
  quality: 0.3,
} as const;

/** Korean character range detection */
const KOREAN_REGEX = /[가-힯ᄀ-ᇿ㄰-㆏]/;

/** Sentence boundary regex — handles both English and Korean punctuation */
const SENTENCE_SPLIT_REGEX = /[.!?。！？]+\s*/;

@Injectable()
export class QualityEvaluator {
  private readonly logger = new Logger(QualityEvaluator.name);

  // ═══════════════════════════════════════════
  //  Accuracy Evaluation
  // ═══════════════════════════════════════════

  /**
   * Evaluate response accuracy against a ground truth reference.
   *
   * Combines four similarity methods with Agent Evaluator SDK weights:
   *   - Token-overlap F1 (0.4)
   *   - Jaccard similarity (0.3)
   *   - LCS ratio (0.2)
   *   - Character-level similarity (0.1)
   *
   * @param response  - The generated response text
   * @param groundTruth - The reference ground truth text
   * @returns Combined accuracy score (0-1), method description, and per-metric details
   */
  evaluateAccuracy(
    response: string,
    groundTruth: string,
  ): { score: number; method: string; details: Record<string, number> } {
    if (!response || !groundTruth) {
      return {
        score: 0,
        method: 'weighted_composite',
        details: { tokenOverlapF1: 0, jaccard: 0, lcsRatio: 0, charLevel: 0 },
      };
    }

    const responseTokens = this.tokenize(response);
    const truthTokens = this.tokenize(groundTruth);

    const tokenOverlapF1 = this.computeTokenOverlapF1(responseTokens, truthTokens);
    const jaccard = this.computeJaccard(responseTokens, truthTokens);
    const lcsRatio = this.computeLcsRatio(response.toLowerCase(), groundTruth.toLowerCase());
    const charLevel = this.computeCharLevelSimilarity(response, groundTruth);

    const score = Math.min(
      1,
      Math.max(
        0,
        tokenOverlapF1 * QA_WEIGHTS.TOKEN_OVERLAP_F1 +
          jaccard * QA_WEIGHTS.JACCARD +
          lcsRatio * QA_WEIGHTS.LCS_RATIO +
          charLevel * QA_WEIGHTS.CHAR_LEVEL,
      ),
    );

    this.logger.debug(
      `Accuracy: F1=${tokenOverlapF1.toFixed(3)}, Jaccard=${jaccard.toFixed(3)}, ` +
        `LCS=${lcsRatio.toFixed(3)}, Char=${charLevel.toFixed(3)}, Combined=${score.toFixed(3)}`,
    );

    return {
      score: Math.round(score * 10000) / 10000,
      method: 'weighted_composite',
      details: {
        tokenOverlapF1: Math.round(tokenOverlapF1 * 10000) / 10000,
        jaccard: Math.round(jaccard * 10000) / 10000,
        lcsRatio: Math.round(lcsRatio * 10000) / 10000,
        charLevel: Math.round(charLevel * 10000) / 10000,
      },
    };
  }

  // ═══════════════════════════════════════════
  //  Hallucination Detection
  // ═══════════════════════════════════════════

  /**
   * Detect hallucinated content in a response by checking each sentence
   * against the provided context (and optional ground truth).
   *
   * A sentence is flagged as an unsupported claim if its word overlap
   * with the context falls below the 0.3 threshold.
   * Also checks for numerical inconsistencies between response and context.
   *
   * @param response    - The generated response text
   * @param context     - The source context / retrieved passages
   * @param groundTruth - Optional ground truth for additional validation
   * @returns Hallucination rate (0-1), flagged indicators, and sentence count
   */
  detectHallucination(
    response: string,
    context: string,
    groundTruth?: string,
  ): {
    hallucinationRate: number;
    indicators: Array<{ type: string; text: string; severity: string }>;
    sentenceCount: number;
  } {
    if (!response || !context) {
      return { hallucinationRate: 0, indicators: [], sentenceCount: 0 };
    }

    const sentences = this.splitSentences(response);
    const contextTokens = new Set(this.tokenize(context));
    const responseTokens = this.tokenize(response);

    // Context coverage check: if context is much shorter than response,
    // hallucination detection becomes unreliable because the context doesn't
    // contain enough reference material. In practice, short context is often
    // just metadata (target system, environment) not a factual reference.
    //
    // Strategy: scale threshold inversely with context richness.
    // Very short context (< 50 chars or < 10 tokens) → skip hallucination check entirely.
    const contextCharLen = context.trim().length;
    const contextTokenCount = contextTokens.size;
    const responseTokenCount = responseTokens.length;

    if (contextCharLen < 100 || contextTokenCount < 20) {
      this.logger.debug(
        `Hallucination check skipped: context too short (${contextCharLen} chars, ${contextTokenCount} tokens)`,
      );
      return { hallucinationRate: 0, indicators: [], sentenceCount: 0 };
    }

    // For longer contexts, scale threshold based on vocabulary coverage ratio
    const contextCoverage = responseTokenCount > 0 ? contextTokenCount / responseTokenCount : 1;
    const effectiveThreshold =
      contextCoverage < 0.3
        ? 0.15 // Context covers < 30% of response vocabulary → relaxed
        : 0.3; // Adequate context → standard threshold
    const groundTruthTokens = groundTruth ? new Set(this.tokenize(groundTruth)) : null;
    const contextNumbers = this.extractNumbers(context);

    const indicators: Array<{ type: string; text: string; severity: string }> = [];
    let unsupportedCount = 0;

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed.length < 5) continue; // skip trivially short fragments

      const sentenceTokens = this.tokenize(trimmed);
      if (sentenceTokens.length === 0) continue;

      // Check word overlap with context
      const overlap = this.computeSetOverlap(sentenceTokens, contextTokens);

      if (overlap < effectiveThreshold) {
        unsupportedCount++;

        // Determine severity: critical if also absent from ground truth
        let severity = 'medium';
        if (groundTruthTokens) {
          const gtOverlap = this.computeSetOverlap(sentenceTokens, groundTruthTokens);
          if (gtOverlap < 0.2) {
            severity = 'high';
          }
        }

        indicators.push({
          type: 'unsupported_claim',
          text: trimmed.length > 120 ? trimmed.substring(0, 120) + '...' : trimmed,
          severity,
        });
      }

      // Check for numerical inconsistencies
      const sentenceNumbers = this.extractNumbers(trimmed);
      for (const num of sentenceNumbers) {
        if (
          !contextNumbers.has(num) &&
          (!groundTruth || !this.extractNumbers(groundTruth).has(num))
        ) {
          indicators.push({
            type: 'numerical_inconsistency',
            text: `Number "${num}" not found in context: "${trimmed.substring(0, 80)}..."`,
            severity: 'high',
          });
        }
      }
    }

    const effectiveSentenceCount = sentences.filter((s) => s.trim().length >= 5).length;
    const hallucinationRate =
      effectiveSentenceCount > 0
        ? Math.round((unsupportedCount / effectiveSentenceCount) * 10000) / 10000
        : 0;

    this.logger.debug(
      `Hallucination: ${unsupportedCount}/${effectiveSentenceCount} unsupported sentences, ` +
        `rate=${hallucinationRate}, indicators=${indicators.length}`,
    );

    return {
      hallucinationRate,
      indicators,
      sentenceCount: effectiveSentenceCount,
    };
  }

  // ═══════════════════════════════════════════
  //  Response Quality Scoring
  // ═══════════════════════════════════════════

  /**
   * Score overall response quality across four dimensions:
   *   - Completeness (response length, sentence count, paragraph coverage)
   *   - Relevance (keyword overlap with question if provided)
   *   - Coherence (sentence structure, transition presence, logical flow)
   *   - Detail (keyword diversity, structure elements, specificity)
   *
   * Returns a total score on a 0-5 scale and a letter grade.
   *
   * @param response - The generated response text
   * @param question - Optional original question for relevance evaluation
   * @returns Total score (0-5), dimension breakdown, and letter grade
   */
  scoreResponseQuality(
    response: string,
    question?: string,
  ): {
    totalScore: number;
    dimensions: Record<string, number>;
    grade: string;
  } {
    if (!response || response.trim().length === 0) {
      return {
        totalScore: 0,
        dimensions: { completeness: 0, relevance: 0, coherence: 0, detail: 0 },
        grade: 'F',
      };
    }

    const completeness = this.scoreCompleteness(response);
    const relevance = this.scoreRelevance(response, question);
    const coherence = this.scoreCoherence(response);
    const detail = this.scoreDetail(response);

    const totalScore =
      Math.round(
        (completeness * QUALITY_WEIGHTS.completeness +
          relevance * QUALITY_WEIGHTS.relevance +
          coherence * QUALITY_WEIGHTS.coherence +
          detail * QUALITY_WEIGHTS.detail) *
          100,
      ) / 100;

    const clampedTotal = Math.min(5, Math.max(0, totalScore));
    const percentage = (clampedTotal / 5) * 100;
    const grade = this.percentageToGrade(percentage);

    this.logger.debug(
      `Quality: completeness=${completeness.toFixed(2)}, relevance=${relevance.toFixed(2)}, ` +
        `coherence=${coherence.toFixed(2)}, detail=${detail.toFixed(2)}, total=${clampedTotal.toFixed(2)}, grade=${grade}`,
    );

    return {
      totalScore: Math.round(clampedTotal * 100) / 100,
      dimensions: {
        completeness: Math.round(completeness * 100) / 100,
        relevance: Math.round(relevance * 100) / 100,
        coherence: Math.round(coherence * 100) / 100,
        detail: Math.round(detail * 100) / 100,
      },
      grade,
    };
  }

  // ═══════════════════════════════════════════
  //  Overall Grade Computation
  // ═══════════════════════════════════════════

  /**
   * Calculate an overall quality grade from all evaluation dimensions.
   *
   * Weights:
   *   - accuracy: 40%
   *   - hallucination penalty: 30% (inverted: 1 - rate)
   *   - quality: 30% (normalized to 0-1 from 0-5 scale)
   *
   * @param accuracy         - Accuracy score (0-1) from evaluateAccuracy
   * @param hallucinationRate - Hallucination rate (0-1) from detectHallucination
   * @param quality          - Quality score (0-5) from scoreResponseQuality
   * @returns Overall score (0-100) and letter grade
   */
  /**
   * @param accuracy         - Accuracy score (0-1). Pass -1 to indicate "no ground truth"
   * @param hallucinationRate - Hallucination rate (0-1)
   * @param quality          - Quality score (0-5) from scoreResponseQuality
   * @param hasGroundTruth   - Whether ground truth was available for accuracy measurement
   */
  computeOverallGrade(
    accuracy: number,
    hallucinationRate: number,
    quality: number,
    hasGroundTruth: boolean = true,
  ): { overallScore: number; grade: string } {
    const normalizedAccuracy = Math.min(1, Math.max(0, accuracy));
    const hallucinationPenalty = Math.min(1, Math.max(0, 1 - hallucinationRate));
    const normalizedQuality = Math.min(1, Math.max(0, quality / 5));

    let rawScore: number;

    if (!hasGroundTruth && accuracy <= 0) {
      // No ground truth available — redistribute accuracy weight to quality + hallucination.
      // This prevents unfairly penalizing responses that ARE correct but have no reference.
      // New weights: quality 55%, hallucination 45%
      rawScore = hallucinationPenalty * 0.45 + normalizedQuality * 0.55;
    } else {
      rawScore =
        normalizedAccuracy * OVERALL_WEIGHTS.accuracy +
        hallucinationPenalty * OVERALL_WEIGHTS.hallucination +
        normalizedQuality * OVERALL_WEIGHTS.quality;
    }

    let overallScore = Math.round(rawScore * 100);

    // Relevance penalty ONLY when ground truth IS available and accuracy is genuinely low.
    // This prevents capping scores for responses without ground truth.
    if (hasGroundTruth && normalizedAccuracy < 0.1 && normalizedQuality < 0.4) {
      overallScore = Math.min(overallScore, 30);
    } else if (hasGroundTruth && normalizedAccuracy < 0.1 && normalizedQuality < 0.5) {
      overallScore = Math.min(overallScore, 45);
    }
    const grade = this.percentageToGrade(overallScore);

    this.logger.debug(
      `Overall: accuracy=${normalizedAccuracy.toFixed(3)}, hallPenalty=${hallucinationPenalty.toFixed(3)}, ` +
        `quality=${normalizedQuality.toFixed(3)}, score=${overallScore}, grade=${grade}`,
    );

    return { overallScore, grade };
  }

  // ═══════════════════════════════════════════
  //  Private: Tokenization & Text Processing
  // ═══════════════════════════════════════════

  /**
   * Tokenize text into lowercase words. Handles Korean (space-based)
   * and English (word boundary) tokenization.
   */
  private tokenize(text: string): string[] {
    const normalized = text.toLowerCase().trim();
    if (!normalized) return [];

    // Split by whitespace and non-alphanumeric/Korean characters
    return normalized
      .split(/[\s,;:!?.'"()\[\]{}<>]+/)
      .map((t) => t.replace(/[^\w가-힯ᄀ-ᇿ㄰-㆏]/g, ''))
      .filter((t) => t.length > 0);
  }

  /**
   * Split text into sentences. Uses punctuation-based splitting that
   * handles both English and Korean sentence endings.
   */
  private splitSentences(text: string): string[] {
    return text
      .split(SENTENCE_SPLIT_REGEX)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Extract unique numeric values from text for numerical consistency checks.
   */
  private extractNumbers(text: string): Set<string> {
    const matches = text.match(/\d+(?:\.\d+)?/g);
    return new Set(matches || []);
  }

  // ═══════════════════════════════════════════
  //  Private: Similarity Algorithms
  // ═══════════════════════════════════════════

  /**
   * Compute token-overlap F1 score between two token arrays.
   * F1 = 2 * precision * recall / (precision + recall)
   */
  private computeTokenOverlapF1(responseTokens: string[], truthTokens: string[]): number {
    if (responseTokens.length === 0 || truthTokens.length === 0) return 0;

    const truthSet = new Set(truthTokens);
    const overlapCount = responseTokens.filter((t) => truthSet.has(t)).length;

    const precision = overlapCount / responseTokens.length;
    const recall = overlapCount / truthTokens.length;

    if (precision + recall === 0) return 0;
    return (2 * precision * recall) / (precision + recall);
  }

  /**
   * Compute Jaccard similarity between two token arrays.
   * J(A,B) = |A ∩ B| / |A ∪ B|
   */
  private computeJaccard(tokensA: string[], tokensB: string[]): number {
    if (tokensA.length === 0 && tokensB.length === 0) return 1;
    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    let intersectionSize = 0;
    for (const token of setA) {
      if (setB.has(token)) intersectionSize++;
    }

    const unionSize = new Set([...tokensA, ...tokensB]).size;
    return unionSize > 0 ? intersectionSize / unionSize : 0;
  }

  /**
   * Compute the longest common subsequence ratio between two strings.
   * Ratio = 2 * LCS_length / (len(a) + len(b))
   *
   * Uses O(min(m,n)) space dynamic programming.
   */
  private computeLcsRatio(a: string, b: string): number {
    if (a.length === 0 || b.length === 0) return 0;

    // Ensure a is the shorter string for space optimization
    if (a.length > b.length) {
      [a, b] = [b, a];
    }

    const m = a.length;
    const n = b.length;

    // Use two rows instead of full matrix for O(min(m,n)) space
    let prev = new Array<number>(m + 1).fill(0);
    let curr = new Array<number>(m + 1).fill(0);

    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= m; i++) {
        if (a[i - 1] === b[j - 1]) {
          curr[i] = prev[i - 1] + 1;
        } else {
          curr[i] = Math.max(curr[i - 1], prev[i]);
        }
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }

    const lcsLength = prev[m];
    return (2 * lcsLength) / (a.length + b.length);
  }

  /**
   * Compute character-level similarity using bigram overlap.
   * Produces character n-gram (n=2) sets and computes Dice coefficient.
   */
  private computeCharLevelSimilarity(a: string, b: string): number {
    const bigramsA = this.extractBigrams(a.toLowerCase());
    const bigramsB = this.extractBigrams(b.toLowerCase());

    if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
    if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

    let intersectionSize = 0;
    for (const bigram of bigramsA) {
      if (bigramsB.has(bigram)) intersectionSize++;
    }

    // Dice coefficient: 2 * |A ∩ B| / (|A| + |B|)
    return (2 * intersectionSize) / (bigramsA.size + bigramsB.size);
  }

  /**
   * Extract character bigrams from text (ignoring whitespace).
   */
  private extractBigrams(text: string): Set<string> {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const bigrams = new Set<string>();
    for (let i = 0; i < cleaned.length - 1; i++) {
      bigrams.add(cleaned[i] + cleaned[i + 1]);
    }
    return bigrams;
  }

  /**
   * Compute set overlap ratio: fraction of tokenSet elements found in referenceSet.
   */
  private computeSetOverlap(tokenList: string[], referenceSet: Set<string>): number {
    if (tokenList.length === 0) return 0;
    const matchCount = tokenList.filter((t) => referenceSet.has(t)).length;
    return matchCount / tokenList.length;
  }

  // ═══════════════════════════════════════════
  //  Private: Quality Dimension Scorers
  // ═══════════════════════════════════════════

  /**
   * Score completeness (0-5) based on response length, sentence count,
   * and paragraph coverage.
   */
  private scoreCompleteness(response: string): number {
    const charCount = response.trim().length;
    const sentences = this.splitSentences(response);
    const paragraphs = response.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

    let score = 0;

    // Length score (0-2): reward responses of reasonable length
    if (charCount >= 500) score += 2.0;
    else if (charCount >= 200) score += 1.5;
    else if (charCount >= 100) score += 1.0;
    else if (charCount >= 30) score += 0.5;

    // Sentence count score (0-1.5): reward multi-sentence responses
    if (sentences.length >= 8) score += 1.5;
    else if (sentences.length >= 5) score += 1.2;
    else if (sentences.length >= 3) score += 0.8;
    else if (sentences.length >= 1) score += 0.4;

    // Paragraph coverage (0-1.5): reward structured multi-paragraph answers
    if (paragraphs.length >= 4) score += 1.5;
    else if (paragraphs.length >= 2) score += 1.0;
    else if (paragraphs.length >= 1) score += 0.5;

    return Math.min(5, score);
  }

  /**
   * Score relevance (0-5) based on keyword overlap with the question.
   * If no question is provided, gives a baseline score based on
   * response structure heuristics.
   */
  private scoreRelevance(response: string, question?: string): number {
    if (!question) {
      // Without a question, give moderate baseline score if response is substantive
      const sentences = this.splitSentences(response);
      if (sentences.length >= 3) return 3.0;
      if (sentences.length >= 1) return 2.0;
      return 1.0;
    }

    const questionTokens = this.tokenize(question);
    const responseTokens = this.tokenize(response);

    if (questionTokens.length === 0) return 3.0;

    // Remove common stop words for better relevance signal
    const stopWords = new Set([
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
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'and',
      'but',
      'or',
      'not',
      'no',
      'nor',
      'so',
      'yet',
      'both',
      'each',
      'every',
      'all',
      'any',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'than',
      'too',
      'very',
      'just',
      'about',
      'what',
      'which',
      'who',
      'whom',
      'this',
      'that',
      'these',
      'those',
      'it',
      'its',
      'how',
      'when',
      'where',
      'why',
      // Korean particles and connectors
      '은',
      '는',
      '이',
      '가',
      '을',
      '를',
      '에',
      '에서',
      '으로',
      '로',
      '의',
      '와',
      '과',
      '도',
      '만',
      '까지',
      '부터',
      '에게',
      '한테',
      '하고',
      '이다',
      '입니다',
      '합니다',
      '하는',
      '있는',
      '없는',
    ]);

    const meaningfulQuestion = questionTokens.filter((t) => !stopWords.has(t) && t.length > 1);
    const responseSet = new Set(responseTokens);

    if (meaningfulQuestion.length === 0) return 3.0;

    // Direct keyword match
    const matchCount = meaningfulQuestion.filter((t) => responseSet.has(t)).length;
    const directCoverage = matchCount / meaningfulQuestion.length;

    // Partial/substring match for Korean compound words (e.g. "쿠버네티스" in "쿠버네티스에서")
    let partialMatches = 0;
    for (const qt of meaningfulQuestion) {
      if (responseSet.has(qt)) continue; // already counted
      // Check if any response token contains or is contained by the question token
      let found = false;
      for (const rt of responseTokens) {
        if (rt.length >= 2 && qt.length >= 2 && (rt.includes(qt) || qt.includes(rt))) {
          found = true;
          break;
        }
      }
      if (found) partialMatches++;
    }

    const totalMatches = matchCount + partialMatches * 0.7; // partial matches worth 70%
    const coverage = Math.min(1, totalMatches / meaningfulQuestion.length);

    // Map coverage (0-1) to quality scale (0-5)
    if (coverage >= 0.7) return 5.0;
    if (coverage >= 0.5) return 4.0;
    if (coverage >= 0.3) return 3.0;
    if (coverage >= 0.15) return 2.0;
    if (coverage > 0) return 1.0;
    return 0;
  }

  /**
   * Score coherence (0-5) based on sentence structure, transitions,
   * and logical flow indicators.
   */
  private scoreCoherence(response: string): number {
    const sentences = this.splitSentences(response);
    if (sentences.length === 0) return 0;

    let score = 0;

    // Transition words indicate logical flow
    const transitionPatterns = [
      // English transitions
      /\b(however|therefore|furthermore|moreover|additionally|consequently|thus|hence)\b/i,
      /\b(first|second|third|finally|in addition|in conclusion|as a result)\b/i,
      /\b(for example|for instance|specifically|in particular|such as)\b/i,
      /\b(on the other hand|in contrast|conversely|meanwhile|nevertheless)\b/i,
      // Korean transitions
      /(?:그러나|따라서|또한|게다가|결과적으로|예를 들어|특히|반면에|그럼에도|즉|한편)/,
      /(?:첫째|둘째|셋째|마지막으로|결론적으로|요약하면)/,
    ];

    let transitionCount = 0;
    for (const sentence of sentences) {
      for (const pattern of transitionPatterns) {
        if (pattern.test(sentence)) {
          transitionCount++;
          break;
        }
      }
    }

    // Transition score (0-2)
    const transitionRatio = sentences.length > 1 ? transitionCount / (sentences.length - 1) : 0;
    if (transitionRatio >= 0.4) score += 2.0;
    else if (transitionRatio >= 0.2) score += 1.5;
    else if (transitionRatio > 0) score += 1.0;
    // No bonus for single-sentence answers — they lack coherence by definition

    // Sentence length consistency (0-1.5): penalize extreme variance
    const sentenceLengths = sentences.map((s) => s.length);
    const avgLength = sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;
    if (avgLength > 0 && sentences.length > 1) {
      const variance =
        sentenceLengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) /
        sentenceLengths.length;
      const cv = Math.sqrt(variance) / avgLength; // coefficient of variation
      if (cv < 0.5) score += 1.5;
      else if (cv < 0.8) score += 1.0;
      else if (cv < 1.2) score += 0.5;
    } else {
      score += 0.5;
    }

    // Proper sentence structure (0-1.5): sentences should start with capital or Korean
    let properStartCount = 0;
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed.length === 0) continue;
      const firstChar = trimmed[0];
      if (/[A-Z]/.test(firstChar) || KOREAN_REGEX.test(firstChar) || /\d/.test(firstChar)) {
        properStartCount++;
      }
    }
    const properRatio = properStartCount / sentences.length;
    score += properRatio * 1.5;

    return Math.min(5, score);
  }

  /**
   * Score detail level (0-5) based on keyword diversity, structural
   * elements (headers, lists, code blocks), and specificity markers.
   */
  private scoreDetail(response: string): number {
    const tokens = this.tokenize(response);
    if (tokens.length === 0) return 0;

    let score = 0;

    // Keyword diversity (0-2): unique tokens / total tokens
    const uniqueTokens = new Set(tokens);
    const diversity = uniqueTokens.size / tokens.length;
    if (diversity >= 0.6) score += 2.0;
    else if (diversity >= 0.4) score += 1.5;
    else if (diversity >= 0.25) score += 1.0;
    else score += 0.5;

    // Structural elements (0-1.5): check for headers, lists, code blocks
    const hasHeaders = /^#{1,6}\s+.+/m.test(response) || /^[A-Z가-힣].+:$/m.test(response);
    const hasLists = /^[\s]*[-*•]\s+.+/m.test(response) || /^\s*\d+[.)]\s+.+/m.test(response);
    const hasCodeBlocks = /```[\s\S]*?```/.test(response) || /`[^`]+`/.test(response);

    if (hasHeaders) score += 0.5;
    if (hasLists) score += 0.5;
    if (hasCodeBlocks) score += 0.5;

    // Specificity markers (0-1.5): numbers, proper nouns, technical terms
    const hasNumbers = /\d+/.test(response);
    const hasUrls = /https?:\/\/\S+/.test(response);
    const hasTechnicalTerms =
      /\b(API|SDK|HTTP|SQL|JSON|XML|REST|gRPC|OAuth|JWT|RBAC)\b/i.test(response) ||
      /\b(알고리즘|아키텍처|데이터베이스|프레임워크|인터페이스)\b/.test(response);

    if (hasNumbers) score += 0.5;
    if (hasUrls) score += 0.5;
    if (hasTechnicalTerms) score += 0.5;

    return Math.min(5, score);
  }

  // ═══════════════════════════════════════════
  //  Private: Grade Mapping
  // ═══════════════════════════════════════════

  /**
   * Map a percentage (0-100) to a letter grade.
   */
  private percentageToGrade(percentage: number): string {
    for (const threshold of GRADE_THRESHOLDS) {
      if (percentage >= threshold.min) return threshold.grade;
    }
    return 'F';
  }
}
