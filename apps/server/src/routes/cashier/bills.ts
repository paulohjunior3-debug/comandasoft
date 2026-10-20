import {
  billRequestSchema,
  createAdjustmentSchema,
  lookupSchema,
  matchesSearch,
  nameSearchSchema,
  removeAdjustmentSchema,
  sumTotals,
  tableLabel,
  transferSchema,
  type Bill,
  type CashierTable,
  type LookupResult,
  type NameSearchHit,
  type TransferResult,
} from '@sistema-bar/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { adjustments, comandas, diningTables } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { loadBill } from '../../lib/billing';
import { billTicket, enqueueCashierPrint } from '../../lib/cashier-print';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { z } from 'zod';
import { idParams } from '../admin/params';
import { getRegister } from './session';

export async function cashierBillRoutes(app: FastifyInstance, { db, cpf, printWorker }: AppDeps) {
  /** Mesas com comandas abertas e seus totais; as que pediram a conta vêm primeiro. */
  async function openTables(tableIds?: string[]): Promise<CashierTable[]> {
    const open = await db
      .select({ id: comandas.id, tableId: comandas.tableId })
      .from(comandas)
      .where(
        and(
          inArray(comandas.status, [...OPEN_STATUSES]),
          tableIds ? inArray(comandas.tableId, tableIds) : undefined,
        ),
      )
      .orderBy(asc(comandas.openedAt), asc(comandas.number));
    if (open.length === 0) return [];
    const settings = await getSettings(db);
    const bill = await loadBill(db, open.map((c) => c.id), settings);
    const tables = await db
      .select()
      .from(diningTables)
      .where(inArray(diningTables.id, [...new Set(open.map((c) => c.tableId))]));

    return tables
      .map((t) => {
        const list = bill.comandas.filter((c) => open.find((o) => o.id === c.id)!.tableId === t.id);
        return {
          id: t.id,
          number: t.number,
          isCounter: t.isCounter,
          label: tableLabel(t),
          area: t.area,
          comandas: list,
          totals: sumTotals(list.map((c) => c.totals)),
          closingRequested: list.some((c) => c.status === 'EM_FECHAMENTO'),
        };
      })
      // Ordem fixa pelo número: no quadro do caixa cada mesa fica sempre no mesmo lugar (a cor diz o status).
      .sort((a, b) => a.number - b.number);
  }

  app.get('/tables', async () => openTables());

  /**
   * Busca no caixa (SPEC 5.7): pelo número da mesa (lista os nomes) ou pelo CPF
   * (encontra a comanda e diz em que mesa está). CPF vai no corpo, nunca na URL.
   */
  app.post('/lookup', async (request): Promise<LookupResult> => {
    const input = lookupSchema.parse(request.body);
    let tableId: string;
    let matchedComandaId: string | null = null;

    if (input.cpf) {
      const [found] = await db
        .select({ id: comandas.id, tableId: comandas.tableId })
        .from(comandas)
        .where(and(eq(comandas.cpfHmac, cpf.hmac(input.cpf)), inArray(comandas.status, [...OPEN_STATUSES])));
      if (!found) throw new HttpError(404, 'NOT_FOUND', 'Nenhuma comanda aberta com este CPF.');
      tableId = found.tableId;
      matchedComandaId = found.id;
    } else {
      const [table] = await db.select().from(diningTables).where(eq(diningTables.number, input.tableNumber!));
      if (!table) throw new HttpError(404, 'NOT_FOUND', `Mesa ${input.tableNumber} não existe.`);
      tableId = table.id;
    }

    const [table] = await openTables([tableId]);
    if (!table) {
      const [t] = await db.select().from(diningTables).where(eq(diningTables.id, tableId));
      throw new HttpError(404, 'NOT_FOUND', `A mesa ${t?.number ?? ''} não tem comandas abertas.`);
    }
    return { table, matchedComandaId };
  });

  /** Busca pelo nome do cliente: "ana" acha "Ana Paula" e "Ána"; devolve em que mesa está. */
  app.post('/search', async (request): Promise<NameSearchHit[]> => {
    const { name } = nameSearchSchema.parse(request.body);
    const rows = await db
      .select({ comandaId: comandas.id, customerName: comandas.customerName, tableId: diningTables.id, tableNumber: diningTables.number, status: comandas.status })
      .from(comandas)
      .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
      .where(inArray(comandas.status, [...OPEN_STATUSES]))
      .orderBy(asc(diningTables.number), asc(comandas.customerName));
    return rows.filter((r) => matchesSearch(r.customerName, name)).slice(0, 30);
  });

  /**
   * Transferência: uma ou mais comandas (ou todas as da mesa) vão para outra mesa, com tudo o
   * que já foi lançado e pago. O nome não pode repetir uma comanda aberta na mesa de destino.
   */
  app.post('/transfer', async (request): Promise<TransferResult> => {
    const input = transferSchema.parse(request.body);
    const [dest] = await db.select().from(diningTables).where(eq(diningTables.number, input.toTableNumber));
    if (!dest) throw new HttpError(404, 'NOT_FOUND', `Mesa ${input.toTableNumber} não existe.`);
    if (!dest.active || dest.isCounter) throw new HttpError(409, 'TABLE_INACTIVE', `A mesa ${dest.number} não pode receber comandas.`);

    const ids = [...new Set(input.comandaIds)];
    const moving = await db
      .select({ c: comandas, tableNumber: diningTables.number })
      .from(comandas)
      .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
      .where(inArray(comandas.id, ids));
    if (moving.length !== ids.length) throw notFound('Comanda');
    const closed = moving.filter((m) => !(OPEN_STATUSES as readonly string[]).includes(m.c.status));
    if (closed.length) throw new HttpError(409, 'COMANDA_NOT_OPEN', `A comanda de ${closed[0]!.c.customerName} já foi encerrada.`);
    if (moving.every((m) => m.c.tableId === dest.id)) throw new HttpError(409, 'SAME_TABLE', `Já está na mesa ${dest.number}.`);

    // Nomes repetidos na mesa de destino: avisa antes, com o nome, em vez do erro do banco.
    const there = await db
      .select({ name: comandas.customerName })
      .from(comandas)
      .where(and(eq(comandas.tableId, dest.id), inArray(comandas.status, [...OPEN_STATUSES])));
    const taken = new Set(there.map((t) => t.name.toLowerCase()));
    const clash = moving.find((m) => m.c.tableId !== dest.id && taken.has(m.c.customerName.toLowerCase()));
    if (clash) {
      throw new HttpError(
        409,
        'DUPLICATE_NAME',
        `Já existe "${clash.c.customerName}" aberta na mesa ${dest.number}. Peça ao garçom para diferenciar o nome (ex.: sobrenome) antes de transferir.`,
      );
    }

    const toMove = moving.filter((m) => m.c.tableId !== dest.id);
    const fromTableNumbers = [...new Set(toMove.map((m) => m.tableNumber))].sort((a, b) => a - b);
    await db.transaction(async (tx) => {
      await tx.update(comandas).set({ tableId: dest.id }).where(inArray(comandas.id, toMove.map((m) => m.c.id)));
      await audit(tx, request, {
        action: 'TRANSFERENCIA',
        entity: 'comanda',
        entityId: toMove.length === 1 ? toMove[0]!.c.id : undefined,
        before: { mesas: fromTableNumbers },
        after: { mesa: dest.number, comandas: toMove.map((m) => m.c.customerName) },
      });
    });
    return { moved: toMove.length, fromTableNumbers, toTableId: dest.id, toTableNumber: dest.number };
  });

  /** Conta de uma, várias comandas ou da mesa inteira. */
  app.post('/bill', async (request): Promise<Bill> => {
    const { comandaIds } = billRequestSchema.parse(request.body);
    const bill = await loadBill(db, [...new Set(comandaIds)], await getSettings(db));
    if (bill.comandas.length === 0) throw notFound('Comanda');
    return bill;
  });

  /** Pré-conta / conferência na impressora do caixa (SPEC 5.5). */
  app.post('/bill/print', async (request) => {
    const { comandaIds, registerId } = billRequestSchema.extend({ registerId: z.string().uuid().optional() }).parse(request.body);
    const register = registerId ? await getRegister(db, registerId) : null;
    const settings = await getSettings(db);
    const bill = await loadBill(db, [...new Set(comandaIds)], settings);
    if (bill.comandas.length === 0) throw notFound('Comanda');
    const printed = await enqueueCashierPrint(
      db,
      settings,
      billTicket(bill, 'PRE_CONTA', settings, register ? `${request.user!.name} · ${register.name}` : request.user!.name),
      undefined,
      register?.printerId,
    );
    if (!printed) {
      throw new HttpError(409, 'NO_CASHIER_PRINTER', 'Escolha a impressora do caixa em Administração > Configurações.');
    }
    printWorker.kick();
    return { printed };
  });

  /** Desconto e retirada de taxa/couvert: exigem gerente (ou PIN de gerente), com motivo (SPEC 5.7). */
  app.post('/adjustments', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = createAdjustmentSchema.parse(request.body);
    const [comanda] = await db.select().from(comandas).where(eq(comandas.id, input.comandaId));
    if (!comanda) throw notFound('Comanda');
    if (!(OPEN_STATUSES as readonly string[]).includes(comanda.status)) {
      throw new HttpError(409, 'COMANDA_NOT_OPEN', 'Comanda já encerrada.');
    }
    if (input.type !== 'DESCONTO') {
      const [existing] = await db
        .select({ id: adjustments.id })
        .from(adjustments)
        .where(and(eq(adjustments.comandaId, comanda.id), eq(adjustments.type, input.type), eq(adjustments.active, true)));
      if (existing) throw new HttpError(409, 'ALREADY_APPLIED', 'Já foi retirado desta comanda.');
    }
    const authorizer = await authorizeManager(db, request, input.authorizerPin);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(adjustments)
        .values({
          comandaId: comanda.id,
          type: input.type,
          amountCents: input.type === 'DESCONTO' ? (input.amountCents ?? null) : null,
          percentBps: input.type === 'DESCONTO' ? (input.percentBps ?? null) : null,
          reason: input.reason,
          userId: request.user!.id,
          authorizedBy: authorizer.self ? null : authorizer.id,
        })
        .returning();
      await audit(tx, request, {
        action: input.type,
        entity: 'comanda',
        entityId: comanda.id,
        after: { amountCents: created!.amountCents, percentBps: created!.percentBps, reason: input.reason, authorizedBy: authorizer.name },
      });
      return created!;
    });
    return reply.code(201).send({ id: row.id });
  });

  /** Desfaz um ajuste (ex.: desconto lançado errado). Também exige gerente. */
  app.post('/adjustments/:id/remove', async (request) => {
    const { id } = idParams.parse(request.params);
    const { authorizerPin } = removeAdjustmentSchema.parse(request.body ?? {});
    const [adj] = await db
      .select({ adj: adjustments, status: comandas.status })
      .from(adjustments)
      .innerJoin(comandas, eq(comandas.id, adjustments.comandaId))
      .where(eq(adjustments.id, id));
    if (!adj || !adj.adj.active) throw notFound('Ajuste');
    if (!(OPEN_STATUSES as readonly string[]).includes(adj.status)) throw new HttpError(409, 'COMANDA_NOT_OPEN', 'Comanda já encerrada.');
    const authorizer = await authorizeManager(db, request, authorizerPin);
    await db.transaction(async (tx) => {
      await tx.update(adjustments).set({ active: false }).where(eq(adjustments.id, id));
      await audit(tx, request, {
        action: `${adj.adj.type}_DESFEITO`,
        entity: 'comanda',
        entityId: adj.adj.comandaId,
        before: adj.adj,
        after: { authorizedBy: authorizer.name },
      });
    });
    return { ok: true };
  });
}
