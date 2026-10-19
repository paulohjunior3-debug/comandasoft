# Sistema Garçom: Especificação Técnica (v1.1)

> **v1.1 (2026-10-18):** incorporadas as decisões do dono sobre os pontos em aberto (ver seção 12):
> comanda identificada por nome + mesa, busca no caixa por mesa ou CPF, taxa de serviço ligável pelo dono,
> CPF obrigatório com PIN do QR = 3 últimos dígitos, impressoras pelo nome no Windows, KDS e estoque como fases futuras.

> Documento de referência para desenvolvimento com Claude Code.
> Coloque este arquivo na raiz do repositório como `SPEC.md` e referencie no `CLAUDE.md`.

---

## 1. Visão geral

Sistema de gestão de atendimento para restaurante/bar, composto por:

1. **Servidor local** (PC do caixa, Windows 11): banco de dados, API, fila de impressão e painel administrativo/caixa.
2. **App do garçom** (PWA instalável em Android e iOS): abertura de comandas, lançamento de pedidos e mapa de mesas, **funcionando mesmo com queda de rede**.
3. **Cardápio/Comanda do cliente via QR Code**: o cliente vê o cardápio e, com o CPF, acompanha a própria comanda e o valor atual.
4. **Impressão roteada por categoria**: cada pedido é dividido e impresso na impressora certa (bar, cozinha, caixa).
5. **Caixa**: abertura/fechamento, sangria/suprimento, pagamentos parciais, múltiplas formas de pagamento e emissão opcional de NFC-e.

### 1.1 Premissas importantes

- **Queda de internet ≠ queda da rede local.** Garçons, servidor e impressoras conversam pela rede local (Wi-Fi/cabo do roteador). Se a internet cair, **o lançamento e a impressão continuam funcionando normalmente**. Só deixam de funcionar: emissão online de NFC-e, consulta do cliente por dados móveis (4G) e sincronização com a nuvem.
- **Queda da rede local** (Wi-Fi cai, servidor reinicia, garçom sai da área de cobertura): o app do garçom guarda os pedidos localmente (fila offline) e envia assim que reconectar. As impressões saem nesse momento.
- **Nobreak recomendado** para PC servidor, roteador e impressoras.

---

## 2. Stack tecnológica

| Camada | Tecnologia | Motivo |
|---|---|---|
| Linguagem | **TypeScript** em todo o projeto | Tipos compartilhados entre servidor e apps |
| Monorepo | **pnpm workspaces** | `apps/server`, `apps/web`, `packages/shared` |
| API | **Node.js 22 LTS + Fastify** | Leve, rápido, ótimo para rodar como serviço Windows |
| Tempo real | **Socket.IO** (ou `@fastify/websocket`) | Atualiza mapa de mesas, caixa e status de impressão ao vivo |
| Banco | **PostgreSQL 16** local | Robusto, transacional, mesmo modelo mental do Supabase |
| ORM | **Drizzle ORM** + drizzle-kit (migrations) | Tipado, SQL próximo, migrations versionadas |
| Validação | **Zod** (em `packages/shared`) | Mesmo schema validando front e back |
| Front-end | **React + Vite + vite-plugin-pwa (Workbox)** | SPA servida pelo próprio Fastify; PWA offline-first. Next.js não é necessário aqui |
| UI | **Tailwind CSS + shadcn/ui** | Rápido de montar, bom em telas de celular |
| Estado/servidor | **TanStack Query** | Cache, refetch e invalidação |
| Offline | **Dexie.js (IndexedDB)** | Fila de pedidos pendentes e cache do cardápio no celular |
| Auth | Senha com **argon2**, sessão via **JWT** (access curto + refresh) | Usuários criados no painel do PC |
| Impressão | **ESC/POS** enviado em modo RAW ao **spooler do Windows**, pela impressora instalada (rede ou USB) e identificada pelo nome | Padrão das Elgin i7/i9 e similares; uma única forma de envio para os dois tipos |
| Serviço Windows | **NSSM** ou `node-windows` | Servidor sobe sozinho com o Windows |
| Fiscal (fase 5) | API de emissor fiscal (ex.: **Nuvem Fiscal**, **Focus NFe**, **PlugNotas**) com certificado **A1 (.pfx)** | Evita implementar assinatura XML/SEFAZ do zero |
| Nuvem (fase 4, opcional) | **Supabase** | Espelho somente-leitura para o QR do cliente fora da rede local |
| Testes | **Vitest** (unit), **Playwright** (e2e) | |

---

## 3. Arquitetura

