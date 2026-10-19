import { fileURLToPath } from 'node:url';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

/** Tipo comum ao driver real (postgres-js) e ao PGlite usado nos testes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return {
    db: db as Db,
    migrate: () => migrate(db, { migrationsFolder }),
    close: () => sql.end(),
  };
}
