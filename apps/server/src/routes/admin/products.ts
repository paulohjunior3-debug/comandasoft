import { productInputSchema, productSoldOutSchema, type Product } from '@sistema-bar/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { categories, products } from '../../db/schema';
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
    const data = productInputSchema.parse(request.body);
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
    const data = productInputSchema.parse(request.body);
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
