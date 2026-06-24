/**
 * Evaluator Module — NestJS Module Definition
 *
 * Registers all evaluation engines and the orchestrator service:
 *
 *   - QualityEvaluator          (Gate 1 & 2) — accuracy, hallucination, response quality
 *   - SecurityEvaluator         (Gate 5)     — input threats, output leakage, tool chain risk
 *   - SecurityAdvancedEvaluator (Gate 5+)    — tool auth, privilege escalation, chain attacks
 *   - AnomalyDetector           (Gate 7)     — statistical anomaly detection (Z-score, IQR, trend)
 *   - CostEvaluator             (Gate 4)     — cost efficiency, latency grading, throughput
 *   - AgenticEvaluator          (Layer 2)    — tool calls, workflow, coordination, retries
 *   - LLMJudgeService           (Hybrid)     — LLM-as-judge evaluation
 *   - EvaluatorService          (Orchestrator) — coordinates all gates, persists to Prisma
 *
 * Exports only EvaluatorService — consumers interact through the orchestrator,
 * which delegates to individual engines internally.
 *
 * @module evaluator
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database.module';
import { QualityEvaluator } from './quality-evaluator';
import { SecurityEvaluator } from './security-evaluator';
import { SecurityAdvancedEvaluator } from './security-advanced';
import { AnomalyDetector } from './anomaly-detector';
import { CostEvaluator } from './cost-evaluator';
import { AgenticEvaluator } from './agentic-evaluator';
import { StreamingEvaluatorService } from './streaming-evaluator';
import { ConversationEvaluator } from './conversation-evaluator';
import { LLMJudgeService } from './llm-judge';
import { EvaluatorService } from './evaluator.service';
import { EvaluatorController } from './evaluator.controller';
import { EvaluationPolicyService } from './evaluation-policy.service';
import { EvaluationPolicyController } from './evaluation-policy.controller';
import { PolicyFeedbackService } from './feedback/policy-feedback.service';
import { PolicyFeedbackController } from './feedback/policy-feedback.controller';
import { AdaptiveSamplingService } from './feedback/adaptive-sampling.service';
import { KnowledgeCaptureService } from './feedback/knowledge-capture.service';
import { FinopsReporterService } from '../../common/finops/finops-reporter.service';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [EvaluatorController, EvaluationPolicyController, PolicyFeedbackController],
  providers: [
    QualityEvaluator,
    SecurityEvaluator,
    SecurityAdvancedEvaluator,
    AnomalyDetector,
    CostEvaluator,
    AgenticEvaluator,
    StreamingEvaluatorService,
    ConversationEvaluator,
    LLMJudgeService,
    EvaluatorService,
    EvaluationPolicyService,
    PolicyFeedbackService,
    AdaptiveSamplingService,
    KnowledgeCaptureService,
    FinopsReporterService,
  ],
  exports: [EvaluatorService, KnowledgeCaptureService, FinopsReporterService],
})
export class EvaluatorModule {}
