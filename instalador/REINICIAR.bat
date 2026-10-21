@echo off
rem Reinicia o Sistema Bar se ele travar, sem perder o que ja foi lancado. Pede permissao de administrador.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reiniciar.ps1"
echo.
pause
