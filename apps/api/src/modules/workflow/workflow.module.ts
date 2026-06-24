/**
 * Workflow Module — Phase 6 (Step 1 + Step 2)
 *
 * Step 1 — Execution Bridge:
 *   - NodeResolutionRegistry — uiType → executionType + capability mapping
 *   - WorkflowExecutionBridge — converts builder nodes to RunWorkflowInput
 *   - WorkflowService — orchestrates execution of draft workflows
 *   - WorkflowController — REST endpoints (/workflows/execute-draft, /workflows/resolve-nodes)
 *
 * Step 2 — Server Persistence:
 *   - WorkflowPersistenceService — Full CRUD + version management + OCC
 *   - WorkflowCrudController — REST CRUD endpoints for saved workflows
 *
 * Depends on:
 *   - ExecutionModule — for WorkflowRunnerService (actual execution engine)
 */
import { Module, forwardRef } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowCrudController } from './workflow-crud.controller';
import { WorkflowService } from './workflow.service';
import { WorkflowPersistenceService } from './workflow-persistence.service';
import { WorkflowExecutionBridge } from './workflow-execution-bridge.service';
import { NodeResolutionRegistry } from './node-resolution.registry';
import { ExecutionModule } from '../execution/execution.module';
import { WorkflowNodesModule } from '../workflow-nodes/workflow-nodes.module';
import { IngestModule } from '../ingest/ingest.module';

@Module({
  imports: [forwardRef(() => ExecutionModule), WorkflowNodesModule, IngestModule],
  controllers: [WorkflowController, WorkflowCrudController],
  providers: [
    WorkflowService,
    WorkflowPersistenceService,
    WorkflowExecutionBridge,
    NodeResolutionRegistry,
  ],
  exports: [
    WorkflowService,
    WorkflowPersistenceService,
    WorkflowExecutionBridge,
    NodeResolutionRegistry,
  ],
})
export class WorkflowModule {}
