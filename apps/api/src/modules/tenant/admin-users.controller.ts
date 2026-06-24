/**
 * Admin Users Controller — 사용자 기준정보 CRUD (관리자 전용).
 *
 * 현재 테넌트 범위에서 구성원(User+Membership)을 등록/수정/삭제한다.
 * 비밀번호는 TenantService.setCredential 이 bcrypt 해시로 저장한다.
 *
 * 라우트(프리픽스 /v1):  /v1/admin/users
 */
import { Controller, Get, Post, Patch, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TenantService, CreateUserDto, UpdateUserDto } from './tenant.service';
import { CurrentUser, RequestUser, Roles, Audit } from '../../common/decorators';

@ApiTags('Admin Users')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly tenantService: TenantService) {}

  @Get()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: '현재 테넌트 구성원 목록' })
  async list(@CurrentUser() user: RequestUser) {
    return this.tenantService.listUsers(user.tenantId);
  }

  @Post()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'User')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '사용자 등록 (User+Membership+초기 비밀번호)' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateUserDto) {
    return this.tenantService.createUser(user.tenantId, dto);
  }

  @Patch(':userId')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('UPDATE', 'User')
  @ApiOperation({ summary: '사용자 수정 (이름/역할/활성/비밀번호 재설정)' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.tenantService.updateUser(user.tenantId, userId, dto);
  }

  @Delete(':userId')
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('DELETE', 'User')
  @ApiOperation({ summary: '사용자 삭제 (본인/마지막 관리자 보호)' })
  async remove(@CurrentUser() user: RequestUser, @Param('userId') userId: string) {
    return this.tenantService.deleteUser(user.tenantId, user.userId, userId);
  }
}
