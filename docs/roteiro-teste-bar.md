# Roteiro de teste no bar

Objetivo: validar o sistema de ponta a ponta no ambiente real, com celulares dos garçons, PC do caixa e impressoras Elgin. Leve este roteiro impresso ou aberto no celular e marque cada item.

Tempo estimado: 1h30 de preparação + 1h de testes. Faça fora do horário de movimento.

---

## Parte A — Antes de sair (no seu PC, ~20 min)

- [ ] **Decidir qual PC será o servidor.**
  - **PC do bar (recomendado):** gere o pacote (`pnpm.cmd empacotar`), leve `dist-instaladorSistemaBar-<versão>.zip` num pendrive, extraia no PC do caixa e rode **INSTALAR.bat** (precisa de internet durante a instalação). Ele já faz rede, certificado, firewall, banco, admin e cardápio; nesse caso pule a Parte B e use o endereço que aparece no fim da instalação. Instalado, o modo de impressão já é `windows`.
  - **Levar este PC:** siga as Partes B a D como estão.
- [ ] **Baixar o driver da Elgin** do site do fabricante, para o modelo exato (i7, i9…), e salvar no PC. No bar pode não ter internet boa.
- [ ] **Cadastrar os dados reais**, que ficam no banco do PC:
  - [ ] Usuários (Administração > Usuários): 1 garçom, 1 caixa e 1 gerente **com PIN** de 4 a 6 números.
  - [ ] Categorias e alguns produtos reais com preço (5 a 10 bastam para o teste).
  - [ ] Mesas: use "Criar várias" com a numeração real do bar.
  - [ ] Configurações: nome/CNPJ do bar, taxa de serviço (liga ou não, como o dono quiser) e couvert.
- [ ] Anotar as senhas dos usuários de teste num papel. Não mande por mensagem.

## Parte B — No bar: rede (~15 min)

- [ ] Conectar o PC ao **mesmo Wi-Fi** (ou cabo) que os celulares vão usar.
- [ ] Descobrir o IP do PC: no PowerShell, rode `ipconfig` e anote o "Endereço IPv4" (ex.: 192.168.0.25).
- [ ] **Gerar o certificado de novo**, porque o IP mudou:
  ```
  powershell -ExecutionPolicy Bypass -File scripts\gerar-certificado.ps1
  ```
  A CA não muda: os celulares que já instalaram o `rootCA.crt` continuam confiando.
- [ ] Liberar o firewall nessa rede (pede permissão de administrador):
  ```
  powershell -ExecutionPolicy Bypass -File scripts\liberar-firewall.ps1
  ```
- [ ] *(Recomendado)* Pedir ao responsável pelo roteador uma **reserva de IP (DHCP)** para o PC, para o endereço não mudar no dia a dia (SPEC 3.1).

### Rodar em modo produção

No bar, use o **modo produção** (o app já montado, servido pelo próprio servidor). É ele que deixa o celular reabrir o app sem rede; o modo de desenvolvimento não garante isso.

- [ ] Feche a aba "dev server" do terminal (Ctrl+C), se estiver aberta.
- [ ] No arquivo `.env`, deixe assim:
  ```
  HTTPS_CERT=certs/dev-cert.pem
  HTTPS_KEY=certs/dev-key.pem
  PRINT_MODE=windows
  ```
- [ ] Monte o app e suba o servidor:
  ```
  pnpm.cmd build
  pnpm.cmd start
  ```
- [ ] O endereço agora é **https://IP-DO-PC:3000** (porta 3000, não 5173). Abra no navegador do PC para conferir.

## Parte C — No bar: impressoras Elgin (~30 min)

Para cada impressora (bar, cozinha, caixa):

- [ ] Instalar no Windows com o driver da Elgin.
  - **USB:** conecte o cabo e rode o instalador do driver.
  - **Rede:** em Configurações > Impressoras > Adicionar, use "porta TCP/IP" com o **IP da impressora** (imprima a autoconfiguração segurando o botão FEED ao ligar). Porta 9100.
- [ ] Dar um nome claro no Windows (ex.: `ELGIN BAR`, `ELGIN COZINHA`, `ELGIN CAIXA`).
- [ ] Administração > Impressoras > Nova impressora: escolher a impressora do Windows, setor (BAR/COZINHA/CAIXA), **largura do papel** (80 ou 58 mm) e as categorias que saem nela.
- [ ] Abrir a impressora e tocar em **Imprimir teste**. Conferir no papel:
  - [ ] Saiu? Se não saiu, veja o erro em Administração > Fila de impressão.
  - [ ] Os **acentos** estão certos ("Ação, pão, coração")? Se vieram trocados, mude "Acentuação" (CP860 → CP850 → Sem acentos) e teste de novo.
  - [ ] O texto ocupa a largura certa e o papel **cortou**?
- [ ] Configurações > **Impressora do caixa**: escolher a do caixa.

## Parte D — Celulares (~10 min por aparelho)

- [ ] Instalar o `certs\rootCA.crt` (só na primeira vez em cada aparelho):
  - **Android:** Configurações > Segurança > Criptografia e credenciais > Instalar certificado > Certificado de CA.
  - **iPhone:** envie o arquivo (AirDrop/e-mail), instale o perfil em Ajustes e **ative** em Ajustes > Geral > Sobre > Ajustes de Confiança de Certificado.
