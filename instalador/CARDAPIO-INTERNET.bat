@echo off
rem Liga o cardapio do QR das mesas pela internet (4G do cliente), pelo tunel da Cloudflare. Pede permissao de administrador.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cardapio-internet.ps1"
echo.
pause
