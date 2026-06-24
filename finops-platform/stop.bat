@echo off
rem Stop Metis FinOps prototype services by window title
taskkill /fi "WINDOWTITLE eq Metis Control Plane*" /t /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq Metis Gateway*" /t /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq Metis Simulator*" /t /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq Metis Test Agent*" /t /f >nul 2>nul
echo Stopped.
pause
