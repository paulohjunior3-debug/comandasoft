# Libera no firewall do Windows (rede privada) as portas do Sistema Bar.
# 5173 = PWA em desenvolvimento (Vite). 3000 = API (producao serve a PWA por ela).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\liberar-firewall.ps1
# Pede elevacao de administrador sozinho, se necessario.

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
  exit
}

$rules = @(
  @{ Name = 'Sistema Bar - PWA dev (5173)'; Port = 5173 },
  @{ Name = 'Sistema Bar - API (3000)'; Port = 3000 }
)

# Vale para rede Privada e Publica (o Windows as vezes nao deixa trocar o Wi-Fi para Privada),
# mas so aceita conexoes de aparelhos da mesma rede local (LocalSubnet).
foreach ($r in $rules) {
  Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP -LocalPort $r.Port `
    -Action Allow -Profile Private, Public -RemoteAddress LocalSubnet | Out-Null
  Write-Host "Regra ativa: $($r.Name) (Privada + Publica, somente rede local)"
}
Start-Sleep -Seconds 5
