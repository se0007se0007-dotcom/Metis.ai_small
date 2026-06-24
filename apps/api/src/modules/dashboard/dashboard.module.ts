/**
 * Dashboard Module — DB-backed home dashboard aggregation.
 * @module dashboard
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [DatabaseModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
