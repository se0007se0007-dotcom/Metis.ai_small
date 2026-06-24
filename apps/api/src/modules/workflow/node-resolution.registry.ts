/**
 * Node Resolution Registry — maps frontend UI types to backend execution types.
 *
 * 3-Layer Type System:
 *   Layer 1 (UI Type)        — what the user sees in the builder canvas
 *   Layer 2 (Execution Type) — which runtime handles execution (connector, agent, adapter, decision, human)
 *   Layer 3 (Capability)     — specific implementation (connector:jira:create_ticket, agent:pentest:8-vector)
 *
 * This registry is the single source of truth for how builder nodes translate to
 * actual executable units in the WorkflowRunnerService pipeline.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { WorkflowNodeType } from '../execution/node-router.service';

// ── Types ──

export interface NodeResolution {
  /** Backend runtime that handles this node */
  executionType: WorkflowNodeType;
  /** Base capability pattern (before config-based resolution) */
  capabilityPattern: string;
  /** If this node needs a tenant-installed connector, its key */
  requiredConnectorKey?: string;
  /** Risk classification for governance */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** What this node does semantically */
  intentCategory: string;
  /** Config fields that can be parameterized at runtime */
  parameterizableKeys: string[];
  /** Output keys this node type produces */
  defaultOutputKeys: string[];
}

export interface ResolvedNode {
  /** Original frontend type */
  uiType: string;
  /** Backend execution type */
  executionType: WorkflowNodeType;
  /** Fully resolved capability string */
  capability: string;
  /** Intent category */
  intentCategory: string;
  /** Risk level */
  riskLevel: string;
  /** Auto-inferred inputMapping (JSON path references) */
  inputMapping: Record<string, string>;
  /** Output keys */
  outputKeys: string[];
}

// ── Semantic output→input mappings for auto-inference ──

const SEMANTIC_MAPPINGS: Record<string, string[]> = {
  search_results: ['context', 'sourceData', 'inputData', 'content'],
  analysis_result: ['body', 'description', 'issueBody', 'reportContent'],
  summary: ['body', 'description', 'messageContent'],
  file_content: ['sourceCode', 'inputData', 'content', 'rawData'],
  vulnerabilities: ['findings', 'issueList', 'alertData'],
  report_html: ['htmlBody', 'body', 'content'],
  ticket_id: ['referenceId', 'relatedTicket'],
  risk_score: ['threshold_input', 'severity_input'],
  transform_result: ['inputData', 'content', 'sourceData'],
  notification_sent: [],
  audit_id: [],
  deploy_status: ['statusInput'],
};

// ── Registry Definition ──

