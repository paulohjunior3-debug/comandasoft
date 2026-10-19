import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { createGuards, type Guards } from './auth/guard';
import { createTokenService, type TokenService } from './auth/tokens';
import type { Db } from './db/client';
import { appVersion, paths } from './paths';
import { createCpfVault, type CpfVault } from './lib/cpf-vault';
import { frameworkMessage, HttpError, mapDbError, validationMessage } from './lib/errors';
import { emulatorTransport, type PrintTransport } from './printing/transport';
import { createPrintWorker, type PrintWorker } from './printing/worker';
import { cachedLister, listWindowsPrinters, type ListInstalledPrinters } from './printing/windows-printers';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { cashierRoutes } from './routes/cashier';
import { printRoutes } from './routes/print';
import { waiterRoutes } from './routes/waiter';

declare module 'fastify' {
  interface FastifyInstance {
    printWorker: AppDeps['printWorker'];
  }
}

export interface AppDeps {
  db: Db;
  tokens: TokenService;
  guards: Guards;
  listInstalledPrinters: ListInstalledPrinters;
  cpf: CpfVault;
  printWorker: PrintWorker & { mode: PrintTransport['mode'] };
}

export interface BuildAppOptions {
  db: Db;
  jwtSecret: string;
  /** Nível do log de cada requisição. Instalado: 'warn' (só avisos e erros), para o log não encher. */
  requestLogLevel?: 'debug' | 'info' | 'warn';
  cpfSecret: string;
  fastify?: FastifyServerOptions;
  /** Pasta do build da PWA. Padrão: apps/web/dist, se existir. `false` desliga. */
  webDist?: string | false;
  /** Para onde vão os cupons. Padrão: emulador em data/impressoes. */
  printTransport?: PrintTransport;
  /** Substituível nos testes; padrão: impressoras do Windows. */
  listInstalledPrinters?: ListInstalledPrinters;
}

const defaultWebDist = paths.webDist;
export const defaultEmulatorDir = paths.emulatorDir;

export async function buildApp({
  db,
  jwtSecret,
  requestLogLevel = 'info',
  cpfSecret,
  fastify,
  webDist = defaultWebDist,
  listInstalledPrinters = cachedLister(listWindowsPrinters),
  printTransport = emulatorTransport(defaultEmulatorDir),
}: BuildAppOptions) {
  const app = Fastify({ trustProxy: true, ...fastify });
  const tokens = createTokenService(jwtSecret);
  const deps: AppDeps = {
    db,
    tokens,
    guards: createGuards(tokens, db),
    listInstalledPrinters,
    cpf: createCpfVault(cpfSecret),
    printWorker: Object.assign(createPrintWorker({ db, transport: printTransport, log: app.log }), { mode: printTransport.mode }),
  };
  app.decorate('printWorker', deps.printWorker);
  app.addHook('onClose', () => deps.printWorker.stop());

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION',
        message: validationMessage(error.issues),
        issues: error.issues,
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const dbError = mapDbError(error);
    if (dbError) {
      return reply.code(dbError.statusCode).send({ error: dbError.code, message: dbError.message });
    }
    const err = error as { statusCode?: number; code?: string; message: string };
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'RATE_LIMIT', message: 'Muitas tentativas. Aguarde um minuto.' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'ERROR', message: frameworkMessage(err.code, err.statusCode) });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Erro interno no servidor.' });
  });

  // O app aberto no navegador compara com a sua versão e oferece recarregar depois de uma atualização.
  const version = appVersion();
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-sistema-bar-versao', version);
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  await app.register(
    async (api) => {
      api.get('/health', async () => {
        await db.execute(sql`select 1`);
        return { status: 'ok', db: 'ok', time: new Date().toISOString() };
      });
      await api.register((auth) => authRoutes(auth, deps), { prefix: '/auth' });
      await api.register((admin) => adminRoutes(admin, deps), { prefix: '/admin' });
      await api.register((waiter) => waiterRoutes(waiter, deps), { prefix: '/waiter' });
      await api.register((print) => printRoutes(print, deps), { prefix: '/print' });
      await api.register((cashier) => cashierRoutes(cashier, deps), { prefix: '/cashier' });
    },
    { prefix: '/api', logLevel: requestLogLevel },
  );

  // Em produção o próprio Fastify serve a PWA buildada (SPA: rotas desconhecidas caem no index.html).
  const servesWeb = webDist !== false && existsSync(webDist);
  if (servesWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, logLevel: requestLogLevel });
    // Rotas do app (/caixa, /garcom/mesa/…) devolvem o index.html, com o mesmo nível de log.
    app.get('/*', { logLevel: requestLogLevel }, (request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'NOT_FOUND', message: 'Rota não encontrada.' })
        : reply.sendFile('index.html'),
    );
  }
  app.setNotFoundHandler((request, reply) => {
    if (servesWeb && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: 'Rota não encontrada.' });
  });

  return app;
}
