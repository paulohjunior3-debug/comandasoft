@echo off
rem Atualiza o Sistema Bar instalado em C:\SistemaBar com esta versao. Pede permissao de administrador.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0atualizar.ps1"
echo.
pause
