/**
 * FinOps Gateway 프록시 — metis 백엔드가 FinOps control-plane(:8500)의 /api/* 를 중계한다.
 * 목적: 브라우저는 metis(:4000)만 호출하고 :8500 을 직접 접속하지 않음 → "한 플랫폼".
 * control-plane 은 Docker 백엔드 서비스로만 동작(사용자 비노출).
 */
import { Controller, Get, Post, Req, Res, Body } from '@nestjs/common';
import type { Request, Response } from 'express';

const CP = (process.env.FINOPS_CP_URL || 'http://localhost:8500').replace(/\/+$/, '');

@Controller('finops-gw')
export class FinopsGwController {
  /** GET /v1/finops-gw/<path>?<qs>  →  CP /api/<path>?<qs> */
  @Get('*')
  async proxyGet(@Req() req: Request, @Res() res: Response): Promise<void> {
    // req.url 예: /v1/finops-gw/overview?hours=24  (전역 prefix 포함)
    const sub = req.url.replace(/^\/v1\/finops-gw\//, '').replace(/^finops-gw\//, '');
    await this.forward('GET', sub, undefined, res);
  }

  /** POST /v1/finops-gw/<path>  →  CP /api/<path>  (정책/단가 변경 등) */
  @Post('*')
  async proxyPost(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    const sub = req.url.replace(/^\/v1\/finops-gw\//, '').replace(/^finops-gw\//, '');
    await this.forward('POST', sub, body, res);
  }

  private async forward(method: string, sub: string, body: unknown, res: Response): Promise<void> {
    const url = `${CP}/api/${sub}`;
    // qa/test 는 실제 LLM 코드리뷰를 수행하므로 길게, 그 외 조회/정책변경은 짧게.
    const timeoutMs = sub.startsWith('qa/') ? 180000 : 8000;
    try {
      const r = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      res
        .status(r.status)
        .type(r.headers.get('content-type') || 'application/json')
        .send(text);
    } catch (e) {
      res.status(503).json({
        error: 'finops_unavailable',
        message:
          'FinOps 컨트롤플레인(:8500)에 연결할 수 없습니다. 컨테이너가 기동/빌드 중인지 확인하세요.',
        detail: (e as Error)?.message,
      });
    }
  }
}
