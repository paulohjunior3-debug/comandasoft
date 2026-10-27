@echo off
rem Liga o endereco proprio do sistema com certificado confiavel (Let's Encrypt + Cloudflare). Pede permissao de administrador.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dominio.ps1"
echo.
pause
