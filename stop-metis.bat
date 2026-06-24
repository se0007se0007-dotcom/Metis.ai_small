@echo off
chcp 65001 >nul 2>&1
title Metis.AI - Shutdown
color 0C

echo ============================================
echo    Metis.AI - Stopping All Services
echo ============================================
echo.

echo [1/2] Stopping server windows...
taskkill /FI "WINDOWTITLE eq Metis API*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Metis Worker*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Metis Frontend*" /F >nul 2>&1
echo    OK

echo [2/2] Stopping Docker containers...
docker compose -f infra/compose/docker-compose.yml down >nul 2>&1
echo    OK

echo.
echo ============================================
echo    All Metis.AI services stopped.
echo ============================================
pause
