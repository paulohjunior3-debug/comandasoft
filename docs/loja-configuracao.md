# Configuração de uma loja (PC do caixa)

Modelo para registrar como ficou a instalação em cada estabelecimento (sistema em `C:\SistemaBar`).
Preencha uma cópia **fora do repositório**: IPs, nomes de rede e senhas de uma loja real não devem ser versionados.
As senhas e segredos ficam só no `.env` da instalação e com o dono.

## Rede da loja

É comum ter dois roteadores: um no cabo, com as impressoras, e outro com o Wi-Fi dos celulares.

| Rede | Interface do PC | IP do PC | Gateway | Observação |
|---|---|---|---|---|
| Rede do cabo (impressoras) | Ethernet | `IP-DO-PC` | `GATEWAY-CABO` | Mesma rede das impressoras. Deixe o PC **no cabo**. |
| Wi-Fi dos celulares | Wi-Fi | `IP-WIFI` | `GATEWAY-WIFI` | Segundo roteador, onde ficam os celulares. |

- Com dois roteadores, os celulares do Wi-Fi chegam ao sistema pelo IP do cabo (`https://IP-DO-PC:8443`); o tráfego aparece vindo do IP do roteador do Wi-Fi (NAT).
- Confira se, a partir do Wi-Fi, o celular também alcança a porta do QR do cliente (`PUBLIC_PORT`, padrão 8080). Se não alcançar, troque a porta (ex.: 80) e reimprima os QR. Outra saída é o endereço pela internet (`CARDAPIO-INTERNET.bat`).
- **Reserve o IP do PC no roteador (reserva DHCP).** Se ele mudar, o certificado e os QR impressos param de funcionar.

## Servidor

- Sistema (HTTPS): porta **8443**, escutando em todas as interfaces. Caixa e garçons usam `https://IP-DO-PC:8443`.
- QR do cliente (HTTP): porta **8080**.
- Página para instalar o app nos celulares: `https://IP-DO-PC:8443/certificado` (também pelo botão **📱 Celulares** no caixa).
- `PRINT_MODE=windows` (impressão real nas impressoras do Windows).
- Tarefa agendada **"Sistema Bar - Servidor"**: inicia com o Windows e confere a cada 5 minutos se o servidor está no ar. Também existe "Sistema Bar - Backup diario".
- Regras de firewall: "Sistema Bar - Servidor" e "Sistema Bar - Cliente (QR)", perfis Privado e Público, aceitando só a rede local.
- Certificado: `C:\SistemaBar\certs` (mkcert), emitido para os IPs do PC. A CA (`rootCA.crt`) precisa estar instalada nos celulares da equipe.
- Notebook como servidor: deixe ligado no carregador e fora da economia de energia. Com bateria baixa, a tarefa agendada pode ficar travada em "Na fila".

## Impressoras (Windows)

Todas com o driver **Generic / Text Only** (impressão RAW ESC/POS):

| Nome no Windows | Porta | Endereço | Uso |
|---|---|---|---|
| Elgin Cozinha | `IP_<ip-da-impressora>` | `<ip-da-impressora>:9100` | Cozinha |
| Elgin Bebidas | `IP_<ip-da-impressora>` | `<ip-da-impressora>:9100` | Bebidas |
| Caixa | `USB00x` | USB | Caixa |

Confira o IP de cada impressora pelo cupom de autoteste dela: um dígito errado na porta do Windows faz a impressão falhar sem aviso claro.
No sistema, cadastre as impressoras em Admin → Impressoras e ligue cada uma às suas categorias.

## Ao levar o notebook para outra rede e voltar

- **Fora da loja** as impressoras não existem. Pedidos lançados lá geram cupons com erro (alerta vermelho no caixa). Para testar sem lixo na fila, use o sandbox (ver [desenvolvimento.md](desenvolvimento.md)).
- Fora da loja o IP muda. O caixa no próprio PC continua funcionando por `https://localhost:8443`. Para usar os celulares em outra rede, rode `gerar-certificado.ps1`: ele reaproveita a mesma CA, então os celulares não precisam reinstalar nada.
- **De volta à loja:**
  1. Ligue o cabo de rede e confira se o IP voltou a ser o reservado (`ipconfig`).
  2. Se gerou certificado em outra rede, gere de novo na loja, para incluir os IPs da loja.
  3. Mande um cupom de teste em cada impressora (Admin → Impressoras).
  4. Abra `https://IP-DO-PC:8443` num celular de garçom.
