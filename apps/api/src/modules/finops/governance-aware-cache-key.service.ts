/**
 * GovernanceAwareCacheKeyService — Patent 3 구성요소 (종속청구항 1).
 *
 * Cache key = sha256(tenant, namespace, agent, skill, workflow, node,
 * policyHash, dataClass, promptHash). policyHash가 키에 포함되므로
 * 정책이 바뀌면 과거 응답은 키 자체가 달라져 재사용될 수 없다.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface CacheKeyInput {
  tenantId: string;
  namespace?: string;
  agentName: string;
  skillId?: string;
  workflowId?: string;
  nodeKey?: string;
  policyHash: string;
  dataClass: string;
  prompt: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class GovernanceAwareCacheKeyService {
  promptHash(prompt: string): string {
    return sha256(prompt.trim());
  }

  build(input: CacheKeyInput): { cacheKey: string; promptHash: string } {
    const promptHash = this.promptHash(input.prompt);
    const cacheKey = sha256(
      JSON.stringify({
        t: input.tenantId,
        ns: input.namespace ?? 'default',
        a: input.agentName,
        s: input.skillId ?? null,
        w: input.workflowId ?? null,
        n: input.nodeKey ?? null,
        p: input.policyHash,
        d: input.dataClass,
        h: promptHash,
      }),
    );
    return { cacheKey, promptHash };
  }
}
