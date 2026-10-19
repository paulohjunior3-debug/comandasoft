import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { frameworkMessage, HttpError, mapDbError, validationMessage } from './errors';

/** Respostas de erro padronizadas, sempre em pt-BR (app interno e QR do cliente). */
export function installErrorHandler(app: FastifyInstance) {
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
      return reply.code(429).send({ error: 'RATE_LIMIT', message: 'Muitas tentativas. Aguarde alguns minutos.' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'ERROR', message: frameworkMessage(err.code, err.statusCode) });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Erro interno no servidor.' });
  });
}
