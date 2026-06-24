import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { GovernanceModule } from '../governance/governance.module';
// EmbeddingService is provided directly (it only needs ConfigService + PRISMA)
// instead of importing the full FinOpsModule, avoiding a circular dependency.
import { EmbeddingService } from '../finops/embedding.service';

@Module({
  imports: [GovernanceModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeRetrievalService, EmbeddingService],
  exports: [KnowledgeService, KnowledgeRetrievalService],
})
export class KnowledgeModule {}
