/**
 * OpenAI GPT-4 ML Score Adapter
 *
 * Demonstrates integration with OpenAI's GPT-4 API for LLM-based risk analysis.
 * Currently returns deterministic mock results, but shows the structure for real API calls.
 *
 * To enable real OpenAI scoring:
 * 1. Set FDS_OPENAI_API_KEY environment variable
 * 2. Uncomment the real API call in score()
 * 3. Install openai npm package: npm install openai
 *
 * Useful for:
 * - Complex contextual fraud analysis
 * - Explaining risk decisions in human terms
 * - Handling novel patterns outside heuristic rules
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MLScoreAdapter, MLScoreInput, MLScoreOutput } from './ml-adapter.interface';

@Injectable()
export class OpenAIMLAdapter implements MLScoreAdapter {
  private readonly logger = new Logger(OpenAIMLAdapter.name);

  readonly name = 'openai-gpt4';
  readonly version = '1.0';

  private readonly apiKey: string | null;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('FDS_OPENAI_API_KEY') || null;
  }

  /**
   * Score using OpenAI GPT-4.
   *
   * In production, this would:
   * 1. Format the features into a natural language prompt
   * 2. Call OpenAI Chat Completion API
   * 3. Parse the response for risk score and explanation
   * 4. Return structured MLScoreOutput
   */
  async score(input: MLScoreInput): Promise<MLScoreOutput> {
    const startTime = Date.now();

    try {
      // MOCK IMPLEMENTATION: Return deterministic result
      // In production, replace with actual OpenAI API call (see commented code below)

      const mockScore = this.generateMockScore(input);

      return {
        score: mockScore,
        confidence: 0.88,
        modelName: this.name,
        latencyMs: Date.now() - startTime,
        features: input.features,
      };

      /* PRODUCTION CODE (requires: npm install openai)
      // Uncomment when ready to use real API
      if (!this.apiKey) {
        this.logger.warn('OpenAI API key not configured, falling back to mock');
        return {
          score: 0.5,
          confidence: 0.1,
          modelName: this.name,
          latencyMs: Date.now() - startTime,
        };
      }

      const client = new OpenAI({ apiKey: this.apiKey });

      const prompt = this.buildPrompt(input);

      const response = await client.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a financial fraud detection expert. Analyze transaction patterns and return a risk score from 0 to 1.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2, // Low temperature for consistent scoring
        max_tokens: 500,
      });

      const scoreValue = this.parseOpenAIResponse(response.choices[0]?.message?.content || '');

      return {
        score: scoreValue,
        confidence: 0.85,
        modelName: this.name,
        latencyMs: Date.now() - startTime,
        features: input.features,
      };
      */
    } catch (error) {
      this.logger.error(`OpenAI scoring failed for ${input.subjectId}:`, error);
      return {
        score: 0.5,
        confidence: 0.1,
        modelName: this.name,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.apiKey) {
      this.logger.warn('OpenAI adapter healthy check: API key not configured');
      return false;
    }

    // In production, you might call a lightweight API endpoint to verify connectivity
    // For now, just verify key exists and has basic format
    return this.apiKey.length > 20; // OpenAI keys are typically 40+ chars
  }

  /**
   * Generate a mock score for demonstration.
   * In production, this is replaced by actual API response parsing.
   */
  private generateMockScore(input: MLScoreInput): number {
    const amount = input.features.amount || 0;
    const velocity = input.features.velocity || 0;

    // Deterministic mock: same input always gives same output
    const hashValue = (input.subjectId.charCodeAt(0) * amount + velocity) % 100;

    // Map to 0..1 range with some realistic variation
    return (hashValue + 30) / 100;
  }

  /**
   * Build a natural language prompt for GPT-4.
   * Used in production implementation.
   */
  private buildPrompt(input: MLScoreInput): string {
    const featureList = Object.entries(input.features)
      .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
      .join('\n');

    return `
Analyze the following transaction for fraud risk.

Subject: ${input.subjectType} (ID: ${input.subjectId})

Features:
${featureList}

${input.historicalContext ? `Historical Context:\n${JSON.stringify(input.historicalContext, null, 2)}` : ''}

Provide:
1. A risk score from 0 (safe) to 1 (high fraud risk)
2. Brief reasoning (1-2 sentences)
3. Confidence level (0-1)

Format your response as JSON:
{
  "score": <number 0-1>,
  "reasoning": "<string>",
  "confidence": <number 0-1>
}
    `;
  }

  /**
   * Parse OpenAI response to extract risk score.
   * Used in production implementation.
   */
  private parseOpenAIResponse(content: string): number {
    try {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('Could not extract JSON from OpenAI response');
        return 0.5;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const score = parseFloat(parsed.score || parsed.riskScore || '0.5');

      return Math.min(Math.max(score, 0), 1.0);
    } catch (error) {
      this.logger.error('Failed to parse OpenAI response:', error);
      return 0.5;
    }
  }
}
