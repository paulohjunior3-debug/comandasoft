# Sistema Bar

Sistema de comandas, pedidos, impressão e caixa para bares e restaurantes. A especificação completa está em [SPEC.md](SPEC.md).

**Status:** Fase 0 (fundação): monorepo, API com login, banco e PWA instalável.

## Estrutura

```
apps/server      API Fastify + Drizzle + PostgreSQL (porta 3000)
apps/web         PWA React + Vite + Tailwind (porta 5173 em desenvolvimento)
packages/shared  Schemas Zod e utilitários (CPF, dinheiro) usados pelos dois lados
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

## Problemas comuns

| Sintoma | Solução |
|---|---|
| `pnpm` não é reconhecido / scripts desabilitados no PowerShell | Use `pnpm.cmd` no lugar de `pnpm` (a política de execução padrão do Windows bloqueia o `pnpm.ps1`). |
| "Port 5173 is in use" e o Vite sobe em outra porta | Já existe um Vite rodando. Feche o terminal antigo ou encerre o processo `node` que usa a porta. |
| Celular não abre o endereço | Celular e PC no mesmo Wi-Fi; rode `scripts\liberar-firewall.ps1`; confira o IP do PC com `ipconfig`. Se o IP mudou, gere o certificado de novo. |
| Celular avisa "conexão não é particular" | O `certs\rootCA.crt` não foi instalado (ou, no iPhone, a confiança total não foi ativada). |

## Comandos úteis

| Comando | O que faz |
|---|---|
| `pnpm dev` | API + PWA em modo desenvolvimento |
| `pnpm test` | Testes (Vitest; a API é testada com PGlite, sem precisar do PostgreSQL) |
| `pnpm typecheck` | Checagem de tipos em todos os pacotes |
| `pnpm build` | Build da PWA (a API passa a servi-la em `pnpm start`) |
| `pnpm db:generate` | Gera migration após alterar `apps/server/src/db/schema.ts` |
| `pnpm db:migrate` | Aplica migrations (a API também aplica ao iniciar) |
| `pnpm db:seed` | Cria o usuário admin, se não existir |
