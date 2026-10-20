# Funções e constantes compartilhadas pelos scripts de instalação, atualização e remoção.
# Compatível com o Windows PowerShell 5.1 que vem no Windows 10/11.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$TarefaServidor = 'Sistema Bar - Servidor'
$TarefaBackup = 'Sistema Bar - Backup diario'
$RegraFirewall = 'Sistema Bar - Servidor'
$RegraFirewallCliente = 'Sistema Bar - Cliente (QR)'
$PortaClientePadrao = 8080

function Passo([string]$texto) {
  Write-Host ''
  Write-Host "==> $texto" -ForegroundColor Cyan
}

function Ok([string]$texto) { Write-Host "    OK: $texto" -ForegroundColor Green }
function Aviso([string]$texto) { Write-Host "    ATENÇÃO: $texto" -ForegroundColor Yellow }

function Falhar([string]$texto) {
  try { Stop-Transcript | Out-Null } catch {}
  Write-Host ''
  Write-Host "ERRO: $texto" -ForegroundColor Red
  Write-Host 'A instalação foi interrompida. Nada do que já estava funcionando foi apagado.'
  if ($global:SistemaBarLog) { Write-Host "Registro da instalação: $global:SistemaBarLog" }
  exit 1
}

function Exigir-Administrador {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Falhar 'Rode como administrador (use o arquivo .bat, que pede a permissão).'
  }
}

# Roda um programa externo (psql, curl…) sem que mensagens dele na saída de erros virem erro fatal.
# No PowerShell 5.1, com ErrorActionPreference = 'Stop', redirecionar o stderr de um .exe (2>$null)
# transforma qualquer aviso em exceção. Aqui vale 'Continue'; confira o resultado por $LASTEXITCODE.
function Rodar-Nativo([scriptblock]$comando) {
  $ErrorActionPreference = 'Continue'
  & $comando
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

# Porta HTTP do QR do cliente (cardápio e comanda), liberada só para a rede local.
function Liberar-Porta-Cliente([int]$porta) {
  Get-NetFirewallRule -DisplayName $RegraFirewallCliente -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $RegraFirewallCliente -Direction Inbound -Protocol TCP -LocalPort $porta `
    -Action Allow -Profile Private, Public -RemoteAddress LocalSubnet | Out-Null
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
    $resposta = Rodar-Nativo { & curl.exe -sk --max-time 3 "https://localhost:$porta/api/health" 2>$null }
    if ($resposta -match '"status":"ok"') { return $true }
    $resposta = Rodar-Nativo { & curl.exe -s --max-time 3 "http://localhost:$porta/api/health" 2>$null }
    if ($resposta -match '"status":"ok"') { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

# Gatilhos da tarefa do servidor: ao ligar o PC e uma verificação a cada 5 minutos (se o
# servidor já está rodando, é ignorada). Com bateria baixa o Windows pode segurar a tarefa
# "na fila"; a verificação religa sozinha depois.
function Gatilhos-Servidor {
  $aoLigar = New-ScheduledTaskTrigger -AtStartup
  $aCada5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $aCada5.Repetition.Duration = ''
  return @($aoLigar, $aCada5)
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
