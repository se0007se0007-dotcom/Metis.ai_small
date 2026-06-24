@echo off
REM headroom 압축 프록시 — METIS LLM 호출 앞단에 둔다 (PoC).
REM 사전: pip install "headroom-ai[proxy,ml]"
REM 사용: 이 창을 띄워두고, 별도 창에서 .env에 ANTHROPIC_BASE_URL/OPENAI_BASE_URL=http://localhost:8787 설정 후 API 기동.
echo [headroom] proxy starting on http://localhost:8787 (Ctrl+C to stop)
headroom proxy --port 8787 --intercept-tool-results
