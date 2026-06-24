/**
 * FDS Adapter Bootstrap — registers FDS ML adapter invokers into the central
 * AdapterInvocationService so the workflow executor can call them.
 *
 * Each registered key maps to an implementation:
 *   - adapter:fds-ml-heuristic → HeuristicMLAdapter (default)
 *   - adapter:fds-ml-openai    → OpenAIMLAdapter (when key configured)
 *   - adapter:fds-ml-http      → HttpModelAdapter (when endpoint configured)
 *
 * All registered invokers share the same active MLScoreAdapter selected by
 * the FDS module's DI token. Swapping the DI binding changes behavior for all.
 */
import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { TenantContext } from '@metis/database';
import { AdapterInvocationService } from '../capability-registry/adapter-invocation.service';
import type { MLScoreAdapter } from './adapters/ml-adapter.interface';

@Injectable()
export class FdsAdapterBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(FdsAdapterBootstrapService.name);

  constructor(
    private readonly registry: AdapterInvocationService,
    @Inject('FDS_ML_ADAPTER') private readonly mlAdapter: MLScoreAdapter,
  ) {}

  onModuleInit() {
    const keys = ['fds-ml-heuristic', 'fds-ml-openai', 'fds-ml-http'];
    for (const key of keys) {
      this.registry.register(key, async (input: Record<string, any>, ctx: TenantContext) => {
        const result = await this.mlAdapter
          .score({
            subjectType: input.subjectType ?? 'transaction',
            subjectId: input.subjectId ?? 'anonymous',
            features: input.features ?? input,
            historicalContext: input.historicalContext,
          })
          .catch(
            (e) =>
              ({
                score: 0.5,
                confidence: 0,
                modelName: 'fallback',
                latencyMs: 0,
                features: {},
                _error: e.message,
              }) as any,
          );

        return {
          success: !('_error' in result),
          output: {
            score: result.score,
            confidence: result.confidence,
            modelName: result.modelName,
            features: result.features,
          },
          adapter: key,
          implementation: this.mlAdapter.name,
          confidence: result.confidence,
          latencyMs: result.latencyMs,
          error: (result as any)._error,
        };
      });
    }
    this.logger.log(`[fds-bootstrap] Registered ${keys.length} FDS adapter invokers`);
  }
}
