/**
 * HTTP Model Adapter
 *
 * Generic adapter for calling external ML model endpoints via HTTP/HTTPS.
 * Supports any model service that accepts MLScoreInput-like JSON and returns MLScoreOutput-like JSON.
 *
 * Useful for:
 * - Calling custom-trained ML models (scikit-learn, TensorFlow, XGBoost services)
 * - Microservice architecture with separate ML inference engines
 * - Easy integration with third-party model APIs
 *
 * Configuration:
 * {
 *   endpoint: "https://ml-service.internal/score",
 *   modelName: "xgboost-v2.1",
 *   apiKey: "optional-bearer-token" (optional)
 * }
 */

import { Logger } from '@nestjs/common';
import { resolveValidatedExternalIps, pinnedLookup } from '../../../common/utils/url-validator';
import { MLScoreAdapter, MLScoreInput, MLScoreOutput } from './ml-adapter.interface';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface HttpModelAdapterConfig {
  /** HTTP(S) endpoint for the model service */
  endpoint: string;

  /** Human-readable name of the model (for tracking) */
  modelName: string;

  /** Optional: Bearer token for authentication */
  apiKey?: string;

  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;

  /** Optional: Custom headers to send with requests */
  headers?: Record<string, string>;
}

export class HttpModelAdapter implements MLScoreAdapter {
  private readonly logger = new Logger(HttpModelAdapter.name);

  readonly name: string;
  readonly version = '1.0';

  private readonly config: HttpModelAdapterConfig;
  private readonly timeout: number;

  constructor(config: HttpModelAdapterConfig) {
    this.config = config;
    this.name = config.modelName;
    this.timeout = config.timeout || 5000;
  }

  /**
   * Score by calling the external HTTP endpoint.
   *
   * POST request structure:
   * {
   *   "subjectType": "ACCOUNT",
   *   "subjectId": "acct-123",
   *   "features": { ... },
   *   "historicalContext": { ... }
   * }
   *
   * Expected response structure:
   * {
   *   "score": 0.75,
   *   "confidence": 0.88,
   *   "modelName": "xgboost-v2.1",
   *   "latencyMs": 150
   * }
   */
  async score(input: MLScoreInput): Promise<MLScoreOutput> {
    const startTime = Date.now();

    try {
      const responseData = await this.callHttpEndpoint(input);
      const latencyMs = Date.now() - startTime;

      // Ensure response has required fields
      if (typeof responseData.score !== 'number' || typeof responseData.confidence !== 'number') {
        this.logger.error('Invalid response format from endpoint:', responseData);
        return this.createFallbackResponse(latencyMs, 'invalid_response');
      }

      return {
        score: Math.min(Math.max(responseData.score, 0), 1.0),
        confidence: Math.min(Math.max(responseData.confidence, 0), 1.0),
        modelName: responseData.modelName || this.name,
        latencyMs: responseData.latencyMs || latencyMs,
        features: responseData.features || input.features,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this.logger.error(`HTTP model endpoint call failed (${this.config.endpoint}):`, error);
      return this.createFallbackResponse(
        latencyMs,
        error instanceof Error ? error.message : 'unknown_error',
      );
    }
  }

  /**
   * Health check by calling the endpoint with a minimal probe request.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const probeInput: MLScoreInput = {
        subjectType: 'PROBE',
        subjectId: 'health-check',
        features: { amount: 0 },
      };

      const response = await this.callHttpEndpoint(probeInput);

      // If we get any response with score field, endpoint is reachable
      return typeof response.score === 'number';
    } catch (error) {
      this.logger.warn(`Health check failed for ${this.config.endpoint}:`, error);
      return false;
    }
  }

  /**
   * Call the HTTP endpoint with the input.
   * Uses Node's http/https modules (no external dependencies).
   */
  private async callHttpEndpoint(input: MLScoreInput): Promise<any> {
    // SSRF guard (H-1) + DNS-rebinding pin: pin the connect to a validated IP.
    const { ips } = await resolveValidatedExternalIps(this.config.endpoint);
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.endpoint);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const requestBody = JSON.stringify(input);

      const requestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
          ...this.config.headers,
        },
        timeout: this.timeout,
        lookup: pinnedLookup(ips),
        servername: url.hostname,
      };

      const request = client.request(url, requestOptions, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          try {
            if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
              reject(new Error(`HTTP ${response.statusCode}: ${data || 'no response body'}`));
            } else {
              const parsed = JSON.parse(data);
              resolve(parsed);
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse response: ${parseError}`));
          }
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`Request timeout after ${this.timeout}ms`));
      });

      request.write(requestBody);
      request.end();
    });
  }

  /**
   * Create a fallback response when the endpoint fails.
   * Neutral score with low confidence indicates degradation.
   */
  private createFallbackResponse(latencyMs: number, reason: string): MLScoreOutput {
    return {
      score: 0.5, // Neutral score
      confidence: 0.0, // Zero confidence indicates adapter failure
      modelName: this.name,
      latencyMs,
      // Note reason in logs; in production, could emit metrics here
    };
  }
}
