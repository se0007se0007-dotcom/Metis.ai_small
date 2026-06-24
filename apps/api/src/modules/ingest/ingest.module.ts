/**
 * Ingest Module — Phase 1 (Ingestion On-Ramp)
 *
 * Wires together the external-agent ingestion on-ramp:
 *   - IngestController   — data route (API key) + key management (JWT/RBAC)
 *   - IngestService      — validates, redacts, resolves sessions, and calls
 *                          the SHARED EvaluatorService (same engine as the
 *                          internal PipelineEngine)
 *   - IngestKeyService   — issue / verify / list / revoke API keys
 *   - IngestKeyGuard     — authenticates external agents on the data route
 *
 * Imports EvaluatorModule (exports EvaluatorService) so external runs are
 * evaluated by the exact same engine as internal workflow nodes.
 *
 * @module ingest
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { EvaluatorModule } from '../evaluator/evaluator.module';
import { GovernanceModule } from '../governance/governance.module';
import { IngestKeyGuard } from '../../common/guards/ingest-key.guard';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestKeyService } from './ingest-key.service';

@Module({
  imports: [DatabaseModule, EvaluatorModule, GovernanceModule],
  controllers: [IngestController],
  providers: [IngestService, IngestKeyService, IngestKeyGuard],
  exports: [IngestKeyService, IngestService],
})
export class IngestModule {}
