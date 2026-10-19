import { readFileSync } from 'node:fs';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';

const config = loadConfig();
const conn = createDb(config.DATABASE_URL);
await conn.migrate();

const https =
  config.HTTPS_CERT && config.HTTPS_KEY
    ? { cert: readFileSync(config.HTTPS_CERT), key: readFileSync(config.HTTPS_KEY) }
    : null;

const app = await buildApp({
  db: conn.db,
  jwtSecret: config.JWT_SECRET,
  fastify: {
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    ...(https ? { https } : {}),
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await conn.close();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
