import { productImageSchema, productInputSchema, productSoldOutSchema, type Product } from '@sistema-bar/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { categories, productImages, products } from '../../db/schema';
import { audit } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { idParams } from './params';

const toProduct = ({ createdAt: _c, updatedAt: _u, ...p }: typeof products.$inferSelect): Product => p;

export async function productRoutes(app: FastifyInstance, { db }: AppDeps) {
  async function find(id: string) {
    const [row] = await db.select().from(products).where(eq(products.id, id));
    if (!row) throw notFound('Produto');
    return row;
  }

  async function assertCategory(categoryId: string) {
    const [cat] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
    if (!cat) throw new HttpError(400, 'VALIDATION', 'Categoria inválida.');
  }

  app.get('/', async (request) => {
    const { categoryId } = z.object({ categoryId: z.string().uuid().optional() }).parse(request.query);
    const rows = await db
      .select({ product: products })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(categoryId ? eq(products.categoryId, categoryId) : undefined)
      .orderBy(asc(categories.sortOrder), asc(categories.name), asc(products.name));
    return rows.map((r) => toProduct(r.product));
  });

  app.post('/', async (request, reply) => {
    // A foto tem rota própria (PUT /:id/image); o formulário não mexe nela.
    const { imageUrl: _image, ...data } = productInputSchema.parse(request.body);
    await assertCategory(data.categoryId);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(products).values(data).returning();
      await audit(tx, request, { action: 'PRODUTO_CRIADO', entity: 'product', entityId: created!.id, after: toProduct(created!) });
      return created!;
    });
    return reply.code(201).send(toProduct(row));
  });

  app.put('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { imageUrl: _image, ...data } = productInputSchema.parse(request.body);
    const before = toProduct(await find(id));
    await assertCategory(data.categoryId);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(products).set(data).where(eq(products.id, id)).returning();
      // Alteração de preço tem ação própria na auditoria (SPEC 5.10).
      const action = before.priceCents !== data.priceCents ? 'PRODUTO_PRECO_ALTERADO' : 'PRODUTO_ALTERADO';
      await audit(tx, request, { action, entity: 'product', entityId: id, before, after: toProduct(updated!) });
      return updated!;
    });
    return toProduct(row);
  });

  /** Foto do produto (cardápio do cliente). Chega reduzida pelo navegador; guardada no banco. */
  app.put('/:id/image', { bodyLimit: 2_000_000 }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { dataUrl } = productImageSchema.parse(request.body);
    await find(id);
    const [, mime, b64] = dataUrl.match(/^data:(image\/[a-z]+);base64,(.*)$/)!;
    const data = Buffer.from(b64!, 'base64');
    const now = new Date();
    const imageUrl = `/fotos/${id}?v=${now.getTime()}`;
    await db.transaction(async (tx) => {
      await tx
        .insert(productImages)
        .values({ productId: id, mime: mime!, data, updatedAt: now })
        .onConflictDoUpdate({ target: productImages.productId, set: { mime: mime!, data, updatedAt: now } });
      await tx.update(products).set({ imageUrl }).where(eq(products.id, id));
      await audit(tx, request, { action: 'PRODUTO_FOTO_ALTERADA', entity: 'product', entityId: id, after: { bytes: data.length } });
    });
    return { imageUrl };
  });

  app.delete('/:id/image', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await find(id);
    await db.transaction(async (tx) => {
      await tx.delete(productImages).where(eq(productImages.productId, id));
      await tx.update(products).set({ imageUrl: null }).where(eq(products.id, id));
      await audit(tx, request, { action: 'PRODUTO_FOTO_REMOVIDA', entity: 'product', entityId: id });
    });
    return reply.code(204).send();
  });

  app.patch('/:id/sold-out', async (request) => {
    const { id } = idParams.parse(request.params);
    const { soldOut } = productSoldOutSchema.parse(request.body);
    await find(id);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(products).set({ soldOut }).where(eq(products.id, id)).returning();
      await audit(tx, request, {
        action: soldOut ? 'PRODUTO_ESGOTADO' : 'PRODUTO_DISPONIVEL',
        entity: 'product',
        entityId: id,
      });
      return updated!;
    });
    return toProduct(row);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const before = toProduct(await find(id));
    await db.transaction(async (tx) => {
      await tx.delete(products).where(eq(products.id, id));
      await audit(tx, request, { action: 'PRODUTO_EXCLUIDO', entity: 'product', entityId: id, before });
    });
    return reply.code(204).send();
  });
}
