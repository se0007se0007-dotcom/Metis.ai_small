import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CapabilityPlannerService, CapabilityPlanInput } from './capability-planner.service';
import { CurrentUser, RequestUser } from '../../common/decorators';

@ApiTags('Builder-CapabilityPlan')
@ApiBearerAuth()
@Controller('builder/capability-plan')
export class CapabilityPlannerController {
  constructor(private readonly planner: CapabilityPlannerService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate a workflow plan from user intent using the Capability Registry',
  })
  async plan(@CurrentUser() user: RequestUser, @Body() body: CapabilityPlanInput) {
    return this.planner.plan(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      body,
    );
  }
}
