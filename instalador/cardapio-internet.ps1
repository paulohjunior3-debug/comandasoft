# Liga o cardápio e a comanda do cliente (QR das mesas) pela internet, pelo túnel da Cloudflare:
# o cliente usa o 4G dele, sem entrar na Wi-Fi do bar. Só o servidor do QR (porta do cliente) sai
# pela internet; caixa, garçom, cozinha e administração continuam só na rede local.
# Use o CARDAPIO-INTERNET.bat. Precisa do token do túnel criado no painel da Cloudflare (veja o LEIA-ME).
param([string]$Destino = 'C:\SistemaBar')

. (Join-Path $PSScriptRoot 'comum.ps1')
Exigir-Administrador

if (-not (Test-Path (Join-Path $Destino '.env'))) { Falhar "Não há instalação em $Destino. Use o INSTALAR.bat antes." }
$portaCliente = [int]((Ler-Env (Join-Path $Destino '.env'))['PUBLIC_PORT'])
if (-not $portaCliente) { Falhar 'O servidor do QR está desligado (PUBLIC_PORT vazio no .env). Rode o ATUALIZAR.bat.' }

Write-Host 'Sistema Bar: cardápio pela internet (túnel da Cloudflare)' -ForegroundColor White
Write-Host "No painel da Cloudflare, o endereço público do túnel deve apontar para:  http://localhost:$portaCliente" -ForegroundColor Yellow

Passo 'Programa do túnel (cloudflared)'
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Winget-Instalar 'Cloudflare.cloudflared' 'cloudflared (túnel da Cloudflare)'
}
$exe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $exe) {
  $padrao = Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'
  if (Test-Path $padrao) { $exe = $padrao } else { Falhar 'cloudflared não ficou disponível. Feche e abra de novo e rode este .bat outra vez.' }
}
Ok $exe

Passo 'Token do túnel'
Write-Host '    Cole o token (Cloudflare > Zero Trust > Networks > Tunnels > seu túnel > Install connector).'
Write-Host '    Pode colar o comando inteiro que a Cloudflare mostra: só o token é usado. Ele não aparece na tela.'
$seguro = Read-Host -AsSecureString '    Token'
$texto = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro))
# Aceita o comando inteiro ("cloudflared.exe service install eyJ..."): fica com a última palavra.
$token = ($texto.Trim() -split '\s+')[-1]
if ($token.Length -lt 50) { Falhar 'Isso não parece um token de túnel da Cloudflare (é um texto longo que começa com eyJ).' }

Passo 'Instalando o túnel como serviço do Windows'
if (Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue) {
  Rodar-Nativo { & $exe service uninstall 2>&1 | Out-Null }
  Start-Sleep -Seconds 2
}
Rodar-Nativo { & $exe service install $token 2>&1 | Out-Null }
$token = $null; $texto = $null
$servico = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
if (-not $servico) { Falhar 'O serviço do túnel não foi criado. Confira o token e rode de novo.' }
Set-Service -Name 'Cloudflared' -StartupType Automatic
if ($servico.Status -ne 'Running') { Start-Service -Name 'Cloudflared' }
Ok 'Túnel ligado; inicia junto com o Windows e o vigia religa se parar'

Write-Host ''
Write-Host '==================== PRONTO ====================' -ForegroundColor Green
Write-Host 'Falta:'
Write-Host '  1. No celular, com o 4G (Wi-Fi desligada), abra https://SEU-ENDERECO/m/teste: deve aparecer'
Write-Host '     "QR Code não reconhecido" (sinal de que o túnel chegou ao sistema).'
Write-Host '  2. No sistema: Administração > Mesas > Imprimir QR Codes > Endereço do QR = https://SEU-ENDERECO'
Write-Host '     (sem porta), Salvar, e reimprima os QR das mesas.'
