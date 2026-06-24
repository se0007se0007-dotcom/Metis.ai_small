/**
 * Ingest Controller — Phase 1 (Ingestion On-Ramp)
 *
 * Two distinct auth surfaces:
 *
 *   DATA route (external agents, API key auth):
 *     POST /ingest/runs        — @Public() + IngestKeyGuard
 *       Accepts a single run object OR an array (cap 100). Tenant is taken
 *       from req.ingestTenantId (set by the guard from the verified key).
 *       Returns 202 { accepted, runIds, rejected } by default; with ?wait=true
 *       evaluates synchronously and returns 200 with evaluation summaries.
 *
 *   KEY MANAGEMENT routes (humans, JWT + RBAC):
 *     POST   /ingest/keys      — create (returns plaintext ONCE)
 *     GET    /ingest/keys      — list (never returns hashed key)
 *     DELETE /ingest/keys/:id  — revoke
 *     Restricted to TENANT_ADMIN / PLATFORM_ADMIN. Tenant from @CurrentUser().
 *
 * @module ingest
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, Public, RequestUser, Roles } from '../../common/decorators';
import { IngestKeyGuard } from '../../common/guards/ingest-key.guard';
import { IngestRunInput, IngestService } from './ingest.service';
import { IngestKeyService } from './ingest-key.service';

const MAX_BATCH = 100;

@ApiTags('Ingest')
@Controller('ingest')
export class IngestController {
  constructor(
    private readonly ingestService: IngestService,
    private readonly keyService: IngestKeyService,
  ) {}

  // ─────────────────────────────────────────────────────────
  // DATA route — external agents (API key auth)
  // ─────────────────────────────────────────────────────────

  @Public()
  @UseGuards(IngestKeyGuard)
  @Post('runs')
  @HttpCode(202)
  @ApiOperation({ summary: 'Ingest external agent run(s) for evaluation (API key auth)' })
  async ingestRuns(
    @Req() req: any,
    @Body() body: IngestRunInput | IngestRunInput[],
    @Query('wait') wait?: string,
  ) {
    const tenantId: string | undefined = req.ingestTenantId;
    if (!tenantId) {
      // Should never happen — guard sets it — but fail closed.
      throw new BadRequestException('Tenant could not be resolved from API key');
    }

    const runs = Array.isArray(body) ? body : [body];
    if (runs.length === 0) {
      throw new BadRequestException('No runs provided');
    }
    if (runs.length > MAX_BATCH) {
      throw new BadRequestException(`Batch too large: max ${MAX_BATCH} runs per request`);
    }

    const waitForEval = wait === 'true' || wait === '1';
    const { accepted, rejected, results } = await this.ingestService.ingestRuns(tenantId, runs, {
      wait: waitForEval,
      ingestKeyId: req.ingestKeyId, // 키별/Sub-Agent별 추적 귀속
      keyScope: req.ingestKeyScope, // agentName 허용목록 강제
    });
    // 키 사용량 캐시 갱신(best-effort) — 정확 집계는 ExecutionSession.ingestKeyId 기준.
    if (req.ingestKeyId && accepted > 0) void this.keyService.recordUsage(req.ingestKeyId);

    const runIds = results
      .filter((r) => r.status === 'evaluated')
      .map((r) => ({ runId: r.runId, sessionId: r.sessionId }));

    if (waitForEval) {
      // Synchronous mode — 200 with full evaluation summaries.
      return {
        accepted,
        rejected,
        results,
      };
    }

    // Default async-style ack — 202.
    return {
      accepted,
      runIds,
      rejected,
    };
  }

  // ─────────────────────────────────────────────────────────
  // TEST route — Hermes Lab in-app test (JWT + RBAC, NOT api-key).
  // Lets the web UI submit a sample run (incl. runtime='hermes' + hermesMeta)
  // using the logged-in user's cookie session; always evaluates synchronously.
  // ─────────────────────────────────────────────────────────
  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'OPERATOR', 'DEVELOPER', 'PLATFORM_ADMIN')
  @Post('test-run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hermes Lab: evaluate one sample run (JWT auth, sync)' })
  async testRun(@CurrentUser() user: RequestUser, @Body() body: IngestRunInput) {
    if (!body || (!body.input && !body.output)) {
      throw new BadRequestException('input 또는 output 중 하나는 필요합니다');
    }
    const { results } = await this.ingestService.ingestRuns(user.tenantId, [body], { wait: true });
    return results[0];
  }

  // ─────────────────────────────────────────────────────────
  // READ route — recent ingested runs (JWT + RBAC, NOT api-key)
  // Powers the Hermes Lab "recent runs + compare" list. Read roles only.
  // ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'OPERATOR', 'AUDITOR', 'PLATFORM_ADMIN')
  @Get('recent')
  @ApiOperation({ summary: 'List recent ingested runs with eval summary (JWT auth)' })
  async recent(
    @CurrentUser() user: RequestUser,
    @Query('runtime') runtime?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return this.ingestService.getRecent(user.tenantId, {
      runtime,
      limit: Number.isFinite(parsedLimit as number) ? parsedLimit : undefined,
    });
  }

  // ─────────────────────────────────────────────────────────
  // KEY MANAGEMENT — humans (JWT + RBAC, NOT api-key)
  // ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'IngestApiKey')
  @Post('keys')
  @ApiOperation({ summary: 'Create an ingest API key (plaintext returned ONCE)' })
  async createKey(
    @CurrentUser() user: RequestUser,
    @Body()
    dto: {
      name?: string;
      env?: string;
      teamId?: string;
      agentKey?: string;
      subAgentKey?: string;
      agentName?: string;
      allowedAgentNames?: string[];
    },
  ) {
    const env = dto?.env === 'test' ? 'test' : 'live';
    const created = await this.keyService.createKey(
      user.tenantId,
      dto?.name ?? 'External Agent Key',
      env,
      user.userId,
      {
        teamId: dto?.teamId || null,
        agentKey: dto?.agentKey || null,
        subAgentKey: dto?.subAgentKey || null,
        agentName: dto?.agentName || null,
        allowedAgentNames: Array.isArray(dto?.allowedAgentNames) ? dto!.allowedAgentNames : [],
      },
    );
    return {
      id: created.id,
      // Plaintext key — store it now; it cannot be retrieved again.
      key: created.key,
      prefix: created.prefix,
      name: created.name,
      env: created.env,
      scopes: created.scopes,
      createdAt: created.createdAt,
      warning: 'Store this key now — it will not be shown again.',
    };
  }

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Get('keys')
  @ApiOperation({ summary: 'List ingest API keys for the tenant' })
  async listKeys(@CurrentUser() user: RequestUser) {
    const items = await this.keyService.listKeys(user.tenantId);
    return { items };
  }

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('UPDATE', 'IngestApiKey')
  @Patch('keys/:id')
  @ApiOperation({ summary: 'Ingest 키 메타/매핑 수정 (이름·팀·Agent·Sub-Agent·허용목록)' })
  async updateKey(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body()
    dto: {
      name?: string;
      teamId?: string | null;
      agentKey?: string | null;
      subAgentKey?: string | null;
      agentName?: string | null;
      allowedAgentNames?: string[];
    },
  ) {
    return this.keyService.updateKey(user.tenantId, id, dto);
  }

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Get('keys/overview')
  @ApiOperation({ summary: '관리자 Ingest Key 현황표 — 키별 사용량 + 팀/Sub-Agent 그룹 집계' })
  async keysOverview(@CurrentUser() user: RequestUser) {
    return this.keyService.overview(user.tenantId);
  }

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Get('teams')
  @ApiOperation({ summary: '테넌트 팀 목록' })
  async listTeams(@CurrentUser() user: RequestUser) {
    return { items: await this.keyService.listTeams(user.tenantId) };
  }

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('CREATE', 'Team')
  @Post('teams')
  @ApiOperation({ summary: '팀 생성' })
  async createTeam(@CurrentUser() user: RequestUser, @Body() dto: { name: string }) {
    if (!dto?.name?.trim()) throw new BadRequestException('팀 이름이 필요합니다.');
    return this.keyService.createTeam(user.tenantId, dto.name);
  }

  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'PLATFORM_ADMIN')
  @Audit('DELETE', 'IngestApiKey')
  @Delete('keys/:id')
  @ApiOperation({ summary: 'Ingest API 키 폐기(기본) 또는 완전 삭제(?hard=true)' })
  async revokeKey(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('hard') hard?: string,
  ) {
    if (hard === 'true' || hard === '1') {
      const r = await this.keyService.deleteKey(user.tenantId, id);
      return { id: r.id, deleted: r.deleted };
    }
    const result = await this.keyService.revokeKey(user.tenantId, id);
    return { id: result.id, revokedAt: result.revokedAt };
  }
}