- [ ] Abrir `https://IP-DO-PC:3000`, entrar com o usuário do garçom e **Adicionar à tela inicial**.
- [ ] Atenção: se o endereço mudou desde a última instalação (IP ou porta), apague o ícone antigo da tela inicial e instale de novo pelo endereço novo.

---

## Parte E — Os testes

Anote em cada um: ✅ funcionou, ⚠️ funcionou com ressalva (anote qual) ou ❌ falhou (anote o que apareceu na tela, de preferência com foto).

### 1. Pedido simples e impressão por setor
- [ ] Garçom abre a mesa, cria uma comanda (nome + CPF) e lança 1 bebida e 1 porção.
- [ ] **Esperado:** o cupom da bebida sai no BAR e o da porção na COZINHA, com **mesa e nome** em destaque, em poucos segundos.
- [ ] A mesa fica verde no mapa.

### 2. Três garçons na mesma mesa ao mesmo tempo (SPEC 10, cenário 1)
- [ ] 3 celulares lançam pedidos na mesma mesa, quase juntos.
- [ ] **Esperado:** todos os cupons saem, nenhum duplicado, e o total da mesa soma tudo.

### 3. Sem Wi-Fi no celular (cenários 2 e 10)
- [ ] Num celular, **desligue o Wi-Fi** (fique sem dados móveis também).
- [ ] Abra uma comanda nova e lance **5 pedidos**. **Esperado:** o topo mostra "Offline · N pendentes" e nada imprime.
- [ ] Feche e abra o app ainda sem rede. **Esperado:** abre logado, com mapa e cardápio.
- [ ] Religue o Wi-Fi com o app **aberto**. **Esperado:** em até ~10 s, tudo é enviado, os cupons saem **uma vez cada**, na ordem.
- [ ] iPhone: só envia com o app aberto na tela. Confirme isso.

### 4. Servidor reiniciando no meio (cenário 3)
- [ ] Enquanto um garçom lança pedidos, pare o servidor (Ctrl+C no terminal) e rode `pnpm.cmd start` de novo.
- [ ] **Esperado:** o celular mostra "Offline", guarda os pedidos e envia quando o servidor volta. Nenhum pedido perdido ou duplicado.

### 5. Internet do bar cai, Wi-Fi local continua (cenário 4)
- [ ] Desconecte o cabo da **internet** do roteador (não o Wi-Fi).
- [ ] **Esperado:** tudo continua funcionando normalmente.

### 6. Impressora sem papel ou desligada (cenário 5)
- [ ] Desligue a impressora da cozinha e lance uma porção.
- [ ] **Esperado:** o caixa vê o alerta vermelho de impressora; a Fila mostra "Erro".
- [ ] Ligue de novo e toque em "Resolvido, tentar de novo" (ou espere até 1 min). **Esperado:** o cupom sai uma vez.

### 7. Pedido com 3 categorias (cenário 6)
- [ ] Um pedido com itens de 3 categorias ligadas a impressoras diferentes. **Esperado:** cada setor recebe só o seu.

### 8. Caixa: busca e pagamentos (cenário 7)
- [ ] Abrir o caixa com o fundo de troco.
- [ ] Buscar pela **mesa** e depois pelo **CPF** de um cliente. **Esperado:** pelo CPF aparece a mesa certa, com a pessoa já selecionada.
- [ ] Imprimir a **pré-conta**: confere itens, taxa e "NÃO É DOCUMENTO FISCAL".
- [ ] Pagamento parcial: **1/3 de um item** por item + o resto no **Pix** + **dinheiro com troco**.
- [ ] **Esperado:** cada parcial abate na hora, a comanda fecha ao zerar, o **cupom final** sai e a **gaveta abre** no dinheiro.
- [ ] Pedir um **desconto** logado como caixa. **Esperado:** pede o PIN do gerente.
- [ ] **Estornar** um pagamento (com PIN). **Esperado:** a comanda volta a ficar aberta.

### 9. Fechamento de caixa com diferença (cenário 8)
- [ ] Faça uma sangria e um suprimento (saem comprovantes).
- [ ] Feche o caixa informando um valor contado **diferente** do esperado.
- [ ] **Esperado:** mostra a sobra/falta correta e imprime o relatório.

---

## Se algo falhar

- **Não apague nada** do banco nem dos arquivos.
- Tire foto da tela e, se for impressão, da **Fila de impressão** (ela mostra o erro exato).
- Anote o horário. Depois me mande as anotações e investigamos com o log que aparece no terminal do servidor.

## Depois do teste

- [ ] Voltar `PRINT_MODE=emulador` e apagar as linhas `HTTPS_CERT`/`HTTPS_KEY` do `.env` para continuar desenvolvendo com `pnpm.cmd dev` (no desenvolvimento o HTTPS fica no Vite, porta 5173).
- [ ] Me passar a lista de ✅/⚠️/❌: ela decide o que corrigir antes da Fase 3 (instalador, backup, relatórios).
