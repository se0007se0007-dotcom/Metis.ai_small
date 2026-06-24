import { SetMetadata } from '@nestjs/common';
import { MembershipRole } from '@metis/types';

export const ROLES_KEY = 'roles';

/** Restrict endpoint to specific roles */
export const Roles = (...roles: MembershipRole[]) => SetMetadata(ROLES_KEY, roles);
