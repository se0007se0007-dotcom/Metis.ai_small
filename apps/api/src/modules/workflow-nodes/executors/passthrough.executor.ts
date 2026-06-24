/**
 * Passthrough Executor
 *
 * Fallback executor for any node type that doesn't have a dedicated executor.
 * Simply passes through the accumulated pipeline output to the next node,
 * ensuring the pipeline never stalls on unrecognized node types.
 *
 * Common cases:
 *   - Generic "api-call" nodes with empty/unknown categories
 *   - Custom user-defined node types
 *   - Placeholder nodes that haven't been implemented yet
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
} from '../node-executor-registry';

@Injectable()
export class PassthroughExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'passthrough';
  readonly displayName = '패스스루 (기본 실행기)';
  /** Not mapped to specific node types — used only as fallback */
  readonly handledNodeTypes: string[] = [];
  readonly handledCategories: string[] = [];

  private readonly logger = new Logger(PassthroughExecutor.name);

  constructor(private readonly registry: NodeExecutorRegistry) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const { nodeType, nodeName, settings, previousOutput } = input;

    this.logger.log(
      `Passthrough executor handling node "${nodeName}" (type: ${nodeType}). ` +
        `Forwarding pipeline data to next node.`,
    );

    // Extract any useful metadata from settings
    const description = settings?.description || settings?.label || '';
    const stepCategory = settings?.stepCategory || 'unknown';

    // Build informative output
    const lines: string[] = [`✅ ${nodeName} — 실행 완료 (패스스루)`];

    if (description) {
      lines.push(`설명: ${description}`);
    }

    lines.push(`노드 타입: ${nodeType}, 카테고리: ${stepCategory}`);

    // If there is previous output, pass it through
    if (previousOutput) {
      lines.push('');
      lines.push('--- 이전 단계 출력 ---');
      lines.push(previousOutput);
    }

    const outputText = lines.join('\n');

    return {
      success: true,
      data: {
        passthrough: true,
        nodeType,
        category: stepCategory,
        forwardedFrom: input.nodeId,
        previousDataKeys: Object.keys(input.pipelineData),
      },
      outputText,
      durationMs: Date.now() - start,
    };
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-passthrough',
      name: '패스스루 실행기',
      type: 'BUILT_IN',
      description:
        '전용 실행기가 없는 노드를 처리하는 기본 패스스루 실행기입니다. 이전 노드의 출력을 그대로 다음 노드로 전달합니다.',
      category: 'utility',
      inputSchema: {
        previousOutput: { type: 'string', description: '이전 노드의 텍스트 출력' },
      },
      outputSchema: {
        passthrough: { type: 'boolean' },
        outputText: { type: 'string' },
      },
      capabilities: ['passthrough', 'fallback'],
    };
  }
}
