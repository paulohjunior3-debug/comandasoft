import { randomBytes } from 'node:crypto';
import { tableBulkInputSchema, tableInputSchema, type DiningTable, type QrInfo } from '@sistema-bar/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { diningTables } from '../../db/schema';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { lanAddresses } from '../../lib/network';
import { idParams } from './params';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Token do QR: 10 caracteres aleatórios (~57 bits), sem caracteres ambíguos. */
export function newQrToken(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const toTable = ({ createdAt: _c, updatedAt: _u, ...t }: typeof diningTables.$inferSelect): DiningTable => t;

export async function tableRoutes(app: FastifyInstance, { db, publicPort }: AppDeps) {
  /** Para a impressão dos QR: porta do servidor do cliente e endereços sugeridos. */
  app.get('/qr-info', async (): Promise<QrInfo> => ({
    publicPort,
    suggestedBaseUrls: publicPort ? lanAddresses().map((ip) => `http://${ip}:${publicPort}`) : [],
  }));

  async function find(id: string) {
    const [row] = await db.select().from(diningTables).where(eq(diningTables.id, id));
    if (!row) throw notFound('Mesa');
    return row;
  }

  app.get('/', async () => {
    // O balcão do caixa é criado pelo sistema e não se edita aqui.
    const rows = await db.select().from(diningTables).where(eq(diningTables.isCounter, false)).orderBy(asc(diningTables.number));
    return rows.map(toTable);
  });

  app.post('/', async (request, reply) => {
    const data = tableInputSchema.parse(request.body);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(diningTables).values({ ...data, qrToken: newQrToken() }).returning();
      await audit(tx, request, { action: 'MESA_CRIADA', entity: 'table', entityId: created!.id, after: toTable(created!) });
      return created!;
    });
    return reply.code(201).send(toTable(row));
  });

  /** Cria um intervalo de mesas, pulando os números que já existem. */
  app.post('/bulk', async (request, reply) => {
    const { from, to, area, capacity } = tableBulkInputSchema.parse(request.body);
    const wanted = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const existing = await db
      .select({ number: diningTables.number })
      .from(diningTables)
      .where(inArray(diningTables.number, wanted));
    const taken = new Set(existing.map((e) => e.number));
    const numbers = wanted.filter((n) => !taken.has(n));

    const created = numbers.length
      ? await db.transaction(async (tx) => {
          const rows = await tx
            .insert(diningTables)
            .values(numbers.map((number) => ({ number, area, capacity, qrToken: newQrToken() })))
            .returning();
          await audit(tx, request, { action: 'MESAS_CRIADAS_LOTE', entity: 'table', after: { from, to, area, capacity, numbers } });
          return rows;
        })
      : [];
    return reply.code(201).send({ created: created.map(toTable), skipped: [...taken].sort((a, b) => a - b) });
  });

  app.put('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const data = tableInputSchema.parse(request.body);
    const before = toTable(await find(id));
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(diningTables).set(data).where(eq(diningTables.id, id)).returning();
      await audit(tx, request, { action: 'MESA_ALTERADA', entity: 'table', entityId: id, before, after: toTable(updated!) });
      return updated!;
    });
    return toTable(row);
  });

  /** Gera um novo QR (invalida o impresso anterior, ex.: se alguém fotografou o QR). */
  app.post('/:id/regenerate-qr', async (request) => {
    const { id } = idParams.parse(request.params);
    await find(id);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(diningTables).set({ qrToken: newQrToken() }).where(eq(diningTables.id, id)).returning();
      await audit(tx, request, { action: 'MESA_QR_REGERADO', entity: 'table', entityId: id });
      return updated!;
    });
    return toTable(row);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const before = toTable(await find(id));
    await db.transaction(async (tx) => {
      await tx.delete(diningTables).where(eq(diningTables.id, id));
      await audit(tx, request, { action: 'MESA_EXCLUIDA', entity: 'table', entityId: id, before });
    });
    return reply.code(204).send();
  });
}
