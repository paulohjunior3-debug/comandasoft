import { printerInputSchema, type InstalledPrinter, type Printer } from '@sistema-bar/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { categories, printerCategories, printers } from '../../db/schema';
import { audit } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { idParams } from './params';

export async function printerRoutes(app: FastifyInstance, { db, listInstalledPrinters }: AppDeps) {
  async function installed(): Promise<InstalledPrinter[] | null> {
    try {
      return await listInstalledPrinters();
    } catch (err) {
      app.log.warn({ err }, 'Não foi possível listar as impressoras do Windows');
      return null;
    }
  }

  async function load(ids?: string[]): Promise<Printer[]> {
    const rows = await db
      .select()
      .from(printers)
      .where(ids ? inArray(printers.id, ids) : undefined)
      .orderBy(asc(printers.name));
    const links = await db.select().from(printerCategories);
    const windows = await installed();
    return rows.map(({ createdAt: _c, updatedAt: _u, ...p }) => ({
      ...p,
      widthMm: p.widthMm === 58 ? 58 : 80,
      codepage: p.codepage as Printer['codepage'],
      categoryIds: links.filter((l) => l.printerId === p.id).map((l) => l.categoryId),
      installed: windows ? windows.some((w) => w.name === p.windowsName) : null,
    }));
  }

  async function assertCategories(ids: string[]) {
    if (ids.length === 0) return;
    const found = await db.select({ id: categories.id }).from(categories).where(inArray(categories.id, ids));
    if (found.length !== new Set(ids).size) throw new HttpError(400, 'VALIDATION', 'Categoria inválida.');
  }

  app.get('/', async () => load());

  /** Impressoras instaladas no Windows do PC do caixa, para escolher no cadastro. */
  app.get('/installed', async () => {
    const list = await installed();
    if (!list) throw new HttpError(503, 'PRINTERS_UNAVAILABLE', 'Não foi possível consultar as impressoras do Windows.');
    return list;
  });

  app.post('/', async (request, reply) => {
    const { categoryIds, ...data } = printerInputSchema.parse(request.body);
    await assertCategories(categoryIds);
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(printers).values(data).returning();
      if (categoryIds.length) {
        await tx.insert(printerCategories).values(categoryIds.map((categoryId) => ({ printerId: row!.id, categoryId })));
      }
      await audit(tx, request, { action: 'IMPRESSORA_CRIADA', entity: 'printer', entityId: row!.id, after: { ...row, categoryIds } });
      return row!.id;
    });
    const [created] = await load([id]);
    return reply.code(201).send(created);
  });

  app.put('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { categoryIds, ...data } = printerInputSchema.parse(request.body);
    const [before] = await load([id]);
    if (!before) throw notFound('Impressora');
    await assertCategories(categoryIds);
    await db.transaction(async (tx) => {
      await tx.update(printers).set(data).where(eq(printers.id, id));
      await tx.delete(printerCategories).where(eq(printerCategories.printerId, id));
      if (categoryIds.length) {
        await tx.insert(printerCategories).values(categoryIds.map((categoryId) => ({ printerId: id, categoryId })));
      }
      await audit(tx, request, { action: 'IMPRESSORA_ALTERADA', entity: 'printer', entityId: id, before, after: { ...data, categoryIds } });
    });
    const [after] = await load([id]);
    return after;
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const [before] = await load([id]);
    if (!before) throw notFound('Impressora');
    await db.transaction(async (tx) => {
      await tx.delete(printers).where(eq(printers.id, id));
      await audit(tx, request, { action: 'IMPRESSORA_EXCLUIDA', entity: 'printer', entityId: id, before });
    });
    return reply.code(204).send();
  });
}