```
                    ┌──────────────── PC Caixa (Windows 11) ────────────────┐
 Celulares garçons  │  Fastify API  ──  PostgreSQL                          │
 (PWA, Wi-Fi) ─────►│      │                                                │
                    │      ├── Socket.IO (tempo real)                       │
 Painel Caixa/Admin │      ├── Print Worker (fila print_jobs) ──► Impressoras│
 (navegador no PC) ►│      │                                     (rede/USB) │
                    │      └── Sync Worker (fase 4) ──► Supabase (nuvem)    │
                    └───────────────────────────────────────────────────────┘
                                                        │
 Cliente (QR) ──► Wi-Fi do estabelecimento ─► servidor local
          └────► 4G/5G ─► espelho na nuvem (fase 4)
```

### 3.1 HTTPS na rede local (obrigatório para PWA)

Service Worker e instalação PWA **exigem HTTPS** (iOS especialmente). Opções:

- **Opção A (recomendada):** domínio próprio (ex.: `local.seudominio.com.br`) apontando para o IP fixo do servidor (ex.: `192.168.0.10`), com certificado **Let's Encrypt via desafio DNS-01** (Cloudflare). Configurar o **DNS local do roteador** (ou DHCP apontando DNS para o servidor) para resolver o nome sem internet. Nenhuma instalação nos celulares.
- **Opção B:** **mkcert** gerando uma CA própria; instalar a CA em cada celular (no iOS: instalar perfil + ativar "confiança total"). Funciona 100% offline, porém exige configuração por aparelho.

O servidor precisa de **IP fixo** (reserva DHCP no roteador).

### 3.2 Estrutura do repositório

```
/apps
  /server         Fastify, rotas, workers (print, sync, fiscal), migrations
  /web            React PWA: rotas /garcom, /caixa, /admin, /cliente
/packages
  /shared         Schemas Zod, tipos, enums, utilitários (dinheiro, CPF)
  /escpos         Gerador de layouts ESC/POS + emulador (preview em texto/HTML)
/scripts          Instalador Windows, backup, seed
SPEC.md
CLAUDE.md
```

Uma única PWA com rotas por perfil é mais simples de manter do que três apps.

---

## 4. Perfis de usuário e permissões

| Perfil | Pode |
|---|---|
| **Admin (dono)** | Tudo: cadastros, usuários, impressoras, configurações, relatórios, fiscal |
| **Gerente** | Cancelar itens, dar descontos, reabrir comanda, transferências, sangria |
| **Caixa** | Abrir/fechar caixa, receber pagamentos, sangria/suprimento, emitir NFC-e |
| **Garçom** | Abrir comanda, lançar pedidos, ver mesas, pedir fechamento, imprimir pré-conta |
| **Cliente** | Ver cardápio; com CPF, ver a própria comanda |

- Usuários **criados apenas no painel do PC** (admin), com login e senha.
- Ações sensíveis (cancelar item, desconto, estorno) exigem **senha/PIN de gerente** no momento da ação, registrada em auditoria.

---

## 5. Funcionalidades

### 5.1 Cadastros (Admin)

- **Categorias**: criadas pelo dono (ex.: Bebidas, Cervejas, Porções, Pratos, Sobremesas). Campos: nome, ordem de exibição, ativo, ícone/cor, **impressora(s) vinculada(s)**.
- **Produtos**: nome, descrição, foto, preço, categoria, código interno, ativo, **esgotado (toggle rápido)**, dados fiscais (NCM, CFOP, CSOSN/CST, unidade, origem) para NFC-e.
- **Adicionais/modificadores** *(melhoria)*: grupos tipo "Ponto da carne", "Adicionais" (com ou sem preço extra), mín./máx. de escolhas.
- **Mesas**: número, área (salão, varanda), capacidade, ativa, **token do QR** (aleatório, não sequencial).
- **Impressoras**: o admin escolhe numa **lista das impressoras instaladas no Windows do PC do caixa** (lidas automaticamente, rede ou USB, tanto faz) e define: apelido do setor que sai no cupom (ex.: BAR, COZINHA, CAIXA), largura (58/80 mm), página de código, guilhotina sim/não, ativa. Botão **"Imprimir teste"**. Se a impressora for renomeada/removida no Windows, o painel mostra alerta.
- **Vínculo Categoria × Impressora**: o dono informa, para cada categoria, em qual(is) impressora(s) ela sai (ex.: Cervejas → Bar; Porções → Cozinha). Muitos-para-muitos: uma categoria pode sair em mais de uma impressora (ex.: cozinha + expedição). Categoria sem impressora vinculada gera alerta no cadastro.
- **Usuários**: nome, login, senha, perfil, PIN de autorização, ativo.
- **Configurações**: **taxa de serviço** (liga/desliga pelo dono; quando ligada, 10%), tempos de alerta das mesas, couvert, dados da empresa, logo do cupom.

