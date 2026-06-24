/**
 * Metrics Module — MEASURED effectiveness-signal collection.
 *
 * Exports EffectivenessSignalService so PipelineEngine (workflow-nodes) can
 * persist agent-emitted signals via the auto-hook.
 *
 * @module metrics
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { MetricsController } from './metrics.controller';
import { PrometheusController } from './prometheus.controller';
import { EffectivenessSignalService } from './effectiveness-signal.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MetricsController, PrometheusController],
  providers: [EffectivenessSignalService],
  exports: [EffectivenessSignalService],
})
export class MetricsModule {}
