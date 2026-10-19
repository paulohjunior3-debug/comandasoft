// Importa um cardápio de um arquivo JSON (ver src/lib/import-menu.ts).
// Uso: pnpm --filter @sistema-bar/server db:import-menu seeds/cardapio-esquina-da-tilapia.json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { importMenu } from '../src/lib/import-menu';

const file = process.argv[2];
if (!file) {
  console.error('Informe o arquivo: db:import-menu seeds/arquivo.json');
  process.exit(1);
}
const conn = createDb(loadConfig().DATABASE_URL);
await conn.migrate();
const r = await importMenu(conn.db, JSON.parse(readFileSync(resolve(file), 'utf8')), file);
await conn.close();
console.log(`Cardápio importado: ${r.categories} categorias, ${r.products} produtos (${r.created} novos, ${r.updated} atualizados).`);
console.log('Falta: vincular as categorias às impressoras em Administração > Impressoras.');
