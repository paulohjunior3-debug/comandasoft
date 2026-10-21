// Ferramenta do dono para emitir e administrar licenças (docs/licenciamento.md). Não vai no pacote da loja.
// Uso (na raiz do repositório): pnpm licenca <comando>
//
//   chaves                         gera a chave raiz e a de renovação (uma vez só; guarde a pasta no pendrive)
//   emitir --cliente "Bar X" --cnpj 00.000.000/0001-00 --maquina XXXX-XXXX-XXXX-XXXX
//          [--sem-maquina] [--ate 2027-12-31] [--recursos fiscal,cozinha,qr] [--sem-renovacao] [--suporte "..."]
//   lease <id> [--dias 15]         lease manual para loja sem internet (o caixa cola em Administração > Licença)
//   verificar <texto>              mostra o conteúdo de uma licença ou lease e confere a assinatura
//   clientes                       lista os clientes no servidor de licenças
//   suspender <id> | reativar <id> para (ou volta) a renovação automática do cliente
//
// Pasta das chaves: %USERPROFILE%\SistemaBar-licencas (ou LICENCA_DIR). Nela, config.json guarda o endereço
// do servidor de licenças, o token do dono e o contato de suporte padrão.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LICENSE_TIMING, leasePayloadSchema, licensePayloadSchema, type LeasePayload, type LicensePayload } from '@sistema-bar/shared';
import { EMBEDDED_PUBLIC_KEYS } from '../src/licensing/keys';
import { generateKeyPair, importPrivateKey, importPublicKey, peekToken, signToken, verifyToken } from '../src/licensing/token';

const DAY_MS = 24 * 60 * 60 * 1000;
const dir = process.env.LICENCA_DIR ?? join(homedir(), 'SistemaBar-licencas');
const file = (name: string) => join(dir, name);

interface Config {
  servidor: string;
  tokenAdmin: string;
  suporte: string;
}
interface KeyFile {
  publicKey: string;
  privateKey: string;
}

function fail(message: string): never {
  console.error(`ERRO: ${message}`);
  process.exit(1);
}

function readJson<T>(name: string): T {
  if (!existsSync(file(name))) fail(`${file(name)} não existe. Rode "pnpm licenca chaves" primeiro.`);
  return JSON.parse(readFileSync(file(name), 'utf8')) as T;
}

