import { loadConfig } from '../config';
import { ensureAdminUser } from '../lib/admin-user';
import { createDb } from './client';

const config = loadConfig();
const conn = createDb(config.DATABASE_URL);
await conn.migrate();

const password = await ensureAdminUser(conn.db, config.SEED_ADMIN_PASSWORD);
if (password === null) {
  console.log('Usuário "admin" já existe. Nada a fazer.');
} else {
  console.log('Usuário admin criado.');
  console.log('  login: admin');
  if (!config.SEED_ADMIN_PASSWORD) {
    console.log(`  senha: ${password}`);
    console.log('  Anote esta senha agora: ela não será mostrada de novo.');
  }
}
await conn.close();
