// Modo sandbox: API completa sobre um PostgreSQL em memória (PGlite). Nada é gravado em disco.
// Útil para testar telas sem mexer no banco real.
//
// Uso: SANDBOX_PASSWORD=algumasenha PORT=3100 pnpm --filter @sistema-bar/server sandbox
// Cria o usuário "teste" (ADMIN) com a senha informada.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app';
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

const app = await buildApp({ db, jwtSecret: randomBytes(48).toString('base64url'), webDist: false });
await app.listen({ port, host: '127.0.0.1' });
console.log(`Sandbox (banco em memória) em http://127.0.0.1:${port} — usuário: teste`);
