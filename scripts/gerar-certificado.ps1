# Gera o certificado HTTPS de desenvolvimento com mkcert (SPEC 3.1, opcao B).
# Pre-requisito: winget install FiloSottile.mkcert
# Uso (na raiz do projeto): powershell -ExecutionPolicy Bypass -File scripts\gerar-certificado.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$certs = Join-Path $root 'certs'

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
  Write-Host 'mkcert nao encontrado. Instale com: winget install FiloSottile.mkcert' -ForegroundColor Red
  Write-Host 'Depois feche e abra o terminal e rode este script de novo.'
  exit 1
}

# IPs IPv4 da rede local (ignora loopback e APIPA)
$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress

$hostname = $env:COMPUTERNAME.ToLower()
$names = @('localhost', '127.0.0.1', $hostname) + $ips

Write-Host 'Instalando a CA local do mkcert neste PC (pode pedir confirmacao)...'
mkcert -install

New-Item -ItemType Directory -Force $certs | Out-Null
mkcert -cert-file (Join-Path $certs 'dev-cert.pem') -key-file (Join-Path $certs 'dev-key.pem') @names

$caRoot = (mkcert -CAROOT).Trim()
Copy-Item (Join-Path $caRoot 'rootCA.pem') (Join-Path $certs 'rootCA.crt') -Force

Write-Host ''
Write-Host 'Certificado gerado em certs\ para:' -ForegroundColor Green
$names | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host 'Para os celulares confiarem no certificado, instale certs\rootCA.crt em cada aparelho:'
Write-Host '  Android: Configuracoes > Seguranca > Criptografia e credenciais > Instalar certificado > Certificado de CA'
Write-Host '  iPhone:  envie o arquivo (AirDrop/e-mail), instale o perfil em Ajustes e depois ative em'
Write-Host '           Ajustes > Geral > Sobre > Ajustes de Confianca de Certificado'
Write-Host ''
Write-Host 'NUNCA compartilhe certs\rootCA-key.pem (fica na pasta do mkcert, nao neste projeto).'
