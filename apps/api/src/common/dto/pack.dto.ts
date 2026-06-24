import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEnum, IsOptional, IsObject } from 'class-validator';

const PACK_SOURCE_TYPES = ['GITHUB', 'MCP', 'N8N', 'MANUAL', 'INTERNAL'] as const;

export class PackImportDto {
  @ApiProperty({ enum: PACK_SOURCE_TYPES })
  @IsEnum(PACK_SOURCE_TYPES)
  sourceType!: string;

  @ApiProperty({ example: 'https://github.com/org/pack-repo' })
  @IsNotEmpty()
  @IsString()
  sourceUrl!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  displayName?: string;
}

export class InstallPackDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  packId!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  packVersionId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
