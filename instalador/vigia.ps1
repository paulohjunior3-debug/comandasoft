# Vigia do Sistema Bar: roda a cada minuto (tarefa "Sistema Bar - Vigia", conta de sistema).
# Se o sistema não responder por 3 verificações seguidas, reinicia sozinho (e o banco, se for ele
# que travou). Não interfere enquanto alguém atualiza ou reinicia pelo .bat (data\manutencao.lock).
# Registro em data\logs\vigia.log.

. (Join-Path $PSScriptRoot 'comum.ps1')
$ErrorActionPreference = 'Continue'

$Destino = $PSScriptRoot
$FalhasParaReiniciar = 3
$logs = Join-Path $Destino 'data\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'vigia.log'
$estadoArquivo = Join-Path $Destino 'data\vigia.json'

function Registrar([string]$texto) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 2MB)) { Move-Item -Force $log (Join-Path $logs 'vigia.1.log') }
  Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $texto" -Encoding UTF8
}

$estado = @{ falhas = 0; ultimoReinicio = $null }
if (Test-Path $estadoArquivo) {
  try {
    $lido = Get-Content $estadoArquivo -Raw | ConvertFrom-Json
    $estado.falhas = [int]$lido.falhas
    $estado.ultimoReinicio = $lido.ultimoReinicio
  } catch {}
}
function Salvar { $estado | ConvertTo-Json | Set-Content -Path $estadoArquivo -Encoding UTF8 }

# Atualização ou reinício manual em andamento (até 30 min): não mexe.
$trava = Arquivo-Manutencao $Destino
if ((Test-Path $trava) -and ((Get-Item $trava).LastWriteTime -gt (Get-Date).AddMinutes(-30))) { exit 0 }

# Acabou de reiniciar: dá tempo de o servidor subir (migrations, conexão com o banco).
if ($estado.ultimoReinicio -and ([datetime]$estado.ultimoReinicio) -gt (Get-Date).AddMinutes(-3)) { exit 0 }

$porta = Porta-Sistema $Destino
$saude = Saude-Servidor $porta 10
if ($saude -eq 'ok') {
  if ($estado.falhas -gt 0) { Registrar "Voltou a responder sozinho (depois de $($estado.falhas) falha(s))" }
  $estado.falhas = 0
  Salvar
  exit 0
}

# Tarefa do servidor parada (ex.: segurada "na fila" pelo Windows): só liga, sem contar falha.
$tarefa = Get-ScheduledTask -TaskName $TarefaServidor -ErrorAction SilentlyContinue
if ($tarefa -and $tarefa.State -ne 'Running') {
  Registrar "Servidor parado (tarefa: $($tarefa.State)); ligando"
  Garantir-PostgreSQL | Out-Null
  Start-ScheduledTask -TaskName $TarefaServidor
  $estado.falhas = 0
  $estado.ultimoReinicio = (Get-Date -Format o)
  Salvar
  exit 0
}

$estado.falhas++
Registrar "Sem resposta ($saude), verificação $($estado.falhas) de $FalhasParaReiniciar"
if ($estado.falhas -lt $FalhasParaReiniciar) { Salvar; exit 0 }

Registrar "Travado: reiniciando sozinho$(if ($saude -eq 'banco') { ' (com o banco de dados)' })"
$estado.falhas = 0
$estado.ultimoReinicio = (Get-Date -Format o)
Salvar
try {
  $r = Reiniciar-Sistema $Destino $porta -ReiniciarBanco:($saude -eq 'banco')
  if ($r.Voltou) { Registrar "Reiniciado: sistema no ar (banco: $($r.Banco))" } else { Registrar "Reiniciado, mas ainda sem resposta (banco: $($r.Banco))" }
} catch {
  Registrar "Erro ao reiniciar: $($_.Exception.Message)"
}
