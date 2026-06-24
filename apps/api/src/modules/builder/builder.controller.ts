/**
 * Builder Harness Controller — Phase 5
 *
 * 7 endpoints implementing the full Builder Harness pipeline:
 *   POST /builder/plan           — BH-1: Intent classify + template match + plan creation
 *   POST /builder/params/extract — BH-2: Parameter extraction from prompt
 *   POST /builder/connectors/check — BH-2: Connector gap analysis (tenant-specific)
 *   POST /builder/validate       — BH-3+4: Policy injection + structural validation
 *   POST /builder/eval/preview   — BH-5: Readiness scoring (5-axis, 0-100)
 *   POST /builder/save           — BH-6: Save with policy enforcement
 *   POST /builder/repair         — BH-6: One-click repair + re-validate
 */
import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { BuilderPlannerService } from './builder-planner.service';
import { BuilderValidationService } from './builder-validation.service';
import { BuilderEvalService } from './builder-eval.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';

// ── Request DTOs (inline for simplicity; validated by runtime guards) ──

class BuilderPlanDto {
  userPrompt!: string;
  templateId?: string;
}

class BuilderParamsExtractDto {
  requestId!: string;
  userPrompt!: string;
}

class BuilderConnectorsCheckDto {
  requestId!: string;
  connectorKeys!: string[];
}

class BuilderValidateDto {
  requestId!: string;
  nodes!: any[];
}

class BuilderEvalPreviewDto {
  requestId!: string;
}

class BuilderSaveDto {
  requestId!: string;
  workflowName!: string;
  acknowledgeWarnings?: boolean;
}

class BuilderRepairDto {
  requestId!: string;
  repairActionId!: string;
}

@ApiTags('Builder Harness')
@ApiBearerAuth()
@Controller('builder')
export class BuilderController {
  constructor(
    private readonly plannerService: BuilderPlannerService,
    private readonly validationService: BuilderValidationService,
    private readonly evalService: BuilderEvalService,
  ) {}

  // ═══════════════════════════════════════════
  //  POST /builder/plan
  // ═══════════════════════════════════════════

  @Post('plan')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'BuilderRequest')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create builder plan (intent classify + template match)' })
  @ApiResponse({ status: 201, description: 'Plan created' })
  async createPlan(@CurrentUser() user: RequestUser, @Body() dto: BuilderPlanDto) {
    return this.plannerService.createPlan(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  // ═══════════════════════════════════════════
  //  POST /builder/params/extract
  // ═══════════════════════════════════════════

  @Post('params/extract')
  @Roles('OPERATOR', 'DEVELOPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Extract parameters from user prompt' })
  async extractParams(@CurrentUser() user: RequestUser, @Body() dto: BuilderParamsExtractDto) {
    return this.plannerService.extractParams(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  // ═══════════════════════════════════════════
  //  POST /builder/connectors/check
  // ═══════════════════════════════════════════

  @Post('connectors/check')
  @Roles('OPERATOR', 'DEVELOPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check connector availability (tenant-specific)' })
  async checkConnectors(@CurrentUser() user: RequestUser, @Body() dto: BuilderConnectorsCheckDto) {
    return this.plannerService.checkConnectors(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  // ═══════════════════════════════════════════
  //  POST /builder/validate
  // ═══════════════════════════════════════════

  @Post('validate')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'BuilderRequest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate workflow structure + inject policies (BH-3+4)' })
  async validate(@CurrentUser() user: RequestUser, @Body() dto: BuilderValidateDto) {
    return this.validationService.validate(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  // ═══════════════════════════════════════════
  //  POST /builder/eval/preview
  // ═══════════════════════════════════════════

  @Post('eval/preview')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'BuilderRequest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compute readiness score (5-axis, 0-100) (BH-5)' })
  async evalPreview(@CurrentUser() user: RequestUser, @Body() dto: BuilderEvalPreviewDto) {
    return this.evalService.evalPreview(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  // ═══════════════════════════════════════════
  //  POST /builder/save
  // ═══════════════════════════════════════════

  @Post('save')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'BuilderRequest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save workflow (with policy enforcement) (BH-6)' })
  @ApiResponse({ status: 200, description: 'Save result' })
  @ApiResponse({ status: 400, description: 'Blocked by policy or missing eval' })
  async save(@CurrentUser() user: RequestUser, @Body() dto: BuilderSaveDto) {
    return this.evalService.save(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  // ═══════════════════════════════════════════
  //  POST /builder/repair
  // ═══════════════════════════════════════════

  @Post('repair')
  @Roles('OPERATOR', 'DEVELOPER')
  @Audit('EXECUTE', 'BuilderRequest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply one-click repair + re-validate (BH-6)' })
  async repair(@CurrentUser() user: RequestUser, @Body() dto: BuilderRepairDto) {
    return this.evalService.repair(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }
}
