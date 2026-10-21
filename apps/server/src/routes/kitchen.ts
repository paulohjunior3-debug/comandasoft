import type { KitchenPanelResponse, KitchenTicket } from '@sistema-bar/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { comandas, diningTables, orderItems, orderItemShares, printers, printJobs } from '../db/schema';
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

    const tickets = jobs.map((j): KitchenTicket => {
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
    });
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
    const [updated] = await db
      .update(printJobs)
      .set({ status: 'PENDENTE', payload, readyAt: new Date(), readyBy: request.user!.id })
      .where(and(eq(printJobs.id, id), eq(printJobs.status, 'PAINEL')))
      .returning({ id: printJobs.id });
    if (!updated) return { ok: true, already: true };
    printWorker.kick();
    return { ok: true, already: false };
  });
}