### 5.2 Comandas e mesas

- **Abertura de comanda**: **nome**, **CPF (obrigatório**, validado por dígito verificador), número da mesa e telefone (opcional).
- **Identificação**: cada pessoa da mesa abre a sua comanda. Exemplo: 5 pessoas na mesa 10 = 5 comandas na mesa 10.
  - **Número da mesa** = *para onde* o garçom/cumim leva o pedido.
  - **Nome do cliente** = *para quem* entregar. É o identificador principal da comanda em todas as telas e cupons.
  - O sistema ainda gera um **número interno sequencial** (referência técnica/auditoria), mas ele não é o que o garçom usa no dia a dia.
  - **Nomes repetidos na mesma mesa**: o app avisa e pede um complemento (sobrenome, inicial ou apelido), ex.: "Paulo H." e "Paulo S.".
- **Um CPF só pode ter uma comanda aberta por vez** (garante que a busca por CPF no caixa encontre exatamente uma comanda/mesa).
- Uma **mesa pode ter várias comandas**; cada comanda pertence a uma mesa.
- **Status da comanda**: `ABERTA` → `EM_FECHAMENTO` → `FECHADA` (ou `CANCELADA`).
- **Status da mesa** (derivado): `LIVRE` (sem comandas abertas), `OCUPADA`, `EM_FECHAMENTO` (quando **todas** as comandas abertas da mesa pediram fechamento; se só uma pessoa pediu a conta, a mesa continua ocupada e a comanda aparece marcada).
- *(Melhorias)*:
  - **Transferir itens** entre comandas e **transferir comanda** entre mesas.
  - **Juntar mesas**.
  - **Reabrir comanda** fechada (gerente).
  - **Observação na comanda** (ex.: "aniversariante").

### 5.3 App do garçom (PWA)

- Login com usuário e senha; sessão longa no aparelho.
- **Mapa de mesas** em grade, mostrando por mesa:
  - Número, **quantidade de comandas**, valor total, tempo desde o último atendimento.
  - **Cores por tempo sem atendimento** (limites configuráveis):
    - Cinza: livre
    - Verde: atendida há menos de 15 min
    - Amarelo: entre 15 e 30 min
    - Vermelho: mais de 30 min
    - Azul: em fechamento
  - "Último atendimento" = último pedido lançado **ou** toque em "Atendi a mesa" (registra visita sem pedido).
- **Clique na mesa** → lista de comandas pelo **nome do cliente**, total de cada uma, botão "Nova comanda".
- **Lançamento**: escolher comanda (ou várias, para lançar o mesmo item rateado) → navegar por categorias / buscar → quantidade, adicionais e **observação** ("sem cebola") → revisar → **Enviar**.
- Itens esgotados aparecem bloqueados.
- Ações: **solicitar fechamento** (mesa fica azul e avisa o caixa), **imprimir pré-conta**, ver histórico da comanda.
- Indicador de conexão sempre visível: **Online / Offline (N pedidos pendentes)**.
- *(Melhoria)* Notificação ao garçom quando o cliente **chamar pelo QR**.

### 5.4 Funcionamento offline (requisito crítico)

**Estratégia: Outbox local + idempotência no servidor.**

1. O app mantém em IndexedDB (Dexie): cardápio, categorias, mesas e comandas abertas (cache atualizado a cada sync e via Socket.IO).
2. Cada pedido recebe um **`client_uuid` gerado no celular** antes do envio.
3. Pedido vai para a tabela local `outbox` com status `PENDENTE` e aparece na tela como "aguardando envio".
4. Um sincronizador tenta enviar quando: o app abre, volta ao primeiro plano (`visibilitychange`), dispara o evento `online`, e a cada 10 s enquanto houver pendências.
5. O servidor faz **upsert por `client_uuid`**: reenviar o mesmo pedido **nunca duplica**.
6. Ao confirmar, o servidor grava o pedido **e** cria os `print_jobs` na mesma transação. A impressão sai nesse momento.
7. Abertura de comanda offline também passa pela outbox (com `client_uuid`); o número definitivo é atribuído pelo servidor e o app atualiza a referência local.
8. **Conflitos**: se a comanda foi fechada/cancelada enquanto o pedido estava pendente, o servidor rejeita com código específico e o app mostra alerta ao garçom para decidir (lançar em outra comanda ou descartar).
> **Implementado (fase 1):** `apps/web/src/lib/offline`. Online e com a fila vazia, o app envia na hora (erros como nome repetido aparecem no formulário); sem conexão, ou com algo já na fila, guarda e envia em ordem. Recusas do servidor (4xx) viram "conflito" na tela **Pendências**, onde o garçom lança em outra comanda, tenta de novo ou descarta. Pedidos podem referenciar a comanda pelo `clientUuid` da abertura offline. O app reabre sem rede com o último usuário e as telas em cache. Validações (CPF, nome repetido na mesa) rodam também no aparelho.

