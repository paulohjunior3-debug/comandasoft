import { cashRegisterInputSchema, type CashRegister } from '@sistema-bar/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { cashRegisters, cashSessions, printers, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { idParams } from './params';

/** Cadastro dos caixas (Caixa Carlos, Caixa Paulo…): nome, cupom fiscal automático ou não, impressora. */
export async function registerRoutes(app: FastifyInstance, { db }: AppDeps) {
  async function list(): Promise<CashRegister[]> {
    const rows = await db.select().from(cashRegisters).orderBy(asc(cashRegisters.name));
    const open = await db
      .select({ s: cashSessions, userName: users.name })
      .from(cashSessions)
      .innerJoin(users, eq(users.id, cashSessions.openedBy))
      .where(isNull(cashSessions.closedAt));
    return rows.map((r) => {
      const o = open.find((x) => x.s.registerId === r.id);
      return {
        id: r.id,
        name: r.name,
        fiscalMode: r.fiscalMode,
        printerId: r.printerId,
        active: r.active,
        openSession: o ? { id: o.s.id, openedAt: o.s.openedAt.toISOString(), openedBy: o.userName } : null,
      };
    });
  }

  async function assertPrinter(printerId: string | null) {
    if (!printerId) return;
    const [p] = await db.select({ id: printers.id }).from(printers).where(eq(printers.id, printerId));
    if (!p) throw new HttpError(400, 'VALIDATION', 'Impressora inválida.');
  }

  app.get('/', async () => list());

  app.post('/', async (request, reply) => {
    const data = cashRegisterInputSchema.parse(request.body);
    await assertPrinter(data.printerId);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(cashRegisters).values(data).returning();
      await audit(tx, request, { action: 'CAIXA_CADASTRADO', entity: 'cash_register', entityId: created!.id, after: created });
      return created!;
    });
    return reply.code(201).send((await list()).find((r) => r.id === row.id));
  });

  app.put('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const data = cashRegisterInputSchema.parse(request.body);
    const [before] = await db.select().from(cashRegisters).where(eq(cashRegisters.id, id));
    if (!before) throw notFound('Caixa');
    await assertPrinter(data.printerId);
    if (!data.active) {
      const [open] = await db
        .select({ id: cashSessions.id })
        .from(cashSessions)
        .where(and(eq(cashSessions.registerId, id), isNull(cashSessions.closedAt)));
      if (open) throw new HttpError(409, 'REGISTER_OPEN', 'Feche este caixa antes de desativá-lo.');
    }
    await db.transaction(async (tx) => {
      await tx.update(cashRegisters).set(data).where(eq(cashRegisters.id, id));
      await audit(tx, request, { action: 'CAIXA_ALTERADO', entity: 'cash_register', entityId: id, before, after: data });
    });
    return (await list()).find((r) => r.id === id);
  });
}
