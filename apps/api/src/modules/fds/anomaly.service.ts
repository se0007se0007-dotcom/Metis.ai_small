/**
 * Fraud Detection System — Anomaly Detection Service
 *
 * High-level anomaly detection combining rules with ML-inspired scoring.
 * Supports similar case lookup and mock ML scoring for pattern detection.
 */

import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { PrismaClient, withTenantIsolation, TenantContext } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';
import { RuleEngineService } from './rule-engine.service';
import { AlertService } from './alert.service';
import { MLScoreAdapter, MLScoreInput } from './adapters/ml-adapter.interface';

export interface Transaction {
  id?: string;
  amount: number;
  currency?: string;
  accountId: string;
  timestamp?: Date;
  merchantId?: string;
  location?: string;
  metadata?: Record<string, any>;
}

export interface SimilarCase {
  id: string;
  severity: string;
  resolution?: string;
  resolvedAt?: Date;
}

@Injectable()
export class AnomalyService {
  private readonly logger = new Logger(AnomalyService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly ruleEngine: RuleEngineService,
    @Inject(forwardRef(() => AlertService)) private readonly alertService: AlertService,
    @Inject('FDS_ML_ADAPTER') private readonly mlAdapter: MLScoreAdapter,
  ) {}

  /**
   * High-level anomaly detection from transaction
   *
   * 1. Evaluate all rules via ruleEngine.evaluateAll
   * 2. Add ML score for additional pattern detection
   * 3. If aggregate > threshold (0.7), create alert
   * 4. Return created alert or null
   */
  async detectFromTransaction(ctx: TenantContext, transaction: Transaction): Promise<any | null> {
    try {
      // Step 1: Evaluate rules
      const ruleResult = await this.ruleEngine.evaluateAll(ctx, {
        amount: transaction.amount,
        accountId: transaction.accountId,
        merchantId: transaction.merchantId,
        location: transaction.location,
        ...transaction.metadata,
      });

      // Step 2: Add ML score via adapter
      let mlScore = 0.5; // Neutral fallback
      try {
        const mlInput: MLScoreInput = {
          subjectType: 'ACCOUNT',
          subjectId: transaction.accountId,
          features: {
            amount: transaction.amount,
            merchantId: transaction.merchantId,
            location: transaction.location,
            timestamp: transaction.timestamp,
            ...transaction.metadata,
          },
        };
        const mlOutput = await this.mlAdapter.score(mlInput);
        mlScore = mlOutput.score;
      } catch (adapterError) {
        this.logger.error(
          `ML adapter failed for account ${transaction.accountId}, using fallback:`,
          adapterError,
        );
        mlScore = 0.5; // Neutral fallback on adapter failure
      }
      const combinedScore = (ruleResult.aggregateScore + mlScore) / 2;

      // Step 3: Threshold check (0.7)
      if (combinedScore <= 0.7) {
        this.logger.debug(
          `Transaction ${transaction.id} passed anomaly check (score: ${combinedScore})`,
        );
        return null;
      }

      // Step 4: Create alert
      const alert = await this.alertService.createAlert(ctx, {
        subjectId: transaction.accountId,
        subjectType: 'ACCOUNT',
        score: combinedScore,
        summary: `Fraud detected on account ${transaction.accountId}: ${ruleResult.matchedRules.length} rules matched`,
        detailsJson: {
          ruleResults: ruleResult,
          mlScore,
          transaction: {
            id: transaction.id,
            amount: transaction.amount,
            merchantId: transaction.merchantId,
            location: transaction.location,
          },
        },
      });

      this.logger.log(
        `Created alert ${alert.id} for transaction ${transaction.id} (score: ${combinedScore})`,
      );
      return alert;
    } catch (error) {
      this.logger.error(`Anomaly detection failed: ${error}`);
      throw error;
    }
  }

  /**
   * Find similar past alerts
   *
   * Returns past 5 alerts with same subjectType + resolved status
   */
  async similarCases(ctx: TenantContext, alert: any): Promise<SimilarCase[]> {
    try {
      const tenantPrisma = withTenantIsolation(this.prisma, ctx);

      const similarAlerts = await tenantPrisma.fDSAlert.findMany({
        where: {
          subjectType: alert.subjectType,
          status: { in: ['BLOCKED', 'DISMISSED', 'RESOLVED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          severity: true,
          resolutionJson: true,
          resolvedAt: true,
        },
      });

      return similarAlerts.map((a) => ({
        id: a.id,
        severity: a.severity,
        resolution: (a.resolutionJson as any)?.decision || undefined,
        resolvedAt: a.resolvedAt || undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to find similar cases: ${error}`);
      return [];
    }
  }
}
