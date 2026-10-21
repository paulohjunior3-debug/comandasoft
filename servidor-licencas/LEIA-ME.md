# Servidor de licenças (Cloudflare Worker)

Renova uma vez por dia o lease de cada loja ativa. Código em `apps/server/src/licensing/worker.ts`;
desenho em `docs/licenciamento.md`. Plano grátis do Cloudflare (Workers + KV) é suficiente.

## Uma vez só

1. Crie uma conta em https://dash.cloudflare.com (grátis).
2. Gere as chaves, se ainda não gerou: `pnpm licenca chaves` (pasta `%USERPROFILE%\SistemaBar-licencas`).
   **Guarde uma cópia dessa pasta num pendrive.** Sem a chave raiz não dá para emitir licenças.
3. Nesta pasta (`servidor-licencas`):

   ```
   npx wrangler login
   npx wrangler kv namespace create LICENCAS
   ```

   Copie o `id` mostrado para `wrangler.toml` (no lugar de `COLE_AQUI_O_ID_DO_KV`).
4. Segredos (cada comando pede o valor):

   ```
   npx wrangler secret put CHAVE_RENOVACAO   # "privateKey" de chave-renovacao.json
   npx wrangler secret put TOKEN_ADMIN       # "tokenAdmin" de config.json
   ```

5. Publique: `npx wrangler deploy`. Ele mostra o endereço, algo como
   `https://sistema-bar-licencas.<sua-conta>.workers.dev`.
6. Coloque esse endereço em `"servidor"` no `config.json` da pasta das chaves, e o contato de suporte em
   `"suporte"` (aparece nos avisos e no bloqueio das lojas).

## Dia a dia (na raiz do repositório)

| Quero… | Comando |
|---|---|
| Licenciar uma loja nova | `pnpm licenca emitir --cliente "Bar X" --cnpj 00.000.000/0001-00 --maquina XXXX-XXXX-XXXX-XXXX` |
| Ver as lojas e a última renovação | `pnpm licenca clientes` |
| Inadimplente | `pnpm licenca suspender <id>` (o lease vence sozinho em até 15 dias + 3 de carência) |
| Pagou | `pnpm licenca reativar <id>` (a loja volta na próxima renovação, ou em "Renovar agora") |
| Loja sem internet | `pnpm licenca lease <id>` e mande o texto para colar em Administração > Licença |
| Trocou o computador da loja | `pnpm licenca emitir ...` de novo com o código novo (MAQUINA.txt) |

O código da máquina aparece no fim do INSTALAR/ATUALIZAR, em `C:\SistemaBar\MAQUINA.txt` e em Administração > Licença.
