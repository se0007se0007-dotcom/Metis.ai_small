/**
 * Adapter Invocation Service — central dispatcher for registered adapters.
 *
 * Why central? Adapters live in domain modules (FDS, AP) but the workflow
 * executor belongs to a sibling module. A central registry decouples them
 * without creating module import cycles.
 *
 * Registration pattern (mirrors LocalAgentsService):
 *   - Each module registers its adapter invokers on OnModuleInit
 *   - Key format: `adapter:<registered-key>` (matches CapabilityBinding)
 *   - Handler receives (input, ctx) and returns adapter output + metadata
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantContext } from '@metis/database';

export type AdapterInvoker = (
  input: Record<string, any>,
  ctx: TenantContext,
) => Promise<AdapterInvocationResult>;

export interface AdapterInvocationResult {
  success: boolean;
  output: Record<string, any>;
  adapter: string;
  implementation?: string;
  confidence?: number;
  latencyMs?: number;
  error?: string;
}

@Injectable()
export class AdapterInvocationService {
  private readonly logger = new Logger(AdapterInvocationService.name);
  private readonly invokers = new Map<string, AdapterInvoker>();

  register(adapterKey: string, invoker: AdapterInvoker) {
    // Keep the raw key (e.g. 'ocr-mock'), and also allow the prefixed form.
    this.invokers.set(adapterKey, invoker);
    if (!adapterKey.startsWith('adapter:')) {
      this.invokers.set(`adapter:${adapterKey}`, invoker);
    }
    this.logger.log(`[adapter-registry] Registered invoker for "${adapterKey}"`);
  }

  list(): string[] {
    return [...new Set(Array.from(this.invokers.keys()).map((k) => k.replace(/^adapter:/, '')))];
  }

  async invoke(
    ctx: TenantContext,
    adapterKey: string,
    input: Record<string, any>,
  ): Promise<AdapterInvocationResult> {
    const start = Date.now();
    const fn = this.invokers.get(adapterKey) || this.invokers.get(`adapter:${adapterKey}`);
    if (!fn) {
      throw new NotFoundException(
        `No invoker registered for adapter "${adapterKey}". Available: ${this.list().join(', ')}`,
      );
    }
    try {
      const result = await fn(input, ctx);
      result.latencyMs = result.latencyMs ?? Date.now() - start;
      return result;
    } catch (e: any) {
      return {
        success: false,
        output: {},
        adapter: adapterKey,
        latencyMs: Date.now() - start,
        error: e.message,
      };
    }
  }
}
