import { SetMetadata } from '@nestjs/common';
import { AuditAction } from '@metis/types';

export const AUDIT_KEY = 'audit';

export interface AuditMeta {
  action: AuditAction;
  targetType: string;
}

/** Mark an endpoint for audit logging */
export const Audit = (action: AuditAction, targetType: string) =>
  SetMetadata(AUDIT_KEY, { action, targetType } as AuditMeta);