const REGISTRY: Record<string, NodeResolution> = {
  schedule: {
    executionType: 'start',
    capabilityPattern: 'trigger:cron',
    riskLevel: 'low',
    intentCategory: 'trigger',
    parameterizableKeys: ['scheduleType', 'scheduleTime', 'scheduleWeekday', 'timezone'],
    defaultOutputKeys: ['trigger_event', 'triggered_at'],
  },

  webhook: {
    executionType: 'start',
    capabilityPattern: 'trigger:webhook',
    riskLevel: 'low',
    intentCategory: 'trigger',
    parameterizableKeys: ['path', 'method', 'authValidation'],
    defaultOutputKeys: ['webhook_payload', 'triggered_at'],
  },

  'web-search': {
    executionType: 'connector',
    capabilityPattern: 'connector:web-search',
    riskLevel: 'low',
    intentCategory: 'search',
    parameterizableKeys: ['keywords', 'maxResults', 'language', 'searchEngine'],
    defaultOutputKeys: ['search_results', 'result_count', 'source_urls'],
  },

  'ai-processing': {
    executionType: 'agent',
    capabilityPattern: 'agent:workflow-agent',
    riskLevel: 'medium',
    intentCategory: 'analyze',
    parameterizableKeys: ['model', 'promptTemplate', 'temperature', 'maxTokens'],
    defaultOutputKeys: ['analysis_result', 'summary', 'recommendations', 'confidence_score'],
  },

  'email-send': {
    executionType: 'connector',
    capabilityPattern: 'connector:email-smtp',
    requiredConnectorKey: 'email-smtp',
    riskLevel: 'high',
    intentCategory: 'notify',
    parameterizableKeys: ['recipientEmail', 'subject', 'body', 'cc', 'bcc'],
    defaultOutputKeys: ['message_id', 'send_status', 'timestamp'],
  },

  'slack-message': {
    executionType: 'connector',
    capabilityPattern: 'connector:slack-webhook',
    requiredConnectorKey: 'slack',
    riskLevel: 'high',
    intentCategory: 'notify',
    parameterizableKeys: ['channel', 'messageTemplate', 'mentionUsers'],
    defaultOutputKeys: ['message_id', 'send_status', 'channel'],
  },

  'api-call': {
    executionType: 'connector',
    capabilityPattern: 'connector:generic-http',
    riskLevel: 'high',
    intentCategory: 'integrate',
    parameterizableKeys: ['url', 'method', 'headers', 'bodyTemplate', 'authType'],
    defaultOutputKeys: ['response_data', 'status_code', 'response_headers'],
  },

  jira: {
    executionType: 'connector',
    capabilityPattern: 'connector:jira',
    requiredConnectorKey: 'jira',
    riskLevel: 'medium',
    intentCategory: 'integrate',
    parameterizableKeys: ['action', 'projectKey', 'issueType', 'priority', 'assignee'],
    defaultOutputKeys: ['ticket_id', 'ticket_url', 'ticket_key'],
  },

  'git-deploy': {
    executionType: 'connector',
    capabilityPattern: 'connector:git',
    requiredConnectorKey: 'github',
    riskLevel: 'critical',
    intentCategory: 'deploy',
    parameterizableKeys: ['repoUrl', 'branch', 'commitMessage', 'action'],
    defaultOutputKeys: ['commit_sha', 'deploy_status', 'deploy_url'],
  },

  condition: {
    executionType: 'decision',
    capabilityPattern: 'decision:evaluator',
    riskLevel: 'low',
    intentCategory: 'control-flow',
    parameterizableKeys: ['conditionExpression'],
    defaultOutputKeys: ['result', 'branch'],
  },

  'wait-approval': {
    executionType: 'human',
    capabilityPattern: 'human:approval-gate',
    riskLevel: 'low',
    intentCategory: 'approval',
    parameterizableKeys: ['waitType', 'timeoutMinutes'],
    defaultOutputKeys: ['approval_result', 'approved_by', 'approved_at'],
  },

  'data-storage': {
    executionType: 'adapter',
    capabilityPattern: 'adapter:data-storage',
    riskLevel: 'low',
    intentCategory: 'store',
    parameterizableKeys: ['storageType', 'operation', 'tableName'],
    defaultOutputKeys: ['record_id', 'storage_status', 'audit_id'],
  },

  'data-transform': {
    executionType: 'adapter',
    capabilityPattern: 'adapter:data-transform',
    riskLevel: 'low',
    intentCategory: 'transform',
    parameterizableKeys: ['transformType', 'mappingRules'],
    defaultOutputKeys: ['transform_result', 'record_count'],
  },

  'log-monitor': {
    executionType: 'adapter',
    capabilityPattern: 'adapter:log-monitor',
    riskLevel: 'low',
    intentCategory: 'monitor',
    parameterizableKeys: ['logLevel', 'destination', 'alertThreshold'],
    defaultOutputKeys: ['audit_id', 'log_status'],
  },

  'file-operation': {
    executionType: 'adapter',
    capabilityPattern: 'adapter:file-io',
    riskLevel: 'medium',
    intentCategory: 'file',
    parameterizableKeys: ['operation', 'path', 'format'],
    defaultOutputKeys: ['file_content', 'file_path', 'file_size'],
  },

  notification: {
    executionType: 'connector',
    capabilityPattern: 'connector:notification',
    riskLevel: 'medium',
    intentCategory: 'notify',
    parameterizableKeys: ['notifyChannel', 'recipientType', 'notifyTemplate', 'customRecipients'],
    defaultOutputKeys: ['notification_sent', 'recipient_count', 'channels_used'],
  },

  pentest: {
    executionType: 'agent',
    capabilityPattern: 'agent:pentest',
    riskLevel: 'medium',
    intentCategory: 'analyze',
    parameterizableKeys: ['enabledVectors', 'targetLanguage', 'severityThreshold'],
    defaultOutputKeys: ['vulnerabilities', 'severity_counts', 'pentest_report', 'risk_score'],
  },
};

@Injectable()
export class NodeResolutionRegistry {
  private readonly logger = new Logger(NodeResolutionRegistry.name);

  /**
   * Resolve a single frontend node into its backend execution specification.
   */
  resolve(uiType: string, config: Record<string, any>): NodeResolution & { capability: string } {
    const entry = REGISTRY[uiType];
    if (!entry) {
      this.logger.warn(`Unknown UI type "${uiType}", falling back to adapter`);
      return {
        executionType: 'adapter',
        capabilityPattern: `adapter:unknown-${uiType}`,
        capability: `adapter:unknown-${uiType}`,
        riskLevel: 'low',
        intentCategory: 'unknown',
        parameterizableKeys: [],
        defaultOutputKeys: ['result'],
      };
    }

    const capability = this.resolveCapability(uiType, entry, config);
    return { ...entry, capability };
  }

