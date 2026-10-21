# Instalador do Sistema Bar para o PC do caixa (Windows 10/11).
# Use o INSTALAR.bat (ele pede permissão de administrador e chama este script).
#
# O que faz (SPEC 5.10):
#   1. Copia o sistema para C:\SistemaBar (ou -Destino)
#   2. Instala Node.js LTS, PostgreSQL 16 e mkcert pelo winget, se faltarem
#   3. Cria o banco, gera o .env com segredos aleatórios e o certificado HTTPS
#   4. Cria as tabelas e o usuário admin (a senha aparece uma única vez)
#   5. Libera a porta no firewall (só para a rede local)
#   6. Agenda o servidor para iniciar com o Windows e o backup diário
#
# Opções (todas opcionais):
#   -Destino C:\SistemaBar     pasta da instalação
#   -Porta 3000                porta HTTPS
#   -PortaCliente 8080         porta HTTP do QR Code das mesas (cardápio e comanda do cliente)
#   -Banco sistema_bar         nome do banco a criar
#   -ConexaoArquivo arquivo    arquivo com a DATABASE_URL de um banco já preparado (PC onde o
#                              PostgreSQL já existe e alguém criou o banco e o usuário antes);
#                              com ele, o instalador não pede a senha do postgres
#   -ModoImpressao windows     "windows" (impressoras reais) ou "emulador" (sem impressora)
param(
  [string]$Destino = 'C:\SistemaBar',
  [int]$Porta = 3000,
  [int]$PortaCliente = 8080,
  [string]$Banco = 'sistema_bar',
  [string]$ConexaoArquivo = '',
  [ValidateSet('windows', 'emulador')][string]$ModoImpressao = 'windows'
)

. (Join-Path $PSScriptRoot 'comum.ps1')
Exigir-Administrador

# Registro da instalação para suporte (a senha do admin não entra: o log para antes do resumo).
# Nome com data/hora: uma tentativa anterior com a janela ainda aberta não trava o arquivo.
$logInstalacao = Join-Path $env:TEMP "sistema-bar-instalacao-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$global:SistemaBarLog = $logInstalacao
try { Start-Transcript -Path $logInstalacao -Force | Out-Null } catch {}

$origem = $PSScriptRoot
$versao = (Get-Content (Join-Path $origem 'VERSAO.txt')).Trim()
Write-Host "Sistema Bar $versao - instalação" -ForegroundColor White
Write-Host "Pasta: $Destino   Porta: $Porta   Impressão: $ModoImpressao"

if (Test-Path (Join-Path $Destino '.env')) {
  Falhar "Já existe uma instalação em $Destino. Para atualizar, use o ATUALIZAR.bat."
}

