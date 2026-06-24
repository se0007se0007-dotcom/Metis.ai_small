"""Metis FinOps 비용 원장 (Cost Ledger) — SQLite.

귀속 차원: tenant -> project -> agent -> version -> run -> step(call)
토큰 5종(input/output/cache_read/cache_write/reasoning) 분리 계측.
"""
import os
import sqlite3
import threading
import time

import pricing

DB_PATH = os.environ.get("METIS_DB", os.path.join(os.path.dirname(__file__), "data", "metis.db"))
ALERT_WEBHOOK = os.environ.get("METIS_ALERT_WEBHOOK", "").strip()  # Slack 호환 {"text": ...}
_lock = threading.RLock()
_conn = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    tenant TEXT, project TEXT, agent TEXT, agent_version TEXT, env TEXT DEFAULT 'prd',
    run_id TEXT, step INTEGER DEFAULT 0, task_type TEXT,
    provider TEXT, model TEXT, requested_model TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0, counterfactual_usd REAL DEFAULT 0,
    savings_usd REAL DEFAULT 0, savings_kind TEXT,
    latency_ms REAL DEFAULT 0, status TEXT DEFAULT 'ok',
    routing_action TEXT DEFAULT 'none', cache_hit INTEGER DEFAULT 0,
    -- 거버넌스 융합 (Patent 3): 데이터 등급 / 리스크 / 캐시 정책 판정 / 거버넌스 라우팅
    data_class TEXT DEFAULT 'INTERNAL', risk_score REAL DEFAULT 0,
    cache_decision TEXT DEFAULT 'ALLOW', gov_action TEXT DEFAULT 'none'
);
CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
CREATE INDEX IF NOT EXISTS idx_calls_run ON calls(run_id);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    tenant TEXT, project TEXT, agent TEXT, agent_version TEXT,
    started REAL, ended REAL,
    status TEXT DEFAULT 'running',          -- running | success | failure | killed
    kill_reason TEXT,
    total_cost REAL DEFAULT 0, total_tokens INTEGER DEFAULT 0,
    steps INTEGER DEFAULT 0,
    last_sig TEXT, sig_repeat INTEGER DEFAULT 0,
    quality_score REAL, quality_passed INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started);

CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,               -- tenant | agent
    scope_id TEXT NOT NULL,
    period TEXT DEFAULT 'daily',            -- daily | monthly
    soft_limit REAL, downgrade_limit REAL, hard_limit REAL,
    soft_alerted REAL DEFAULT 0,
    UNIQUE(scope_type, scope_id, period)
);

CREATE TABLE IF NOT EXISTS run_policies (
    agent TEXT PRIMARY KEY,
    max_cost_per_run REAL DEFAULT 0.50,
    max_steps INTEGER DEFAULT 30,
    loop_threshold INTEGER DEFAULT 4,
    downgrade_ratio REAL DEFAULT 0.7        -- run 예산의 70% 도달 시 강등
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, severity TEXT, kind TEXT, scope TEXT, message TEXT
);

CREATE TABLE IF NOT EXISTS config_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, agent TEXT, description TEXT
);

CREATE TABLE IF NOT EXISTS agents (
    agent TEXT PRIMARY KEY,
    description TEXT DEFAULT '',
    semantic_cache INTEGER DEFAULT 0,        -- 중앙 정책: 1=적용 (opt-in, 안전 기본값 0)
    cache_ttl INTEGER DEFAULT 300,
    downgrade_enabled INTEGER DEFAULT 1,
    gate_min_quality REAL DEFAULT 0.80,      -- 강등 대상 모델의 최소 평균 품질
    gate_min_samples INTEGER DEFAULT 10,     -- 게이트 판정에 필요한 최소 run 수
    canary_ratio REAL DEFAULT 0.10,          -- 데이터 부족 시 카나리 비율
    tool_registry_tokens INTEGER DEFAULT 0,  -- 이 에이전트의 전체 툴 스키마 토큰(스킬패커 기준값)
    complexity_routing INTEGER DEFAULT 0     -- 1=프롬프트 복잡도 기반 경제모델 라우팅 (게이트 적용)
);

