# Executado pela Tarefa Agendada "Sistema Bar - Servidor" ao ligar o PC (conta de sistema).
# Roda o servidor guardando a saída em data\logs\servidor.log (com rodízio simples por tamanho).
# Se o servidor cair, a tarefa reinicia sozinha (configurado pelo instalador).

$raiz = $PSScriptRoot
$logs = Join-Path $raiz 'data\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'servidor.log'

# Rodízio: acima de 20 MB, o log atual vira servidor.1.log (o anterior é descartado).
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 20MB)) {
  Move-Item -Force $log (Join-Path $logs 'servidor.1.log')
}

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }

Add-Content -Path $log -Value "`n===== Iniciando em $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
Set-Location $raiz
& $node (Join-Path $raiz 'app\server.mjs') *>> $log
exit $LASTEXITCODE
