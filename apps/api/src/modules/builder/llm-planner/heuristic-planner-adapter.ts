/**
 * Heuristic Planner Adapter — default zero-dependency planner.
 *
 * Mirrors the logic of CapabilityPlannerService but conforms to the
 * LLMPlannerAdapter interface so callers can uniformly swap it for an
 * LLM implementation later.
 */
import { Injectable } from '@nestjs/common';
import type {
  LLMPlannerAdapter,
  PlannerContext,
  PlannerSuggestion,
} from './planner-adapter.interface';

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  ap: ['인보이스', 'invoice', 'ocr', 'po', 'gr', 'match', '매칭', '승인', 'approve'],
  risk: ['fds', '이상', 'fraud', '리스크', 'risk', 'block', '차단'],
  ops: ['장애', 'incident', '배포', 'deploy', '복구', 'rollback', '격리'],
  deployment: ['canary', '카나리', 'shadow', 'promote', '승격'],
};

@Injectable()
export class HeuristicPlannerAdapter implements LLMPlannerAdapter {
  readonly name = 'heuristic';
  readonly version = '1.0.0';

  async isHealthy() {
    return true;
  }

  async suggest(ctx: PlannerContext): Promise<PlannerSuggestion> {
    const q = ctx.intent.toLowerCase();

    // 1. Domain inference
    let domain = ctx.hints?.domain ?? 'general';
    let bestScore = 0;
    for (const [d, kws] of Object.entries(DOMAIN_KEYWORDS)) {
      const score = kws.filter((k) => q.includes(k.toLowerCase())).length;
      if (score > bestScore) {
        domain = d;
        bestScore = score;
      }
    }

    // 2. Score each capability
    const scored = ctx.availableCapabilities
      .map((c) => {
        let score = 0;
        if (q.includes(c.label.toLowerCase())) score += 8;
        const rawKey = c.key.split(':').pop() || '';
        if (q.includes(rawKey.toLowerCase())) score += 5;
        for (const t of c.tags) if (q.includes(t.toLowerCase())) score += 3;
        if (q.includes(c.category.toLowerCase())) score += 2;
        if (ctx.hints?.preferredAgents?.some((a) => c.key === `agent:${a}`)) score += 6;
        if (ctx.hints?.preferredConnectors?.some((cn) => c.key === `connector:${cn}`)) score += 6;
        // Domain bonus
        if (
          domain !== 'general' &&
          (c.category.includes(domain) || c.tags.some((t) => t.includes(domain)))
        ) {
          score += 4;
        }
        return { cap: c, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const selected = scored.slice(0, 8).map((s) => s.cap);

    // 3. Build node order — canonical pipeline with basic DAG awareness
    const adapters = selected.filter((c) => c.kind === 'ADAPTER');
    const agents = selected.filter((c) => c.kind === 'AGENT');
    const skills = selected.filter((c) => c.kind === 'SKILL');
    const connectors = selected.filter((c) => c.kind === 'CONNECTOR');

    const nodeOrder: PlannerSuggestion['nodeOrder'] = [{ id: 'start', type: 'start' }];
    let idx = 1;
    const adapterIds: string[] = [];
    for (const a of adapters.slice(0, 2)) {
      const id = `n${idx++}`;
      nodeOrder.push({
        id,
        type: 'adapter',
        capability: a.key,
        dependsOn: ['start'],
        rationale: `입력 처리 단계: ${a.label}`,
      });
      adapterIds.push(id);
    }
    const agentIds: string[] = [];
    for (const ag of agents.slice(0, 3)) {
      const id = `n${idx++}`;
      // Agents depend on all adapters (parallel within agents themselves)
      nodeOrder.push({
        id,
        type: 'agent',
        capability: ag.key,
        dependsOn: adapterIds.length > 0 ? adapterIds : ['start'],
        rationale: `의사결정: ${ag.label}`,
      });
      agentIds.push(id);
    }
    for (const sk of skills.slice(0, 2)) {
      const id = `n${idx++}`;
      nodeOrder.push({
        id,
        type: 'skill',
        capability: sk.key,
        dependsOn: agentIds.length > 0 ? agentIds : adapterIds.length > 0 ? adapterIds : ['start'],
      });
    }
    const lastPre = agentIds.length ? agentIds : adapterIds.length ? adapterIds : ['start'];
    const connectorIds: string[] = [];
    for (const cn of connectors.slice(0, 2)) {
      const id = `n${idx++}`;
      nodeOrder.push({
        id,
        type: 'connector',
        capability: cn.key,
        dependsOn: lastPre,
        rationale: `외부 연동: ${cn.label}`,
      });
      connectorIds.push(id);
    }
    nodeOrder.push({
      id: 'end',
      type: 'end',
      dependsOn: connectorIds.length > 0 ? connectorIds : lastPre,
    });

    // 4. Confidence
    const totalScore = scored.slice(0, selected.length).reduce((s, x) => s + x.score, 0);
    const maxPossible = selected.length * 10;
    const confidence = Math.min(1, totalScore / Math.max(1, maxPossible));

    return {
      domain,
      selectedCapabilityKeys: selected.map((c) => c.key),
      nodeOrder,
      confidence,
      explanation:
        selected.length > 0
          ? `의도 "${ctx.intent}" (domain=${domain})에 대해 ${selected.length}개 Capability를 병렬 실행 가능한 DAG로 배치했습니다.`
          : '해당 의도에 매칭되는 Capability를 찾지 못했습니다.',
      warnings: selected.length === 0 ? ['매칭되는 Capability 없음 — 수동 설계 필요'] : undefined,
    };
  }
}
