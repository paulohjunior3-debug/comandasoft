import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import type { Db } from '../db/client';
import { users } from '../db/schema';

/**
 * Garante o usuário "admin" inicial. Devolve a senha só quando acabou de criar
 * (gerada aleatoriamente se nenhuma for informada); null se já existia.
 */
export async function ensureAdminUser(db: Db, password?: string): Promise<string | null> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.login, 'admin'));
  if (existing.length > 0) return null;
  const pass = password ?? randomBytes(9).toString('base64url');
  await db.insert(users).values({ name: 'Administrador', login: 'admin', passwordHash: await hashPassword(pass), role: 'ADMIN' });
  return pass;
}
