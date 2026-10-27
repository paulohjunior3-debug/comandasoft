import { mkdirSync, readFileSync } from 'node:fs';
import { createSecureContext, type SecureContext } from 'node:tls';
import { dirname } from 'node:path';
import { buildApp, defaultEmulatorDir } from './app';
import { buildPublicApp } from './public-app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { startDomainCert } from './lib/domain-cert';
import { listenExtraHttps } from './lib/extra-port';
import { paths } from './paths';
import { emulatorTransport, windowsTransport } from './printing/transport';

const config = loadConfig();
const logFile = config.LOG_FILE ? paths.fromHome(config.LOG_FILE) : null;
if (logFile) mkdirSync(dirname(logFile), { recursive: true });
const conn = createDb(config.DATABASE_URL);
await conn.migrate();

// Endereço próprio: quem chega pelo nome (SNI) recebe o certificado da Let's Encrypt; pelo IP,
// continua o certificado do próprio sistema (aparelhos que já instalaram seguem funcionando).
let domainContext: SecureContext | null = null;
const domain = config.DOMINIO && config.CLOUDFLARE_TOKEN ? config.DOMINIO : null;
const https =
  config.HTTPS_CERT && config.HTTPS_KEY
    ? {
        cert: readFileSync(paths.fromHome(config.HTTPS_CERT)),
        key: readFileSync(paths.fromHome(config.HTTPS_KEY)),
        SNICallback: (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) =>
          cb(null, domain && domainContext && servername.toLowerCase() === domain ? domainContext : undefined),
      }
    : null;

const app = await buildApp({
  db: conn.db,
  jwtSecret: config.JWT_SECRET,
  cpfSecret: config.CPF_SECRET,
  publicPort: config.PUBLIC_PORT ?? null,
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

// QR do cliente em HTTP, numa porta só dele (SPEC 5.6).
const publicApp = config.PUBLIC_PORT
  ? await buildPublicApp({ db: conn.db, jwtSecret: config.JWT_SECRET, mainPort: config.PORT, fastify: { loggerInstance: app.log } })
  : null;

let extraServer: import('node:https').Server | null = null;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    extraServer?.close();
    await publicApp?.close();
    await app.close();
    await conn.close();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
await app.printWorker.start();
if (publicApp && config.PUBLIC_PORT) {
  await publicApp.listen({ port: config.PUBLIC_PORT, host: config.HOST });
  app.log.info(`QR do cliente: http na porta ${config.PUBLIC_PORT}`);
}
app.log.info(`Impressão: modo ${config.PRINT_MODE}`);
if (domain && https) {
  // O timer de renovação não segura o processo (unref): parar o serviço não espera por ele.
  startDomainCert({
    hostname: domain,
    token: config.CLOUDFLARE_TOKEN!,
    dir: paths.fromHome('certs/dominio'),
    email: config.ACME_EMAIL,
    staging: config.ACME_STAGING === '1',
    log: app.log,
    onCert: (c) => {
      domainContext = createSecureContext({ cert: c.cert, key: c.key });
    },
  });
  // Porta padrão do HTTPS: o endereço fica sem ":8443" (o com a porta continua valendo).
  const extraPort = config.EXTRA_HTTPS_PORT ?? 443;
  if (extraPort && extraPort !== config.PORT) extraServer = await listenExtraHttps(app, https, extraPort, config.HOST);
  app.log.info(`Endereço próprio: https://${domain}${extraServer ? '' : `:${config.PORT}`}`);
}
