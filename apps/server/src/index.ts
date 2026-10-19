import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, defaultEmulatorDir } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { emulatorTransport, windowsTransport } from './printing/transport';

// Caminhos relativos do .env (ex.: certs/dev-cert.pem) valem a partir da raiz do projeto.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const fromRoot = (p: string) => resolve(root, p);

const config = loadConfig();
const conn = createDb(config.DATABASE_URL);
await conn.migrate();

const https =
  config.HTTPS_CERT && config.HTTPS_KEY
    ? { cert: readFileSync(fromRoot(config.HTTPS_CERT)), key: readFileSync(fromRoot(config.HTTPS_KEY)) }
    : null;

const app = await buildApp({
  db: conn.db,
  jwtSecret: config.JWT_SECRET,
  cpfSecret: config.CPF_SECRET,
  printTransport:
    config.PRINT_MODE === 'windows' ? windowsTransport() : emulatorTransport(config.PRINT_EMULATOR_DIR ?? defaultEmulatorDir),
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
await app.printWorker.start();
app.log.info(`Impressão: modo ${config.PRINT_MODE}`);
