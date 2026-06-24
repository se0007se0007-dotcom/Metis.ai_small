import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { KnowledgeService } from './knowledge.service';
import { CurrentUser, RequestUser, Roles } from '../../common/decorators';

@ApiTags('Knowledge')
@ApiBearerAuth()
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  private ctx(user: RequestUser) {
    return { tenantId: user.tenantId, userId: user.userId, role: user.role };
  }

  @Get('artifacts')
  @ApiOperation({ summary: 'List knowledge artifacts' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'source', required: false })
  @ApiQuery({ name: 'q', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('q') q?: string,
  ) {
    const items = await this.knowledgeService.list(this.ctx(user), {
      category,
      status,
      source,
      q,
    });
    return { items };
  }

  @Get('utilization')
  @ApiOperation({
    summary: 'Knowledge utilization stats (most used / unused / by agent)',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async utilization(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    return this.knowledgeService.getUtilization(this.ctx(user), days ? parseInt(days, 10) : 30);
  }

  @Get('error-patterns')
  @ApiOperation({ summary: 'List captured error patterns' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'workflowKey', required: false })
  async errorPatterns(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('workflowKey') workflowKey?: string,
  ) {
    const items = await this.knowledgeService.listErrorPatterns(this.ctx(user), {
      status,
      workflowKey,
    });
    return { items };
  }

  @Get('artifacts/:id')
  @ApiOperation({ summary: 'Get a knowledge artifact' })
  async getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.knowledgeService.getById(this.ctx(user), id);
  }

  @Post('artifacts')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Create a knowledge artifact' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: any) {
    return this.knowledgeService.create(this.ctx(user), dto);
  }

  @Put('artifacts/:id')
  @Roles('OPERATOR')
  @ApiOperation({ summary: 'Update a knowledge artifact' })
  async update(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: any) {
    return this.knowledgeService.update(this.ctx(user), id, dto);
  }

  @Patch('artifacts/:id/status')
  @Roles('OPERATOR')
  @ApiOperation({
    summary: 'Set artifact status (DRAFT/ACTIVE/ARCHIVED/DEPRECATED)',
  })
  async setStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.knowledgeService.setStatus(this.ctx(user), id, status);
  }

  @Delete('artifacts/:id')
  @Roles('OPERATOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a knowledge artifact' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.knowledgeService.remove(this.ctx(user), id);
  }

  @Post('artifacts/:id/promote-policy')
  @Roles('TENANT_ADMIN')
  @ApiOperation({
    summary: 'Promote a knowledge artifact to a governance policy',
  })
  async promotePolicy(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.knowledgeService.promoteToPolicy(this.ctx(user), id);
  }
}
