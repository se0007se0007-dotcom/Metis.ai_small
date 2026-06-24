import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { MembershipRole } from '@metis/types';

/**
 * RBAC guard — checks if request user's role is allowed.
 * If no @Roles() decorator is present, access is granted (authenticated-only).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  /** Role hierarchy: higher index = more privilege */
  private static readonly HIERARCHY: MembershipRole[] = [
    'VIEWER',
    'AUDITOR',
    'DEVELOPER',
    'OPERATOR',
    'TENANT_ADMIN',
    'PLATFORM_ADMIN',
  ];

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<MembershipRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() → authenticated access only
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { role } = context.switchToHttp().getRequest().user ?? {};
    if (!role) {
      throw new ForbiddenException('No role assigned');
    }

    const userLevel = RolesGuard.HIERARCHY.indexOf(role as MembershipRole);
    const minRequired = Math.min(...requiredRoles.map((r) => RolesGuard.HIERARCHY.indexOf(r)));

    if (userLevel < minRequired) {
      throw new ForbiddenException(`Role '${role}' does not have sufficient privileges`);
    }

    return true;
  }
}
