/**
 * Node Executor Registry
 *
 * Central registry that maps workflow node types + categories
 * to their concrete executor implementations.
 *
 * Each executor implements the INodeExecutor interface and self-registers
 * on module init. The registry also generates ConnectorRegistry entries
 * so that the frontend can discover available capabilities.
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';

// ── Shared interfaces for all executors ──

export interface NodeExecutionInput {
  nodeId: string;
  nodeType: string;
  nodeName: string;
  settings: Record<string, any>;
  /** Output from all previously completed nodes, keyed by nodeId */
  pipelineData: Record<string, NodeExecutionOutput>;
  /** Accumulated text from previous nodes for easy piping */
  previousOutput: string;
  /** Uploaded files (for file-operation input nodes) */
  uploadedFiles?: UploadedFileInfo[];
  /** Tenant + user context */
  tenantId: string;
  userId: string;
  executionSessionId: string;
  /** 노드 테스트 실행 여부 — LLM 호출이 게이트웨이를 거칠 때 x-metis-env=test 로 표시되어
   *  FinOps 원장(비용/절감) 기록에서 제외된다. */
  isTest?: boolean;
}

export interface NodeExecutionOutput {
  success: boolean;
  data: Record<string, any>;
  /** Human-readable output text (piped to next node) */
  outputText: string;
  /** Generated files (for file-operation output nodes) */
  generatedFiles?: GeneratedFile[];
  /** Duration in ms */
  durationMs: number;
  error?: string;
}

export interface UploadedFileInfo {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  isArchive: boolean;
  extractedPath?: string;
}

export interface GeneratedFile {
  name: string;
  path: string;
  format: string;
  size: number;
  downloadUrl?: string;
}

/**
 * Interface all node executors must implement.
 */
export interface INodeExecutor {
  /** Unique key for this executor, e.g. 'file-upload', 'ai-analysis-sast' */
  readonly executorKey: string;
  /** Human-readable name */
  readonly displayName: string;
  /** Node types this executor handles */
  readonly handledNodeTypes: string[];
  /** Optional: step categories this handles (e.g. 'input', 'inspection') */
  readonly handledCategories?: string[];
  /** Execute the node */
  execute(input: NodeExecutionInput): Promise<NodeExecutionOutput>;
  /** Get connector metadata for registration */
  getConnectorMetadata(): ConnectorMetadata;
}

export interface ConnectorMetadata {
  key: string;
  name: string;
  type: 'BUILT_IN' | 'MCP_SERVER' | 'REST_API' | 'WEBHOOK';
  description: string;
  category: string;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  capabilities: string[];
  /** 노드 테스트(실호출) 시 execute-node 가 실행기를 해석하는 데 쓰는 정보. */
  nodeTypes?: string[];
  categories?: string[];
}

// Generic node types that should fall back to category-based resolution
const GENERIC_NODE_TYPES = new Set(['api-call', 'custom', 'generic', 'unknown', 'notification']);

// Static alias mapping: "nodeType:category" or "nodeType" → registered executor key
const NODE_TYPE_ALIASES: Record<string, string> = {
  // notification type → email or slack
  notification: 'email-send:delivery',
  'notification:delivery': 'email-send:delivery',
  'notification:alert': 'slack-message:delivery',
  // generic api-call with specific categories
  'api-call:input': 'file-operation:input',
  'api-call:output': 'file-operation:output',
  'api-call:delivery': 'email-send:delivery',
  'api-call:monitor': 'log-monitor:monitor',
  'api-call:storage': 'data-storage:storage',
  'api-call:search': 'web-search:search',
  'api-call:schedule': 'schedule:schedule',
  'api-call:trigger': 'schedule:trigger',
  'api-call:inspection': 'ai-processing:inspection',
  'api-call:analysis': 'ai-processing:analysis',
  'api-call:pentest': 'ai-processing:pentest',
};

@Injectable()
export class NodeExecutorRegistry implements OnModuleInit {
  private readonly logger = new Logger(NodeExecutorRegistry.name);
  private executors: Map<string, INodeExecutor> = new Map();
  private typeMap: Map<string, INodeExecutor[]> = new Map();

  // Injected executors will call register() in their onModuleInit
  onModuleInit() {
    this.logger.log(`Node Executor Registry initialized with ${this.executors.size} executors`);
  }

  register(executor: INodeExecutor): void {
    this.executors.set(executor.executorKey, executor);

    // Map node types to executors
    for (const nodeType of executor.handledNodeTypes) {
      const key = executor.handledCategories
        ? executor.handledCategories.map((c) => `${nodeType}:${c}`).concat([nodeType])
        : [nodeType];

      for (const k of key) {
        const existing = this.typeMap.get(k) || [];
        existing.push(executor);
        this.typeMap.set(k, existing);
      }
    }

    this.logger.log(`Registered executor: ${executor.executorKey} (${executor.displayName})`);
  }

  /**
   * Find the best executor for a given node type + category combination.
   *
   * Resolution order:
   *   1. Exact match: type:category (e.g. "schedule:schedule")
   *   2. Type-only match: type (e.g. "schedule")
   *   3. Category-as-type fallback: category:category (handles "api-call:schedule" → "schedule:schedule")
   *   4. Category-only fallback: category (handles "api-call:schedule" → "schedule")
   *   5. Alias mapping for common generic types
   */
  resolve(nodeType: string, category?: string): INodeExecutor | null {
    // 1. Try specific type:category
    if (category) {
      const specific = this.typeMap.get(`${nodeType}:${category}`);
      if (specific?.length) return specific[0];
    }

    // 2. Fall back to type-only
    const general = this.typeMap.get(nodeType);
    if (general?.length) return general[0];

    // 3. If type is generic (api-call, custom, etc.), try category as type
    if (category && GENERIC_NODE_TYPES.has(nodeType)) {
      const byCat = this.typeMap.get(`${category}:${category}`);
      if (byCat?.length) return byCat[0];

      const catOnly = this.typeMap.get(category);
      if (catOnly?.length) return catOnly[0];
    }

    // 4. Static alias mapping (works with or without category)
    const aliasKey = category ? `${nodeType}:${category}` : nodeType;
    const alias = NODE_TYPE_ALIASES[aliasKey] || NODE_TYPE_ALIASES[nodeType];
    if (alias) {
      const aliased = this.typeMap.get(alias);
      if (aliased?.length) return aliased[0];
    }

    // 5. Fallback to passthrough executor for any unresolved types
    const passthrough = this.executors.get('passthrough');
    if (passthrough) return passthrough;

    return null;
  }

  /**
   * Get all registered executors as connector metadata (for frontend discovery).
   */
  listConnectors(): ConnectorMetadata[] {
    return Array.from(this.executors.values()).map((e) => ({
      ...e.getConnectorMetadata(),
      nodeTypes: e.handledNodeTypes,
      categories: e.handledCategories,
    }));
  }

  getExecutor(key: string): INodeExecutor | null {
    return this.executors.get(key) ?? null;
  }

  listAll(): INodeExecutor[] {
    return Array.from(this.executors.values());
  }
}
