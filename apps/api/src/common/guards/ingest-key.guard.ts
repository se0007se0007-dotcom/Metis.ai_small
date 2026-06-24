/**
 * Ingest API Key Guard — Phase 1 (Ingestion On-Ramp)
 *
 * Authenticates EXTERNAL agents on the ingest DATA routes (e.g. POST
 * /ingest/runs). These routes are also marked @Public() so the global
 * JwtAuthGuard skips them; this guard validates the API key instead.
 *
 * Accepted credential locations:
 *   - Authorization: Bearer mts_...
 *   - x-metis-key: mts_...
 *
 * On success it sets `req.ingestTenantId` (+ `req.ingestKeyId`) so the
 * controller can scope all work to the resolved tenant. On failure it
 * throws UnauthorizedException.
 *
 * @module ingest
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { IngestKeyService } from '../../modules/ingest/ingest-key.service';

@Injectable()
export class IngestKeyGuard implements CanActivate {
  constructor(private readonly keyService: IngestKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const rawKey = this.extractKey(request);
    if (!rawKey) {
      throw new UnauthorizedException('Missing METIS ingest API key');
    }

    const result = await this.keyService.verifyKey(rawKey);
    if (!result) {
      throw new UnauthorizedException('Invalid or revoked METIS ingest API key');
    }

    request.ingestTenantId = result.tenantId;
    request.ingestKeyId = result.keyId;
    // 표준화: 키 scope(허용 agentName, sub-agent 귀속)를 컨트롤러/서비스로 전달.
    request.ingestKeyScope = {
      allowedAgentNames: result.allowedAgentNames ?? [],
      subAgentKey: result.subAgentKey ?? null,
      agentName: result.agentName ?? null,
    };
    return true;
  }

  private extractKey(request: any): string | undefined {
    // (a) Authorization: Bearer mts_...
    const authHeader: string | undefined = request.headers?.authorization;
    if (authHeader) {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token && token.startsWith('mts_')) return token.trim();
    }
    // (b) x-metis-key: mts_...
    const headerKey: string | undefined = request.headers?.['x-metis-key'];
    if (headerKey && headerKey.startsWith('mts_')) return headerKey.trim();

    return undefined;
  }
}
