# Licenciamento do Sistema Bar

> Desenho aprovado pelo dono em 21/10/2026 e implementado na 0.15.0. Ver a seção 9 (decisões) e
> `servidor-licencas/LEIA-ME.md` (implantação do Worker e comandos do dia a dia).

Objetivo: vender o sistema a outros estabelecimentos. O sistema só funciona com licença válida, e o dono
consegue desligar um cliente inadimplente sem ir até a loja. Nunca parar uma casa no meio do movimento,
e nunca prender os dados do cliente.

> **Limite honesto.** O servidor roda na máquina do cliente, em JavaScript. Quem souber programar consegue
> remover a checagem. A licença impede o uso casual (copiar o pacote para outro bar, continuar usando sem
> pagar). O que segura o cliente de verdade é o contrato, as atualizações e o suporte.

## 1. Peças

| Peça | Onde fica | O que faz |
|---|---|---|
| **Chave raiz** (Ed25519, privada) | Só com o dono, fora do repositório (pendrive + cópia) | Assina a **licença** de cada cliente |
| **Chave de renovação** (Ed25519, privada) | No servidor de licenças (segredo do Worker) | Assina os **leases** curtos |
| Chaves públicas das duas | Embutidas em `apps/server` | Conferir licença e lease |
| CLI `pnpm licenca` | Repositório, roda no PC do dono | Gerar chaves, emitir licença, emitir lease manual, suspender/reativar cliente |
| Servidor de licenças | Cloudflare Worker + KV (plano grátis) | Renova o lease uma vez por dia se o cliente estiver ativo |

Duas chaves para que um vazamento do Worker não permita criar clientes novos: o Worker só estende leases de
licenças que o dono já assinou com a chave raiz.

## 2. Arquivos

**Licença** (emitida uma vez por cliente; trocada só em mudança de contrato ou de máquina):

```
{ id, cliente, cnpj, maquina?, emitidaEm, validaAte?, recursos[], renovacao: "https://..." }
```

- `maquina`: impressão digital do PC (opcional; sem ela a licença roda em qualquer PC).
- `validaAte`: fim do contrato (opcional; sem ela vale enquanto houver lease).
- `recursos`: ex. `fiscal`, `cozinha`, `qr`. Na v1 só é registrado e mostrado, sem bloquear nada.

**Lease** (curto, renovado todo dia): `{ licencaId, maquina?, emitidoEm, validoAte }`, validade 15 dias.

Os dois vão como texto `SB1.<base64url do JSON>.<assinatura>` (dá para mandar por WhatsApp/e-mail e colar).
Ficam gravados no banco (`settings`, chave `licenca`), não em arquivo solto.

## 3. Estados e o que cada um bloqueia

Hora efetiva = `max(relógio do PC, maior horário já visto)`. O maior horário visto fica no banco e sobe a cada
10 min, a cada requisição de escrita e com o `emitidoEm` de cada lease. Atrasar o relógio do Windows não
devolve dias. Relógio adiantado por engano é absorvido (só antecipa o vencimento; o próximo lease corrige).

| Estado | Quando | Efeito |
|---|---|---|
| **Válida** | lease em dia | nada |
| **Aviso** | faltam ≤ 7 dias para o lease vencer (8 dias sem renovar) | faixa amarela no caixa e no admin: "A licença vence em N dias. Verifique a internet ou fale com o suporte." |
| **Carência** | lease vencido há até 3 dias | faixa vermelha, tudo funciona |
| **Bloqueada** | depois da carência, licença sem assinatura válida, máquina diferente ou `validaAte` passada | ver abaixo |

**Bloqueada** recusa só: abrir caixa, abrir comanda e lançar pedido (garçom e balcão), com a mensagem
"Licença vencida. Fale com o suporte: (contato)". O app do garçom mostra isso como conflito na fila, como
qualquer recusa do servidor.

**Nunca no meio do movimento:** se havia caixa aberto quando a licença bloqueou, o dia continua normal até
esse caixa fechar (limite de 24 h, para que um caixa nunca fechado não vire licença eterna).

**Sempre liberado:** login, fechar contas, receber pagamentos, estornos, fechar caixa, relatórios, exportações,
auditoria, XML/DANFE fiscal, painel da cozinha, fila de impressão, QR do cliente, cadastros, backup e a própria
tela de licença. Os dados são do cliente.

