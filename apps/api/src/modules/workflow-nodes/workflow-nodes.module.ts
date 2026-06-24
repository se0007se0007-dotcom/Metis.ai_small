/**
 * Workflow Nodes Module
 *
 * Provides real execution capabilities for each workflow node type.
 * Each executor registers as a connector in the Connector Registry,
 * enabling the workflow engine to invoke them via the standard pipeline.
 *
 * Node Executors:
 *   - FileUploadExecutor     — File upload, extraction, source loading
 *   - AIAnalysisExecutor     — LLM-based code analysis, security scanning
 *   - PentestExecutor        — Multi-vector penetration testing simulation
 *   - DocumentGenExecutor    — DOCX/PDF/HTML report generation
 *   - WebSearchExecutor      — Web search via external APIs
 *   - SlackExecutor          — Slack message delivery
 *   - DataStorageExecutor    — Database persistence
 *   - LogMonitorExecutor     — Log collection & pattern analysis
 *   - ScheduleExecutor       — Cron/interval trigger management
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database.module';
import { ConnectorModule } from '../connector/connector.module';
import { EmailModule } from '../email/email.module';
import { FinOpsModule } from '../finops/finops.module';
import { EvaluatorModule } from '../evaluator/evaluator.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MetricsModule } from '../metrics/metrics.module';
import { GovernanceModule } from '../governance/governance.module';

import { WorkflowNodesController } from './workflow-nodes.controller';
import { WorkflowNodesService } from './workflow-nodes.service';
import { NodeExecutorRegistry } from './node-executor-registry';
import { PipelineEngine } from './pipeline-engine';

// Individual executors
import { FileUploadExecutor } from './executors/file-upload.executor';
import { AIAnalysisExecutor } from './executors/ai-analysis.executor';
import { DocumentGenExecutor } from './executors/document-gen.executor';
import { WebSearchExecutor } from './executors/web-search.executor';
import { SlackExecutor } from './executors/slack.executor';
import { DataStorageExecutor } from './executors/data-storage.executor';
import { LogMonitorExecutor } from './executors/log-monitor.executor';
import { PentestExecutor } from './executors/pentest.executor';
import { ScheduleExecutor } from './executors/schedule.executor';
import { EmailSendExecutor } from './executors/email-send.executor';
import { PassthroughExecutor } from './executors/passthrough.executor';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ConnectorModule,
    EmailModule,
    FinOpsModule,
    EvaluatorModule,
    KnowledgeModule,
    MetricsModule,
    GovernanceModule,
  ],
  controllers: [WorkflowNodesController],
  providers: [
    WorkflowNodesService,
    NodeExecutorRegistry,
    PipelineEngine,
    FileUploadExecutor,
    AIAnalysisExecutor,
    PentestExecutor,
    DocumentGenExecutor,
    WebSearchExecutor,
    SlackExecutor,
    DataStorageExecutor,
    LogMonitorExecutor,
    ScheduleExecutor,
    EmailSendExecutor,
    PassthroughExecutor,
  ],
  exports: [WorkflowNodesService, PipelineEngine, NodeExecutorRegistry],
})
export class WorkflowNodesModule {}
