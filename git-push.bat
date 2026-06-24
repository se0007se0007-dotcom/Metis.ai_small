@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   Metis.AI  -  Git Commit ^& Push
echo ============================================

REM ── 새 GitHub 레포(위치 변경 반영) ───────────────────────────────
set "REPO_URL=https://github.com/se0007se0007-dotcom/Metis.ai_small.git"

REM [init] 아직 git 저장소가 아니면 초기화하고 main 브랜치로 맞춤
if not exist "%~dp0.git" (
  echo [init] git 저장소가 없어 초기화합니다...
  git init
  git branch -M main
)

REM [remote] origin 을 항상 새 레포 주소로 보정(없으면 추가, 있으면 교체)
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin "%REPO_URL%"
) else (
  git remote set-url origin "%REPO_URL%"
)
echo [remote] origin = %REPO_URL%

REM 커밋 메시지: 인자로 받으면 그대로, 없으면 날짜/시간 자동
set "MSG=%*"
if "%MSG%"=="" set "MSG=chore: 업데이트 %date% %time%"

echo.
echo [0/3] 루트 README 확인...
if not exist "%~dp0README.md" (
  echo      [경고] 루트에 README.md 가 없습니다.
  echo             GitHub 첫 화면에는 루트 README.md 만 표시됩니다.
  echo             README.md 를 먼저 만든 뒤 다시 실행하세요.
)

echo [1/3] 변경 사항 스테이징...
git add -A

REM [보안] .env 가 추적되면 즉시 중단 — 실제 API 키 유출 방지
git ls-files --error-unmatch ".env" >nul 2>&1
if not errorlevel 1 (
  echo [중단] .env 가 git 에 추적되고 있습니다! 키 유출 위험.
  echo        git rm --cached .env  실행 후 다시 푸시하세요.
  pause
  exit /b 1
)
git ls-files --error-unmatch "finops-platform/.env" >nul 2>&1
if not errorlevel 1 (
  echo [중단] finops-platform/.env 가 추적되고 있습니다! 키 유출 위험.
  echo        git rm --cached finops-platform/.env  실행 후 다시 푸시하세요.
  pause
  exit /b 1
)

REM 스테이징된 변경이 없으면 커밋 건너뜀
git diff --cached --quiet
if not errorlevel 1 (
  echo      변경 사항이 없습니다. 커밋 건너뜀.
  goto :push
)

echo [2/3] 커밋: %MSG%
git commit -m "%MSG%"
if errorlevel 1 (
  echo [오류] 커밋 실패
  pause
  exit /b 1
)

:push
REM 현재 브랜치를 자동 감지해서 그 브랜치를 push (예전엔 main 고정이라
REM 다른 브랜치에서 작업 시 push 해도 GitHub에 반영 안 되는 문제가 있었음)
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BR=%%b"

if /i not "%BR%"=="main" (
  echo.
  echo      [주의] 현재 브랜치는 "%BR%" 입니다. (GitHub 기본 화면은 main)
  echo             이 브랜치를 그대로 push 하면 GitHub 첫 화면(main)에는
  echo             바로 안 보일 수 있습니다.
  echo.
)

echo [3/3] origin/%BR% 으로 push...
git push -u origin %BR%
if errorlevel 1 (
  echo.
  echo [오류] push 실패 - GitHub 인증/네트워크를 확인하세요.
  pause
  exit /b 1
)

echo.
echo  완료! GitHub(origin/%BR%)에 반영되었습니다.
pause
