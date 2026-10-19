import {
  CASHIER_ERRORS,
  cashMovementSchema,
  closeCashSessionSchema,
  openCashSessionSchema,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type CashClosePreview,
  type CashCloseResult,
  type CashSessionSummary,
  type PaymentMethod,
} from '@sistema-bar/shared';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { cashMovements, cashSessions, comandas, payments, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import type { Queryable } from '../../lib/billing';
import { companyOf, enqueueCashierPrint } from '../../lib/cashier-print';
import { HttpError } from '../../lib/errors';
import { getSettings } from '../../lib/settings';

const zeroByMethod = () => Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;

export async function openSession(db: Queryable) {
  const [session] = await db.select().from(cashSessions).where(isNull(cashSessions.closedAt));
  return session ?? null;
}

/** Sem caixa aberto não se recebe pagamento (SPEC 5.7). */
export async function requireOpenSession(db: Queryable) {
  const session = await openSession(db);
  if (!session) throw new HttpError(409, CASHIER_ERRORS.NO_OPEN_SESSION, 'Abra o caixa antes de receber pagamentos.');
  return session;
}

/** Resumo da sessão: recebido por forma, movimentos e dinheiro esperado na gaveta. */
export async function sessionSummary(db: Queryable, session: typeof cashSessions.$inferSelect): Promise<CashSessionSummary> {
  const [received, movements, [opener]] = await Promise.all([
    db
      .select({ method: payments.method, total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.cashSessionId, session.id), eq(payments.status, 'OK')))
      .groupBy(payments.method),
    db
      .select({ m: cashMovements, userName: users.name })
      .from(cashMovements)
      .innerJoin(users, eq(users.id, cashMovements.userId))
      .where(eq(cashMovements.cashSessionId, session.id))
      .orderBy(asc(cashMovements.createdAt)),
    db.select({ name: users.name }).from(users).where(eq(users.id, session.openedBy)),
  ]);
  const receivedByMethod = zeroByMethod();
  for (const r of received) receivedByMethod[r.method] = Number(r.total);
  const sum = (type: 'SANGRIA' | 'SUPRIMENTO') => movements.filter((x) => x.m.type === type).reduce((s, x) => s + x.m.amountCents, 0);
  return {
    id: session.id,
    openedAt: session.openedAt.toISOString(),
    openedBy: opener?.name ?? '',
    openingFloatCents: session.openingFloatCents,
    receivedByMethod,
    movements: movements.map(({ m, userName }) => ({
      id: m.id,
      type: m.type,
      amountCents: m.amountCents,
      reason: m.reason,
      userName,
      createdAt: m.createdAt.toISOString(),
    })),
    expectedCashCents: session.openingFloatCents + sum('SUPRIMENTO') - sum('SANGRIA') + receivedByMethod.DINHEIRO,
  };
}

