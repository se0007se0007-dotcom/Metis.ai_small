import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { GovernanceModule } from '../governance/governance.module';
import { SandboxReplayService } from './sandbox-replay.service';

@Module({
  imports: [DatabaseModule, GovernanceModule],
  providers: [SandboxReplayService],
  exports: [SandboxReplayService],
})
export class SandboxModule {}
