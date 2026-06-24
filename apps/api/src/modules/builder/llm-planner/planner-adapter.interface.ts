/**
 * LLM Planner Adapter — pluggable interface for LLM-based intent understanding.
 *
 * Implementations: MockPlannerAdapter (deterministic), OpenAIPlannerAdapter (prod),
 * AnthropicPlannerAdapter (prod), HttpPlannerAdapter (self-hosted).
 */
import type { CapabilityEntry } from '../../capability-registry/capability-registry.service';

export interface PlannerContext {
  intent: string;
  availableCapabilities: CapabilityEntry[];
  hints?: {
    domain?: string;
    preferredAgents?: string[];
    preferredConnectors?: string[];
    examples?: Array<{ intent: string; nodes: string[] }>;
  };
}

export interface PlannerSuggestion {
  domain: string; // inferred domain (ap/risk/ops/deployment/general)
  selectedCapabilityKeys: string[]; // ordered list of capability keys to include
  nodeOrder: Array<{
    id: string;
    type: 'connector' | 'agent' | 'adapter' | 'decision' | 'human' | 'skill' | 'start' | 'end';
    capability?: string;
    dependsOn?: string[]; // DAG support
    rationale?: string;
  }>;
  confidence: number; // 0..1 — how sure the planner is
  explanation: string; // natural-language summary for the user
  warnings?: string[];
}

export interface LLMPlannerAdapter {
  readonly name: string;
  readonly version: string;
  suggest(ctx: PlannerContext): Promise<PlannerSuggestion>;
  isHealthy(): Promise<boolean>;
}
