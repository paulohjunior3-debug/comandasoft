import { KITCHEN_DONE_HOURS, type KitchenDoneTicket, type KitchenPanelResponse, type KitchenTicket } from '@sistema-bar/shared';
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { comandas, diningTables, orderItems, orderItemShares, printers, printJobs, users } from '../db/schema';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import type { ProductionTicket } from '../printing/tickets';
import { idParams } from './admin/params';

/**
 * Painel da cozinha (KDS): os cupons de produção das impressoras com "painel" ficam em PAINEL
 * até a cozinha marcar pronto; aí viram PENDENTE e o worker imprime. Cozinha, gerente e admin.
 */
export async function kitchenRoutes(app: FastifyInstance, { db, guards, printWorker }: AppDeps) {
  app.addHook('preHandler', guards.requireRole('COZINHA', 'GERENTE'));

  /**
   * Mesa atual de cada pedido: o caixa pode ter transferido as comandas depois do lançamento,
   * e o cupom precisa sair com a mesa onde o cliente está agora.
   */
  async function currentTables(orderIds: string[]) {
    if (orderIds.length === 0) return new Map<string, { number: number; isCounter: boolean }>();
    const rows = await db
      .selectDistinct({ orderId: orderItems.orderId, number: diningTables.number, isCounter: diningTables.isCounter })
      .from(orderItems)
      .innerJoin(orderItemShares, eq(orderItemShares.orderItemId, orderItems.id))
      .innerJoin(comandas, eq(comandas.id, orderItemShares.comandaId))
      .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
      .where(inArray(orderItems.orderId, orderIds));
    return new Map(rows.map((r) => [r.orderId, { number: r.number, isCounter: r.isCounter }]));
  }

  function withTable(payload: ProductionTicket, table: { number: number; isCounter: boolean } | undefined): ProductionTicket {
    if (!table) return payload;
    return { ...payload, tableNumber: table.number, tableLabel: table.isCounter ? 'Balcão' : undefined };
  }

  function toTicket(j: typeof printJobs.$inferSelect, tables: Awaited<ReturnType<typeof currentTables>>): KitchenTicket {
    const p = withTable(j.payload as ProductionTicket, tables.get(j.referenceId ?? ''));
    return {
      id: j.id,
      printerId: j.printerId,
      sector: p.sector,
      tableNumber: p.tableNumber,
      tableLabel: p.tableLabel ?? null,
      customers: p.customers,
      waiter: p.waiter,
      createdAt: j.createdAt.toISOString(),
      orderRef: p.orderRef,
      takeaway: p.takeaway ?? false,
      items: p.items.map(({ qty, name, notes }) => ({ qty, name, notes })),
    };
  }

  app.get('/', async (request): Promise<KitchenPanelResponse> => {
    const { printerId } = z.object({ printerId: z.string().uuid().optional() }).parse(request.query);
    const panelPrinters = await db
      .select({ id: printers.id, name: printers.name, sector: printers.sectorLabel })
      .from(printers)
      .where(and(eq(printers.usesPanel, true), eq(printers.active, true)))
      .orderBy(asc(printers.name));
    const jobs = await db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.status, 'PAINEL'), printerId ? eq(printJobs.printerId, printerId) : undefined))
      .orderBy(asc(printJobs.createdAt));
    const tables = await currentTables([...new Set(jobs.map((j) => j.referenceId).filter((id): id is string => !!id))]);

    const tickets = jobs.map((j) => toTicket(j, tables));
    return { now: new Date().toISOString(), printers: panelPrinters, tickets };
  });

  /** Pronto: o cupom vai para a fila de impressão (com a mesa atual) e sai do painel. */
  app.post('/tickets/:id/ready', async (request) => {
    const { id } = idParams.parse(request.params);
    const [job] = await db.select().from(printJobs).where(eq(printJobs.id, id));
    if (!job || job.status !== 'PAINEL') {
      // Duas telas ou dois toques no mesmo pedido: o primeiro já mandou imprimir.
      if (job?.readyAt) return { ok: true, already: true };
      throw new HttpError(404, 'NOT_FOUND', 'Pedido não está mais no painel.');
    }
    const tables = await currentTables(job.referenceId ? [job.referenceId] : []);
    const payload = withTable(job.payload as ProductionTicket, tables.get(job.referenceId ?? ''));

    // Só alguns itens prontos (ex.: o suco antes do prato): o cupom sai com eles e o resto fica no painel.
    const { items: picked } = z.object({ items: z.array(z.number().int().min(0)).max(100).optional() }).parse(request.body ?? {});
    const indexes = [...new Set(picked ?? [])].filter((i) => i < payload.items.length).sort((a, b) => a - b);
    if (indexes.length > 0 && indexes.length < payload.items.length) {
      const done = indexes.map((i) => payload.items[i]!);
      const rest = payload.items.filter((_, i) => !indexes.includes(i));
      const created = await db.transaction(async (tx) => {
        const [kept] = await tx
          .update(printJobs)
          .set({ payload: { ...payload, items: rest } })
          .where(and(eq(printJobs.id, id), eq(printJobs.status, 'PAINEL')))
          .returning({ id: printJobs.id });
        if (!kept) return null;
        const [part] = await tx
          .insert(printJobs)
          .values({
            printerId: job.printerId,
            type: 'PRODUCAO',
            payload: { ...payload, items: done },
            referenceId: job.referenceId,
            status: 'PENDENTE',
            readyAt: new Date(),
            readyBy: request.user!.id,
            // Mesmo horário do pedido: se voltar para a tela, o cronômetro continua de onde estava.
            createdAt: job.createdAt,
          })
          .returning({ id: printJobs.id });
        return part!.id;
      });
      if (!created) return { ok: true, already: true };
      printWorker.kick();
      return { ok: true, already: false, partial: true, partId: created, printedItems: done.length, remainingItems: rest.length };
    }

    const [updated] = await db
      .update(printJobs)
      .set({ status: 'PENDENTE', payload, readyAt: new Date(), readyBy: request.user!.id })
      .where(and(eq(printJobs.id, id), eq(printJobs.status, 'PAINEL')))
      .returning({ id: printJobs.id });
    if (!updated) return { ok: true, already: true };
    printWorker.kick();
    return { ok: true, already: false };
  });

  /** Finalizados das últimas horas, do mais recente para o mais antigo: para reverter um Enter sem querer. */
  app.get('/done', async (request): Promise<KitchenDoneTicket[]> => {
    const { printerId } = z.object({ printerId: z.string().uuid().optional() }).parse(request.query);
    const since = new Date(Date.now() - KITCHEN_DONE_HOURS * 3_600_000);
    const rows = await db
      .select({ job: printJobs, readyByName: users.name })
      .from(printJobs)
      .innerJoin(printers, eq(printers.id, printJobs.printerId))
      .leftJoin(users, eq(users.id, printJobs.readyBy))
      .where(
        and(
          eq(printJobs.type, 'PRODUCAO'),
          eq(printers.usesPanel, true),
          gte(printJobs.readyAt, since),
          printerId ? eq(printJobs.printerId, printerId) : undefined,
        ),
      )
      .orderBy(desc(printJobs.readyAt))
      .limit(60);
    const tables = await currentTables([...new Set(rows.map((r) => r.job.referenceId).filter((id): id is string => !!id))]);
    return rows.map(({ job, readyByName }) => ({
      ...toTicket(job, tables),
      readyAt: job.readyAt!.toISOString(),
      readyBy: readyByName,
      printed: job.status === 'OK',
    }));
  });

  /**
   * Reverter: o pedido volta para o painel (com o cronômetro de antes). Se o cupom ainda não
   * saiu, não sai mais; quando marcarem pronto de novo, imprime de novo.
   */
  app.post('/tickets/:id/revert', async (request) => {
    const { id } = idParams.parse(request.params);
    const [job] = await db.select().from(printJobs).where(eq(printJobs.id, id));
    if (!job || job.type !== 'PRODUCAO' || !job.readyAt) {
      if (job?.status === 'PAINEL') return { ok: true, already: true };
      throw new HttpError(404, 'NOT_FOUND', 'Pedido não encontrado entre os finalizados.');
    }
    if (job.status === 'IMPRIMINDO') throw new HttpError(409, 'PRINTING', 'O cupom está saindo agora. Tente de novo em instantes.');
    const [updated] = await db
      .update(printJobs)
      .set({ status: 'PAINEL', readyAt: null, readyBy: null, printedAt: null, attempts: 0, lastError: null, nextAttemptAt: null })
      .where(and(eq(printJobs.id, id), inArray(printJobs.status, ['PENDENTE', 'OK', 'ERRO'])))
      .returning({ id: printJobs.id });
    if (!updated) throw new HttpError(409, 'PRINTING', 'O cupom está saindo agora. Tente de novo em instantes.');
    const p = job.payload as ProductionTicket;
    await audit(db, request, {
      action: 'PAINEL_REVERTIDO',
      entity: 'print_job',
      entityId: id,
      after: { table: p.tableNumber, sector: p.sector, printed: job.status === 'OK' },
    });
    return { ok: true, already: false };
  });
}
