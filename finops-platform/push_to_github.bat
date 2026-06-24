@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo ============================================
echo  Metis FinOps - GitHub push
echo ============================================

set "DEFAULT_REMOTE=https://github.com/se0007se0007-dotcom/finops.git"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git not found. Install from https://git-scm.com/download/win
  pause & exit /b 1
)

rem ---- init (no parentheses blocks for set /p - batch expansion pitfall) ----
if exist ".git" goto :has_repo
echo [INIT] initializing git repository...
git init
git branch -M main
:has_repo

rem ---- verify/repair origin remote ----
set "CUR_URL="
for /f "delims=" %%u in ('git remote get-url origin 2^>nul') do set "CUR_URL=%%u"
if not "%CUR_URL%"=="" goto :remote_ok
git remote remove origin >nul 2>nul
set "REMOTE_URL="
set /p REMOTE_URL="GitHub repo URL [Enter = %DEFAULT_REMOTE%]: "
if "%REMOTE_URL%"=="" set "REMOTE_URL=%DEFAULT_REMOTE%"
git remote add origin %REMOTE_URL%
for /f "delims=" %%u in ('git remote get-url origin 2^>nul') do set "CUR_URL=%%u"
:remote_ok
echo [REMOTE] origin = %CUR_URL%

rem ---- safety: never push secrets ----
findstr /c:".env" .gitignore >nul 2>nul
if errorlevel 1 (
  echo [ERROR] .gitignore does not exclude .env - aborting for safety.
  pause & exit /b 1
)
git rm --cached .env >nul 2>nul
git rm --cached --ignore-unmatch ".env" >nul 2>nul

rem ---- secret scan: abort if a real API key pattern is staged ----
rem Patterns match real key shapes only (prefix + long alphanumeric run),
rem so doc snippets like "sk-ant-..." in SECURITY.md do not false-positive.
set "PAT_ANT=sk-ant-api[0-9][0-9]-[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]"
set "PAT_PROJ=sk-proj-[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]"
set "PAT_SK=sk-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]"
git add -A
git diff --cached --name-only > "%TEMP%\metis_staged.txt"
set "LEAK="
for /f "usebackq delims=" %%F in ("%TEMP%\metis_staged.txt") do (
  if /i not "%%F"=="push_to_github.bat" if exist "%%F" (
    findstr /r /c:"%PAT_ANT%" /c:"%PAT_PROJ%" /c:"%PAT_SK%" "%%F" >nul 2>nul
    if not errorlevel 1 set "LEAK=%%F"
  )
)
del "%TEMP%\metis_staged.txt" >nul 2>nul
if defined LEAK (
  echo.
  echo [ERROR] A possible API key was found in a staged file: %LEAK%
  echo         Push ABORTED to prevent secret leakage.
  echo         Remove the secret or add the file to .gitignore, then retry.
  pause & exit /b 1
)

rem ---- commit message (arg or timestamp) ----
set "MSG=%~1"
if "%MSG%"=="" set "MSG=update %date% %time:~0,8%"

echo.
echo [1/3] git add -A
git add -A
echo [2/3] git commit -m "%MSG%"
git commit -m "%MSG%"
if errorlevel 1 echo   (no changes to commit - pushing anyway)
echo [3/3] git push
git push -u origin main
if not errorlevel 1 goto :pushed

echo.
echo [RETRY] push rejected - remote may already have commits (e.g. README).
echo         Trying: git pull --rebase origin main ...
git pull --rebase origin main
git push -u origin main
if not errorlevel 1 goto :pushed

echo.
echo [ERROR] push still failed. Most common causes:
echo   1) Login: a GitHub sign-in window should appear on first push.
echo      If not, run:  git config --global credential.helper manager
echo      or use a PAT: https://github.com/settings/tokens (repo scope),
echo      then push again and enter the token as password.
echo   2) Repository does not exist or no write permission: %CUR_URL%
echo   3) Corporate proxy: set HTTPS_PROXY environment variable.
echo.
echo   Manual push command:  git push -u origin main
pause & exit /b 1

:pushed
echo.
echo Done. Pushed to %CUR_URL% (branch main^)
pause
