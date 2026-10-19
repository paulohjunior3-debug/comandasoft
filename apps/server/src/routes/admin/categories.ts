import { categoryInputSchema, type Category } from '@sistema-bar/shared';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { categories, printerCategories, printers, products } from '../../db/schema';
import { audit } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { idParams } from './params';

export async function categoryRoutes(app: FastifyInstance, { db }: AppDeps) {
  async function load(ids?: string[]): Promise<Category[]> {
    const rows = await db
      .select()
      .from(categories)
      .where(ids ? inArray(categories.id, ids) : undefined)
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    const links = await db.select().from(printerCategories);
    const counts = await db
      .select({ categoryId: products.categoryId, n: count() })
      .from(products)
      .groupBy(products.categoryId);
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      color: c.color,
      active: c.active,
      printerIds: links.filter((l) => l.categoryId === c.id).map((l) => l.printerId),
      productCount: counts.find((x) => x.categoryId === c.id)?.n ?? 0,
    }));
  }

  async function assertPrinters(ids: string[]) {
    if (ids.length === 0) return;
    const found = await db.select({ id: printers.id }).from(printers).where(inArray(printers.id, ids));
    if (found.length !== new Set(ids).size) throw new HttpError(400, 'VALIDATION', 'Impressora inválida.');
  }

  app.get('/', async () => load());

  app.post('/', async (request, reply) => {
    const { printerIds, ...data } = categoryInputSchema.parse(request.body);
    await assertPrinters(printerIds);
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(categories).values(data).returning();
      if (printerIds.length) {
        await tx.insert(printerCategories).values(printerIds.map((printerId) => ({ printerId, categoryId: row!.id })));
      }
      await audit(tx, request, { action: 'CATEGORIA_CRIADA', entity: 'category', entityId: row!.id, after: { ...row, printerIds } });
      return row!.id;
    });
    const [created] = await load([id]);
    return reply.code(201).send(created);
  });

  app.put('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { printerIds, ...data } = categoryInputSchema.parse(request.body);
    const [before] = await load([id]);
    if (!before) throw notFound('Categoria');
    await assertPrinters(printerIds);
    await db.transaction(async (tx) => {
      await tx.update(categories).set(data).where(eq(categories.id, id));
      await tx.delete(printerCategories).where(eq(printerCategories.categoryId, id));
      if (printerIds.length) {
        await tx.insert(printerCategories).values(printerIds.map((printerId) => ({ printerId, categoryId: id })));
      }
      await audit(tx, request, { action: 'CATEGORIA_ALTERADA', entity: 'category', entityId: id, before, after: { ...data, printerIds } });
    });
    const [after] = await load([id]);
    return after;
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const [before] = await load([id]);
    if (!before) throw notFound('Categoria');
    if (before.productCount > 0) {
      throw new HttpError(409, 'IN_USE', 'A categoria tem produtos. Mova ou exclua os produtos antes, ou desative a categoria.');
    }
    await db.transaction(async (tx) => {
      await tx.delete(categories).where(eq(categories.id, id));
      await audit(tx, request, { action: 'CATEGORIA_EXCLUIDA', entity: 'category', entityId: id, before });
    });
    return reply.code(204).send();
  });
}
