import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp, defaultEmulatorDir } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { paths } from './paths';
import { emulatorTransport, windowsTransport } from './printing/transport';

const config = loadConfig();
const logFile = config.LOG_FILE ? paths.fromHome(config.LOG_FILE) : null;
if (logFile) mkdirSync(dirname(logFile), { recursive: true });
const conn = createDb(config.DATABASE_URL);
await conn.migrate();

const https =
  config.HTTPS_CERT && config.HTTPS_KEY
    ? { cert: readFileSync(paths.fromHome(config.HTTPS_CERT)), key: readFileSync(paths.fromHome(config.HTTPS_KEY)) }
    : null;

const app = await buildApp({
  db: conn.db,
  jwtSecret: config.JWT_SECRET,
  cpfSecret: config.CPF_SECRET,
  // Instalado, o log guarda só início, avisos e erros (cada requisição encheria o arquivo à toa).
  requestLogLevel: config.NODE_ENV === 'production' ? 'warn' : 'info',
  printTransport:
    config.PRINT_MODE === 'windows' ? windowsTransport() : emulatorTransport(config.PRINT_EMULATOR_DIR ?? defaultEmulatorDir),
  fastify: {
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      ...(logFile ? { file: logFile } : {}),
    },
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
