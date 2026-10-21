# Reinicia o Sistema Bar quando ele travar (use o REINICIAR.bat ou o atalho na área de trabalho).
# Não perde nada: pedidos, comandas e pagamentos já estão gravados no banco, e os celulares
# reenviam sozinhos o que lançaram enquanto o sistema reiniciava.
param([string]$Destino = '')

. (Join-Path $PSScriptRoot 'comum.ps1')
Exigir-Administrador

# Rodando da pasta instalada, reinicia ela; rodando do pacote extraído, a instalação padrão.
if (-not $Destino) {
  if (Test-Path (Join-Path $PSScriptRoot '.env')) { $Destino = $PSScriptRoot } else { $Destino = 'C:\SistemaBar' }
}
if (-not (Test-Path (Join-Path $Destino '.env'))) { Falhar "Não há instalação em $Destino." }

$porta = Porta-Sistema $Destino
$registro = Join-Path $Destino 'data\logs\reinicios.log'
New-Item -ItemType Directory -Force -Path (Join-Path $Destino 'data\logs') | Out-Null
function Registrar([string]$texto) { Add-Content -Path $registro -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $texto" -Encoding UTF8 }

Write-Host 'Sistema Bar: reiniciando' -ForegroundColor White
Write-Host 'O que já foi lançado está salvo. Os celulares guardam o que lançarem agora e enviam quando o sistema voltar.'

Passo 'Conferindo o sistema'
$antes = Saude-Servidor $porta 5
switch ($antes) {
  'ok' { Ok 'Estava respondendo (reiniciando mesmo assim, como pedido)' }
  'banco' { Aviso 'O sistema responde, mas o banco de dados não: o banco também será reiniciado' }
  default { Aviso 'O sistema não estava respondendo' }
}
Registrar "Reinício manual por $env:USERNAME (antes: $antes)"

Iniciar-Manutencao $Destino
try {
  Passo 'Parando, conferindo o banco e ligando de novo'
  $r = Reiniciar-Sistema $Destino $porta -ReiniciarBanco:($antes -eq 'banco')
} finally {
  Encerrar-Manutencao $Destino
}

Ok "Banco de dados: $($r.Banco)"
if (-not $r.Voltou) {
  Registrar 'Falhou: o servidor não voltou'
  Write-Host ''
  Write-Host 'O sistema não voltou sozinho.' -ForegroundColor Red
  Write-Host '  1. Reinicie o computador (Iniciar > Ligar/Desligar > Reiniciar).'
  Write-Host '  2. Se continuar, chame o suporte e informe o arquivo:'
  Write-Host "     $Destino\data\logs\servidor.log"
  exit 1
}

Registrar 'OK: sistema no ar'
Write-Host ''
Write-Host '==================== SISTEMA NO AR ====================' -ForegroundColor Green
Write-Host 'Pode voltar a usar. Nos celulares, se aparecer "sem conexão", espere alguns segundos ou puxe a tela para atualizar.'
foreach ($ip in @(IPs-Rede-Local)) { Write-Host "    https://${ip}:$porta" }
