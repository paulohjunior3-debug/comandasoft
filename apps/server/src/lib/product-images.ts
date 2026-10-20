import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { productImages } from '../db/schema';

/**
 * Entrega as fotos dos produtos em /fotos/<id>. Sem login: o cardápio do cliente (QR) também
 * usa. A URL leva ?v=<data>, então o navegador pode guardar em cache por muito tempo.
 */
export async function productImageRoutes(app: FastifyInstance, db: Db) {
  app.get('/fotos/:productId', { logLevel: 'warn' }, async (request, reply) => {
    const parsed = z.object({ productId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Foto não encontrada.' });
    const [img] = await db.select().from(productImages).where(eq(productImages.productId, parsed.data.productId));
    if (!img) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Foto não encontrada.' });
    const etag = `"${createHash('sha1').update(img.data).digest('hex').slice(0, 16)}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply
      .header('content-type', img.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', etag)
      .send(img.data);
  });
}