9. Atenção ao **iOS**: não há Background Sync API; o envio só acontece com o app aberto. Orientar o garçom a manter o app em primeiro plano e mostrar contador de pendências bem visível.
10. Preços no pedido offline são os do cache; o servidor grava o **preço vigente na hora do recebimento** e registra divergência em log (configurável: aceitar preço do celular ou do servidor).

### 5.5 Impressão

- **Roteamento**: ao receber um pedido, os itens são agrupados por impressora conforme o vínculo categoria × impressora. Um pedido com cerveja e porção gera um cupom no bar e outro na cozinha.
- **Fila persistente** (`print_jobs`): status `PENDENTE`, `IMPRIMINDO`, `OK`, `ERRO`; tentativas com backoff; reimpressão manual pelo painel.
- Impressora offline/sem papel → job fica pendente, **alerta no painel do caixa**, e imprime ao voltar. *(Melhoria)* Opção de redirecionar a fila para outra impressora.
- **Layout do cupom de produção** (80 mm, 48 colunas):
  - Destino (BAR / COZINHA) em fonte dupla
  - **MESA e NOME DO CLIENTE em destaque** (é o que o cumim precisa para entregar), garçom, data/hora
  - Pedido rateado entre várias comandas: lista todos os nomes
  - Itens: quantidade + nome em destaque, adicionais e **observações em negrito**
  - Marcação "REIMPRESSÃO" ou "CANCELAMENTO" quando aplicável
  - Corte de papel
- **Cupom de cancelamento** impresso automaticamente no setor quando um item é cancelado.
- **Pré-conta / conferência** (impressora do caixa): itens, subtotal, taxa de serviço, couvert, descontos, **pagamentos parciais já realizados (quem pagou, quanto, forma)** e **valor restante**. Rodapé: "NÃO É DOCUMENTO FISCAL".
- **Acentuação**: configurar página de código (testar CP860/CP850 nas Elgin) e remover acentos como fallback.
- **Gaveta de dinheiro**: comando ESC/POS de abertura via impressora do caixa.
- **Modo emulador** (dev): imprime em arquivo/preview HTML, permitindo desenvolver sem impressora.
- **Conexão**: toda impressora (rede ou USB) é **instalada no Windows do PC do caixa** com o driver do fabricante e identificada pelo **nome da instalação**. O worker envia os bytes ESC/POS em modo **RAW** para o spooler do Windows por esse nome (via API Win32 `WritePrinter`, chamada por módulo nativo ou utilitário de linha de comando). A lista de impressoras disponíveis é lida do Windows (`Get-Printer`).
  - *(Avançado, opcional)*: envio TCP direto na porta 9100 para impressoras de rede, caso o spooler dê problema.

### 5.6 Cardápio e comanda do cliente (QR Code)

- Cada mesa tem um QR com URL contendo o **token da mesa** (ex.: `/m/k3J9xQ`), nunca o número puro, para evitar que alguém espione outras mesas.
- **Sem autenticação**: cardápio com fotos, categorias, preços, itens esgotados ocultos.
- **Ver minha comanda**: lista as comandas da mesa com **nome mascarado** ("Pau*** H.") → cliente escolhe a sua → informa o **PIN = 3 últimos dígitos do CPF** → vê itens lançados, horários, valor atual, taxa de serviço, pagamentos parciais e restante.
- Segurança:
  - O PIN tem só 1.000 combinações, então o **rate limit é obrigatório**: 5 tentativas erradas por comanda a cada 10 min, mais limite por IP; após o limite, a comanda fica bloqueada para consulta pelo QR até o garçom liberar.
  - A consulta é **somente leitura** (não permite pedir nem pagar), o que mantém o risco baixo.
  - CPF nunca trafega/retorna completo; o servidor compara apenas com os 3 últimos dígitos guardados.
  - *(Se precisar endurecer no futuro)*: exigir CPF completo ou um PIN aleatório gerado na abertura.
- *(Melhorias)*: botão **"Chamar garçom"** e **"Pedir a conta"** (notifica o app do garçom e o caixa).
- **Alcance**:
  - Fases 1–3: funciona para clientes conectados ao **Wi-Fi do estabelecimento** (rede de convidados com acesso apenas ao servidor).
  - Fase 4: espelho na nuvem (Supabase) para funcionar também no 4G. O servidor local envia cardápio e comandas abertas (somente leitura). Sem internet, só o Wi-Fi local atende.