## 4. Renovação automática

- O servidor tenta renovar ao subir e a cada 6 h (falha silenciosa; quem avisa é o estado "Aviso").
- `POST {renovacao}/renovar` com `{ licencaId, maquina, versao }`. Nada de dados de clientes ou vendas.
- O Worker confere no KV: cliente ativo → devolve lease novo (15 dias); suspenso → `403` e o lease atual
  vence sozinho. Não existe desligamento instantâneo.
- Inadimplência: `pnpm licenca suspender <id>`. Pagou: `pnpm licenca reativar <id>` e o lease volta na
  próxima tentativa (ou o caixa clica "Renovar agora").
- Loja sem internet: o dono roda `pnpm licenca lease <id>` e manda o texto para colar na tela de licença.

## 5. Impressão digital da máquina

`SHA-256("sistema-bar|" + MachineGuid do Windows)`, mostrada em 4 grupos (`7F3A-91C2-0B5E-D4A8`).
O servidor lê o MachineGuid (`HKLM\SOFTWARE\Microsoft\Cryptography`) sozinho; não vem do `.env`, que o
cliente consegue editar. O instalador mostra o código no final e grava em `C:\SistemaBar\MAQUINA.txt` para o
cliente mandar ao dono. Troca de notebook = o dono emite licença nova.

## 6. Tela Admin › Licença

Cliente, CNPJ, recursos, estado com cor, validade do lease, última renovação (sucesso ou erro), código da
máquina. Botões: **Colar licença/lease** e **Renovar agora** (só Admin). Toda troca de licença, lease colado e
renovação recusada vai para `audit_logs`. Caixa e admin mostram a faixa de aviso/carência/bloqueio.

## 7. Instalação nova e a loja atual

- Instalação nova sem licença: **avaliação de 15 dias** contados da primeira subida (mesmas regras de aviso e
  bloqueio). Apagar o banco zera a avaliação, mas também apaga os dados, então não compensa.
- **Loja atual (0.14.x):** antes de atualizar para a versão com licença, o dono emite a licença dela
  (pode ser sem `validaAte` e com renovação desligada); a atualização mantém tudo como está.

## 8. Desenvolvimento e testes

- Checagem ligada só no servidor empacotado (`__SISTEMA_BAR_BUNDLE__`); `pnpm dev`, sandbox e testes ficam
  sem bloqueio, salvo os testes da licença, que injetam chaves de teste, relógio falso e um servidor de
  licenças falso (sem rede).
- Testes: assinatura adulterada, máquina errada, cada estado, relógio atrasado, caixa aberto antes do
  bloqueio, renovação aceita/recusada/offline, rotas sempre liberadas, auditoria.

## 9. Decisões do dono (21/10/2026)

1. Prazos: lease de 15 dias, aviso com 7 dias, carência de 3 dias, avaliação de 15 dias.
2. Servidor de licenças no Cloudflare Worker (conta do dono).
3. Licença presa à máquina por padrão (`--sem-maquina` só por exceção).
4. Contato de suporte: a informar. Fica em `suporte` no `config.json` da pasta das chaves e vai dentro de
   cada licença emitida (sem precisar de versão nova do sistema).

## 10. Onde está no código

| Parte | Arquivo |
|---|---|
| Formato, prazos e estados (puro) | `packages/shared/src/license.ts` |
| Assinatura Ed25519 (WebCrypto) | `apps/server/src/licensing/token.ts` |
| Chaves públicas embutidas | `apps/server/src/licensing/keys.ts` |
| Código da máquina | `apps/server/src/licensing/machine.ts`, `instalador/comum.ps1` (`Codigo-Maquina`) |
| Estado, bloqueio, renovação | `apps/server/src/licensing/service.ts` (`settings['licenca']`) |
| Worker | `apps/server/src/licensing/worker.ts`, `servidor-licencas/` |
| CLI do dono | `apps/server/scripts/licenca.ts` (`pnpm licenca`) |
| Tela e faixas | `apps/web/src/pages/admin/LicensePage.tsx`, `apps/web/src/components/LicenseBanner.tsx` |
| Testes | `apps/server/test/license.test.ts` |
