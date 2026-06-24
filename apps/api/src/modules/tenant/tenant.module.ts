import { Module } from '@nestjs/common';
import { TenantController } from './tenant.controller';
import { AdminUsersController } from './admin-users.controller';
import { TenantService } from './tenant.service';

@Module({
  controllers: [TenantController, AdminUsersController],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
