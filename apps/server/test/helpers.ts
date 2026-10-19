import { PGlite } from '@electric-sql/pglite';
import type { InstalledPrinter, Role } from '@sistema-bar/shared';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { migrationsFolder, type Db } from '../src/db/client';
import * as schema from '../src/db/schema';

export const PASSWORD = 'senha-certa';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
  /** Faz login e devolve uma função `inject` já autenticada. */
  as: (login: string) => Promise<(opts: InjectOptions) => Promise<LightMyRequestResponse>>;
  installedPrinters: InstalledPrinter[];
}

/** App completo sobre um PostgreSQL em memória (PGlite), com um usuário por perfil. */
export async function createTestContext(): Promise<TestContext> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema, casing: 'snake_case' }) as unknown as Db;
  await migrate(drizzle(pg), { migrationsFolder });

  const passwordHash = await hashPassword(PASSWORD);
  const roles: [string, Role][] = [
    ['admin', 'ADMIN'],
    ['gerente', 'GERENTE'],
    ['caixa', 'CAIXA'],
    ['garcom', 'GARCOM'],
  ];
  await db.insert(schema.users).values(roles.map(([login, role]) => ({ name: login, login, passwordHash, role })));

  const installedPrinters: InstalledPrinter[] = [];
  const app = await buildApp({
    db,
    jwtSecret: 'x'.repeat(32),
    cpfSecret: 'c'.repeat(32),
    webDist: false,
    listInstalledPrinters: async () => installedPrinters,
  });

  return {
    app,
    db,
    installedPrinters,
    close: async () => {
      await app.close();
      await pg.close();
    },
    as: async (login) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: PASSWORD } });
      if (res.statusCode !== 200) throw new Error(`login ${login} falhou: ${res.body}`);
      const { accessToken } = res.json() as { accessToken: string };
      return (opts) => app.inject({ ...opts, headers: { ...opts.headers, authorization: `Bearer ${accessToken}` } });
    },
  };
}