export async function cashSessionRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  app.get('/', async () => {
    const session = await openSession(db);
    return { session: session ? await sessionSummary(db, session) : null };
  });

  /** Abertura com o fundo de troco. Um caixa aberto por vez. */
  app.post('/open', async (request, reply) => {
    const { openingFloatCents } = openCashSessionSchema.parse(request.body);
    if (await openSession(db)) throw new HttpError(409, CASHIER_ERRORS.SESSION_ALREADY_OPEN, 'Já existe um caixa aberto.');
    const settings = await getSettings(db);
    const session = await db.transaction(async (tx) => {
      const [row] = await tx.insert(cashSessions).values({ openedBy: request.user!.id, openingFloatCents }).returning();
      await audit(tx, request, { action: 'CAIXA_ABERTO', entity: 'cash_session', entityId: row!.id, after: { openingFloatCents } });
      await enqueueCashierPrint(tx, settings, {
        kind: 'CAIXA',
        variant: 'ABERTURA',
        company: companyOf(settings),
        operator: request.user!.name,
        createdAt: row!.openedAt.toISOString(),
        amountCents: openingFloatCents,
        reason: 'Fundo de troco',
      });
      return row!;
    });
    printWorker.kick();
    return reply.code(201).send({ session: await sessionSummary(db, session) });
  });

  /** Sangria (retirada) e suprimento (entrada de dinheiro), com motivo e comprovante. */
  app.post('/movements', async (request, reply) => {
    const input = cashMovementSchema.parse(request.body);
    const session = await requireOpenSession(db);
    if (input.type === 'SANGRIA') {
      const { expectedCashCents } = await sessionSummary(db, session);
      if (input.amountCents > expectedCashCents) {
        throw new HttpError(409, 'INSUFFICIENT_CASH', 'A sangria é maior que o dinheiro esperado na gaveta.');
      }
    }
    const settings = await getSettings(db);
    const printed = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(cashMovements)
        .values({ cashSessionId: session.id, type: input.type, amountCents: input.amountCents, reason: input.reason, userId: request.user!.id })
        .returning();
      await audit(tx, request, { action: input.type, entity: 'cash_session', entityId: session.id, after: input });
      return enqueueCashierPrint(tx, settings, {
        kind: 'CAIXA',
        variant: input.type,
        company: companyOf(settings),
        operator: request.user!.name,
        createdAt: row!.createdAt.toISOString(),
        amountCents: input.amountCents,
        reason: input.reason,
      });
    });
    printWorker.kick();
    return reply.code(201).send({ session: await sessionSummary(db, session), printed });
  });

  async function closePreview(): Promise<CashClosePreview> {
    const session = await requireOpenSession(db);
    const summary = await sessionSummary(db, session);
    const [{ n }] = (await db
      .select({ n: count() })
      .from(comandas)
      .where(inArray(comandas.status, ['ABERTA', 'EM_FECHAMENTO']))) as [{ n: number }];
    return {
      session: summary,
      expected: { ...summary.receivedByMethod, DINHEIRO: summary.expectedCashCents },
      openComandas: n,
    };
  }

  app.get('/close-preview', async () => closePreview());

  /** Fechamento: esperado × contado, diferença (sobra/falta) e relatório impresso (SPEC 5.7). */
  app.post('/close', async (request): Promise<CashCloseResult & { printed: boolean }> => {
    const input = closeCashSessionSchema.parse(request.body);
    const preview = await closePreview();
    if (preview.openComandas > 0 && !input.confirmOpenComandas) {
      throw new HttpError(409, CASHIER_ERRORS.OPEN_COMANDAS, `Ainda há ${preview.openComandas} comanda(s) aberta(s). Confirme para fechar mesmo assim.`);
    }
    const differenceByMethod: Partial<Record<PaymentMethod, number>> = {};
    for (const m of PAYMENT_METHODS) {
      const counted = input.counted[m];
      if (counted !== undefined) differenceByMethod[m] = counted - preview.expected[m];
    }
    const differenceCents = Object.values(differenceByMethod).reduce((s, d) => s + (d ?? 0), 0);
    const settings = await getSettings(db);
    const movements = preview.session.movements;
    const sum = (type: 'SANGRIA' | 'SUPRIMENTO') => movements.filter((x) => x.type === type).reduce((s, x) => s + x.amountCents, 0);

    const printed = await db.transaction(async (tx) => {
      const [closed] = await tx
        .update(cashSessions)
        .set({
          closedAt: new Date(),
          closedBy: request.user!.id,
          expectedJson: preview.expected,
          countedJson: input.counted,
          differenceCents,
          notes: input.notes ?? null,
        })
        .where(and(eq(cashSessions.id, preview.session.id), isNull(cashSessions.closedAt)))
        .returning({ id: cashSessions.id });
      if (!closed) throw new HttpError(409, CASHIER_ERRORS.NO_OPEN_SESSION, 'Este caixa já foi fechado.');
      await audit(tx, request, {
        action: 'CAIXA_FECHADO',
        entity: 'cash_session',
        entityId: preview.session.id,
        after: { expected: preview.expected, counted: input.counted, differenceCents, openComandas: preview.openComandas },
      });
      return enqueueCashierPrint(tx, settings, {
        kind: 'CAIXA',
        variant: 'FECHAMENTO',
        company: companyOf(settings),
        operator: request.user!.name,
        createdAt: new Date().toISOString(),
        report: {
          openedAt: preview.session.openedAt,
          openingFloatCents: preview.session.openingFloatCents,
          rows: PAYMENT_METHODS.map((m) => ({
            method: PAYMENT_METHOD_LABELS[m],
            expectedCents: preview.expected[m],
            countedCents: input.counted[m] ?? null,
            differenceCents: differenceByMethod[m] ?? null,
          })),
          sangriasCents: sum('SANGRIA'),
          suprimentosCents: sum('SUPRIMENTO'),
          differenceCents,
          openComandas: preview.openComandas,
          notes: input.notes,
        },
      });
    });
    printWorker.kick();
    return {
      sessionId: preview.session.id,
      expected: preview.expected,
      counted: input.counted,
      differenceCents,
      differenceByMethod,
      printed,
    };
  });
}