CREATE TABLE IF NOT EXISTS governance_policy (
    id INTEGER PRIMARY KEY CHECK (id=1),
    sensitive_classes TEXT DEFAULT 'PII,SECRET,CUSTOMER_CONFIDENTIAL',  -- 캐시 재사용 금지 등급
    high_risk_threshold REAL DEFAULT 0.7,      -- 이 이상이면 캐시 차단
    escalate_risk_threshold REAL DEFAULT 0.8,  -- 이 이상이면 강등 방어(safe tier로 상향)
    safe_min_tier TEXT DEFAULT 'standard',     -- 고위험 요청의 최소 보장 티어
    enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS gpu_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, node TEXT, gpu_util REAL, mem_util REAL, kv_cache_util REAL,
    queue_depth INTEGER, cost_per_hour REAL
);
CREATE INDEX IF NOT EXISTS idx_gpu_ts ON gpu_metrics(ts);

-- 모델 단가 런타임 마스터 (metis-ai ModelPrice 이식) — API 로 수정, pricing 오버레이로 적용
CREATE TABLE IF NOT EXISTS model_prices (
    model TEXT PRIMARY KEY,
    input_usd REAL, output_usd REAL, cache_read_usd REAL DEFAULT 0, cache_write_usd REAL DEFAULT 0,
    tier TEXT DEFAULT 'standard',
    downgrade_to TEXT,
    active INTEGER DEFAULT 1,
    updated REAL
);

