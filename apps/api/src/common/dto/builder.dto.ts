/**
 * Builder Harness DTOs — Phase 5
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BuilderPlanDto {
  @ApiProperty({ description: 'User prompt describing desired workflow' })
  userPrompt!: string;

  @ApiPropertyOptional({ description: 'Force a specific template ID' })
  templateId?: string;
}

export class BuilderParamsExtractDto {
  @ApiProperty({ description: 'Builder request ID' })
  requestId!: string;

  @ApiProperty({ description: 'User prompt for parameter extraction' })
  userPrompt!: string;
}

export class BuilderConnectorsCheckDto {
  @ApiProperty({ description: 'Builder request ID' })
  requestId!: string;

  @ApiProperty({ description: 'Connector keys to check', type: [String] })
  connectorKeys!: string[];
}

export class BuilderValidateDto {
  @ApiProperty({ description: 'Builder request ID' })
  requestId!: string;

  @ApiProperty({ description: 'Workflow nodes to validate', type: 'array' })
  nodes!: any[];
}

export class BuilderEvalPreviewDto {
  @ApiProperty({ description: 'Builder request ID' })
  requestId!: string;
}

export class BuilderSaveDto {
  @ApiProperty({ description: 'Builder request ID' })
  requestId!: string;

  @ApiProperty({ description: 'Workflow name for saving' })
  workflowName!: string;

  @ApiPropertyOptional({ description: 'Acknowledge warnings to allow save' })
  acknowledgeWarnings?: boolean;
}

export class BuilderRepairDto {
  @ApiProperty({ description: 'Builder request ID' })
  requestId!: string;

  @ApiProperty({ description: 'Repair action ID to apply' })
  repairActionId!: string;
}
