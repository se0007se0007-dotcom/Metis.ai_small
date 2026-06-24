/**
 * Builder Module — workflow authoring hub.
 *
 * LLM Planner: OpenAIPlannerAdapter (LLM이 자연어 의도 → 워크플로우 설계).
 *   - OPENAI_API_KEY 설정 시 LLM 기반 노드 선택/순서 결정 (타임아웃 20초 보호)
 *   - 미설정 또는 호출 실패 시 HeuristicPlannerAdapter로 자동 폴백 (무중단)
 *   - 사내망: OPENAI_BASE_URL을 QWEN/Azure 엔드포인트로 지정하면 동일 동작
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BuilderController } from './builder.controller';
import { BuilderPlannerService } from './builder-planner.service';
import { BuilderValidationService } from './builder-validation.service';
import { BuilderEvalService } from './builder-eval.service';
import { CapabilityPlannerService } from './capability-planner.service';
import { CapabilityPlannerController } from './capability-planner.controller';
import { OpenAIPlannerAdapter } from './llm-planner/openai-planner-adapter';
import { ConnectorModule } from '../connector/connector.module';
import { GovernanceModule } from '../governance/governance.module';
import { CapabilityRegistryModule } from '../capability-registry/capability-registry.module';

@Module({
  imports: [ConfigModule, ConnectorModule, GovernanceModule, CapabilityRegistryModule],
  controllers: [BuilderController, CapabilityPlannerController],
  providers: [
    BuilderPlannerService,
    BuilderValidationService,
    BuilderEvalService,
    CapabilityPlannerService,
    { provide: 'LLM_PLANNER_ADAPTER', useClass: OpenAIPlannerAdapter },
  ],
  exports: [
    BuilderPlannerService,
    BuilderValidationService,
    BuilderEvalService,
    CapabilityPlannerService,
  ],
})
export class BuilderModule {}
