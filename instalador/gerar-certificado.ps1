# Gera (ou renova) o certificado HTTPS para os IPs atuais deste PC.
# Rode de novo sempre que o IP do PC mudar. Uso: gerar-certificado.ps1 [-Destino C:\SistemaBar]
param([string]$Destino = $PSScriptRoot)

. (Join-Path $PSScriptRoot 'comum.ps1')

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
  Winget-Instalar 'FiloSottile.mkcert' 'mkcert (certificados HTTPS da rede local)'
}
if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
  Falhar 'mkcert não ficou disponível. Feche e abra o PowerShell e rode de novo.'
}

$certs = Join-Path $Destino 'certs'
New-Item -ItemType Directory -Force -Path $certs | Out-Null
$nomes = @('localhost', '127.0.0.1', $env:COMPUTERNAME.ToLower()) + @(IPs-Rede-Local)

& mkcert -install | Out-Host
& mkcert -cert-file (Join-Path $certs 'servidor-cert.pem') -key-file (Join-Path $certs 'servidor-key.pem') @nomes | Out-Host
if ($LASTEXITCODE -ne 0) { Falhar 'mkcert não conseguiu gerar o certificado.' }

$caRoot = (& mkcert -CAROOT).Trim()
Copy-Item -Force (Join-Path $caRoot 'rootCA.pem') (Join-Path $certs 'rootCA.crt')
Ok "Certificado gerado para: $($nomes -join ', ')"
Write-Host "    Para os celulares confiarem: instale $certs\rootCA.crt em cada aparelho (veja o LEIA-ME)."
