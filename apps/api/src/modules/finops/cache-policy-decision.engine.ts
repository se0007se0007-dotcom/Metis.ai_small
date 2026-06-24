/**
 * CachePolicyDecisionEngine — Patent 3 구성요소 (종속청구항 2·3).
 *
 * Semantic cache 재사용 가능성을 비용이 아니라 "정책"으로 판단한다:
 *   DENY_SENSITIVE_DATA  — PII/SECRET/고객기밀 prompt는 재사용 금지
 *   DENY_HIGH_RISK       — riskScore >= 0.7 노드는 재사용 금지
 *   DENY_POLICY_CHANGED  — 정책 hash가 달라진 캐시는 조회 자체가 차단
 *                          (cache lookup이 policyHash 일치 조건으로 실행됨)
 *   ALLOW                — 그 외
 * 모든 판정은 reason과 함께 FinOpsTokenLog에 남는다.
 */
import { Injectable } from '@nestjs/common';

export const SENSITIVE_DATA_CLASSES = ['PII', 'SECRET', 'CUSTOMER_CONFIDENTIAL'];
export const HIGH_RISK_THRESHOLD = 0.7;

export type CachePolicyDecisionValue =
  | 'ALLOW'
  | 'DENY_SENSITIVE_DATA'
  | 'DENY_HIGH_RISK'
  | 'DENY_POLICY_CHANGED'
  | 'CACHE_DISABLED';

export interface CachePolicyDecision {
  decision: CachePolicyDecisionValue;
  cacheAllowed: boolean;
  reasons: string[];
}

@Injectable()
export class CachePolicyDecisionEngine {
  decide(input: {
    dataClass: string;
    riskScore: number;
    cacheEnabled: boolean;
  }): CachePolicyDecision {
    if (!input.cacheEnabled) {
      return {
        decision: 'CACHE_DISABLED',
        cacheAllowed: false,
        reasons: ['semantic cache disabled by config'],
      };
    }
    if (SENSITIVE_DATA_CLASSES.includes(input.dataClass)) {
      return {
        decision: 'DENY_SENSITIVE_DATA',
        cacheAllowed: false,
        reasons: [`dataClass=${input.dataClass} must not be cached or reused`],
      };
    }
    if (input.riskScore >= HIGH_RISK_THRESHOLD) {
      return {
        decision: 'DENY_HIGH_RISK',
        cacheAllowed: false,
        reasons: [`riskScore=${input.riskScore} >= ${HIGH_RISK_THRESHOLD}`],
      };
    }
    return { decision: 'ALLOW', cacheAllowed: true, reasons: ['cache reuse permitted'] };
  }
}
