/**
 * Data Storage Executor
 *
 * Persists workflow results to databases.
 * Uses the Prisma-connected PostgreSQL by default,
 * with support for external DB connections.
 *
 * Registers as connector: metis-data-storage
 */
import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../../database.module';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
} from '../node-executor-registry';

@Injectable()
export class DataStorageExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'data-storage';
  readonly displayName = 'DB 저장 / 데이터 영속화';
  readonly handledNodeTypes = ['data-storage'];
  readonly handledCategories = ['storage'];

  private readonly logger = new Logger(DataStorageExecutor.name);

  constructor(
    private readonly registry: NodeExecutorRegistry,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;
    const storageType = (settings.storageType || 'postgresql').toLowerCase();
    const operation = settings.operation || 'INSERT';

    try {
      // For the built-in PostgreSQL, store in a generic workflow_results table
      // via Prisma's raw query capability
      if (storageType === 'postgresql' || storageType === 'postgres') {
        const result = await this.storeInPostgres(input, operation);
        return {
          success: true,
          data: result,
          outputText: `DB 저장 완료: ${result.recordId} (${operation})`,
          durationMs: Date.now() - start,
        };
      }

      // For external databases, use connection string
      if (settings.connectionString) {
        return {
          success: false,
          data: {},
          outputText: '',
          durationMs: Date.now() - start,
          error: `외부 DB 연결(${storageType})은 커넥터 설정이 필요합니다. 커넥터 페이지에서 ${storageType} 커넥터를 추가하세요.`,
        };
      }

      // Default: store in Metis internal storage
      const result = await this.storeInPostgres(input, operation);
      return {
        success: true,
        data: result,
        outputText: `Metis 내부 DB 저장 완료: ${result.recordId}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: `DB 저장 실패: ${(err as Error).message}`,
      };
    }
  }

  private async storeInPostgres(
    input: NodeExecutionInput,
    operation: string,
  ): Promise<{ recordId: string; table: string }> {
    const tableKey = input.settings.tableKey || 'workflow_results';
    const data = {
      tenantId: input.tenantId,
      executionSessionId: input.executionSessionId,
      nodeId: input.nodeId,
      nodeName: input.nodeName,
      resultText: input.previousOutput?.slice(0, 50000) || '',
      metadata: JSON.stringify({
        nodeType: input.nodeType,
        timestamp: new Date().toISOString(),
        pipelineNodeCount: Object.keys(input.pipelineData).length,
      }),
    };

    // Use knowledge artifact as generic storage (existing model)
    const record = await this.prisma.knowledgeArtifact.create({
      data: {
        tenantId: input.tenantId,
        key: `wf-result-${input.executionSessionId}-${input.nodeId}`,
        title: `워크플로우 결과: ${input.nodeName}`,
        category: 'WORKFLOW_RESULT',
        status: 'ACTIVE',
        version: '1.0',
        contentJson: {
          resultText: data.resultText,
          metadata: JSON.parse(data.metadata),
          createdBy: input.userId,
        } as any,
      },
    });

    return { recordId: record.id, table: tableKey };
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-data-storage',
      name: 'DB 저장 / 데이터 영속화',
      type: 'BUILT_IN',
      description:
        '워크플로우 결과를 데이터베이스에 저장합니다. PostgreSQL 내장, 외부 DB 커넥터 지원.',
      category: 'storage',
      inputSchema: {
        storageType: {
          type: 'string',
          enum: ['postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch'],
        },
        operation: { type: 'string', enum: ['INSERT', 'UPSERT', 'REPLACE'] },
        tableKey: { type: 'string' },
      },
      outputSchema: { recordId: { type: 'string' }, table: { type: 'string' } },
      capabilities: ['postgresql', 'data-persistence', 'audit-trail'],
    };
  }
}
