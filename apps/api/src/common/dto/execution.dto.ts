import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsObject } from 'class-validator';

export class CreateExecutionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  packInstallationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  workflowKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  capabilityKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
