@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo ============================================
echo  Metis FinOps prototype launcher
echo ============================================

rem ---- find python (py launcher first, then python) ----
set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo [ERROR] Python not found.
  echo         Install Python 3.10+ from https://www.python.org/downloads/
  echo         IMPORTANT: check "Add python.exe to PATH" during install.
  pause
  exit /b 1
)

rem ---- verify it is a real python 3.10+ (not the MS Store stub) ----
%PY% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Working Python 3.10+ not found.
  echo         If you have not installed Python yet, the "python" command on
  echo         Windows may be a Microsoft Store stub that does nothing.
  echo         Install from https://www.python.org/downloads/ and re-run.
  pause
  exit /b 1
)

rem ---- create venv ----
if not exist ".venv\Scripts\python.exe" (
  echo [1/4] Creating virtual environment...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo [ERROR] venv creation failed.
    pause
    exit /b 1
  )
)
echo [2/4] Installing dependencies...
.venv\Scripts\python.exe -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo [ERROR] pip install failed. Check your network/proxy and retry.
  pause
  exit /b 1
)

echo [3/4] Starting services (3 console windows will open)...
rem "start" inherits the current directory, so relative paths are safe here.
start "Metis Control Plane :8500" cmd /k .venv\Scripts\python.exe services\control_plane\app.py
timeout /t 5 /nobreak >nul
start "Metis Gateway :8400" cmd /k .venv\Scripts\python.exe services\gateway\app.py
timeout /t 3 /nobreak >nul
start "Metis Simulator" cmd /k .venv\Scripts\python.exe services\simulator\sim.py
timeout /t 2 /nobreak >nul
start "Metis Test Agent :8600" cmd /k .venv\Scripts\python.exe services\test_agent\app.py

echo [4/4] Opening dashboard...
timeout /t 3 /nobreak >nul
start http://localhost:8500

echo.
echo Done. Dashboard: http://localhost:8500
echo   (Test agent is inside the dashboard - left menu, bottom item)
echo To stop: close the 4 console windows (or run stop.bat).
pause
