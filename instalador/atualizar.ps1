# Atualiza uma instalação existente com a versão deste pacote (SPEC 5.10).
# Use o ATUALIZAR.bat. Faz backup do banco antes, troca os arquivos do sistema
# (mantendo .env, certificados, backups e logs), aplica as migrations e reinicia.
param([string]$Destino = 'C:\SistemaBar')

. (Join-Path $PSScriptRoot 'comum.ps1')
Exigir-Administrador

$global:SistemaBarLog = Join-Path $env:TEMP "sistema-bar-atualizacao-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
try { Start-Transcript -Path $global:SistemaBarLog -Force | Out-Null } catch {}

$origem = $PSScriptRoot
$nova = (Get-Content (Join-Path $origem 'VERSAO.txt')).Trim()
if (-not (Test-Path (Join-Path $Destino '.env'))) { Falhar "Não há instalação em $Destino. Use o INSTALAR.bat." }
$atual = '?'
if (Test-Path (Join-Path $Destino 'VERSAO.txt')) { $atual = (Get-Content (Join-Path $Destino 'VERSAO.txt')).Trim() }
Write-Host "Sistema Bar: atualizando de $atual para $nova em $Destino" -ForegroundColor White

$node = Caminho-Node
if (-not $node) { Falhar 'Node.js não encontrado.' }
$porta = [int]((Ler-Env (Join-Path $Destino '.env'))['PORT'])
if (-not $porta) { $porta = 3000 }

Passo 'Backup do banco antes de atualizar'
Set-Location $Destino
& $node 'app\cli.mjs' backup --manter 30
if ($LASTEXITCODE -ne 0) { Falhar 'O backup falhou; a atualização foi cancelada para não arriscar os dados.' }

Passo 'Parando o servidor'
Parar-Servidor $Destino
Ok 'Parado'

Passo 'Copiando a nova versão'
if ((Resolve-Path $origem).Path.TrimEnd('\') -eq $Destino.TrimEnd('\')) {
  Falhar 'Rode o ATUALIZAR.bat a partir da pasta extraída do novo pacote, não da pasta instalada.'
}
Copiar-Pacote $origem $Destino
Ok "Arquivos da versão $nova copiados (.env, certs e data mantidos)"

Passo 'QR Code das mesas (porta do cliente)'
$envArquivo = Join-Path $Destino '.env'
$portaCliente = [int]((Ler-Env $envArquivo)['PUBLIC_PORT'])
if (-not $portaCliente) {
  # Instalação anterior à 0.6: liga o servidor do QR na porta padrão.
  $portaCliente = $PortaClientePadrao
  $linha = "`r`n# QR Code das mesas: porta HTTP do cardápio e da comanda do cliente (só rede local).`r`nPUBLIC_PORT=$portaCliente`r`n"
  [IO.File]::AppendAllText($envArquivo, $linha, (New-Object Text.UTF8Encoding($false)))
}
Liberar-Porta-Cliente $portaCliente
Ok "Cliente pelo QR na porta $portaCliente (liberada só para a rede local)"

Passo 'Atualizando o banco'
& $node 'app\cli.mjs' migrate
if ($LASTEXITCODE -ne 0) {
  Aviso 'As migrations falharam. O backup de antes da atualização está em data\backups.'
  Falhar 'Atualização incompleta.'
}

Passo 'Iniciando o servidor'
# Instalações antigas só tinham o gatilho "ao ligar o PC": acrescenta a verificação de 5 minutos.
Set-ScheduledTask -TaskName $TarefaServidor -Trigger (Gatilhos-Servidor) | Out-Null
Start-ScheduledTask -TaskName $TarefaServidor
if (-not (Aguardar-Servidor $porta)) { Falhar "O servidor não respondeu. Veja $Destino\data\logs\servidor.log" }
Ok "Sistema Bar $nova no ar"

try { Stop-Transcript | Out-Null } catch {}
Copy-Item -Force $global:SistemaBarLog (Join-Path $Destino 'data\logs\') -ErrorAction SilentlyContinue
