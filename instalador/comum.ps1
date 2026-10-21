# Funções e constantes compartilhadas pelos scripts de instalação, atualização e remoção.
# Compatível com o Windows PowerShell 5.1 que vem no Windows 10/11.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$TarefaServidor = 'Sistema Bar - Servidor'
$TarefaBackup = 'Sistema Bar - Backup diario'
$TarefaVigia = 'Sistema Bar - Vigia'
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

# ---------- Reinício e vigia (sistema travado em produção) ----------

# Arquivo que avisa o vigia que alguém está atualizando ou reiniciando: ele não interfere.
function Arquivo-Manutencao([string]$destino) { return (Join-Path $destino 'data\manutencao.lock') }

function Iniciar-Manutencao([string]$destino) {
  New-Item -ItemType Directory -Force -Path (Join-Path $destino 'data') | Out-Null
  Set-Content -Path (Arquivo-Manutencao $destino) -Value (Get-Date -Format o) -Encoding ASCII
}

function Encerrar-Manutencao([string]$destino) {
  Remove-Item -Force (Arquivo-Manutencao $destino) -ErrorAction SilentlyContinue
}

# Consulta /api/health: 'ok', 'banco' (o servidor responde mas o banco falhou) ou 'sem-resposta'.
function Saude-Servidor([int]$porta, [int]$segundos = 10) {
  $resposta = Rodar-Nativo { & curl.exe -sk --max-time $segundos "https://localhost:$porta/api/health" 2>$null }
  if (-not $resposta) { $resposta = Rodar-Nativo { & curl.exe -s --max-time $segundos "http://localhost:$porta/api/health" 2>$null } }
  if ($resposta -match '"status":"ok"') { return 'ok' }
  if ($resposta) { return 'banco' }
  return 'sem-resposta'
}

function Servico-PostgreSQL {
  return Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
}

# Liga o PostgreSQL se estiver parado; com -Reiniciar, reinicia mesmo ligado (banco travado).
function Garantir-PostgreSQL([switch]$Reiniciar) {
  $servico = Servico-PostgreSQL
  if (-not $servico) { return 'não encontrado' }
  if ($Reiniciar -and $servico.Status -eq 'Running') {
    Restart-Service -Name $servico.Name -Force
    return 'reiniciado'
  }
  if ($servico.Status -ne 'Running') {
    Start-Service -Name $servico.Name
    $servico.WaitForStatus('Running', (New-TimeSpan -Seconds 60))
    return 'ligado'
  }
  return 'ok'
}

# Para o servidor, confere o banco e liga de novo. Nada do que foi lançado se perde: cada pedido
# e pagamento já está gravado no banco, e os celulares reenviam sozinhos o que lançaram nesse meio-tempo.
function Reiniciar-Sistema([string]$destino, [int]$porta, [switch]$ReiniciarBanco) {
  Parar-Servidor $destino
  $banco = Garantir-PostgreSQL -Reiniciar:$ReiniciarBanco
  Start-ScheduledTask -TaskName $TarefaServidor
  $voltou = Aguardar-Servidor $porta 120
  return @{ Banco = $banco; Voltou = $voltou }
}

function Porta-Sistema([string]$destino) {
  $porta = [int]((Ler-Env (Join-Path $destino '.env'))['PORT'])
  if (-not $porta) { $porta = 3000 }
  return $porta
}

# Vigia: a cada minuto confere se o sistema responde; travado por 3 minutos seguidos, reinicia sozinho.
function Registrar-Vigia([string]$destino) {
  $sistema = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $acao = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $destino `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$destino\vigia.ps1`""
  $gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $gatilho.Repetition.Duration = ''
  $config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TarefaVigia -Action $acao -Trigger $gatilho -Principal $sistema -Settings $config `
    -Description 'Confere a cada minuto se o Sistema Bar responde e reinicia sozinho se travar (log em data\logs\vigia.log).' -Force | Out-Null
}

# Atalho "Reiniciar Sistema Bar" na área de trabalho de todos os usuários.
function Criar-Atalho-Reiniciar([string]$destino) {
  $pasta = [Environment]::GetFolderPath('CommonDesktopDirectory')
  $shell = New-Object -ComObject WScript.Shell
  $atalho = $shell.CreateShortcut((Join-Path $pasta 'Reiniciar Sistema Bar.lnk'))
  $atalho.TargetPath = Join-Path $destino 'REINICIAR.bat'
  $atalho.WorkingDirectory = $destino
  $atalho.IconLocation = "$env:SystemRoot\System32\shell32.dll,238"
  $atalho.Description = 'Reinicia o Sistema Bar sem perder o que já foi lançado'
  $atalho.Save()
}

