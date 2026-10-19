# Executado pela Tarefa Agendada "Sistema Bar - Servidor" ao ligar o PC (conta de sistema).
# O próprio servidor grava o log em data\logs\servidor.log (UTF-8); aqui só há o rodízio por
# tamanho e a captura de erros que aconteçam antes do log abrir (servidor-erro.log).
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

# Variável de ambiente vale mais que o .env: o servidor passa a escrever direto no arquivo.
$env:LOG_FILE = $log
$servidor = Join-Path $raiz 'app\server.mjs'
# Start-Process repassa o caminho entre aspas sem mexer (o & do PowerShell 5.1 estraga aspas
# em caminhos com espaço, como "C:\Program Files").
$processo = Start-Process -FilePath $node -ArgumentList "`"$servidor`"" -WorkingDirectory $raiz -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput (Join-Path $logs 'servidor-saida.log') -RedirectStandardError (Join-Path $logs 'servidor-erro.log')
exit $processo.ExitCode
