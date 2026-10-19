# CLAUDE.md

Leia [SPEC.md](SPEC.md) antes de qualquer tarefa. Ela é a fonte da verdade do produto; a seção 12 registra as decisões do dono. Siga o roadmap (seção 9) fase a fase.

## Projeto

Monorepo pnpm (Node 22+, TypeScript estrito):
- `apps/server`: Fastify 5 + Drizzle ORM + PostgreSQL. Rotas sob `/api`. `buildApp()` em `src/app.ts` recebe as dependências (db, segredo) para ser testável.
- `apps/web`: React 19 + Vite 7 + Tailwind 4 + vite-plugin-pwa. Em dev, o Vite faz proxy de `/api` para a porta 3000.
- `packages/shared`: schemas Zod e utilitários. Contratos de API são definidos aqui e importados pelos dois lados.

## Comandos

- `pnpm test`, `pnpm typecheck`: rode os dois antes de concluir uma tarefa.
- Alterou `apps/server/src/db/schema.ts`? Rode `pnpm db:generate` e versione a migration gerada em `apps/server/drizzle/`.

## Regras

- Dinheiro sempre em centavos (inteiro). Use `formatBRL`/`percentOf` de `@sistema-bar/shared`.
- Escritas do app do garçom são idempotentes por `client_uuid`. Pedido + `print_jobs` na mesma transação.
- Ação sensível: checar permissão no servidor (`guards.requireRole`) e gravar em `audit_logs`.
- CPF nunca em texto puro no banco nem na URL (ver SPEC seção 6).
- Interface e mensagens de erro em pt-BR; fuso `America/Sao_Paulo`.
- Testes da API usam PGlite em memória (`apps/server/test`); não dependem de PostgreSQL instalado.
- Dependências: as versões foram fixadas em majors estáveis (TS 5, Vite 7, Vitest 3, React Router 7). Não suba major sem pedir.
