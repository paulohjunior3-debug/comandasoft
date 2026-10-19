import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { loadConfig } from '../config';
import { createDb } from './client';
import { users } from './schema';

const config = loadConfig();
const conn = createDb(config.DATABASE_URL);
await conn.migrate();

const existing = await conn.db.select({ id: users.id }).from(users).where(eq(users.login, 'admin'));
if (existing.length > 0) {
  console.log('Usuário "admin" já existe. Nada a fazer.');
} else {
  const password = config.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
  await conn.db.insert(users).values({
    name: 'Administrador',
    login: 'admin',
    passwordHash: await hashPassword(password),
    role: 'ADMIN',
  });
  console.log('Usuário admin criado.');
  console.log('  login: admin');
  if (!config.SEED_ADMIN_PASSWORD) {
    console.log(`  senha: ${password}`);
    console.log('  Anote esta senha agora: ela não será mostrada de novo.');
  }
}
await conn.close();
