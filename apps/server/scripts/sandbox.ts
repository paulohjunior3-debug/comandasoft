// Modo sandbox: API completa sobre um PostgreSQL em memória (PGlite). Nada é gravado em disco.
// Útil para testar telas sem mexer no banco real.
//
// Uso: SANDBOX_PASSWORD=algumasenha PORT=3100 pnpm --filter @sistema-bar/server sandbox
// Cria o usuário "teste" (ADMIN) com a senha informada.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app';
import { emulatorTransport } from '../src/printing/transport';
import { hashPassword } from '../src/auth/password';
import { migrationsFolder, type Db } from '../src/db/client';
import * as schema from '../src/db/schema';

const password = process.env.SANDBOX_PASSWORD;
if (!password || password.length < 8) {
  console.error('Defina SANDBOX_PASSWORD (mínimo 8 caracteres).');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3100);

const pg = new PGlite();
const db = drizzle(pg, { schema, casing: 'snake_case' }) as unknown as Db;
await migrate(drizzle(pg), { migrationsFolder });
await db.insert(schema.users).values({
  name: 'Teste',
  login: 'teste',
  passwordHash: await hashPassword(password),
  role: 'ADMIN',
});

// SANDBOX_DEMO=1: cardápio, impressoras e mesas de exemplo para testar o app do garçom.
if (process.env.SANDBOX_DEMO === '1') {
  const [bar, cozinha] = await db
    .insert(schema.printers)
    .values([
      { name: 'Bar', windowsName: 'Demo Bar', sectorLabel: 'BAR' },
      { name: 'Cozinha', windowsName: 'Demo Cozinha', sectorLabel: 'COZINHA' },
    ])
    .returning();
  const menu: [string, string, string, [string, number][]][] = [
    ['Cervejas', '#f59e0b', bar!.id, [['Heineken 600ml', 1890], ['Original 600ml', 1590], ['Chopp 300ml', 1100]]],
    ['Drinks', '#ec4899', bar!.id, [['Caipirinha de limão', 2200], ['Gin tônica', 2900]]],
    ['Porções', '#22c55e', cozinha!.id, [['Batata frita', 3290], ['Calabresa acebolada', 3890], ['Frango a passarinho', 4290]]],
    ['Sem álcool', '#3b82f6', bar!.id, [['Refrigerante lata', 700], ['Água sem gás', 500]]],
  ];
  for (const [i, [name, color, printerId, items]] of menu.entries()) {
    const [cat] = await db.insert(schema.categories).values({ name, color, sortOrder: i }).returning();
    await db.insert(schema.printerCategories).values({ printerId, categoryId: cat!.id });
    await db.insert(schema.products).values(items.map(([n, priceCents]) => ({ categoryId: cat!.id, name: n, priceCents })));
  }
  await db.insert(schema.diningTables).values(
    Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      area: i < 8 ? 'Salão' : 'Varanda',
      capacity: 4,
      qrToken: randomBytes(8).toString('base64url'),
    })),
  );
}

const app = await buildApp({
  db,
  jwtSecret: randomBytes(48).toString('base64url'),
  cpfSecret: randomBytes(48).toString('base64url'),
  webDist: false,
  // Cupons do sandbox vão para data/impressoes-sandbox (nunca para impressora real).
  printTransport: emulatorTransport(fileURLToPath(new URL('../../../data/impressoes-sandbox', import.meta.url))),
});
await app.listen({ port, host: '127.0.0.1' });
await app.printWorker.start();
console.log(`Sandbox (banco em memória) em http://127.0.0.1:${port} — usuário: teste`);