  /**
   * Build inputMapping for a node by analyzing upstream node output keys.
   *
   * Rules:
   *   1. If node already has explicit inputMapping, keep it
   *   2. Match upstream outputKeys to current node's config fields via SEMANTIC_MAPPINGS
   *   3. For AI nodes, collect all upstream context automatically
   */
  inferInputMapping(
    uiType: string,
    config: Record<string, any>,
    upstreamNodes: Array<{ nodeKey: string; outputKeys: string[] }>,
    existingMapping?: Record<string, string>,
  ): Record<string, string> {
    // Explicit mapping takes precedence
    if (existingMapping && Object.keys(existingMapping).length > 0) {
      return existingMapping;
    }

    const mapping: Record<string, string> = {};

    // AI processing: auto-collect upstream search results and data as context
    if (uiType === 'ai-processing') {
      for (const upstream of upstreamNodes) {
        if (upstream.outputKeys.includes('search_results')) {
          mapping['context'] = `$.${upstream.nodeKey}.search_results`;
          break;
        }
        if (upstream.outputKeys.includes('file_content')) {
          mapping['sourceData'] = `$.${upstream.nodeKey}.file_content`;
        }
        if (upstream.outputKeys.includes('analysis_result')) {
          mapping['previousAnalysis'] = `$.${upstream.nodeKey}.analysis_result`;
        }
      }
      return mapping;
    }

    // Email/Slack: map body from upstream summary or analysis
    if (uiType === 'email-send' || uiType === 'slack-message' || uiType === 'notification') {
      for (const upstream of upstreamNodes) {
        if (upstream.outputKeys.includes('summary')) {
          mapping['body'] = `$.${upstream.nodeKey}.summary`;
          break;
        }
        if (upstream.outputKeys.includes('analysis_result')) {
          mapping['body'] = `$.${upstream.nodeKey}.analysis_result`;
          break;
        }
        if (upstream.outputKeys.includes('report_html')) {
          mapping['htmlBody'] = `$.${upstream.nodeKey}.report_html`;
          break;
        }
      }
      return mapping;
    }

    // Jira: map description from upstream summary
    if (uiType === 'jira') {
      for (const upstream of upstreamNodes) {
        if (upstream.outputKeys.includes('summary')) {
          mapping['description'] = `$.${upstream.nodeKey}.summary`;
          break;
        }
        if (upstream.outputKeys.includes('vulnerabilities')) {
          mapping['description'] = `$.${upstream.nodeKey}.vulnerabilities`;
          break;
        }
      }
      return mapping;
    }

    // Pentest: map source from upstream file content
    if (uiType === 'pentest') {
      for (const upstream of upstreamNodes) {
        if (upstream.outputKeys.includes('file_content')) {
          mapping['sourceCode'] = `$.${upstream.nodeKey}.file_content`;
          break;
        }
      }
      return mapping;
    }

    // Condition: evaluate on immediate predecessor's full output
    if (uiType === 'condition' && upstreamNodes.length > 0) {
      const lastUpstream = upstreamNodes[upstreamNodes.length - 1];
      mapping['evaluationTarget'] = `$.${lastUpstream.nodeKey}`;
    }

    // Generic: try semantic mapping for remaining types
    for (const upstream of upstreamNodes) {
      for (const outKey of upstream.outputKeys) {
        const targets = SEMANTIC_MAPPINGS[outKey];
        if (!targets) continue;
        for (const target of targets) {
          if (target in config && !config[target] && !mapping[target]) {
            mapping[target] = `$.${upstream.nodeKey}.${outKey}`;
          }
        }
      }
    }

    return mapping;
  }

  /**
   * Get all registered UI types.
   */
  getSupportedTypes(): string[] {
    return Object.keys(REGISTRY);
  }

  /**
   * Get resolution entry for a UI type (without config-based capability resolution).
   */
  getEntry(uiType: string): NodeResolution | undefined {
    return REGISTRY[uiType];
  }

  // ── Private helpers ──

  private resolveCapability(
    uiType: string,
    entry: NodeResolution,
    config: Record<string, any>,
  ): string {
    switch (uiType) {
      case 'ai-processing': {
        const model = config.model || 'claude-sonnet-4.6';
        const agentName = config.agentName || 'workflow-agent';
        return `agent:${agentName}:${model}`;
      }

      case 'pentest': {
        const vectors = Array.isArray(config.enabledVectors) ? config.enabledVectors.length : 8;
        return `agent:pentest:${vectors}-vector`;
      }

      case 'web-search': {
        const engine = (config.searchEngine || 'google').toLowerCase();
        return `connector:${engine}-search`;
      }

      case 'jira': {
        const action = config.action || 'create';
        return `connector:jira:${action}`;
      }

      case 'git-deploy': {
        const action = config.action || 'push';
        return `connector:git:${action}`;
      }

      case 'api-call': {
        const method = (config.method || 'GET').toUpperCase();
        return `connector:generic-http:${method}`;
      }

      case 'email-send':
        return 'connector:email-smtp:send';

      case 'slack-message':
        return 'connector:slack-webhook:post';

      case 'notification': {
        const channel = config.notifyChannel || 'email';
        return `connector:notification:${channel}`;
      }

      case 'data-storage': {
        const op = config.operation || 'INSERT';
        return `adapter:data-storage:${op.toLowerCase()}`;
      }

      case 'data-transform': {
        const tt = config.transformType || 'JSON';
        return `adapter:data-transform:${tt.toLowerCase()}`;
      }

      case 'file-operation': {
        const op = config.operation || 'read';
        return `adapter:file-io:${op}`;
      }

      case 'condition':
        return config.conditionType
          ? `decision:${config.conditionType}`
          : 'decision:json-path-eval';

      default:
        return entry.capabilityPattern;
    }
  }
}
