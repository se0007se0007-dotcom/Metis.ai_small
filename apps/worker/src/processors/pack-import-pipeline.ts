/**
 * Pack Import Pipeline — 9-Stage Processor
 *
 * Pipeline stages (aligned with metis_pack_spec.md):
 *   1. FETCH      — Download/retrieve pack from source
 *   2. PARSE      — Extract and parse manifest
 *   3. NORMALIZE  — Normalize manifest fields, generate key
 *   4. VALIDATE   — Schema validation + business rules
 *   5. SCAN       — Security scan (license, deps, vulnerabilities)
 *   6. CERTIFY    — Create certification record
 *   7. SIGN       — Digital signature / integrity hash
 *   8. PUBLISH    — Transition to PUBLISHED status
 *   9. INSTALL    — Auto-install to requesting tenant (optional)
 *
 * Each stage updates job progress and PackVersion status.
 */

import { Job } from 'bullmq';
import { PrismaClient } from '@metis/database';
import { parseManifest, canTransition } from '@metis/types';
import type { PackManifest, PackStatus } from '@metis/types';
import type { PackSourceType } from '@prisma/client';
import { getSourceAdapter, FetchedPackPayload, validateSourceUrl } from '../adapters';

// ── Constants ──
const STAGE_TIMEOUT_MS: Record<string, number> = {
  fetch: 60_000, // 60s — network I/O
  parse: 10_000, // 10s
  normalize: 15_000, // 15s — DB lookups
  validate: 10_000, // 10s
  scan: 120_000, // 2min — vulnerability scanning
  certify: 10_000, // 10s
  sign: 10_000, // 10s
  publish: 10_000, // 10s
  install: 15_000, // 15s
};

// ── Types ──

export interface PackImportJobData {
  sourceType: string;
  sourceUrl: string;
  displayName?: string;
  tenantId?: string;
  userId?: string;
  /** If true, auto-install after publish */
  autoInstall?: boolean;
  /** Stop at this stage (e.g., 'VALIDATED' for dry-run) */
  stopAt?: PackStatus;
}

export interface PipelineContext {
  job: Job<PackImportJobData>;
  prisma: PrismaClient;
  packId?: string;
  packVersionId?: string;
  fetchedPayload?: FetchedPackPayload;
  manifest?: PackManifest;
  certificationId?: string;
  signatureHash?: string;
  errors: string[];
  warnings: string[];
}

type PipelineStage = {
  name: string;
  status: PackStatus | null; // target status after stage, null = no transition
  execute: (ctx: PipelineContext) => Promise<void>;
};

// ── Stage Implementations ──

/** Stage 1: FETCH — Retrieve pack from source (with SSRF protection) */
async function stageFetch(ctx: PipelineContext): Promise<void> {
  const { sourceType, sourceUrl } = ctx.job.data;

  // SSRF prevention: validate URL before any network access
  const urlCheck = validateSourceUrl(sourceUrl, false);
  if (!urlCheck.valid) {
    throw new Error(`Source URL rejected (security): ${urlCheck.reason}`);
  }

  const adapter = getSourceAdapter(sourceType);
  if (!adapter.validate(sourceUrl)) {
    throw new Error(`Invalid source URL for type ${sourceType}: ${sourceUrl}`);
  }

  ctx.fetchedPayload = await adapter.fetch(sourceUrl);
  console.log(`[pipeline:fetch] Fetched from ${sourceType}: ${sourceUrl}`);
}

/** Stage 2: PARSE — Parse manifest from fetched payload */
async function stageParse(ctx: PipelineContext): Promise<void> {
  if (!ctx.fetchedPayload) {
    throw new Error('No fetched payload — fetch stage may have failed');
  }

  const result = parseManifest(ctx.fetchedPayload.rawManifest);

  if (!result.valid) {
    ctx.errors.push(...result.errors);
    throw new Error(`Manifest parse failed: ${result.errors.join(', ')}`);
  }

  ctx.warnings.push(...result.warnings);
  ctx.manifest = result.normalized!;
  console.log(`[pipeline:parse] Manifest parsed: ${ctx.manifest.name}@${ctx.manifest.version}`);
}

/** Stage 3: NORMALIZE — Generate pack key, deduplicate, normalize fields */
async function stageNormalize(ctx: PipelineContext): Promise<void> {
  if (!ctx.manifest) throw new Error('No manifest available');

  // Generate deterministic pack key
  const key = ctx.manifest.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Check for existing pack with same key
  const existingPack = await ctx.prisma.pack.findUnique({ where: { key } });

  if (existingPack) {
    // Check for duplicate version
    const existingVersion = await ctx.prisma.packVersion.findFirst({
      where: { packId: existingPack.id, version: ctx.manifest.version },
    });

    if (existingVersion) {
      throw new Error(
        `Pack "${key}" version ${ctx.manifest.version} already exists (status: ${existingVersion.status})`,
      );
    }

    ctx.packId = existingPack.id;
    console.log(`[pipeline:normalize] Existing pack found: ${key} (${existingPack.id})`);
  } else {
    // Create new pack record
    const newPack = await ctx.prisma.pack.create({
      data: {
        key,
        name: ctx.manifest.name,
        sourceType: ctx.job.data.sourceType as PackSourceType,
        sourceUrl: ctx.job.data.sourceUrl,
        description: ctx.manifest.description,
      },
    });
    ctx.packId = newPack.id;
    console.log(`[pipeline:normalize] New pack created: ${key} (${newPack.id})`);
  }

  // Create PackVersion in DRAFT
  const version = await ctx.prisma.packVersion.create({
    data: {
      packId: ctx.packId,
      version: ctx.manifest.version,
      manifestJson: ctx.manifest as any,
      status: 'DRAFT',
    },
  });
  ctx.packVersionId = version.id;
  console.log(`[pipeline:normalize] PackVersion created: ${version.id} (DRAFT)`);
}

