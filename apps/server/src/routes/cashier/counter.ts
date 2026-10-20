import { counterComandaSchema, type CounterComandaResult } from '@sistema-bar/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import type { Db } from '../../db/client';
import { comandas, diningTables } from '../../db/schema';
import { audit } from '../../lib/audit';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError } from '../../lib/errors';
import { newQrToken } from '../admin/tables';

/** O "balcão" do caixa: uma mesa especial (número 0) criada na primeira venda no balcão. */
export async function counterTable(db: Db) {
  const [existing] = await db.select().from(diningTables).where(eq(diningTables.isCounter, true));
  if (existing) return existing;
  const [created] = await db
    .insert(diningTables)
    .values({ number: 0, area: 'Balcão', isCounter: true, qrToken: newQrToken() })
    .onConflictDoNothing()
    .returning();
  return created ?? (await db.select().from(diningTables).where(eq(diningTables.isCounter, true)))[0]!;
}

/**
 * Venda no balcão e mesas para o caixa abrir comanda. O lançamento dos itens usa a mesma
 * rota do garçom (/waiter/orders), então sai impresso no bar/cozinha como BALCÃO.
 */
export async function cashierCounterRoutes(app: FastifyInstance, { db, cpf }: AppDeps) {
  /** Mesas ativas do salão (para "Abrir mesa" no caixa), com quantas comandas abertas cada uma tem. */
  app.get('/all-tables', async () => {
    const [tables, open] = await Promise.all([
      db
        .select({ id: diningTables.id, number: diningTables.number, area: diningTables.area })
        .from(diningTables)
        .where(and(eq(diningTables.active, true), eq(diningTables.isCounter, false)))
        .orderBy(asc(diningTables.number)),
      db
        .select({ tableId: comandas.tableId, name: comandas.customerName })
        .from(comandas)
        .where(inArray(comandas.status, [...OPEN_STATUSES])),
    ]);
    return tables.map((t) => ({ ...t, openNames: open.filter((c) => c.tableId === t.id).map((c) => c.name) }));
  });

  /** Abre a comanda de uma venda no balcão. Nome e CPF opcionais (o CPF só serve para a nota). */
  app.post('/counter/comanda', async (request, reply): Promise<CounterComandaResult> => {
    const input = counterComandaSchema.parse(request.body);
    const [again] = await db.select({ id: comandas.id, tableId: comandas.tableId }).from(comandas).where(eq(comandas.clientUuid, input.clientUuid));
    if (again) return { comandaId: again.id, tableId: again.tableId };

    const table = await counterTable(db);
    const openHere = await db
      .select({ name: comandas.customerName })
      .from(comandas)
      .where(and(eq(comandas.tableId, table.id), inArray(comandas.status, [...OPEN_STATUSES])));
    const taken = new Set(openHere.map((c) => c.name.toLowerCase()));
    // Sem nome: "Balcão 1", "Balcão 2"… (o menor número livre entre as vendas em aberto).
    let name = input.customerName;
    if (!name) {
      let n = 1;
      while (taken.has(`balcão ${n}`)) n++;
      name = `Balcão ${n}`;
    } else if (taken.has(name.toLowerCase())) {
      throw new HttpError(409, 'DUPLICATE_NAME', `Já existe uma venda no balcão em aberto para "${name}". Use outro nome.`);
    }

    const protectedCpf = input.cpf ? cpf.protect(input.cpf) : null;
    if (protectedCpf) {
      const [other] = await db
        .select({ name: comandas.customerName })
        .from(comandas)
        .where(and(eq(comandas.cpfHmac, protectedCpf.hmac), inArray(comandas.status, [...OPEN_STATUSES])));
      if (other) throw new HttpError(409, 'CPF_HAS_OPEN_COMANDA', `Este CPF já tem comanda aberta (${other.name}).`);
    }

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(comandas)
        .values({
          clientUuid: input.clientUuid,
          tableId: table.id,
          customerName: name,
          cpfHmac: protectedCpf?.hmac ?? null,
          cpfEncrypted: protectedCpf?.encrypted ?? null,
          cpfLast3: protectedCpf?.last3 ?? null,
          peopleCount: 1,
          openedBy: request.user!.id,
        })
        .returning({ id: comandas.id, number: comandas.number });
      await audit(tx, request, {
        action: 'VENDA_BALCAO_ABERTA',
        entity: 'comanda',
        entityId: created!.id,
        after: { number: created!.number, customerName: name, comCpf: Boolean(protectedCpf) },
      });
      return created!;
    });
    reply.code(201);
    return { comandaId: row.id, tableId: table.id };
  });
}
