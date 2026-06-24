/**
 * FinopsReporterService — metis → FinOps control-plane 품질 폐루프 + 비용 귀속 헤더.
 *
 * 두 가지 역할:
 *  1) attributionHeaders(): metis 의 LLM 호출이 게이트웨이(:8400)를 경유할 때
 *     X-Metis-* 헤더를 실어 보내, 게이트웨이가 비용/절감을 동일 run_id 에 귀속하게 한다.
 *  2) reportQuality(): 실행 후 평가기가 산정한 품질을 control-plane(:8500)
 *     /api/quality/report 로 전송 → 원장의 run.quality_score 갱신(품질 폐루프).
 *
 * 의존성이 없는 stateless 서비스(환경변수만 읽음)라 여러 모듈에서 안전하게 provide 가능.
 * 모든 호출은 best-effort — 실패해도 절대 파이프라인을 막지 않는다.
 */
import { Injectable, Logger } from '@nestjs/common';

export interface Attribution {
  runId?: string;
  agent?: string;
  tenant?: string;
  step?: number;
}

@Injectable()
export class FinopsReporterService {
  private readonly logger = new Logger(FinopsReporterService.name);
  private readonly cpUrl = (process.env.FINOPS_CP_URL || 'http://localhost:8500').replace(/\/+$/, '');
  /** 품질 폐루프 전송 on/off (기본 on). FINOPS_REPORT_QUALITY=0 으로 비활성화. */
  private readonly enabled = (process.env.FINOPS_REPORT_QUALITY ?? '1') !== '0';

  /** 게이트웨이가 비용을 run/agent 에 귀속하도록 X-Metis-* 헤더를 만든다. */
  attributionHeaders(a: Attribution): Record<string, string> {
    const h: Record<string, string> = {};
    if (a.runId) h['x-metis-run-id'] = a.runId;
    if (a.agent) h['x-metis-agent'] = a.agent;
    if (a.tenant) h['x-metis-tenant'] = a.tenant;
    if (typeof a.step === 'number') h['x-metis-step'] = String(a.step);
    return h;
  }

  /**
   * 실행 품질을 원장에 보고한다(0..1 스케일).
   * @param score 0..1 (평가기 overallScore/100)
   * @param passed 품질 게이트 통과 여부(기본 score>=0.8 권장)
   */
  async reportQuality(p: {
    runId: string;
    score: number;
    passed: boolean;
    agent?: string;
    tenant?: string;
    project?: string;
    status?: 'success' | 'failure';
  }): Promise<void> {
    if (!this.enabled || !p.runId) return;
    const score = Math.max(0, Math.min(1, p.score));
    try {
      await fetch(`${this.cpUrl}/api/quality/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          run_id: p.runId,
          score,
          passed: p.passed,
          agent: p.agent || 'unknown',
          tenant: p.tenant || 'unknown',
          project: p.project || 'default',
          status: p.status || 'success',
        }),
        signal: AbortSignal.timeout(4000),
      });
    } catch (err) {
      // 원장이 미기동/네트워크 단절이어도 실행을 막지 않는다.
      this.logger.warn(`FinOps quality report skipped: ${(err as Error)?.message}`);
    }
  }
}
