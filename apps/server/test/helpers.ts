import { PGlite } from '@electric-sql/pglite';
import type { InstalledPrinter, Role } from '@sistema-bar/shared';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildAppOptions } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { migrationsFolder, type Db } from '../src/db/client';
import * as schema from '../src/db/schema';
import type { PrintTransport } from '../src/printing/transport';

export const PASSWORD = 'senha-certa';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
  /** Faz login e devolve uma função `inject` já autenticada. */
  as: (login: string) => Promise<(opts: InjectOptions) => Promise<LightMyRequestResponse>>;
  installedPrinters: InstalledPrinter[];
  /** O que o transporte falso "imprimiu", em ordem. */
  printed: { printer: string; jobId: string; preview: string; bytes: Uint8Array }[];
  /** Impressoras (pelo windowsName) que devem falhar, com a mensagem de erro. */
  failing: Map<string, string>;
}

/** App completo sobre um PostgreSQL em memória (PGlite), com um usuário por perfil. */
export async function createTestContext(options: Pick<BuildAppOptions, 'license' | 'sefazTransport'> = {}): Promise<TestContext> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema, casing: 'snake_case' }) as unknown as Db;
  await migrate(drizzle(pg), { migrationsFolder });

  const passwordHash = await hashPassword(PASSWORD);
  const roles: [string, Role][] = [
    ['admin', 'ADMIN'],
    ['gerente', 'GERENTE'],
    ['caixa', 'CAIXA'],
    ['garcom', 'GARCOM'],
    ['cozinha', 'COZINHA'],
  ];
  await db.insert(schema.users).values(roles.map(([login, role]) => ({ name: login, login, passwordHash, role })));

  const installedPrinters: InstalledPrinter[] = [];
  const printed: TestContext['printed'] = [];
  const failing = new Map<string, string>();
  const printTransport: PrintTransport = {
    mode: 'emulador',
    async send(printer, job) {
      const error = failing.get(printer.windowsName);
      if (error) throw new Error(error);
      printed.push({ printer: printer.name, jobId: job.id, preview: job.preview, bytes: job.bytes });
    },
  };
  const app = await buildApp({
    db,
    jwtSecret: 'x'.repeat(32),
    cpfSecret: 'c'.repeat(32),
    webDist: false,
    listInstalledPrinters: async () => installedPrinters,
    printTransport,
    ...options,
  });

  return {
    app,
    db,
    installedPrinters,
    printed,
    failing,
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
