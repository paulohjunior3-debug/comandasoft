import { tableVisitSchema, type TableDetail, type TableMapEntry, type TableMapResponse } from '@sistema-bar/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { comandas, diningTables, tableVisits } from '../../db/schema';
import { audit } from '../../lib/audit';
import { comandaTotals, loadComandaSummaries, OPEN_STATUSES } from '../../lib/comandas';
import { clearBillAlert, tableAttention } from '../../lib/table-attention';
import { notFound } from '../../lib/errors';
import { getDayRules } from '../../lib/day-rules';
import { getSettings } from '../../lib/settings';
import { idParams } from '../admin/params';

export async function waiterTableRoutes(app: FastifyInstance, { db }: AppDeps) {
  /** Mapa de mesas: status, nº de comandas, total e último atendimento de cada mesa (SPEC 5.3). */
  app.get('/', async (): Promise<TableMapResponse> => {
    const [allTables, open, settings, rules] = await Promise.all([
      // O balcão (vendas do caixa) não é mesa do salão.
      db
        .select()
        .from(diningTables)
        .where(and(eq(diningTables.active, true), eq(diningTables.isCounter, false)))
        .orderBy(asc(diningTables.number)),
      db
        .select({ id: comandas.id, tableId: comandas.tableId, status: comandas.status, openedAt: comandas.openedAt })
        .from(comandas)
        .where(inArray(comandas.status, [...OPEN_STATUSES])),
      getSettings(db),
      getDayRules(db),
    ]);
    const [totals, attention] = await Promise.all([comandaTotals(db, open.map((c) => c.id)), tableAttention(db, open)]);

    // Mesas em funcionamento hoje (abertura do caixa): as N primeiras pelo número.
    // Mesa com comanda aberta aparece sempre, mesmo fora das N.
    const inService = rules?.tablesInService ? new Set(allTables.slice(0, rules.tablesInService).map((t) => t.id)) : null;
    const tables = inService ? allTables.filter((t) => inService.has(t.id) || open.some((c) => c.tableId === t.id)) : allTables;

    const entries: TableMapEntry[] = tables.map((t) => {
      const mine = open.filter((c) => c.tableId === t.id);
      if (mine.length === 0) {
        return {
          id: t.id,
          number: t.number,
          area: t.area,
          status: 'LIVRE',
          comandaCount: 0,
          totalCents: 0,
          lastAttendedAt: null,
          billAlert: false,
          partialPaid: false,
        };
      }
      const a = attention.get(t.id)!;
      return {
        id: t.id,
        number: t.number,
        area: t.area,
        status: mine.every((c) => c.status === 'EM_FECHAMENTO') ? 'EM_FECHAMENTO' : 'OCUPADA',
        comandaCount: mine.length,
        totalCents: mine.reduce((sum, c) => sum + (totals.get(c.id) ?? 0), 0),
        lastAttendedAt: a.lastAttendedAt,
        billAlert: a.billAlert,
        partialPaid: a.partialPaid,
      };
    });

    return {
      tables: entries,
      alertYellowMinutes: settings.alertYellowMinutes,
      alertRedMinutes: settings.alertRedMinutes,
      serverTime: new Date().toISOString(),
    };
  });

  /** Comandas abertas da mesa, pelo nome do cliente. */
  app.get('/:id', async (request): Promise<TableDetail> => {
    const { id } = idParams.parse(request.params);
    const [table] = await db.select().from(diningTables).where(eq(diningTables.id, id));
    if (!table) throw notFound('Mesa');
    const list = await loadComandaSummaries(
      db,
      and(eq(comandas.tableId, id), inArray(comandas.status, [...OPEN_STATUSES])),
    );
    const open = await db
      .select({ id: comandas.id, tableId: comandas.tableId, openedAt: comandas.openedAt })
      .from(comandas)
      .where(and(eq(comandas.tableId, id), inArray(comandas.status, [...OPEN_STATUSES])));
    const a = (await tableAttention(db, open)).get(id);
    return {
      table: { id: table.id, number: table.number, area: table.area },
      comandas: list,
      billAlert: a?.billAlert ?? false,
      partialPaid: a?.partialPaid ?? false,
    };
  });

  /** "Atendi a mesa": zera o tempo sem atendimento sem lançar pedido. Idempotente por clientUuid. */
  /** Tirar do vermelho: a conta foi impressa, mas a mesa continua consumindo (ex.: alguém pagou só a sua parte). */
  app.post('/:id/clear-alert', async (request) => {
    const { id } = idParams.parse(request.params);
    const [table] = await db.select({ id: diningTables.id, number: diningTables.number }).from(diningTables).where(eq(diningTables.id, id));
    if (!table) throw notFound('Mesa');
    const cleared = await clearBillAlert(db, id);
    if (cleared.length) {
      await audit(db, request, { action: 'MESA_ALERTA_CONTA_REMOVIDO', entity: 'table', entityId: id, after: { table: table.number } });
    }
    return { cleared: cleared.length };
  });

  app.post('/:id/visit', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { clientUuid } = tableVisitSchema.parse(request.body);
    const [table] = await db.select({ id: diningTables.id }).from(diningTables).where(eq(diningTables.id, id));
    if (!table) throw notFound('Mesa');
    await db
      .insert(tableVisits)
      .values({ clientUuid, tableId: id, userId: request.user!.id })
      .onConflictDoNothing({ target: tableVisits.clientUuid });
    return reply.code(204).send();
  });
}