async function workerApi(method: string, path: string, body?: unknown) {
  const config = readJson<Config>('config.json');
  if (!config.servidor) fail(`Preencha "servidor" em ${file('config.json')} (endereço do Worker).`);
  const res = await fetch(`${config.servidor.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.tokenAdmin}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) fail(`servidor de licenças respondeu ${res.status}: ${data.message ?? ''}`);
  return data;
}

const MACHINE = /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      cliente: { type: 'string' },
      cnpj: { type: 'string' },
      maquina: { type: 'string' },
      'sem-maquina': { type: 'boolean' },
      ate: { type: 'string' },
      recursos: { type: 'string' },
      'sem-renovacao': { type: 'boolean' },
      suporte: { type: 'string' },
      dias: { type: 'string' },
    },
  });

  switch (command) {
    case 'chaves': {
      if (existsSync(file('chave-raiz.json'))) fail(`Já existem chaves em ${dir}. Não sobrescrevo (as licenças emitidas dependem delas).`);
      mkdirSync(join(dir, 'clientes'), { recursive: true });
      const root = await generateKeyPair();
      const renewal = await generateKeyPair();
      writeFileSync(file('chave-raiz.json'), JSON.stringify(root, null, 2));
      writeFileSync(file('chave-renovacao.json'), JSON.stringify(renewal, null, 2));
      const config: Config = { servidor: '', tokenAdmin: randomBytes(32).toString('base64url'), suporte: '' };
      writeFileSync(file('config.json'), JSON.stringify(config, null, 2));
      console.log(`Chaves criadas em ${dir}. Guarde uma cópia desta pasta num pendrive: sem a chave raiz não dá para emitir licenças.`);
      console.log('\nCole em apps/server/src/licensing/keys.ts (EMBEDDED_PUBLIC_KEYS):');
      console.log(`  root: ['${root.publicKey}'],\n  renewal: ['${renewal.publicKey}'],`);
      console.log('\nSegredos do Worker (servidor-licencas/LEIA-ME.md):');
      console.log(`  CHAVE_RENOVACAO = conteúdo de "privateKey" em chave-renovacao.json`);
      console.log(`  TOKEN_ADMIN     = "tokenAdmin" de config.json`);
      return;
    }

    case 'emitir': {
      const config = readJson<Config>('config.json');
      const root = readJson<KeyFile>('chave-raiz.json');
      if (!values.cliente) fail('Informe --cliente "Nome do estabelecimento".');
      const cnpj = (values.cnpj ?? '').replace(/\D/g, '');
      if (cnpj.length !== 14) fail('Informe --cnpj com 14 números.');
      const maquina = values['sem-maquina'] ? null : (values.maquina ?? '').trim().toUpperCase();
      if (maquina !== null && !MACHINE.test(maquina)) {
        fail('Informe --maquina XXXX-XXXX-XXXX-XXXX (o instalador mostra e grava em MAQUINA.txt) ou --sem-maquina.');
      }
      const renovacao = values['sem-renovacao'] ? null : config.servidor || null;
      if (!values['sem-renovacao'] && !renovacao) fail(`Preencha "servidor" em ${file('config.json')} ou use --sem-renovacao.`);
      const validaAte = values.ate ? new Date(`${values.ate}T23:59:59-03:00`) : null;
      if (validaAte && Number.isNaN(validaAte.getTime())) fail('--ate deve ser uma data AAAA-MM-DD.');
      const license: LicensePayload = licensePayloadSchema.parse({
        tipo: 'licenca',
        id: `L${randomBytes(5).toString('hex').toUpperCase()}`,
        cliente: values.cliente,
        cnpj: cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
        maquina,
        emitidaEm: new Date().toISOString(),
        validaAte: validaAte?.toISOString() ?? null,
        recursos: (values.recursos ?? 'fiscal,cozinha,qr').split(',').map((r) => r.trim()).filter(Boolean),
        renovacao,
        suporte: values.suporte ?? (config.suporte || null),
      });
      const token = await signToken(license, await importPrivateKey(root.privateKey));
      mkdirSync(join(dir, 'clientes'), { recursive: true });
      writeFileSync(file(`clientes/${license.id}.json`), JSON.stringify({ license, token }, null, 2));
      if (renovacao) {
        await workerApi('PUT', `/admin/clientes/${license.id}`, { cliente: license.cliente, cnpj: license.cnpj, maquina });
        console.log('Cliente cadastrado no servidor de licenças (ativo).');
      }
      console.log(`\nLicença ${license.id} para ${license.cliente} (guardada em clientes/${license.id}.json).`);
      console.log('Cole o texto abaixo em Administração > Licença:\n');
      console.log(token);
      return;
    }

    case 'lease': {
      const id = positionals[0] ?? fail('Informe o id da licença (ex.: pnpm licenca lease L1A2B3C4D5).');
      const saved = readJson<{ license: LicensePayload }>(`clientes/${id}.json`);
      const renewal = readJson<KeyFile>('chave-renovacao.json');
      const days = Number(values.dias ?? LICENSE_TIMING.leaseDays);
      if (!(days > 0 && days <= 60)) fail('--dias entre 1 e 60.');
      const now = new Date();
      const lease: LeasePayload = {
        tipo: 'lease',
        licencaId: saved.license.id,
        maquina: saved.license.maquina,
        emitidoEm: now.toISOString(),
        validoAte: new Date(now.getTime() + days * DAY_MS).toISOString(),
      };
      console.log(`Lease de ${days} dia(s) para ${saved.license.cliente}. Cole em Administração > Licença:\n`);
      console.log(await signToken(lease, await importPrivateKey(renewal.privateKey)));
      return;
    }

    case 'verificar': {
      const token = positionals[0] ?? fail('Informe o texto (SB1....).');
      const keys = {
        root: await Promise.all(EMBEDDED_PUBLIC_KEYS.root.map(importPublicKey)),
        renewal: await Promise.all(EMBEDDED_PUBLIC_KEYS.renewal.map(importPublicKey)),
      };
      const peek = peekToken(token) as { tipo?: string } | null;
      if (!peek) fail('Texto inválido.');
      const ok = await verifyToken(token, peek.tipo === 'licenca' ? keys.root : [...keys.renewal, ...keys.root]);
      const parsed = (peek.tipo === 'licenca' ? licensePayloadSchema : leasePayloadSchema).safeParse(peek);
      console.log(JSON.stringify(peek, null, 2));
      console.log(ok && parsed.success ? '\nAssinatura OK (chaves embutidas no servidor).' : '\nASSINATURA INVÁLIDA ou formato desconhecido.');
      return;
    }

    case 'clientes': {
      const list = (await workerApi('GET', '/admin/clientes')) as unknown as {
        id: string;
        cliente: string;
        ativo: boolean;
        ultimaRenovacao: { em: string; versao: string | null } | null;
      }[];
      for (const c of list) {
        const last = c.ultimaRenovacao ? `${c.ultimaRenovacao.em} (v${c.ultimaRenovacao.versao ?? '?'})` : 'nunca';
        console.log(`${c.id}  ${c.ativo ? 'ATIVO    ' : 'SUSPENSO '}  ${c.cliente}  · última renovação: ${last}`);
      }
      if (list.length === 0) console.log('Nenhum cliente cadastrado.');
      return;
    }

    case 'suspender':
    case 'reativar': {
      const id = positionals[0] ?? fail(`Informe o id da licença (pnpm licenca ${command} L1A2B3C4D5).`);
      await workerApi('POST', `/admin/clientes/${id}/${command}`);
      console.log(
        command === 'suspender'
          ? `${id} suspenso. O lease atual vence sozinho (até ${LICENSE_TIMING.leaseDays} dias, mais ${LICENSE_TIMING.graceDays} de carência).`
          : `${id} reativado. A loja renova na próxima tentativa (ou em "Renovar agora").`,
      );
      return;
    }

    default:
      console.log('Comandos: chaves | emitir | lease <id> | verificar <texto> | clientes | suspender <id> | reativar <id>');
      console.log('Detalhes no começo de apps/server/scripts/licenca.ts e em docs/licenciamento.md.');
  }
}

await main();
