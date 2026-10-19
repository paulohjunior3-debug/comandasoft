# Sistema Bar

Sistema de comandas, pedidos, impressão e caixa para bares e restaurantes. A especificação completa está em [SPEC.md](SPEC.md).

**Status:** Fases 0 e 1 concluídas no código. Fase 2 (caixa) pronta: abertura/fechamento com diferença, sangria/suprimento, busca por mesa ou CPF, pagamentos parciais (valor, item/fração, dividir por N), troco, descontos e estorno com PIN de gerente, pré-conta e cupom. Falta validar com impressoras Elgin reais.

## Estrutura

```
apps/server      API Fastify + Drizzle + PostgreSQL (porta 3000)
apps/web         PWA React + Vite + Tailwind (porta 5173 em desenvolvimento)
packages/shared  Schemas Zod e utilitários (CPF, dinheiro) usados pelos dois lados
packages/escpos  Cupons: comandos ESC/POS, acentuação (CP860/850/437) e prévia em texto
scripts/         Certificado HTTPS de desenvolvimento, ícones
```

## 1. Pré-requisitos (uma vez por máquina)

| Ferramenta | Como instalar |
|---|---|
| Node.js 22+ | já instalado (v24) |
| pnpm 10 | `npm install -g pnpm@10` |
| PostgreSQL 16 | veja abaixo |
| mkcert | `winget install FiloSottile.mkcert` (só para testar no celular) |

### Instalando o PostgreSQL 16 no Windows

1. Rode no PowerShell:
   ```powershell
   winget install PostgreSQL.PostgreSQL.16
   ```
   Ou baixe o instalador da EDB em https://www.postgresql.org/download/windows/.
2. Durante a instalação:
   - **Senha do superusuário `postgres`**: escolha uma e anote. Ela vai no `.env`.
   - **Porta**: deixe `5432`.
   - Stack Builder no final: pode desmarcar.
3. Adicione o `psql` ao PATH (opcional, mas útil): `C:\Program Files\PostgreSQL\16\bin`.
4. Crie o banco do sistema:
   ```powershell
   & "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres sistema_bar
   ```
   (vai pedir a senha do passo 2)

O PostgreSQL fica instalado como serviço do Windows e sobe sozinho junto com o PC.

## 2. Configurar o projeto

```powershell
pnpm install
copy .env.example .env
```

Edite o `.env`:
- `DATABASE_URL`: troque `SUA_SENHA` pela senha do `postgres`.
- `JWT_SECRET`: gere um com
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

Crie as tabelas e o usuário admin:

```powershell
pnpm db:seed
```

O seed mostra a senha do `admin` **uma única vez** no terminal (ou usa `SEED_ADMIN_PASSWORD` do `.env`, se preenchido).

## 3. Rodar em desenvolvimento

```powershell
pnpm dev
```

