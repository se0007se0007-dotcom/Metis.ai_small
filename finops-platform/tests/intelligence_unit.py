"""지능 계층(metis-ai 이식) 순수 로직 단위테스트.

DB/서비스 없이 통계 함수·복잡도 라우팅·임베딩 유사도·모델ID 정규화·시크릿 redaction 검증.
사용법: python tests/intelligence_unit.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "services", "control_plane"))
sys.path.insert(0, os.path.join(ROOT, "services", "gateway"))
os.environ.setdefault("METIS_DB", "/tmp/metis_unit/metis.db")

import embeddings as E  # noqa: E402
import intelligence as I  # noqa: E402
import pricing  # noqa: E402

PASS = FAIL = 0


def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


def main():
    # ---- z-score 드리프트 ----
    ck("품질 하락 드리프트 감지", I.zscore_drift([0.9] * 12, [0.5, 0.52, 0.48]) is not None)
    ck("무변화는 미감지", I.zscore_drift([0.9] * 12, [0.9, 0.89, 0.91]) is None)
    ck("샘플 부족 시 None", I.zscore_drift([0.9, 0.8], [0.5]) is None)
    d = I.zscore_drift([0.9] * 12, [0.5, 0.5])
    ck("드리프트 z 부호(하락=음수)", d and d["z"] < 0)

    # ---- IQR 스파이크 ----
    ub = I.iqr_bounds([1000, 1100, 950, 1050, 980, 1020, 990, 1010])
    ck("IQR 상한 계산", ub is not None and ub < 50000)
    ck("스파이크 판정 (50k > 상한)", 50000 > ub)
    ck("정상값 비스파이크 (1030 < 상한)", 1030 < ub)
    ck("데이터 부족 시 None", I.iqr_bounds([1, 2]) is None)

    # ---- 선형회귀 추세 ----
    ck("상승 추세 기울기=1", abs(I.linreg_slope([1, 2, 3, 4, 5]) - 1.0) < 1e-9)
    ck("무추세 기울기≈0", abs(I.linreg_slope([5, 5, 5, 5])) < 1e-9)
    ck("하락 추세 음수", I.linreg_slope([10, 8, 6, 4]) < 0)

    # ---- 에러 서지 ----
    ck("서지 감지 (5%→30%)", I.error_surge(0.05, 0.30))
    ck("비서지 (5%→10%)", not I.error_surge(0.05, 0.10))

    # ---- 복잡도 라우팅 (metis-ai Model Router) ----
    simple = [{"role": "user", "content": "포인트 소멸 기한 알려줘 요약"}]
    complex_ = [{"role": "user", "content": "마이크로서비스 아키텍처 심층 분석 후 설계 최적화 전략 " + "데이터 " * 600}]
    code = [{"role": "user", "content": "```python\ndef f(x):\n    return x\n``` 이 코드 분석"}]
    ck("단순 프롬프트 복잡도 ≤0.3", E.complexity_score(simple) <= 0.3, str(E.complexity_score(simple)))
    ck("복잡 프롬프트 복잡도 >0.7", E.complexity_score(complex_) > 0.7, str(E.complexity_score(complex_)))
    ck("코드 포함 시 가산", E.complexity_score(code) > E.complexity_score(simple))
    ck("tools 포함 시 가산", E.complexity_score(simple, has_tools=True) > E.complexity_score(simple))
    ck("범위 0..1 클램프", 0 <= E.complexity_score(complex_, True) <= 1)

    # ---- 임베딩 유사도 (mock bag-of-words) ----
    a = E._mock_embed("환불 규정 정책 문서 전체 요약 알려줘")
    b = E._mock_embed("환불 규정 정책 문서 전체 요약 알려줘요")
    c = E._mock_embed("오늘 점심 메뉴 추천")
    ck("유사 문장 cosine > 0.7", E.cosine(a, b) > 0.7, f"{E.cosine(a, b):.3f}")
    ck("상이 문장 cosine < 0.3", E.cosine(a, c) < 0.3, f"{E.cosine(a, c):.3f}")
    ck("동일 문장 cosine = 1", abs(E.cosine(a, a) - 1.0) < 1e-9)
    ck("빈 벡터 cosine = 0", E.cosine([], a) == 0.0)

    # ---- 시크릿 redaction (임베딩 외부 전송 보호) ----
    ck("OpenAI 키 redact", "sk-" not in E.redact_secrets("내 키는 sk-proj-abcdef1234567890 입니다"))
    ck("Bearer 토큰 redact", "Bearer abc" not in E.redact_secrets("Authorization: Bearer abcdefgh12345678"))
    ck("일반 텍스트 보존", E.redact_secrets("환불 규정 요약") == "환불 규정 요약")

    # ---- 모델 ID 정규화 (metis-ai normalize) ----
    ck("점 버전 → 대시", pricing.normalize_model_id("claude-opus-4.6") == "claude-opus-4-6")
    ck("날짜 서픽스 제거", pricing.normalize_model_id("claude-haiku-4-5-20251001") == "claude-haiku-4-5")
    ck("정상 ID 보존", pricing.normalize_model_id("gpt-5-mini") == "gpt-5-mini")

    # ---- 런타임 단가 오버레이 ----
    base = pricing.price_of("qwen3-72b-local")
    pricing.load_runtime([{"model": "qwen3-72b-local", "input_usd": 9.9, "output_usd": 9.9,
                           "cache_read_usd": 0, "cache_write_usd": 0, "tier": "self-host",
                           "downgrade_to": None, "active": 1}])
    ck("런타임 단가 오버라이드", pricing.price_of("qwen3-72b-local")[0] == 9.9)
    ck("미등록 모델은 정적 단가", pricing.price_of("gpt-5")[0] == 1.25)
    pricing.load_runtime([{"model": "claude-sonnet-4-6", "input_usd": 3, "output_usd": 15,
                           "cache_read_usd": 0.3, "cache_write_usd": 3.75, "tier": "standard",
                           "downgrade_to": "gpt-5-nano", "active": 1}])
    ck("런타임 강등맵 오버라이드", pricing.downgrade_of("claude-sonnet-4-6") == "gpt-5-nano")
    pricing.load_runtime([])
    ck("오버레이 해제 시 기본 복귀", pricing.downgrade_of("claude-sonnet-4-6") == "claude-haiku-4-5")

    print(f"\n지능 계층 단위테스트: PASS {PASS} / FAIL {FAIL}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
