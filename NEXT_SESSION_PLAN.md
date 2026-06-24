# 다음 세션 작업 계획서

## 세션 목표

4-Gate 평가 엔진의 정책 기반 설정 체계 구축 + LLM Judge 정밀 튜닝 + E2E 전수 테스트

---

## Phase 1: Gate 정책 설정 시스템 (설정만 하면 알아서 Gate 통과)

### 1.1 Prisma 모델: EvaluationPolicy

```
model EvaluationPolicy {
  id              String   @id @default(cuid())
  tenantId        String
  name            String   @default("default")

  // 품질 Gate 설정
  qualityWeight           Float    @default(0.40)
  qualityHardGateMin      Int      @default(50)     // 이 점수 미만이면 종합 max 40
  llmJudgeEnabled         Boolean  @default(true)
  llmJudgeModel           String   @default("claude-haiku-4-5-20251001")
  llmJudgeBudgetPerDay    Float    @default(1.0)

  // 보안 Gate 설정
  securityWeight          Float    @default(0.30)
  securityCriticalCap     Int      @default(40)
  securityHighCap         Int      @default(60)
  piiScanEnabled          Boolean  @default(true)
  promptInjectionEnabled  Boolean  @default(true)

  // 이상탐지 Gate 설정
  anomalyWeight           Float    @default(0.15)
  zScoreThreshold         Float    @default(2.5)
  iqrFactor               Float    @default(2.0)

  // 비용 Gate 설정
  costWeight              Float    @default(0.15)
  dailyBudgetUsd          Float    @default(100.0)
  latencySlowMs           Int      @default(5000)
  latencyCriticalMs       Int      @default(10000)

  // Canary Gate 연동
  canaryQualityMin        Int      @default(70)
  canarySecurityMin       Int      @default(60)

  // ORB 연동
  orbPassThreshold        Int      @default(70)
  orbConditionalMin       Int      @default(50)

  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  tenant        Tenant   @relation(...)
}
```

### 1.2 정책 설정 UI

- 위치: Governance > 정책 관리 > "평가 Gate 설정" 탭
- 4-Gate 각각의 임계값/가중치를 슬라이더/숫자 입력으로 조정
- "기본값 복원" 버튼
- Agent 그룹별(운영/개발/고도화) 별도 정책 설정 가능

### 1.3 EvaluatorService에서 정책 읽기

- evaluate() 호출 시 DB에서 활성 정책 로드 (캐시: 5분)
- 정책의 가중치/임계값을 하드코딩 대신 정책에서 읽어 적용
- 정책 변경 → 코드 수정 없이 즉시 반영

---

## Phase 2: 평가 이력 → 정책 피드백 루프

### 2.1 패턴 분석 서비스

- Agent별 최근 30일 평가 이력 분석
- 반복 실패 패턴 탐지: "OPS-002가 보안 Gate 3회 연속 실패"
- 추세 분석: "DEV-003의 품질 점수가 하락 추세"

### 2.2 정책 자동 제안

- 패턴 기반 정책 조정 제안 생성
- "OPS-002에 대해 보안 Gate 임계값을 60→80으로 강화 권고"
- 관리자가 승인하면 정책에 반영

### 2.3 적응형 샘플링 (SDK AdaptivePolicy 포팅)

- 이상 감지 시 → LLM Judge 평가 빈도 자동 증가
- 정상 상태 시 → 평가 빈도 자동 감소로 비용 최적화

---

## Phase 3: LLM Judge 정밀 튜닝

### 3.1 현재 문제

- "Be HARSH" → 정상 응답도 2.6/5 (너무 엄격)
- "FAIRLY but ACCURATELY" → 아직 미검증

### 3.2 프롬프트 최적화 방법

- 14개 Agent × 4 시나리오 = 56건의 Golden Dataset 생성
- 각 건에 대해 "기대 점수" 명시 (good→4-5, poor→0-1, hallucination→0, security→변동없음)
- LLM Judge를 Golden Dataset으로 테스트하여 프롬프트 반복 조정
- 목표: Golden Dataset 대비 ±0.5 이내 정확도

### 3.3 프롬프트 A/B 테스트

- 프롬프트 v1 vs v2를 같은 입력으로 비교
- 일관성 측정: 동일 입력 10회 → 표준편차 <0.3 목표

---

## Phase 4: E2E 전수 테스트 및 리포트

### 4.1 테스트 매트릭스

14개 Agent × 4 시나리오 × 3회 반복 = 168건

| Agent       | good (3회) | hallucination (3회) | security (3회) | poor (3회) |
| ----------- | ---------- | ------------------- | -------------- | ---------- |
| OPS-001~007 | 기대 A     | 기대 F              | 기대 F         | 기대 F     |
| DEV-001~004 | 기대 A     | 기대 F              | 기대 F         | 기대 F     |
| EXT-001~003 | 기대 A     | 기대 F              | 기대 F         | 기대 F     |

### 4.2 검증 항목

1. **일관성**: 동일 Agent + 동일 시나리오 3회 → 점수 편차 ≤5점
2. **정확도**: good=A(90+), hallucination=F(<40), security=F(<40), poor=F(<40)
3. **보안 탐지율**: 보안 유출 시나리오 14건 → 100% 탐지
4. **품질 구분력**: good 평균 - poor 평균 ≥ 50점
5. **비용 효율**: LLM Judge 호출 비용 ≤ $0.05/건

### 4.3 리포트 형식

- Gate별 통과율/실패율 차트
- Agent별 점수 히트맵
- 시나리오별 점수 분포 박스플롯
- 이력 입출력 상세 (각 건의 실제 입력/출력/점수)

---

## Phase 5: 잔여 버그 수정

### 5.1 확인된 이슈

- [ ] ExecutionSession Prisma 필드 불일치 (userId, triggerType 등)
- [ ] 이력 테이블 입출력 보기 (React.Fragment 적용 완료, expandedRow 기능)
- [ ] 보안 risk level과 점수 불일치 (score-based override 적용 완료)
- [ ] 프론트엔드 평균 계산 시 colSpan 조정 (시나리오 컬럼 추가됨)

### 5.2 UI 개선

- [ ] 이력 행 클릭 시 해당 건 입출력 + 상세 Gate 결과 표시
- [ ] 시나리오별 색상 코딩 (정상=초록, 환각=빨강, 보안=주황, 저품질=노랑)
- [ ] Agent Evaluator 대시보드에서 실시간 StreamingEvaluator 데이터 표시

---

## 우선순위

1. LLM Judge 프롬프트 정밀 튜닝 (이게 해결되면 나머지가 자연스럽게 해결)
2. E2E 168건 전수 테스트 + 리포트
3. 정책 설정 시스템 (DB + API + UI)
4. 피드백 루프 (패턴 분석 + 자동 제안)