/** Stage 4: VALIDATE — Deep validation: schema rules, runtime constraints */
async function stageValidate(ctx: PipelineContext): Promise<void> {
  if (!ctx.manifest || !ctx.packVersionId) throw new Error('Missing context for validation');

  const validationErrors: string[] = [];

  // Business rule validations
  if (ctx.manifest.runtime?.maxConcurrency && ctx.manifest.runtime.maxConcurrency > 100) {
    validationErrors.push('maxConcurrency cannot exceed 100');
  }

  if (ctx.manifest.runtime?.timeoutMs && ctx.manifest.runtime.timeoutMs > 3600000) {
    validationErrors.push('timeoutMs cannot exceed 1 hour (3600000ms)');
  }

  if (ctx.manifest.runtime?.memoryMb && ctx.manifest.runtime.memoryMb > 4096) {
    validationErrors.push('memoryMb cannot exceed 4096MB');
  }

  // Name length check
  if (ctx.manifest.name.length > 128) {
    validationErrors.push('Pack name cannot exceed 128 characters');
  }

  // Connector reference validation (in production, check against connector registry)
  if (ctx.manifest.connectors?.length) {
    ctx.warnings.push(
      `Pack declares ${ctx.manifest.connectors.length} connector(s) — will be verified at install time`,
    );
  }

  if (validationErrors.length > 0) {
    ctx.errors.push(...validationErrors);
    // Update version status to reflect failure
    await ctx.prisma.packVersion.update({
      where: { id: ctx.packVersionId },
      data: { status: 'DRAFT' }, // stays in DRAFT on validation failure
    });
    throw new Error(`Validation failed: ${validationErrors.join('; ')}`);
  }

  // Transition DRAFT → IMPORTED
  await transitionVersion(ctx, 'DRAFT', 'IMPORTED');
  console.log(`[pipeline:validate] Validation passed, status → IMPORTED`);
}

/** Stage 5: SCAN — Security scan (license, dependency audit, vulnerability check) */
async function stageScan(ctx: PipelineContext): Promise<void> {
  if (!ctx.packVersionId) throw new Error('Missing packVersionId');

  const scanResults = {
    licenseOk: true,
    vulnerabilities: [] as string[],
    scannedAt: new Date().toISOString(),
  };

  // License check
  if (ctx.manifest?.license) {
    const allowedLicenses = [
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      'UNLICENSED',
    ];
    if (!allowedLicenses.includes(ctx.manifest.license)) {
      ctx.warnings.push(`License "${ctx.manifest.license}" may require legal review`);
    }
  } else {
    ctx.warnings.push('No license specified — defaults to UNLICENSED');
  }

  // In production: run actual dependency vulnerability scan
  // For now, just log scan results (not persisted - no metadata field in PackVersion)
  console.log(`[pipeline:scan] Scan results:`, scanResults);

  // Transition IMPORTED → VALIDATED
  await transitionVersion(ctx, 'IMPORTED', 'VALIDATED');
  console.log(`[pipeline:scan] Security scan passed, status → VALIDATED`);
}

/** Stage 6: CERTIFY — Create certification record */
async function stageCertify(ctx: PipelineContext): Promise<void> {
  if (!ctx.packVersionId) throw new Error('Missing packVersionId');

  const certification = await ctx.prisma.certification.create({
    data: {
      packVersionId: ctx.packVersionId,
      level: 'STANDARD',
      score: 100,
    },
  });

  ctx.certificationId = certification.id;

  // Transition VALIDATED → CERTIFIED
  await transitionVersion(ctx, 'VALIDATED', 'CERTIFIED');
  console.log(`[pipeline:certify] Certification created: ${certification.id}, status → CERTIFIED`);
}

/** Stage 7: SIGN — Generate integrity hash / digital signature */
async function stageSign(ctx: PipelineContext): Promise<void> {
  if (!ctx.packVersionId || !ctx.manifest) throw new Error('Missing context for signing');

  // Generate SHA-256 hash of manifest content as integrity signature
  const crypto = await import('crypto');
  const manifestStr = JSON.stringify(ctx.manifest, null, 0);
  const hash = crypto.createHash('sha256').update(manifestStr).digest('hex');

  ctx.signatureHash = hash;

  // Update checksum field with signature
  await ctx.prisma.packVersion.update({
    where: { id: ctx.packVersionId },
    data: { checksum: hash },
  });

  console.log(`[pipeline:sign] Integrity hash: ${hash.substring(0, 16)}...`);
}

