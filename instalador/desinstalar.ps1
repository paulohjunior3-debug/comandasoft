# Remove o Sistema Bar da inicialização do Windows (tarefas agendadas e regra de firewall).
# NÃO apaga o banco de dados, os backups nem a pasta da instalação: os dados ficam guardados.
# Uso (como administrador): powershell -ExecutionPolicy Bypass -File desinstalar.ps1 [-Destino C:\SistemaBar]
param([string]$Destino = 'C:\SistemaBar')

. (Join-Path $PSScriptRoot 'comum.ps1')
Exigir-Administrador

Passo 'Parando o servidor'
Parar-Servidor $Destino

Passo 'Removendo tarefas e firewall'
foreach ($t in @($TarefaVigia, $TarefaServidor, $TarefaBackup)) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $t -Confirm:$false }
}
Get-NetFirewallRule -DisplayName $RegraFirewall -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName $RegraFirewallCliente -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Reiniciar Sistema Bar.lnk') -ErrorAction SilentlyContinue
Ok 'Removido'

Write-Host ''
Write-Host "Os dados continuam no PostgreSQL (banco sistema_bar) e em $Destino\data."
Write-Host "Para apagar de vez: remova a pasta $Destino e o banco (pgAdmin ou dropdb). Faça um backup antes."
