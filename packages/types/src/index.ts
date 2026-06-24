// ── Auth ──
export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: UserDto;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
}

// ── Tenant ──
export interface TenantDto {
  id: string;
  slug: string;
  name: string;
}

// ── Membership ──
export type MembershipRole =
  | 'PLATFORM_ADMIN'
  | 'TENANT_ADMIN'
  | 'OPERATOR'
  | 'DEVELOPER'
  | 'AUDITOR'
  | 'VIEWER';

export interface MembershipDto {
  id: string;
  tenantId: string;
  userId: string;
  role: MembershipRole;
}

// ── Pack ──
export type PackSourceType = 'GITHUB' | 'MCP' | 'N8N' | 'MANUAL' | 'INTERNAL';

export type PackStatus =
  | 'DRAFT'
  | 'IMPORTED'
  | 'VALIDATED'
  | 'CERTIFIED'
  | 'PUBLISHED'
  | 'DEPRECATED'
  | 'BLOCKED';

export interface PackDto {
  id: string;
  key: string;
  name: string;
  sourceType: PackSourceType;
  description?: string;
  icon?: string;
}

export interface PackVersionDto {
  id: string;
  version: string;
  status: PackStatus;
  publishedAt?: string | null;
}

export interface PackImportRequest {
  sourceType: PackSourceType;
  sourceUrl: string;
  displayName?: string;
}

// ── Pack Manifest ──
export interface PackManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  sourceType?: string;
  capabilities?: string[];
  workflows?: string[];
  runtime?: {
    minVersion?: string;
    maxConcurrency?: number;
    timeoutMs?: number;
    memoryMb?: number;
  };
  connectors?: string[];
  configSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalized: PackManifest | null;
}

export interface TransitionResult {
  allowed: boolean;
  reason?: string;
}

// ── Installation ──
export type InstallationStatus =
  | 'INSTALLED'
  | 'DISABLED'
  | 'UPGRADE_AVAILABLE'
  | 'FAILED'
  | 'REMOVED';

export interface InstallationDto {
  id: string;
  status: InstallationStatus;
  installedAt: string;
}

// ── Execution ──
export type ExecutionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED';

export interface ExecutionSessionDto {
  id: string;
  status: ExecutionStatus;
  workflowKey?: string | null;
  capabilityKey?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  latencyMs?: number | null;
  costUsd?: number | null;
}

export interface CreateExecutionRequest {
  packInstallationId?: string;
  workflowKey?: string;
  capabilityKey?: string;
  input?: Record<string, unknown>;
}

// ── Governance ──
export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'IMPORT'
  | 'INSTALL'
  | 'UNINSTALL'
  | 'EXECUTE'
  | 'CERTIFY'
  | 'REVOKE_CERTIFICATION'
  | 'PUBLISH'
  | 'LOGIN'
  | 'POLICY_CHECK'
  | 'STATUS_TRANSITION'
  | 'BLOCK'
  | 'DEPRECATE'
  // Phase 3: Controlled Release Engineering
  | 'REPLAY_DATASET_CREATE'
  | 'REPLAY_RUN_START'
  | 'SHADOW_CONFIG_CREATE'
  | 'SHADOW_PAIR_CREATE'
  | 'CANARY_START'
  | 'CANARY_GATE_EVALUATE'
  | 'CANARY_PROMOTE'
  | 'CANARY_ROLLBACK'
  | 'VERSION_PROMOTE'
  | 'VERSION_ROLLBACK'
  // Phase 6: Workflow Persistence
  | 'ARCHIVE'
  | 'RESTORE';

export interface AuditLogDto {
  id: string;
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  policyResult?: string | null;
  correlationId: string;
  createdAt: string;
}

export interface PolicyDto {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  version: number;
}

// ── Connector ──
export interface ConnectorDto {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
}

// ── Pagination ──
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

// ── Async Job ──
export interface AsyncAcceptedResponse {
  jobId: string;
  status: 'QUEUED';
}

// ── Pack Domain Functions (re-export) ──
export { parseManifest, canTransition, nextPipelineStatus } from './pack-domain';

// ── Capability Model (re-export) ──
export * from './capability';

// ── Phase 3: Release Engineering (re-export) ──
export * from './release-engineering';

// ── Phase 5: Builder Harness (re-export) ──
export * from './builder-harness';

// ── Error ──
export interface ErrorResponse {
  statusCode: number;
  message: string;
  error?: string;
  correlationId?: string;
}