# ---------- 1. Arquivos ----------
Passo 'Copiando os arquivos'
if ((Resolve-Path $origem).Path.TrimEnd('\') -ne $Destino.TrimEnd('\')) {
  Copiar-Pacote $origem $Destino
}
New-Item -ItemType Directory -Force -Path (Join-Path $Destino 'data\logs'), (Join-Path $Destino 'data\backups') | Out-Null
Ok $Destino

# ---------- 2. Node.js ----------
Passo 'Node.js'
$node = Caminho-Node
if (-not $node) {
  Winget-Instalar 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  $node = Caminho-Node
}
if (-not $node) { Falhar 'Node.js não foi encontrado depois da instalação.' }
$versaoNode = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($versaoNode -lt 22) { Falhar "Node.js $versaoNode encontrado; é preciso a versão 22 ou mais nova. Atualize o Node.js e rode de novo." }
Ok "Node.js $(& $node --version) em $node"

# ---------- 3. PostgreSQL ----------
Passo 'PostgreSQL'
$pgBin = Pasta-PostgreSQL
$databaseUrl = $null
if ($ConexaoArquivo) {
  # Banco preparado antes: só confere se a conexão funciona.
  if (-not (Test-Path $ConexaoArquivo)) { Falhar "Arquivo de conexão não encontrado: $ConexaoArquivo" }
  $databaseUrl = (Get-Content $ConexaoArquivo -Raw).Trim()
  if (-not $pgBin) { Falhar 'PostgreSQL não encontrado neste PC.' }
  # No Windows o psql não aceita opções depois do endereço do banco: o endereço vai em -d, por último.
  Rodar-Nativo { & (Join-Path $pgBin 'psql.exe') -tAc 'select 1' -d $databaseUrl 2>$null } | Out-Null
  if ($LASTEXITCODE -ne 0) { Falhar 'Não consegui conectar no banco informado no arquivo de conexão.' }
  Ok 'Conectado ao banco preparado'
} elseif ($pgBin) {
  Aviso 'O PostgreSQL já está instalado neste PC.'
  $seguro = Read-Host 'Digite a senha do usuário "postgres" (definida na instalação dele)' -AsSecureString
  $senhaPg = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro))
} else {
  # Senha aleatória só com letras e números (vai no .env; ninguém precisa digitá-la).
  $senhaPg = (Segredo 18) -replace '[-_]', 'x'
  Winget-Instalar 'PostgreSQL.PostgreSQL.16' 'PostgreSQL 16' @(
    '--override', "--mode unattended --unattendedmodeui minimal --superpassword $senhaPg --serverport 5432 --disable-components stackbuilder"
  )
  $pgBin = Pasta-PostgreSQL
  if (-not $pgBin) { Falhar 'PostgreSQL não foi encontrado depois da instalação.' }
}
if (-not $databaseUrl) {
  $env:PGPASSWORD = $senhaPg
  Rodar-Nativo { & (Join-Path $pgBin 'psql.exe') -U postgres -h localhost -tAc 'select 1' 2>$null } | Out-Null
  if ($LASTEXITCODE -ne 0) { Falhar 'Não consegui entrar no PostgreSQL com essa senha.' }
  $existe = & (Join-Path $pgBin 'psql.exe') -U postgres -h localhost -tAc "select 1 from pg_database where datname = '$Banco'"
  if ($existe -ne '1') {
    & (Join-Path $pgBin 'createdb.exe') -U postgres -h localhost $Banco
    if ($LASTEXITCODE -ne 0) { Falhar "Não consegui criar o banco $Banco." }
    Ok "Banco $Banco criado"
  } else {
    Aviso "O banco $Banco já existia: os dados serão mantidos."
  }
  Remove-Item Env:PGPASSWORD
  $databaseUrl = "postgres://postgres:$([Uri]::EscapeDataString($senhaPg))@localhost:5432/$Banco"
}

# ---------- 4. Certificado HTTPS ----------
Passo 'Certificado HTTPS para a rede local'
& (Join-Path $Destino 'gerar-certificado.ps1') -Destino $Destino
# O script do certificado roda em outro escopo: confere aqui se ele realmente gerou os arquivos.
if (-not (Test-Path (Join-Path $Destino 'certs\servidor-cert.pem'))) { Falhar 'O certificado HTTPS não foi gerado.' }

# ---------- 5. Configuração (.env) ----------
Passo 'Configuração'
$envTexto = @"
# Gerado pelo instalador em $(Get-Date -Format 'yyyy-MM-dd HH:mm'). GUARDE UMA CÓPIA EM LOCAL SEGURO.
# Sem este arquivo (CPF_SECRET), os CPFs gravados ficam ilegíveis. Não troque os segredos depois de usar.
NODE_ENV=production
DATABASE_URL=$databaseUrl
JWT_SECRET=$(Segredo)
CPF_SECRET=$(Segredo)
PORT=$Porta
HOST=0.0.0.0
HTTPS_CERT=certs/servidor-cert.pem
HTTPS_KEY=certs/servidor-key.pem
PRINT_MODE=$ModoImpressao
# QR Code das mesas: porta HTTP do cardápio e da comanda do cliente (só rede local).
PUBLIC_PORT=$PortaCliente
"@
$envArquivo = Join-Path $Destino '.env'
[IO.File]::WriteAllText($envArquivo, $envTexto, (New-Object Text.UTF8Encoding($false)))
# Só administradores e o sistema leem o .env (tem a senha do banco e os segredos).
& icacls $envArquivo /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
Ok '.env criado e protegido'

# ---------- 6. Banco e admin ----------
Passo 'Criando as tabelas e o usuário admin'
Set-Location $Destino
& $node 'app\cli.mjs' migrate
if ($LASTEXITCODE -ne 0) { Falhar 'Falha ao criar as tabelas.' }
$saida = & $node 'app\cli.mjs' criar-admin
if ($LASTEXITCODE -ne 0) { Falhar 'Falha ao criar o usuário admin.' }
$senhaAdmin = $null
$linhaAdmin = @($saida) | Where-Object { $_ -match 'senha=' } | Select-Object -First 1
if ($linhaAdmin -match 'senha=(\S+)') { $senhaAdmin = $Matches[1] }