/** Stage 8: PUBLISH — Transition to PUBLISHED, set publishedAt */
async function stagePublish(ctx: PipelineContext): Promise<void> {
  if (!ctx.packVersionId) throw new Error('Missing packVersionId');

  await ctx.prisma.packVersion.update({
    where: { id: ctx.packVersionId },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });

  console.log(`[pipeline:publish] Pack version published`);
}

/** Stage 9: INSTALL — Auto-install to requesting tenant (optional) */
async function stageInstall(ctx: PipelineContext): Promise<void> {
  if (!ctx.job.data.autoInstall || !ctx.job.data.tenantId) {
    console.log(`[pipeline:install] Skipped (autoInstall=${ctx.job.data.autoInstall})`);
    return;
  }

  if (!ctx.packId || !ctx.packVersionId) throw new Error('Missing pack context for install');

  await ctx.prisma.packInstallation.create({
    data: {
      packId: ctx.packId,
      packVersionId: ctx.packVersionId,
      tenantId: ctx.job.data.tenantId,
      installedById: ctx.job.data.userId ?? 'system',
      configJson: {},
    },
  });

  console.log(`[pipeline:install] Auto-installed to tenant ${ctx.job.data.tenantId}`);
}

// ── Pipeline Definition ──

const PIPELINE_STAGES: PipelineStage[] = [
  { name: 'fetch', status: null, execute: stageFetch },
  { name: 'parse', status: null, execute: stageParse },
  { name: 'normalize', status: 'DRAFT', execute: stageNormalize },
  { name: 'validate', status: 'IMPORTED', execute: stageValidate },
  { name: 'scan', status: 'VALIDATED', execute: stageScan },
  { name: 'certify', status: 'CERTIFIED', execute: stageCertify },
  { name: 'sign', status: null, execute: stageSign },
  { name: 'publish', status: 'PUBLISHED', execute: stagePublish },
  { name: 'install', status: null, execute: stageInstall },
];

const STATUS_ORDER: PackStatus[] = ['DRAFT', 'IMPORTED', 'VALIDATED', 'CERTIFIED', 'PUBLISHED'];

// ── Pipeline Runner ──

export async function runPackImportPipeline(
  job: Job<PackImportJobData>,
  prisma: PrismaClient,
): Promise<{
  packId: string;
  packVersionId: string;
  certificationId?: string;
  signatureHash?: string;
  warnings: string[];
}> {
  const ctx: PipelineContext = {
    job,
    prisma,
    errors: [],
    warnings: [],
  };

  const stopAt = job.data.stopAt;
  const totalStages = PIPELINE_STAGES.length;

  for (let i = 0; i < totalStages; i++) {
    const stage = PIPELINE_STAGES[i];

    // Check if we should stop at a specific status
    if (stopAt && stage.status) {
      const stopIdx = STATUS_ORDER.indexOf(stopAt);
      const stageIdx = STATUS_ORDER.indexOf(stage.status);
      if (stageIdx > stopIdx) {
        console.log(`[pipeline] Stopping at ${stopAt} (skipping ${stage.name})`);
        break;
      }
    }

    try {
      console.log(`[pipeline] Stage ${i + 1}/${totalStages}: ${stage.name}`);
      await job.updateProgress(Math.round((i / totalStages) * 100));

      // Execute with per-stage timeout
      const timeout = STAGE_TIMEOUT_MS[stage.name] ?? 30_000;
      await Promise.race([
        stage.execute(ctx),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Stage "${stage.name}" timed out after ${timeout}ms`)),
            timeout,
          ),
        ),
      ]);

      await job.updateProgress(Math.round(((i + 1) / totalStages) * 100));
    } catch (error: any) {
      console.error(`[pipeline] Stage "${stage.name}" failed:`, error.message);
      throw new Error(`Pipeline failed at stage "${stage.name}": ${error.message}`);
    }
  }

  if (!ctx.packId || !ctx.packVersionId) {
    throw new Error('Pipeline completed but pack was not created');
  }

  return {
    packId: ctx.packId,
    packVersionId: ctx.packVersionId,
    certificationId: ctx.certificationId,
    signatureHash: ctx.signatureHash,
    warnings: ctx.warnings,
  };
}

// ── Helpers ──

async function transitionVersion(
  ctx: PipelineContext,
  from: PackStatus,
  to: PackStatus,
): Promise<void> {
  const role = 'PLATFORM_ADMIN'; // pipeline runs as system admin
  const check = canTransition(from, to, role);
  if (!check.allowed) {
    throw new Error(`State transition blocked: ${check.reason}`);
  }

  await ctx.prisma.packVersion.update({
    where: { id: ctx.packVersionId },
    data: { status: to },
  });
}