- **LGPD**: aviso de privacidade na abertura da comanda; finalidade do CPF (identificação e nota fiscal); política de retenção/anonimização configurável.

### 5.7 Caixa

#### Abertura e fechamento de caixa (sessão)

- **Abertura**: data/hora, operador, **fundo de troco (suprimento inicial)**.
  > Obs.: o valor deixado para troco na abertura é o *fundo de troco/suprimento*. **Sangria** é a retirada de dinheiro durante o expediente. O sistema terá os dois.
- **Movimentações**: **sangria** (retirada, com motivo) e **suprimento** (entrada de dinheiro), ambas com operador, horário e comprovante impresso.
- **Fechamento**: o sistema calcula o esperado por forma de pagamento; o operador informa o **valor contado** (no mínimo dinheiro; opcional para cartão/pix); o sistema mostra **diferença (sobra/falta)**; impressão do **relatório de fechamento**.
- Não permitir receber pagamentos sem caixa aberto. Alertar se houver comandas abertas no fechamento (permitir fechar mesmo assim, com confirmação).

#### Localizar a comanda no caixa

- **Pelo número da mesa**: o cliente diz "mesa 10" → a tela lista os **nomes** das comandas abertas da mesa 10 → o caixa seleciona a pessoa (ou várias / a mesa inteira).
- **Pelo CPF** (cliente esqueceu a mesa): o caixa digita o CPF → o sistema mostra a comanda aberta daquele CPF e **em qual mesa ela está**.
- CPF é enviado no corpo da requisição (nunca na URL) e buscado por hash.

#### Fechamento de comanda/mesa

- Selecionar **uma comanda, várias comandas ou a mesa inteira**.
- Mostrar itens, subtotal, **taxa de serviço**, couvert, **desconto** (valor ou %, com permissão), total, já pago, **restante**.
- **Taxa de serviço**: o dono liga ou desliga em Configurações. Ligada = **10%** aplicados automaticamente sobre os itens de toda comanda. Desligada = não aparece. Mesmo ligada, pode ser retirada de uma comanda específica (gerente, com motivo, em auditoria), pois o cliente tem o direito de recusar.
- **Formas de pagamento**: Crédito, Débito, Pix, Dinheiro (com **cálculo de troco**). *(Melhoria: vale-refeição e "outros", configuráveis.)*
- **Múltiplos pagamentos** na mesma conta (ex.: parte no Pix, parte no crédito).
- **Pagamento parcial**:
  - **Por valor livre**: informar valor, forma e **quem está pagando** (nome).
  - **Por item ou fração de item**: selecionar item(ns) e a fração (ex.: 1/3 da pizza); o sistema calcula o valor.
  - **Divisão igual** *(melhoria)*: dividir o restante por N pessoas.
  - Cada parcial **abate imediatamente** o total e aparece na comanda do cliente (QR), na pré-conta e no cupom final: **"Pago por Fulano: R$ X (Pix) | Restante: R$ Y"**.
- **Emitir NFC-e?** Escolha a cada pagamento/fechamento (padrão configurável), com opção **CPF na nota** (pré-preenchido com o CPF da comanda).
- Ao zerar o restante: comanda `FECHADA`, mesa liberada, cupom final impresso.
- **Estorno de pagamento**: gerente, com motivo, registrado em auditoria.

### 5.8 Fiscal: NFC-e (fase 5)

- Interpretação: "gerar receita" = emissão de **NFC-e** (Nota Fiscal de Consumidor Eletrônica, modelo 65).
- O estabelecimento **tem contador**. Requisitos a levantar com ele:
  - **Certificado digital A1** (.pfx + senha), cadastrado no painel (armazenado criptografado).
  - **Credenciamento na SEFAZ-MG** para NFC-e, **CSC** (ID e token).
  - Regime tributário, NCM/CFOP/CSOSN por produto, série e numeração.
  - Verificar os novos campos da **reforma tributária (IBS/CBS)** exigidos a partir de 2026.
- Implementação recomendada: **API de emissor fiscal** (Nuvem Fiscal, Focus NFe, PlugNotas). O servidor envia o JSON da venda, a API assina, transmite e devolve XML/DANFE.
- **DANFE NFC-e** impresso na impressora do caixa (com QR Code da consulta).
- **Sem internet**: registrar a venda e emitir **em contingência** (ou enfileirar para emissão posterior) conforme as regras e prazos da SEFAZ. Confirmar com o contador e com o provedor escolhido qual modo de contingência é suportado.
- Cancelamento de NFC-e dentro do prazo legal, com justificativa.
- Abstrair em uma interface `FiscalProvider` para trocar de provedor sem reescrever o caixa.