-- 자동 권고 (metis-ai PolicySuggestion/recommendations 이식)
CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, agent TEXT, kind TEXT, title TEXT, body TEXT,
    action TEXT,                              -- JSON: 적용 시 실행할 정책 변경 (없으면 수동)
    est_saving_usd REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',            -- pending | applied | dismissed
    applied_ts REAL
);
"""

SEED_BUDGETS = [
    ("tenant", "CRM사업팀", "daily", 6.0, 10.0, 60.0),
    ("tenant", "AI혁신지원센터", "daily", 5.0, 9.0, 50.0),
    ("tenant", "kt", "daily", 4.0, 8.0, 40.0),
    ("tenant", "ICT AX사업팀", "daily", 4.0, 8.0, 40.0),
    ("tenant", "오픈채널서비스팀", "daily", 3.0, 6.0, 30.0),
    ("agent", "code-review-agent", "daily", 3.0, 5.0, 20.0),
]

OLD_TENANTS = ("금융사업부", "공공사업부", "사내운영", "R&D")  # 구버전 시드 정리용

SEED_POLICIES = [
    # agent, max_cost_per_run, max_steps, loop_threshold, downgrade_ratio
    ("cs-relay-bot", 0.05, 6, 4, 0.7),
    ("report-writer", 0.40, 12, 4, 0.7),
    ("code-review-agent", 0.80, 20, 4, 0.7),
    ("ops-anomaly-agent", 0.05, 5, 4, 0.7),
    ("runaway-test-agent", 0.15, 10, 3, 0.6),
]

SEED_AGENTS = [
    # agent, description, semantic_cache, cache_ttl, downgrade_enabled,
    # gate_min_quality, gate_min_samples, canary_ratio, tool_registry_tokens, complexity_routing
    ("cs-relay-bot", "고객상담 — 반복 FAQ 비중 높음(캐시 적합)", 1, 300, 1, 0.80, 10, 0.10, 0, 0),
    ("report-writer", "보고서 생성 — 매번 다른 산출물(캐시 부적합)", 0, 300, 1, 0.82, 10, 0.10, 0, 0),
    ("code-review-agent", "코드리뷰 — 고유 diff(캐시 부적합), 툴 40여 개", 0, 300, 1, 0.80, 10, 0.10, 5500, 0),
    ("ops-anomaly-agent", "운영 이상감지 — 실시간성(캐시 부적합)", 0, 300, 1, 0.85, 10, 0.10, 0, 0),
    ("test-report-agent", "QA 자동화 — 고유 소스 분석(캐시 부적합), 분석 툴 12개", 0, 300, 1, 0.80, 10, 0.10, 1800, 0),
    ("runaway-test-agent", "폭주 시나리오 검증용", 0, 300, 1, 0.80, 10, 0.10, 0, 0),
]


# 기존 DB(구버전)에 신규 컬럼을 자동 추가하는 경량 마이그레이션.
# CREATE TABLE IF NOT EXISTS 는 기존 테이블을 변경하지 않으므로, 누락 컬럼을 ALTER 로 보강한다.
MIGRATIONS = {
    "calls": [
        ("data_class", "TEXT DEFAULT 'INTERNAL'"),
        ("risk_score", "REAL DEFAULT 0"),
        ("cache_decision", "TEXT DEFAULT 'ALLOW'"),
        ("gov_action", "TEXT DEFAULT 'none'"),
    ],
    "agents": [
        ("gate_min_quality", "REAL DEFAULT 0.80"),
        ("gate_min_samples", "INTEGER DEFAULT 10"),
        ("canary_ratio", "REAL DEFAULT 0.10"),
        ("tool_registry_tokens", "INTEGER DEFAULT 0"),
        ("complexity_routing", "INTEGER DEFAULT 0"),
    ],
}


def _migrate(conn: sqlite3.Connection) -> None:
    for table, cols in MIGRATIONS.items():
        try:
            existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        except sqlite3.OperationalError:
            continue
        for name, decl in cols:
            if name not in existing:
                try:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                except sqlite3.OperationalError:
                    pass
    conn.commit()


def get_conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.executescript("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            _conn.executescript(SCHEMA)
            _migrate(_conn)
            _conn.execute(
                f"DELETE FROM budgets WHERE scope_type='tenant' AND scope_id IN ({','.join('?'*len(OLD_TENANTS))})",
                OLD_TENANTS)
            for b in SEED_BUDGETS:
                _conn.execute(
                    "INSERT OR IGNORE INTO budgets(scope_type,scope_id,period,soft_limit,downgrade_limit,hard_limit) VALUES(?,?,?,?,?,?)", b)
            for p in SEED_POLICIES:
                _conn.execute(
                    "INSERT OR IGNORE INTO run_policies(agent,max_cost_per_run,max_steps,loop_threshold,downgrade_ratio) VALUES(?,?,?,?,?)", p)
            for a in SEED_AGENTS:
                _conn.execute(
                    """INSERT OR IGNORE INTO agents(agent,description,semantic_cache,cache_ttl,downgrade_enabled,
                       gate_min_quality,gate_min_samples,canary_ratio,tool_registry_tokens,complexity_routing)
                       VALUES(?,?,?,?,?,?,?,?,?,?)""", a)
            _conn.execute("INSERT OR IGNORE INTO governance_policy(id) VALUES(1)")
            # 모델 단가 시드: 정적 PRICES → model_prices (최초 1회, 이후 API 수정값 유지)
            now = time.time()
            for m, (pi, po, pcr, pcw) in pricing.PRICES.items():
                _conn.execute(
                    """INSERT OR IGNORE INTO model_prices(model,input_usd,output_usd,cache_read_usd,cache_write_usd,
                       tier,downgrade_to,active,updated) VALUES(?,?,?,?,?,?,?,1,?)""",
                    (m, pi, po, pcr, pcw, pricing.MODEL_TIER.get(m, "standard"),
                     pricing.DOWNGRADE_MAP.get(m), now))
            _conn.commit()
        return _conn


def q(sql, args=()):
    with _lock:
        cur = get_conn().execute(sql, args)
        rows = [dict(r) for r in cur.fetchall()]
        return rows


def ex(sql, args=()):
    with _lock:
        conn = get_conn()
        try:
            cur = conn.execute(sql, args)
        except sqlite3.OperationalError as e:
            # 스키마 누락(예: 구버전 DB) 시 자동 마이그레이션 후 1회 재시도 — 자가 치유
            if "no column named" in str(e) or "has no column" in str(e):
                _migrate(conn)
                cur = conn.execute(sql, args)
            else:
                raise
        conn.commit()
        return cur


def day_start(ts=None) -> float:
    t = time.localtime(ts or time.time())
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))


def month_start(ts=None) -> float:
    t = time.localtime(ts or time.time())
    return time.mktime((t.tm_year, t.tm_mon, 1, 0, 0, 0, 0, 0, -1))


def _post_webhook(severity: str, message: str) -> None:
    """Slack 호환 웹훅으로 알림 전송 (best-effort, 실패 무시)."""
    try:
        import httpx
        httpx.post(ALERT_WEBHOOK, json={"text": f"[Metis FinOps][{severity}] {message}"}, timeout=4.0)
    except Exception:
        pass


def add_alert(severity, kind, scope, message):
    ex("INSERT INTO alerts(ts,severity,kind,scope,message) VALUES(?,?,?,?,?)",
       (time.time(), severity, kind, scope, message))
    if ALERT_WEBHOOK:
        threading.Thread(target=_post_webhook, args=(severity, message), daemon=True).start()
