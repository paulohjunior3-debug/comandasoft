// Comandos de manutenção usados pelo instalador e pelas tarefas agendadas.
// Instalado: node app\cli.mjs <comando>   ·   Desenvolvimento: pnpm --filter @sistema-bar/server cli <comando>
//
//   migrate                 aplica as migrations do banco
//   criar-admin             cria o usuário "admin" (mostra a senha uma única vez)
//   backup [--manter 30]    gera um backup do banco em data\backups e apaga os mais antigos que N dias
//   importar-cardapio <arq> importa categorias e produtos de um JSON (pode repetir sem duplicar)
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { ensureAdminUser } from './lib/admin-user';
import { importMenu } from './lib/import-menu';
import { paths } from './paths';

const run = promisify(execFile);

function pgTool(name: 'pg_dump' | 'pg_restore'): string {
  const fromEnv = process.env.PG_BIN && join(process.env.PG_BIN, `${name}.exe`);
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const v of ['17', '16']) {
    const p = `C:\\Program Files\\PostgreSQL\\${v}\\bin\\${name}.exe`;
    if (existsSync(p)) return p;
  }
  return name; // no PATH
}

async function backup(keepDays: number) {
  const config = loadConfig();
  const url = new URL(config.DATABASE_URL);
  const password = decodeURIComponent(url.password);
  url.password = ''; // a senha vai por variável de ambiente, não na linha de comando
  await mkdir(paths.backupsDir, { recursive: true });
  // Nome com a data/hora de Brasília: sistema_bar-20261019-1057.dump
  const local = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // "2026-10-19 10:57:00"
  const stamp = local.slice(0, 16).replace(/-/g, '').replace(' ', '-').replace(':', '');
  const file = join(paths.backupsDir, `sistema_bar-${stamp}.dump`);
  await run(pgTool('pg_dump'), ['--format=custom', '--no-owner', `--file=${file}`, `--dbname=${url.toString()}`], {
    env: { ...process.env, PGPASSWORD: password },
    timeout: 10 * 60_000,
    windowsHide: true,
  });
  const size = (await stat(file)).size;
  console.log(`Backup criado: ${file} (${(size / 1024).toFixed(0)} KB)`);

  // Retenção (SPEC 5.10): apaga backups mais antigos que N dias.
  const limit = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of await readdir(paths.backupsDir)) {
    if (!/^sistema_bar-.*\.dump$/.test(name)) continue;
    const full = join(paths.backupsDir, name);
    if ((await stat(full)).mtimeMs < limit) {
      await rm(full);
      console.log(`Backup antigo removido: ${name}`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

try {
  switch (command) {
    case 'migrate': {
      const conn = createDb(loadConfig().DATABASE_URL);
      await conn.migrate();
      await conn.close();
      console.log('Banco atualizado.');
      break;
    }
    case 'criar-admin': {
      const config = loadConfig();
      const conn = createDb(config.DATABASE_URL);
      await conn.migrate();
      const password = await ensureAdminUser(conn.db, config.SEED_ADMIN_PASSWORD);
      await conn.close();
      if (password === null) console.log('O usuário "admin" já existe.');
      else console.log(`ADMIN_CRIADO login=admin senha=${password}`);
      break;
    }
    case 'backup':
      await backup(Number(flag('--manter') ?? 30));
      break;
    case 'importar-cardapio': {
      const file = args[0];
      if (!file) throw new Error('Informe o arquivo do cardápio (.json).');
      const conn = createDb(loadConfig().DATABASE_URL);
      await conn.migrate();
      const r = await importMenu(conn.db, JSON.parse(readFileSync(resolve(file), 'utf8')), file);
      await conn.close();
      console.log(`Cardápio importado: ${r.categories} categorias, ${r.products} produtos (${r.created} novos, ${r.updated} atualizados).`);
      break;
    }
    default:
      console.error('Comandos: migrate | criar-admin | backup [--manter 30] | importar-cardapio <arquivo>');
      process.exit(2);
  }
} catch (err) {
  console.error(`ERRO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