### 5.9 Relatórios (melhoria)

- Vendas por período, por forma de pagamento, por produto/categoria, por garçom (com **comissão/taxa de serviço por garçom**).
- Ticket médio, tempo médio de permanência por mesa, itens cancelados (com motivo e responsável).
- Histórico de sessões de caixa e diferenças.
- Exportação CSV/XLSX.

### 5.10 Auditoria, backup e operação

- **Log de auditoria** imutável: quem, quando, o quê (cancelamentos, descontos, estornos, reaberturas, alteração de preço, login).
- **Backup automático** diário do PostgreSQL (`pg_dump`) com retenção (ex.: 30 dias) e cópia opcional para nuvem/pendrive.
- **Painel de saúde**: status do banco, impressoras (online/erro), fila de impressão, internet, emissor fiscal, garçons conectados.
- **Instalador Windows**: script que instala Node, PostgreSQL, cria o banco, roda migrations, registra o serviço, configura o firewall (porta HTTPS) e cria o usuário admin inicial.
- **Atualização**: script de update com backup prévio e migrations automáticas.

### 5.11 KDS: tela de produção (fase futura)

- Roda no navegador em modo quiosque num **mini PC (tipo Intel NUC)** com monitor e **apenas mouse**, um por setor (cozinha, bar).
- Mostra os pedidos do setor em cartões, por ordem de chegada, com mesa, nome do cliente, itens, observações e tempo de espera.
- Ao terminar, o cozinheiro **clica no pedido → "Finalizado"** → sai um **ticket de entrega** com **número da mesa e nome do cliente** para o cumim levar.
- Pode funcionar junto com o papel de produção ou substituí-lo (configurável por setor).
- Exigirá status por item/pedido (`RECEBIDO`, `PRONTO`) e o evento Socket.IO `order.ready`. O modelo de dados atual já deve prever isso para não exigir retrabalho.

### 5.12 Fora do escopo atual

- **Controle de estoque e ficha técnica**: fase futura; nada de estoque nas fases 0 a 5.

---

## 6. Modelo de dados (inicial)

Todos os valores monetários em **centavos (integer)**. Todas as tabelas com `id` (uuid), `created_at`, `updated_at`.

```
users              (name, login, password_hash, role, pin_hash, active)
categories         (name, sort_order, color, active)
products           (category_id, name, description, image_url, price_cents, active, sold_out,
                    sku, ncm, cfop, csosn, unit, origin)
modifier_groups    (product_id, name, min, max)
modifiers          (group_id, name, price_cents)
printers           (name, windows_name, sector_label, width_mm, codepage, cut, active)
printer_categories (printer_id, category_id)
tables             (number, area, capacity, qr_token, active)
comandas           (number, table_id, customer_name, cpf_hmac, cpf_encrypted, cpf_last3,
                    phone, status, client_uuid, opened_by, opened_at, closing_requested_at,
                    closed_at, notes, qr_locked_until)
table_visits       (table_id, user_id, visited_at)            -- "atendi a mesa"
orders             (client_uuid UNIQUE, comanda_id, user_id, created_at_device, received_at)
order_items        (order_id, product_id, product_name_snapshot, category_id, qty,
                    unit_price_cents, notes, status[ATIVO|CANCELADO],
                    canceled_by, cancel_reason, canceled_at)
order_item_shares  (order_item_id, comanda_id, amount_cents)   -- parte de cada comanda no item
payments           (cash_session_id, method[CREDITO|DEBITO|PIX|DINHEIRO], amount_cents,
                    change_cents, payer_name, user_id, status[OK|ESTORNADO], fiscal_doc_id)
payment_comandas   (payment_id, comanda_id, amount_cents)     -- pagamento cobrindo várias comandas
payment_items      (payment_id, order_item_id, fraction, amount_cents)  -- parcial por item
adjustments        (comanda_id, type[TAXA_SERVICO|DESCONTO|COUVERT], amount_cents, reason, user_id)
cash_sessions      (opened_by, opened_at, opening_float_cents, closed_by, closed_at,
                    counted_json, expected_json, difference_cents)
cash_movements     (cash_session_id, type[SANGRIA|SUPRIMENTO], amount_cents, reason, user_id)
print_jobs         (printer_id, type[PRODUCAO|CANCELAMENTO|PRE_CONTA|CUPOM|DANFE|CAIXA],
                    payload, status, attempts, last_error, reference_id)
fiscal_documents   (payment_id, provider, status, number, series, key, xml_url, cpf, error)
audit_logs         (user_id, action, entity, entity_id, before_json, after_json, at)
settings           (key, value_json)
```

