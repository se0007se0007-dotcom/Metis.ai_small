/**
 * Pack Domain Logic — shared between API and Worker
 * Contains: parseManifest, canTransition, nextPipelineStatus
 */

import type { PackStatus, PackManifest, ManifestValidationResult, TransitionResult } from './index';

// ═══════════════════════════════════════════
//  Manifest Parser
// ═══════════════════════════════════════════

export function parseManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON object'], warnings, normalized: null };
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== 'string') {
    errors.push('Missing or invalid "name" field');
  }
  if (!obj.version || typeof obj.version !== 'string') {
    errors.push('Missing or invalid "version" field');
  }

  if (typeof obj.version === 'string' && !/^\d+\.\d+\.\d+/.test(obj.version)) {
    warnings.push(`Version "${obj.version}" does not follow semver format`);
  }

  if (obj.capabilities && !Array.isArray(obj.capabilities)) {
    errors.push('"capabilities" must be an array');
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, normalized: null };
  }

  const manifest: PackManifest = {
    name: obj.name as string,
    version: obj.version as string,
    description: (obj.description as string) ?? undefined,
    author: (obj.author as string) ?? undefined,
    license: (obj.license as string) ?? undefined,
    homepage: (obj.homepage as string) ?? undefined,
    sourceType: (obj.sourceType as string) ?? undefined,
    capabilities: (obj.capabilities as string[]) ?? [],
    workflows: (obj.workflows as string[]) ?? [],
    runtime: (obj.runtime as PackManifest['runtime']) ?? undefined,
    connectors: (obj.connectors as string[]) ?? [],
    configSchema: (obj.configSchema as Record<string, unknown>) ?? undefined,
    metadata: (obj.metadata as Record<string, unknown>) ?? undefined,
  };

  if (!manifest.description) {
    warnings.push('Missing "description" — recommended for registry visibility');
  }
  if (!manifest.capabilities?.length && !manifest.workflows?.length) {
    warnings.push('No capabilities or workflows declared');
  }

  return { valid: true, errors, warnings, normalized: manifest };
}

// ═══════════════════════════════════════════
//  State Machine
// ═══════════════════════════════════════════

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['IMPORTED', 'BLOCKED'],
  IMPORTED: ['VALIDATED', 'BLOCKED'],
  VALIDATED: ['CERTIFIED', 'BLOCKED'],
  CERTIFIED: ['PUBLISHED', 'BLOCKED'],
  PUBLISHED: ['DEPRECATED', 'BLOCKED'],
  DEPRECATED: ['BLOCKED'],
  BLOCKED: [],
};

const TRANSITION_ROLES: Record<string, string[]> = {
  'DRAFT→IMPORTED': ['PLATFORM_ADMIN', 'TENANT_ADMIN', 'OPERATOR'],
  'IMPORTED→VALIDATED': ['PLATFORM_ADMIN', 'TENANT_ADMIN', 'OPERATOR'],
  'VALIDATED→CERTIFIED': ['PLATFORM_ADMIN', 'TENANT_ADMIN'],
  'CERTIFIED→PUBLISHED': ['PLATFORM_ADMIN', 'TENANT_ADMIN'],
  'PUBLISHED→DEPRECATED': ['PLATFORM_ADMIN', 'TENANT_ADMIN'],
  'DRAFT→BLOCKED': ['PLATFORM_ADMIN'],
  'IMPORTED→BLOCKED': ['PLATFORM_ADMIN'],
  'VALIDATED→BLOCKED': ['PLATFORM_ADMIN'],
  'CERTIFIED→BLOCKED': ['PLATFORM_ADMIN'],
  'PUBLISHED→BLOCKED': ['PLATFORM_ADMIN'],
  'DEPRECATED→BLOCKED': ['PLATFORM_ADMIN'],
};

export function canTransition(from: PackStatus, to: PackStatus, role: string): TransitionResult {
  const validTargets = TRANSITIONS[from];
  if (!validTargets || !validTargets.includes(to)) {
    return {
      allowed: false,
      reason: `Transition ${from} → ${to} is not allowed`,
    };
  }

  const key = `${from}→${to}`;
  const allowedRoles = TRANSITION_ROLES[key];
  if (allowedRoles && !allowedRoles.includes(role)) {
    return {
      allowed: false,
      reason: `Role "${role}" cannot perform transition ${from} → ${to}`,
    };
  }

  return { allowed: true };
}

export function nextPipelineStatus(current: PackStatus): PackStatus | null {
  const pipeline: PackStatus[] = ['DRAFT', 'IMPORTED', 'VALIDATED', 'CERTIFIED', 'PUBLISHED'];
  const idx = pipeline.indexOf(current);
  if (idx === -1 || idx >= pipeline.length - 1) return null;
  return pipeline[idx + 1];
}
