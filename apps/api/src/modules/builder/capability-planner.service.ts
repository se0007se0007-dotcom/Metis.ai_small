/**
 * Capability-Aware Planner — Uses CapabilityRegistry + pluggable LLM adapter
 * to propose workflow graphs with DAG-aware node dependencies.
 *
 * Flow:
 *   1. Fetch available capabilities from Registry
 *   2. Delegate to LLMPlannerAdapter (Heuristic by default; OpenAI when configured)
 *   3. Materialize the suggestion into executable WorkflowNode[] with dependsOn
 *   4. Return plan with confidence, explanation, selected capabilities
 *
 * Swap behavior via DI token 'LLM_PLANNER_ADAPTER' in BuilderModule.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { TenantContext } from '@metis/database';
import {
  CapabilityRegistryService,
  CapabilityEntry,
} from '../capability-registry/capability-registry.service';
import { WorkflowNode } from '../execution/node-router.service';
import type { LLMPlannerAdapter } from './llm-planner/planner-adapter.interface';

export interface CapabilityPlanInput {
  intent: string;
  hints?: {
    domain?: 'ap' | 'risk' | 'ops' | 'deployment' | 'general';
    preferredAgents?: string[];
    preferredConnectors?: string[];
  };
}

export interface CapabilityPlan {
  intent: string;
  nodes: WorkflowNode[];
  capabilitiesUsed: CapabilityEntry[];
  confidence: number;
  explanation: string;
  domain: string;
  plannerUsed: string;
  warnings?: string[];
}

@Injectable()
export class CapabilityPlannerService {
  private readonly logger = new Logger(CapabilityPlannerService.name);

  constructor(
    private readonly registry: CapabilityRegistryService,
    @Inject('LLM_PLANNER_ADAPTER') private readonly planner: LLMPlannerAdapter,
  ) {}

  async plan(ctx: TenantContext, input: CapabilityPlanInput): Promise<CapabilityPlan> {
    const available = await this.registry.list(ctx, {});

    const suggestion = await this.planner.suggest({
      intent: input.intent,
      availableCapabilities: available,
      hints: input.hints,
    });

    // Materialize into WorkflowNode[]
    const selectedMap = new Map(available.map((c) => [c.key, c]));
    const selectedCaps = suggestion.selectedCapabilityKeys
      .map((k) => selectedMap.get(k))
      .filter((c): c is CapabilityEntry => !!c);

    const nodes: WorkflowNode[] = suggestion.nodeOrder.map((n) => ({
      id: n.id,
      type: n.type as any,
      capability: n.capability,
      dependsOn: n.dependsOn,
      config: {},
    }));

    this.logger.log(
      `[capability-planner] ${this.planner.name} — intent="${input.intent.slice(0, 40)}..." ` +
        `domain=${suggestion.domain} caps=${selectedCaps.length} confidence=${suggestion.confidence.toFixed(2)}`,
    );

    return {
      intent: input.intent,
      nodes,
      capabilitiesUsed: selectedCaps,
      confidence: suggestion.confidence,
      explanation: suggestion.explanation,
      domain: suggestion.domain,
      plannerUsed: `${this.planner.name}@${this.planner.version}`,
      warnings: suggestion.warnings,
    };
  }
}