Sobe a API (http://localhost:3000) e a PWA (http://localhost:5173). Abra a PWA no navegador do PC e entre com `admin`.

## 4. Testar no celular (HTTPS na rede local)

PWA e Service Worker exigem HTTPS fora do `localhost`.

1. Instale o mkcert e gere o certificado:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\gerar-certificado.ps1
   ```
2. Instale `certs\rootCA.crt` no celular (o script mostra o passo a passo para Android e iPhone).
3. Rode `pnpm dev` de novo. Agora a PWA sobe em **https://IP-DO-PC:5173**.
4. Libere as portas no firewall do Windows (o script pede permissão de administrador):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\liberar-firewall.ps1
   ```
   As regras valem para rede Privada e Pública, mas **só aceitam aparelhos da mesma rede local**. Isso cobre o caso comum de o Windows marcar o Wi-Fi como "Público" e não deixar trocar.
5. No celular, conectado ao mesmo Wi-Fi, abra `https://IP-DO-PC:5173`, faça login e use "Adicionar à tela inicial".

## Instalar no PC do bar

Gere o pacote neste PC de desenvolvimento:

```powershell
pnpm.cmd empacotar
```

Sai `dist-instaladorSistemaBar-<versão>.zip` (~1,3 MB). No PC do caixa (Windows 10/11, com internet na hora de instalar): extraia o zip e dê dois cliques em **INSTALAR.bat**. O instalador:

- instala Node.js, PostgreSQL 16 e mkcert pelo `winget`, se faltarem;
- cria o banco, o `.env` com segredos aleatórios (protegido só para administradores) e o certificado HTTPS para os IPs do PC;
- cria as tabelas e o usuário `admin` (mostra a senha uma vez) e oferece importar o cardápio;
- libera a porta 3000 no firewall só para a rede local;
- agenda o servidor para iniciar com o Windows (reinicia sozinho se cair) e o backup diário às 3h (30 dias em `dataackups`).

Para atualizar: gere um pacote novo, extraia no PC do bar e rode **ATUALIZAR.bat** (faz backup antes e mantém `.env`, certificados e dados). Detalhes para quem instala: `instalador/LEIA-ME.txt`.

Comandos de manutenção (instalado: `node appcli.mjs <comando>`; desenvolvimento: `pnpm --filter @sistema-bar/server cli <comando>`): `migrate`, `criar-admin`, `backup [--manter 30]`, `importar-cardapio <arquivo.json>`.

## 5. Caixa

Em **Caixa** (perfis Caixa, Gerente e Admin):
1. Abra o caixa com o fundo de troco.
2. Busque pela **mesa** (ex.: `10`) ou pelo **CPF** do cliente; a lista ao lado mostra as mesas abertas, com as que pediram a conta em azul.
3. Escolha quem paga (uma, várias comandas ou a mesa inteira) e receba **por valor**, **dividido por N** ou **por item/fração** (ex.: 1/3 da pizza), em crédito, débito, Pix ou dinheiro (com troco).
4. Desconto, retirada da taxa de serviço/couvert e estorno pedem o **PIN de um gerente** quando quem está no caixa não é gerente. Cadastre o PIN em Administração > Usuários.
5. No fim do expediente, **Fechar caixa**: informe o dinheiro contado (e, se quiser, os totais de cartão/Pix) e veja a sobra ou falta.

Escolha a **impressora do caixa** em Administração > Configurações: nela saem a pré-conta, o cupom final, os comprovantes de sangria/suprimento, o relatório de fechamento e o comando da gaveta.

## 6. Impressoras

O modo de impressão fica no `.env`:

| `PRINT_MODE` | O que acontece |
|---|---|
| `emulador` (padrão) | Os cupons **não** vão para o papel: são gravados em `data/impressoes/<impressora>/` (.txt para ler, .bin com os bytes ESC/POS). Use para desenvolver sem impressora. |
| `windows` | Os cupons vão para as impressoras instaladas no Windows, pelo nome, em modo RAW. Use no PC do caixa. |

Para ligar uma impressora térmica (Elgin i7/i9 ou similar):
1. Instale-a no Windows com o driver do fabricante (rede ou USB) e confira o nome em Configurações > Impressoras.
2. No painel: **Administração > Impressoras > Nova impressora**, escolha-a na lista e marque as categorias que saem nela.
3. Troque `PRINT_MODE=windows` no `.env` e reinicie o servidor.
4. Abra a impressora no painel e toque em **Imprimir teste**. Se os acentos saírem trocados, mude a "Acentuação" (CP860 é o padrão das Elgin).

A **Fila de impressão** (menu da administração) mostra cada cupom, a prévia exata do papel, erros por impressora (ex.: sem papel), e permite tentar de novo ou reimprimir. Cupons com erro são tentados de novo sozinhos (5 s, 10 s, 20 s… até a cada 1 min); os da mesma impressora saem sempre na ordem.

## Problemas comuns

| Sintoma | Solução |
|---|---|
| `pnpm` não é reconhecido / scripts desabilitados no PowerShell | Use `pnpm.cmd` no lugar de `pnpm` (a política de execução padrão do Windows bloqueia o `pnpm.ps1`). |
| "Port 5173 is in use" e o Vite sobe em outra porta | Já existe um Vite rodando. Feche o terminal antigo ou encerre o processo `node` que usa a porta. |
| Celular não abre o endereço | Celular e PC no mesmo Wi-Fi; rode `scripts\liberar-firewall.ps1`; confira o IP do PC com `ipconfig`. Se o IP mudou, gere o certificado de novo. |
| Impressora não imprime nada (modo `windows`) | Veja o erro na Fila de impressão. "Impressora não encontrada": o nome no cadastro precisa ser igual ao do Windows. Impressoras PDF/XPS não aceitam modo RAW. |
| Celular avisa "conexão não é particular" | O `certs\rootCA.crt` não foi instalado (ou, no iPhone, a confiança total não foi ativada). |

## Comandos úteis

| Comando | O que faz |
|---|---|
| `pnpm dev` | API + PWA em modo desenvolvimento |
| `pnpm test` | Testes (Vitest; a API é testada com PGlite e a fila offline com IndexedDB simulado, sem precisar do PostgreSQL) |
| `pnpm typecheck` | Checagem de tipos em todos os pacotes |
| `pnpm build` | Build da PWA (a API passa a servi-la em `pnpm start`) |
| `pnpm db:generate` | Gera migration após alterar `apps/server/src/db/schema.ts` |
| `pnpm db:migrate` | Aplica migrations (a API também aplica ao iniciar) |
| `pnpm db:seed` | Cria o usuário admin, se não existir |
| `pnpm --filter @sistema-bar/server sandbox` | API com banco em memória para testes (precisa de `SANDBOX_PASSWORD`; usuário `teste`; `SANDBOX_DEMO=1` cria cardápio e mesas de exemplo) |
