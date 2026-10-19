# Funções e constantes compartilhadas pelos scripts de instalação, atualização e remoção.
# Compatível com o Windows PowerShell 5.1 que vem no Windows 10/11.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$TarefaServidor = 'Sistema Bar - Servidor'
$TarefaBackup = 'Sistema Bar - Backup diario'
$RegraFirewall = 'Sistema Bar - Servidor'

function Passo([string]$texto) {
  Write-Host ''
  Write-Host "==> $texto" -ForegroundColor Cyan
}

function Ok([string]$texto) { Write-Host "    OK: $texto" -ForegroundColor Green }
function Aviso([string]$texto) { Write-Host "    ATENÇÃO: $texto" -ForegroundColor Yellow }

function Falhar([string]$texto) {
  Write-Host ''
  Write-Host "ERRO: $texto" -ForegroundColor Red
  Write-Host 'A instalação foi interrompida. Nada do que já estava funcionando foi apagado.'
  exit 1
}

function Exigir-Administrador {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Falhar 'Rode como administrador (use o arquivo .bat, que pede a permissão).'
  }
}

# Recarrega o PATH depois de instalar programas pelo winget, sem reabrir o terminal.
function Atualizar-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Winget-Instalar([string]$id, [string]$nome, [string[]]$extra = @()) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Falhar "winget não encontrado. Instale o 'Instalador de Aplicativo' pela Microsoft Store e rode de novo, ou instale $nome manualmente."
  }
  Write-Host "    Instalando $nome (pode levar alguns minutos)..."
  $parametros = @('install', '--id', $id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements') + $extra
  & winget @parametros | Out-Host
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
    # -1978335189 = já instalado
    Falhar "Não foi possível instalar $nome pelo winget (código $LASTEXITCODE). Verifique a internet."
  }
  Atualizar-Path
}

function Caminho-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $padrao = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path $padrao) { return $padrao }
  return $null
}

function Pasta-PostgreSQL {
  foreach ($v in @('17', '16')) {
    $p = "C:\Program Files\PostgreSQL\$v\bin"
    if (Test-Path (Join-Path $p 'psql.exe')) { return $p }
  }
  return $null
}

function IPs-Rede-Local {
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress
}

function Ler-Env([string]$arquivo) {
  $valores = @{}
  if (Test-Path $arquivo) {
    foreach ($linha in Get-Content $arquivo -Encoding UTF8) {
      if ($linha -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $valores[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $valores
}

function Segredo([int]$bytes = 48) {
  $buf = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return ([Convert]::ToBase64String($buf)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

# Espera o servidor responder em /api/health (curl.exe vem no Windows 10/11).
function Aguardar-Servidor([int]$porta, [int]$segundos = 90) {
  $limite = (Get-Date).AddSeconds($segundos)
  while ((Get-Date) -lt $limite) {
    $resposta = & curl.exe -sk --max-time 3 "https://localhost:$porta/api/health" 2>$null
    if ($resposta -match '"status":"ok"') { return $true }
    $resposta = & curl.exe -s --max-time 3 "http://localhost:$porta/api/health" 2>$null
    if ($resposta -match '"status":"ok"') { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Parar-Servidor([string]$destino) {
  if (Get-ScheduledTask -TaskName $TarefaServidor -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TarefaServidor -ErrorAction SilentlyContinue
  }
  # Garante que o node desta instalação parou (a tarefa pode ter deixado o processo vivo).
  $alvo = (Join-Path $destino 'app\server.mjs').ToLower()
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($alvo) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# Copia os arquivos do pacote para a pasta de instalação, sem tocar em .env, certs e data.
function Copiar-Pacote([string]$origem, [string]$destino) {
  New-Item -ItemType Directory -Force -Path $destino | Out-Null
  foreach ($pasta in @('app', 'apps', 'cardapios')) {
    $alvo = Join-Path $destino $pasta
    if (Test-Path $alvo) { Remove-Item -Recurse -Force $alvo }
    Copy-Item -Recurse -Force (Join-Path $origem $pasta) $alvo
  }
  Get-ChildItem -Path $origem -File | Where-Object { $_.Name -ne '.env' } | ForEach-Object {
    Copy-Item -Force $_.FullName (Join-Path $destino $_.Name)
  }
}