$cardapios = Get-ChildItem (Join-Path $Destino 'cardapios') -Filter *.json -ErrorAction SilentlyContinue
foreach ($c in $cardapios) {
  $resp = Read-Host "Importar o cardápio '$($c.BaseName)'? (s/N)"
  if ($resp -match '^[sS]') { & $node 'app\cli.mjs' importar-cardapio $c.FullName }
}

# ---------- 7. Firewall ----------
Passo 'Firewall'
Get-NetFirewallRule -DisplayName $RegraFirewall -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $RegraFirewall -Direction Inbound -Protocol TCP -LocalPort $Porta `
  -Action Allow -Profile Private, Public -RemoteAddress LocalSubnet | Out-Null
Ok "Porta $Porta liberada só para aparelhos da rede local"
Liberar-Porta-Cliente $PortaCliente
Ok "Porta $PortaCliente (QR Code das mesas) liberada só para a rede local"

# ---------- 8. Iniciar com o Windows + backup diário ----------
Passo 'Agendando o servidor e o backup'
$sistema = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$acaoServidor = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $Destino `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Destino\servico.ps1`""
$configServidor = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TarefaServidor -Action $acaoServidor -Trigger (Gatilhos-Servidor) `
  -Principal $sistema -Settings $configServidor -Description 'Servidor do Sistema Bar (inicia com o Windows).' -Force | Out-Null

$acaoBackup = New-ScheduledTaskAction -Execute $node -WorkingDirectory $Destino -Argument "`"$Destino\app\cli.mjs`" backup --manter 30"
$configBackup = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TarefaBackup -Action $acaoBackup -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) `
  -Principal $sistema -Settings $configBackup -Description 'Backup diário do banco do Sistema Bar (guarda 30 dias).' -Force | Out-Null
Ok 'Servidor inicia com o Windows; backup todo dia às 3h (data\backups)'

Start-ScheduledTask -TaskName $TarefaServidor
Write-Host '    Aguardando o servidor subir...'
if (-not (Aguardar-Servidor $Porta)) {
  Falhar "O servidor não respondeu. Veja o log em $Destino\data\logs\servidor.log"
}
Ok 'Servidor no ar'

Registrar-Vigia $Destino
Criar-Atalho-Reiniciar $Destino
Ok 'Vigia ligado (reinicia sozinho se travar); atalho "Reiniciar Sistema Bar" na área de trabalho'

# ---------- Resumo ----------
# Encerra o registro antes de mostrar a senha do admin, e guarda o log junto da instalação.
try { Stop-Transcript | Out-Null } catch {}
Copy-Item -Force $logInstalacao (Join-Path $Destino 'data\logs\instalacao.log') -ErrorAction SilentlyContinue
$ips = @(IPs-Rede-Local)
$codigoMaquina = Gravar-Codigo-Maquina $Destino

Write-Host ''
Write-Host '==================== INSTALAÇÃO CONCLUÍDA ====================' -ForegroundColor Green
Write-Host "Endereço para os celulares e o caixa:"
foreach ($ip in $ips) { Write-Host "    https://${ip}:$Porta" -ForegroundColor White }
Write-Host "QR Code das mesas: imprima em Administração > Mesas > Imprimir QR Codes (porta $PortaCliente)."
if ($codigoMaquina) {
  Write-Host "Código deste computador (licença): $codigoMaquina" -ForegroundColor White
  Write-Host "    Mande ao suporte para receber a licença (também em $Destino\MAQUINA.txt). Sem ela, o sistema funciona 15 dias em avaliação."
}
if ($senhaAdmin) {
  Write-Host ''
  Write-Host 'Primeiro acesso (anote agora; a senha não será mostrada de novo):' -ForegroundColor Yellow
  Write-Host '    usuário: admin'
  Write-Host "    senha:   $senhaAdmin"
}
Write-Host ''
Write-Host 'Próximos passos (detalhes no LEIA-ME.txt):'
Write-Host "  1. Instale $Destino\certs\rootCA.crt em cada celular."
Write-Host '  2. Entre como admin: cadastre usuários (gerente com PIN), impressoras e confira o cardápio.'
Write-Host '  3. Em Configurações, escolha a impressora do caixa.'
Write-Host "  4. Guarde uma cópia do arquivo $Destino\.env em local seguro (pendrive)."
Write-Host '  5. Peça ao responsável pelo roteador para reservar o IP deste PC.'
Write-Host '==============================================================' -ForegroundColor Green