Regras-chave:
- **Saldo da comanda** = Σ itens ativos + ajustes − Σ pagamentos OK alocados. Calculado no servidor, nunca confiado ao cliente.
- `orders.client_uuid` e `comandas.client_uuid` com **UNIQUE** garantem idempotência offline.
- **CPF**: `cpf_hmac` (HMAC-SHA256 com segredo do servidor) permite a busca no caixa; `cpf_encrypted` (AES-GCM) guarda o CPF para "CPF na nota" da NFC-e; `cpf_last3` serve ao PIN do QR. O CPF em texto puro nunca é gravado.
- **Índice único parcial** em `comandas(cpf_hmac)` onde `status IN ('ABERTA','EM_FECHAMENTO')`: um CPF, uma comanda aberta.
- Taxa de serviço gravada como `adjustments` do tipo `TAXA_SERVICO` (10%) quando a configuração estiver ligada.
- **Rateio** (implementado na fase 1): cada item tem uma linha em `order_item_shares` por comanda. Item de uma comanda só = 1 linha com o valor cheio; rateado entre N comandas = N linhas que somam exatamente o total (os centavos que sobram vão para as primeiras). O saldo de itens da comanda é a soma das suas partes em itens ativos.
- **Número da comanda**: sequência interna contínua (`comandas.number`), usada só como referência; no dia a dia a comanda é o nome do cliente.
- Nome e preço do produto são **copiados (snapshot)** no item, para que alterações futuras no cardápio não mudem o histórico.

---

## 7. API (rascunho)

```
POST   /auth/login                 POST /auth/refresh
GET    /sync/bootstrap             (cardápio + mesas + comandas abertas para cache offline)
GET    /tables                     GET  /tables/:id/comandas
POST   /comandas/lookup            (caixa: { tableNumber } ou { cpf } no corpo)
POST   /comandas                   (idempotente via client_uuid)
POST   /comandas/:id/request-close
POST   /orders                     (idempotente via client_uuid; cria print_jobs)
POST   /order-items/:id/cancel     (requer PIN gerente)
POST   /order-items/transfer
POST   /tables/:id/visit
GET    /comandas/:id/bill          (pré-conta calculada)
POST   /payments                   POST /payments/:id/refund
POST   /cash-sessions/open         POST /cash-sessions/:id/close
POST   /cash-sessions/:id/movements
GET    /print-jobs                 POST /print-jobs/:id/retry
CRUD   /admin/{categories,products,printers,tables,users,settings}
GET    /admin/printers/installed   (impressoras instaladas no Windows)
POST   /admin/printers/:id/test
GET    /public/m/:qrToken/menu
GET    /public/m/:qrToken/comandas            (nomes mascarados)
POST   /public/m/:qrToken/comandas/:id/unlock (3 últimos dígitos do CPF → token curto de leitura)
POST   /public/m/:qrToken/call-waiter
GET    /health
```

> Fase 1: o mapa de mesas atualiza por consulta a cada 10 s. O Socket.IO entra quando o caixa e o KDS precisarem de atualização instantânea.

Eventos Socket.IO: `table.updated`, `comanda.updated`, `order.created`, `print.status`, `waiter.called`, `close.requested`.

---

## 8. Telas

**Garçom (celular):** Login · Mapa de mesas · Comandas da mesa · Nova comanda · Lançamento (categorias → itens → carrinho) · Revisão/envio · Pendências offline · Detalhe da comanda.

**Caixa (PC):** Abertura de caixa · Busca por mesa ou CPF · Mapa de mesas (visão caixa, destacando "em fechamento") · Fechamento de conta (pagamentos parciais) · Sangria/Suprimento · Fechamento de caixa · Fila de impressão.

**Admin (PC):** Dashboard · Categorias · Produtos · Adicionais · Mesas (com geração/impressão dos QR Codes em PDF) · Impressoras + vínculos · Usuários · Configurações · Fiscal · Relatórios · Auditoria · Backup.

**Cliente (celular):** Cardápio · Selecionar comanda · Desbloqueio por CPF · Minha comanda · Chamar garçom.

---

