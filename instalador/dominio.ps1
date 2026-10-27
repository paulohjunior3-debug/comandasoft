# Liga o endereço próprio do sistema (ex.: sistema.esquinadatilapia.com.br) com certificado da
# Let's Encrypt: os celulares confiam sem instalar o certificado do sistema e o app instala direto
# no Android. O DNS do domínio precisa estar na Cloudflare. Use o DOMINIO.bat.
# O servidor aponta o nome para o IP deste PC na rede local e renova o certificado sozinho.
param([string]$Destino = '')

. (Join-Path $PSScriptRoot 'comum.ps1')
Exigir-Administrador

if (-not $Destino) {
  if (Test-Path (Join-Path $PSScriptRoot '.env')) { $Destino = $PSScriptRoot } else { $Destino = 'C:\SistemaBar' }
}
$envArquivo = Join-Path $Destino '.env'
if (-not (Test-Path $envArquivo)) { Falhar "Não há instalação em $Destino. Use o INSTALAR.bat antes." }
$porta = Porta-Sistema $Destino

# Troca (ou acrescenta) uma linha CHAVE=valor do .env, sem mexer no resto.
function Gravar-Env([string]$chave, [string]$valor) {
  $linhas = [Collections.Generic.List[string]]@(Get-Content $envArquivo -Encoding UTF8)
  $achou = $false
  for ($i = 0; $i -lt $linhas.Count; $i++) {
    if ($linhas[$i] -match "^\s*$chave\s*=") { $linhas[$i] = "$chave=$valor"; $achou = $true }
  }
  if (-not $achou) { $linhas.Add("$chave=$valor") }
  [IO.File]::WriteAllLines($envArquivo, $linhas, (New-Object Text.UTF8Encoding($false)))
}

Write-Host 'Sistema Bar: endereço próprio com certificado confiável' -ForegroundColor White
$atual = (Ler-Env $envArquivo)['DOMINIO']
if ($atual) { Write-Host "    Endereço atual: $atual" }

Passo 'Endereço'
Write-Host '    Digite o endereço completo do sistema, por exemplo: sistema.esquinadatilapia.com.br'
$dominio = (Read-Host '    Endereço').Trim().ToLower()
$dominio = $dominio -replace '^https?://', '' -replace '[/:].*$', ''
if ($dominio -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+){2,}$') { Falhar 'Endereço inválido. Use algo como sistema.seudominio.com.br (sem https:// e sem porta).' }

Passo 'Token da Cloudflare'
Write-Host '    Na Cloudflare: My Profile > API Tokens > Create Token > modelo "Edit zone DNS", escolha o seu domínio.'
Write-Host '    Cole o token aqui. Ele não aparece na tela e fica só no .env deste computador.'
$seguro = Read-Host -AsSecureString '    Token'
$token = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro))).Trim()
if ($token.Length -lt 30) { Falhar 'Isso não parece um token da Cloudflare (é um texto de uns 40 caracteres).' }

# Confere o token antes de gravar: a Cloudflare responde se ele vale.
$resposta = Rodar-Nativo { & curl.exe -s --max-time 15 -H "Authorization: Bearer $token" 'https://api.cloudflare.com/client/v4/user/tokens/verify' 2>$null }
if ($resposta -notmatch '"status"\s*:\s*"active"') { Falhar 'A Cloudflare não aceitou o token (ou não há internet). Confira e rode de novo.' }
Ok 'Token aceito pela Cloudflare'

Passo 'Gravando a configuração e reiniciando o sistema'
Gravar-Env 'DOMINIO' $dominio
Gravar-Env 'CLOUDFLARE_TOKEN' $token
$token = $null
Iniciar-Manutencao $Destino
try {
  $r = Reiniciar-Sistema $Destino $porta
} finally {
  Encerrar-Manutencao $Destino
}
if (-not $r.Voltou) { Falhar "O sistema não voltou. Veja $Destino\data\logs\servidor.log" }
Ok 'Sistema no ar'

Passo 'Pedindo o certificado (até 2 minutos)'
$log = Join-Path $Destino 'data\logs\servidor.log'
$limite = (Get-Date).AddSeconds(150)
$resultado = $null
while ((Get-Date) -lt $limite -and -not $resultado) {
  Start-Sleep -Seconds 5
  $ultimas = Get-Content $log -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue | Out-String
  if ($ultimas -match "Certificado de $([regex]::Escape($dominio)) válido até ([0-9-]+)") { $resultado = "ok:$($Matches[1])" }
  elseif ($ultimas -match "Endereço próprio \($([regex]::Escape($dominio))\): ([^`"]+)") { $resultado = "erro:$($Matches[1])" }
}
if (-not $resultado) {
  # Já tinha certificado válido: não pede de novo.
  if (Test-Path (Join-Path $Destino 'certs\dominio\certificado.pem')) { $resultado = 'ok:já existente' }
}

Write-Host ''
if ($resultado -like 'ok:*') {
  Write-Host '==================== PRONTO ====================' -ForegroundColor Green
  Write-Host "Certificado: $($resultado.Substring(3))"
  Write-Host "Endereço do sistema:  https://$($dominio):$porta" -ForegroundColor Yellow
  Write-Host 'Nos celulares e computadores, abra esse endereço (na rede do bar) e instale o app de novo.'
  Write-Host 'O endereço antigo pelo IP continua funcionando nos aparelhos que já tinham o certificado.'
} elseif ($resultado -like 'erro:*') {
  Aviso "Não foi possível tirar o certificado: $($resultado.Substring(5))"
  Write-Host 'O sistema continua funcionando pelo IP. Corrija e rode o DOMINIO.bat de novo.'
} else {
  Aviso "Ainda sem resposta. Veja as últimas linhas de $log ou rode o DOMINIO.bat de novo em alguns minutos."
}
