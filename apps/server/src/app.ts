import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { createGuards, type Guards } from './auth/guard';
import { createTokenService, type TokenService } from './auth/tokens';
import type { Db } from './db/client';
import { createCpfVault, type CpfVault } from './lib/cpf-vault';
import { HttpError, mapDbError } from './lib/errors';
import { emulatorTransport, type PrintTransport } from './printing/transport';
import { createPrintWorker, type PrintWorker } from './printing/worker';
import { cachedLister, listWindowsPrinters, type ListInstalledPrinters } from './printing/windows-printers';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
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
  cpfSecret: string;
  fastify?: FastifyServerOptions;
  /** Pasta do build da PWA. Padrão: apps/web/dist, se existir. `false` desliga. */
  webDist?: string | false;
  /** Para onde vão os cupons. Padrão: emulador em data/impressoes. */
  printTransport?: PrintTransport;
  /** Substituível nos testes; padrão: impressoras do Windows. */
  listInstalledPrinters?: ListInstalledPrinters;
}

const defaultWebDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
export const defaultEmulatorDir = fileURLToPath(new URL('../../../data/impressoes', import.meta.url));

export async function buildApp({
  db,
  jwtSecret,
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
        message: error.issues[0]?.message ?? 'Dados inválidos.',
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
      return reply.code(err.statusCode).send({ error: err.code ?? 'ERROR', message: err.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Erro interno no servidor.' });
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
    },
    { prefix: '/api' },
  );

  // Em produção o próprio Fastify serve a PWA buildada (SPA: rotas desconhecidas caem no index.html).
  const servesWeb = webDist !== false && existsSync(webDist);
  if (servesWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    if (servesWeb && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: 'Rota não encontrada.' });
  });

  return app;
}
