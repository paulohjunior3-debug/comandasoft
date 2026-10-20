# Configuração da loja (notebook do caixa)

Registro de como ficou o PC do restaurante em 20/10/2026, versão **0.13.1** instalada em `C:\SistemaBar`.
Sem senhas aqui: as senhas e segredos ficam só no `.env` da instalação e com o dono.

## Rede do restaurante

São dois roteadores diferentes:

| Rede | Interface do PC | IP do PC | Gateway | Observação |
|---|---|---|---|---|
| Rede do cabo (impressoras) | Ethernet | **192.168.100.161** | 192.168.100.1 | Mesma rede das impressoras Elgin. O PC fica **no cabo**. |
| Wi-Fi "Luizote" | Wi-Fi | 192.168.12.21 | 192.168.12.1 | Wi-Fi do segundo roteador, onde ficam os celulares. |

- Os celulares na Wi-Fi Luizote chegam ao sistema pela porta **8443** no IP do cabo (`https://192.168.100.161:8443`); o tráfego aparece vindo de 192.168.100.47 (NAT do roteador da Wi-Fi).
- **Pendente:** dessa Wi-Fi o celular **não** alcança a porta **8080** (servidor do QR do cliente). Enquanto isso, o QR das mesas só funciona para quem estiver na rede 192.168.100.x. Caminho provável: mudar `PUBLIC_PORT` para outra porta (ex.: 80) e reimprimir os QR.
- O IP do cabo vem por DHCP. **Reservar 192.168.100.161 no roteador** evita que ele mude (se mudar, o certificado e os QR impressos param de funcionar).

## Servidor

- Sistema (HTTPS): porta **8443**, escutando em todas as interfaces. Caixa e garçons usam `https://192.168.100.161:8443`.
- QR do cliente (HTTP): porta **8080**.
- Página para instalar o app nos celulares: `https://192.168.100.161:8443/certificado` (também pelo botão **📱 Celulares** no caixa).
- `PRINT_MODE=windows` (impressão real nas impressoras do Windows).
- Tarefa agendada **"Sistema Bar - Servidor"**: inicia com o Windows e confere a cada 5 minutos se o servidor está no ar. Também existe "Sistema Bar - Backup diario".
- Regras de firewall: "Sistema Bar - Servidor" e "Sistema Bar - Cliente (QR)", perfis Privado e Público.
- Certificado: `C:\SistemaBar\certs` (mkcert), emitido para os dois IPs acima. A CA (`rootCA.crt`) está instalada nos celulares da equipe.
- Notebook: ligado no carregador e fora da economia de energia. Com bateria baixa a tarefa ficou travada em "Na fila".

## Impressoras (Windows)

Todas com o driver **Generic / Text Only** (impressão RAW ESC/POS):

| Nome no Windows | Porta | Endereço | Uso |
|---|---|---|---|
| Elgin Cozinha | IP_192.168.100.120 | 192.168.100.120:9100 | Cozinha |
| Elgin Bebidas | IP_192.168.100.63 | 192.168.100.63:9100 | Bebidas. Atenção: o IP é **.63**, não .64. |
| Epson Caixa | USB002 | USB | Caixa (Epson TM-T20X / M352A) |

No sistema, Cozinha e Bebidas estão cadastradas em Admin → Impressoras e ligadas às categorias. As impressões do caixa ficaram como estão.

## Ao levar o notebook para casa e voltar

- **Em casa** as impressoras não existem. Pedidos lançados lá geram cupons com erro (alerta vermelho no caixa). Para testar em casa sem lixo na fila, use o sandbox (ver `CLAUDE.md`).
- Em casa o IP muda. O caixa no próprio PC continua funcionando por `https://localhost:8443`. Celulares em casa precisariam de um certificado para o IP de casa: rode `gerar-certificado.ps1`, que reaproveita a mesma CA, então os celulares não precisam reinstalar nada.
- **De volta à loja:**
  1. Ligue o cabo de rede e confira se o IP voltou a ser 192.168.100.161 (`ipconfig`).
  2. Se gerou certificado em casa, gere de novo na loja, para incluir os IPs da loja.
  3. Mande um cupom de teste em cada impressora (Admin → Impressoras).
  4. Abra `https://192.168.100.161:8443` num celular de garçom.
