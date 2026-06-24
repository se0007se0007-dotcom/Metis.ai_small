import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WorkflowRunnerService, RunWorkflowInput } from './workflow-runner.service';
import { CurrentUser, RequestUser, Roles, Audit } from '../../common/decorators';

@ApiTags('WorkflowRunner')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowRunnerController {
  constructor(private readonly runner: WorkflowRunnerService) {}

  @Post('run')
  @Roles('OPERATOR')
  @Audit('EXECUTE', 'Workflow')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run a workflow graph end-to-end' })
  async run(@CurrentUser() user: RequestUser, @Body() body: RunWorkflowInput) {
    return this.runner.run({ tenantId: user.tenantId, userId: user.userId, role: user.role }, body);
  }
}
