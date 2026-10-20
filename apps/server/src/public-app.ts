import { existsSync } from 'node:fs';
import { join } from 'node:path';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { createTokenService } from './auth/tokens';
import type { Db } from './db/client';
import { certificatePageRoutes } from './lib/certificate-page';
import { installErrorHandler } from './lib/error-handler';
import { productImageRoutes } from './lib/product-images';
import { paths } from './paths';
import { publicRoutes } from './routes/public';

export interface BuildPublicAppOptions {
  db: Db;
  jwtSecret: string;
  fastify?: FastifyServerOptions;
  /** Pasta do build web (usa cliente.html e assets/). `false` desliga. */
  webDist?: string | false;
  /** Certificado de confiança (público) para os celulares da equipe: /certificado. */
  caCertPath?: string;
  /** Porta HTTPS do sistema, para o link "Abrir o sistema" da página do certificado. */
  mainPort?: number | null;
}

/**
 * Servidor do QR do cliente (SPEC 5.6), separado do sistema: em HTTP, para o celular do cliente
 * abrir sem aviso de certificado, e expondo SÓ o cardápio e a consulta da comanda. Login,
 * caixa e administração não existem nesta porta.
 */
export async function buildPublicApp({
  db,
  jwtSecret,
  fastify,
  webDist = paths.webDist,
  caCertPath = paths.fromHome('certs/rootCA.crt'),
  mainPort = null,
}: BuildPublicAppOptions) {
  // Sem proxy na frente: o IP é o do aparelho (X-Forwarded-For não é aceito, para o limite por IP valer).
  const app = Fastify({ trustProxy: false, ...fastify });
  installErrorHandler(app);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });
  await app.register(rateLimit, { global: false });
  await app.register((pub) => publicRoutes(pub, { db, tokens: createTokenService(jwtSecret) }), { prefix: '/api/public' });
  await app.register((r) => productImageRoutes(r, db));
  await app.register((r) => certificatePageRoutes(r, { caCertPath, mainPort }));

  const servesWeb = webDist !== false && existsSync(join(webDist, 'cliente.html'));
  if (servesWeb) {
    // Só os arquivos da página do cliente; o app interno (index.html) não é servido aqui.
    await app.register(fastifyStatic, { root: join(webDist, 'assets'), prefix: '/assets/', logLevel: 'warn' });
    app.get('/favicon.svg', (_request, reply) => reply.sendFile('favicon.svg', webDist));
    app.get('/m/*', { logLevel: 'warn' }, (_request, reply) => reply.sendFile('cliente.html', webDist));
  }
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'NOT_FOUND', message: 'Página não encontrada. Aponte a câmera para o QR Code da mesa.' }),
  );
  return app;
}
