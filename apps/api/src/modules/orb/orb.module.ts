/**
 * ORB Module — Ops.AI Review Board
 *
 * NestJS module for Agent registration review workflow.
 * Provides CRUD for OrbReview records with 5-area scoring,
 * mandatory checks, and verdict management.
 *
 * Exports OrbService for use by other modules (e.g., Agent Kernel, Governance).
 *
 * @module orb
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { GovernanceModule } from '../governance/governance.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { OrbController } from './orb.controller';
import { OrbService } from './orb.service';
import { OrbGovernanceController } from './orb-governance.controller';
import { OrbReviewMachineService } from './orb-review-machine.service';
import { ImmutableVersionPromotionService } from './immutable-version-promotion.service';

@Module({
  imports: [DatabaseModule, GovernanceModule, SandboxModule, WorkflowModule],
  controllers: [OrbController, OrbGovernanceController],
  providers: [OrbService, OrbReviewMachineService, ImmutableVersionPromotionService],
  exports: [OrbService, OrbReviewMachineService, ImmutableVersionPromotionService],
})
export class OrbModule {}
