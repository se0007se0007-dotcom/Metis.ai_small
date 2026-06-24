"""거버넌스 융합(Patent 3) 순수 로직 단위테스트.

전체 E2E(tests/e2e.py)와 별개로, 캐시 정책 판정·티어 상향·캐시 키 격리 같은
순수 함수 로직을 외부 서비스 없이 빠르게 검증한다.
사용법: python tests/governance_unit.py
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "services", "control_plane"))
import pricing  # noqa: E402

PASS = FAIL = 0


def ck(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}")


SENS = ["PII", "SECRET", "CUSTOMER_CONFIDENTIAL"]


def cache_policy_decision(data_class, risk, high=0.7, enabled=True):
    if not enabled:
        return ("CACHE_DISABLED", True)
    if data_class in SENS:
        return ("DENY_SENSITIVE_DATA", False)
    if risk >= high:
        return ("DENY_HIGH_RISK", False)
    return ("ALLOW", True)


def cache_key(tenant, model, msgs, ph="", dc=""):
    norm = json.dumps([(m["role"], m["content"].strip().lower()) for m in msgs], ensure_ascii=False)
    return hashlib.sha256((f"{tenant}|{ph}|{dc}|{model}|" + norm).encode()).hexdigest()


def main():
    # escalate_to_tier (거버넌스 강등 방어)
    ck("haiku(economy)→standard = sonnet", pricing.escalate_to_tier("claude-haiku-4-5", "standard") == "claude-sonnet-4-6")
    ck("gpt-5-nano→standard = gpt-5-mini", pricing.escalate_to_tier("gpt-5-nano", "standard") == "gpt-5-mini")
    ck("gpt-5-nano→premium = gpt-5", pricing.escalate_to_tier("gpt-5-nano", "premium") == "gpt-5")
    ck("sonnet(standard)→standard 유지", pricing.escalate_to_tier("claude-sonnet-4-6", "standard") == "claude-sonnet-4-6")
    ck("opus(premium)→standard 유지", pricing.escalate_to_tier("claude-opus-4-8", "standard") == "claude-opus-4-8")
    ck("티어순위 economy<standard<premium", pricing.TIER_RANK["economy"] < pricing.TIER_RANK["standard"] < pricing.TIER_RANK["premium"])
    ck("GPT-5 현행화(gpt-4o-mini 티어 미등록)", "gpt-4o-mini" not in pricing.MODEL_TIER)

    # cache_policy_decision (Patent 3)
    ck("PII → 캐시 차단", cache_policy_decision("PII", 0.1) == ("DENY_SENSITIVE_DATA", False))
    ck("SECRET → 캐시 차단", cache_policy_decision("SECRET", 0.1)[1] is False)
    ck("고위험(0.8) → 캐시 차단", cache_policy_decision("INTERNAL", 0.8) == ("DENY_HIGH_RISK", False))
    ck("일반(저위험) → 캐시 허용", cache_policy_decision("INTERNAL", 0.2) == ("ALLOW", True))
    ck("거버넌스 OFF → 차단 안함", cache_policy_decision("PII", 0.9, enabled=False)[1] is True)

    # 거버넌스 인지형 캐시 키
    m = [{"role": "user", "content": "같은질문"}]
    ck("정책해시 다르면 캐시키 다름(무효화)", cache_key("t", "m", m, "polA") != cache_key("t", "m", m, "polB"))
    ck("정책해시 같으면 캐시키 동일(히트)", cache_key("t", "m", m, "polA") == cache_key("t", "m", m, "polA"))
    ck("테넌트 다르면 캐시키 다름(격리)", cache_key("t1", "m", m) != cache_key("t2", "m", m))
    ck("데이터등급 다르면 캐시키 다름", cache_key("t", "m", m, "p", "PII") != cache_key("t", "m", m, "p", "INTERNAL"))

    print(f"\n거버넌스 단위테스트: PASS {PASS} / FAIL {FAIL}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