## 9. Roadmap de desenvolvimento

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **0. Fundação** | Monorepo, Fastify, Postgres, Drizzle, auth, PWA instalável com HTTPS local | Garçom faz login no celular via HTTPS na rede local |
| **1. Núcleo** | Cadastros, mesas/comandas, lançamento, **outbox offline**, roteamento e fila de impressão (+ emulador) | Pedido lançado com Wi-Fi desligado é impresso uma única vez ao reconectar |
| **2. Caixa** | Sessão de caixa, sangria/suprimento, fechamento com parciais, pré-conta/cupom, auditoria | Mesa com 3 pagamentos parciais fecha com saldo zero e cupom correto |
| **3. Operação** | Relatórios, backup, painel de saúde, instalador Windows, serviço automático | Instalação do zero em PC limpo em < 30 min |
| **4. Cliente/Nuvem** | QR do cliente (Wi-Fi local), depois espelho Supabase para 4G | Cliente vê a comanda pelo 4G com até 10 s de atraso |
| **5. Fiscal** | NFC-e via provedor, contingência, DANFE na impressora | NFC-e autorizada em homologação e impressa |
| **6. KDS (futuro)** | Tela de produção na cozinha/bar (ver 5.11) | Pedido aparece no KDS, clique em "Finalizado" imprime o ticket de entrega |
| **Futuro** | Controle de estoque / ficha técnica | Fora do escopo atual |

---

## 10. Plano de testes (ambiente do desenvolvedor)

- Servidor no PC de desenvolvimento (Windows 11), IP fixo, impressoras Elgin de teste (uma em rede, uma USB, se possível) e celulares Android + iPhone.
- **Cenários obrigatórios:**
  1. Lançamento simultâneo de 3 garçons na mesma mesa.
  2. Desligar o Wi-Fi do celular, lançar 5 pedidos, religar → todos impressos uma vez, na ordem.
  3. Reiniciar o servidor durante lançamentos → nenhum pedido perdido ou duplicado.
  4. Desconectar o cabo da internet do roteador → operação normal (exceto fiscal/nuvem).
  5. Impressora sem papel / desligada → fila retém e imprime ao voltar.
  6. Pedido com itens de 3 categorias → 3 cupons nas impressoras certas.
  7. Pagamento parcial por fração de item + Pix + dinheiro com troco.
  8. Fechamento de caixa com diferença.
  9. Força bruta no CPF do QR → bloqueado pelo rate limit.
  10. PWA instalada no iOS: abrir sem rede → app carrega com cardápio em cache.

---

## 11. Instruções para o Claude Code

- Ler este `SPEC.md` antes de qualquer tarefa; seguir o roadmap **fase a fase**, com commits pequenos.
- TypeScript estrito; schemas Zod em `packages/shared` são a fonte da verdade dos contratos.
- Dinheiro sempre em centavos (integer); nunca usar float para valores.
- Toda escrita vinda do app do garçom deve ser **idempotente** (`client_uuid`).
- Pedido + print_jobs na **mesma transação**.
- Toda ação sensível passa por checagem de permissão no servidor e grava `audit_logs`.
- Desenvolver impressão primeiro com o **emulador**; depois testar nas Elgin reais.
- Testes Vitest para cálculo de saldo, parciais, rateio e idempotência; Playwright para o fluxo de lançamento offline.
- Interface em **português (pt-BR)**, formato de moeda `R$ 1.234,56`, fuso `America/Sao_Paulo`.

**Prompt inicial sugerido:**
> Leia o SPEC.md. Execute a Fase 0: crie o monorepo pnpm com apps/server (Fastify + Drizzle + PostgreSQL), apps/web (React + Vite + vite-plugin-pwa + Tailwind + shadcn/ui) e packages/shared (Zod). Implemente autenticação com argon2 + JWT, seed de um usuário admin e configure HTTPS local com mkcert para desenvolvimento. Ao final, me passe os comandos para rodar e testar no celular.

---

## 12. Decisões e pontos em aberto

### Decidido (2026-10-18)

| Tema | Decisão |
|---|---|
| Identificação da comanda | Uma comanda por pessoa, aberta com nome + CPF + mesa. Mesa = onde entregar; nome = para quem. Caixa localiza por mesa (lista nomes) ou por CPF (mostra a mesa). Ver 5.2 e 5.7. |
| Taxa de serviço | Dono liga/desliga. Ligada = 10%. Ver 5.7. |
| CPF | Obrigatório na abertura. PIN do QR = 3 últimos dígitos do CPF, com rate limit. Ver 5.6. |
| Impressoras | Rede ou USB, instaladas no Windows do caixa e identificadas pelo nome; dono vincula categorias a impressoras. Ver 5.1 e 5.5. |
| KDS | Fase futura, em mini PC com mouse. Ver 5.11. |
| Contador | Existe; será consultado para a fase fiscal. |
| Estoque | Fase futura, fora do escopo atual. |

### Ainda em aberto

- Taxa de serviço: haverá **repasse/relatório por garçom**?
- Setores e impressoras reais do primeiro cliente (bar, cozinha, chapa, caixa?).
- Provedor fiscal, regime tributário, CSC e certificado A1 (com o contador, antes da fase 5).
- Número interno da comanda: reinicia por dia ou contínuo?
