import {
  CASHIER_ERRORS,
  cashMovementSchema,
  closeCashSessionSchema,
  couvertStart,
  formatBRL,
  formatLocalTime,
  localDate,
  nextLocalTime,
  openCashSessionSchema,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  periodLabel,
  periodOf,
  periodTable,
  suggestedBusinessDate,
  type CashClosePreview,
  type CashCloseResult,
  type CashRegister,
  type CashSessionSummary,
  type PaymentMethod,
} from '@sistema-bar/shared';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { cashMovements, cashRegisters, cashSessions, comandas, couvertWindows, diningTables, payments, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import type { Queryable } from '../../lib/billing';
import { companyOf, enqueueCashierPrint } from '../../lib/cashier-print';
import { couvertWindowsOf, getDayRules } from '../../lib/day-rules';
import { HttpError, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';

const zeroByMethod = () => Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;

export async function getRegister(db: Queryable, registerId: string) {
  const [register] = await db.select().from(cashRegisters).where(eq(cashRegisters.id, registerId));
  if (!register) throw notFound('Caixa');
  return register;
}

/** Sessão aberta de um caixa (ou null). */
export async function openSessionOf(db: Queryable, registerId: string) {
  const [session] = await db
    .select()
    .from(cashSessions)
    .where(and(eq(cashSessions.registerId, registerId), isNull(cashSessions.closedAt)));
  return session ?? null;
}

/** Sem caixa aberto não se recebe pagamento (SPEC 5.7). */
export async function requireOpenSession(db: Queryable, registerId: string) {
  const session = await openSessionOf(db, registerId);
  if (!session) throw new HttpError(409, CASHIER_ERRORS.NO_OPEN_SESSION, 'Abra este caixa antes de receber pagamentos.');
  return session;
}

/** Resumo da sessão: recebido por forma, movimentos e dinheiro esperado na gaveta. */
export async function sessionSummary(db: Queryable, session: typeof cashSessions.$inferSelect): Promise<CashSessionSummary> {
  const [received, movements, [opener], register] = await Promise.all([
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
    getRegister(db, session.registerId),
  ]);
  const receivedByMethod = zeroByMethod();
  for (const r of received) receivedByMethod[r.method] = Number(r.total);
  const sum = (type: 'SANGRIA' | 'SUPRIMENTO') => movements.filter((x) => x.m.type === type).reduce((s, x) => s + x.m.amountCents, 0);
  return {
    id: session.id,
    registerId: register.id,
    registerName: register.name,
    fiscalMode: register.fiscalMode,
    expectedCloseAt: session.expectedCloseAt?.toISOString() ?? null,
    businessDate: session.businessDate,
    period: session.period,
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

const registerQuery = z.object({ registerId: z.string().uuid('Escolha o caixa') });

export async function cashSessionRoutes(app: FastifyInstance, { db, printWorker, license }: AppDeps) {
  /** Caixas cadastrados e quem está com cada um aberto (para escolher em qual trabalhar). */
  app.get('/registers', async (): Promise<CashRegister[]> => {
    const rows = await db.select().from(cashRegisters).where(eq(cashRegisters.active, true)).orderBy(asc(cashRegisters.name));
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
  });

  /**
   * Regras do dia em vigor (turno, mesas, couvert), definidas pelo primeiro caixa aberto,
   * e as sugestões para o formulário de abertura (couvert padrão, total de mesas ativas).
   */
  app.get('/day-rules', async () => {
    const settings = await getSettings(db);
    const [{ n }] = (await db.select({ n: count() }).from(diningTables).where(eq(diningTables.active, true))) as [{ n: number }];
    // Sugestão do dia do movimento e do período para o primeiro caixa (os outros herdam das regras).
    const businessDate = suggestedBusinessDate();
    return {
      rules: await getDayRules(db),
      defaultCouvertCents: settings.couvertCents,
      activeTables: n,
      suggested: { businessDate, period: periodOf(businessDate, settings) },
      periods: periodTable(settings),
    };
  });

  app.get('/', async (request) => {
    const { registerId } = registerQuery.parse(request.query);
    await getRegister(db, registerId);
    const session = await openSessionOf(db, registerId);
    return { session: session ? await sessionSummary(db, session) : null, rules: await getDayRules(db) };
  });

  /**
   * Abertura do caixa: fundo de troco e, no primeiro caixa do dia, o turno (previsão de
   * fechamento, pode passar da meia-noite), as mesas em funcionamento e o couvert do dia.
   * Os caixas abertos depois seguem as regras já definidas.
   */
  app.post('/open', async (request, reply) => {
    const input = openCashSessionSchema.parse(request.body);
    await license.assertCanOperate('CAIXA');
    const register = await getRegister(db, input.registerId);
    if (!register.active) throw new HttpError(409, 'REGISTER_INACTIVE', 'Este caixa está desativado.');
    if (await openSessionOf(db, register.id)) {
      throw new HttpError(409, CASHIER_ERRORS.SESSION_ALREADY_OPEN, `O ${register.name} já está aberto.`);
    }
    const existingRules = await getDayRules(db);
    const now = new Date();
    const settings = await getSettings(db);
    // Dia do movimento: o do primeiro caixa aberto; senão o informado (hoje ou ontem) ou o sugerido.
    const businessDate = existingRules?.businessDate ?? input.businessDate ?? suggestedBusinessDate(now);
    if (!existingRules && input.businessDate) {
      const today = localDate(now);
      const yesterday = localDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      if (businessDate !== today && businessDate !== yesterday) {
        throw new HttpError(400, 'VALIDATION', 'O dia do movimento deve ser hoje ou ontem.');
      }
    }
    const period = existingRules ? existingRules.period : input.period !== undefined ? input.period : periodOf(businessDate, settings);
    const dayRules = existingRules
      ? null // outro caixa já definiu as regras do dia
      : {
          expectedCloseAt: input.expectedCloseTime ? nextLocalTime(now, input.expectedCloseTime) : null,
          tablesInService: input.tablesInService ?? null,
          couvertCents: input.couvert?.amountCents ?? 0,
          couvertStartAt: input.couvert ? couvertStart(now, input.couvert.startTime) : null,
        };

    const session = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(cashSessions)
        .values({
          registerId: register.id,
          openedBy: request.user!.id,
          openedAt: now,
          openingFloatCents: input.openingFloatCents,
          // Caixas abertos depois do primeiro guardam só a própria previsão de fechamento.
          expectedCloseAt: dayRules?.expectedCloseAt ?? (input.expectedCloseTime ? nextLocalTime(now, input.expectedCloseTime) : null),
          tablesInService: dayRules?.tablesInService ?? null,
          couvertCents: dayRules?.couvertCents ?? 0,
          couvertStartAt: dayRules?.couvertStartAt ?? null,
          businessDate,
          period: period ?? null,
        })
        .returning();
      // "Couvert a partir de" na abertura vira a primeira janela do dia (se não houver uma ativa).
      if (dayRules?.couvertCents && dayRules.couvertStartAt) {
        const active = (await couvertWindowsOf(tx, businessDate)).some((w) => !w.endAt);
        if (!active) {
          await tx.insert(couvertWindows).values({
            businessDate,
            amountCents: dayRules.couvertCents,
            startAt: dayRules.couvertStartAt,
            startedBy: request.user!.id,
          });
        }
      }
      await audit(tx, request, {
        action: 'CAIXA_ABERTO',
        entity: 'cash_session',
        entityId: row!.id,
        after: { register: register.name, openingFloatCents: input.openingFloatCents, businessDate, period, dayRules },
      });
      const lines = [`Fundo de troco`, `${periodLabel(period ?? null, businessDate)} · ${businessDate.split('-').reverse().join('/')}`];
      if (dayRules?.expectedCloseAt) lines.push(`Turno até ${formatLocalTime(dayRules.expectedCloseAt)}`);
      if (dayRules?.tablesInService) lines.push(`${dayRules.tablesInService} mesas`);
      if (dayRules?.couvertCents) lines.push(`Couvert ${formatBRL(dayRules.couvertCents)} desde ${formatLocalTime(dayRules.couvertStartAt!)}`);
      await enqueueCashierPrint(
        tx,
        settings,
        {
          kind: 'CAIXA',
          variant: 'ABERTURA',
          company: companyOf(settings),
          operator: `${request.user!.name} · ${register.name}`,
          createdAt: row!.openedAt.toISOString(),
          amountCents: input.openingFloatCents,
          reason: lines.join(' · '),
        },
        undefined,
        register.printerId,
      );
      return row!;
    });
    printWorker.kick();
    return reply.code(201).send({ session: await sessionSummary(db, session), rules: await getDayRules(db) });
  });

  /** Sangria (retirada) e suprimento (entrada de dinheiro), com motivo e comprovante. */
  app.post('/movements', async (request, reply) => {
    const input = cashMovementSchema.parse(request.body);
    const register = await getRegister(db, input.registerId);
    const session = await requireOpenSession(db, register.id);
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
      await audit(tx, request, { action: input.type, entity: 'cash_session', entityId: session.id, after: { ...input, register: register.name } });
      return enqueueCashierPrint(
        tx,
        settings,
        {
          kind: 'CAIXA',
          variant: input.type,
          company: companyOf(settings),
          operator: `${request.user!.name} · ${register.name}`,
          createdAt: row!.createdAt.toISOString(),
          amountCents: input.amountCents,
          reason: input.reason,
        },
        undefined,
        register.printerId,
      );
    });
    printWorker.kick();
    return reply.code(201).send({ session: await sessionSummary(db, session), printed });
  });

  async function closePreview(registerId: string): Promise<CashClosePreview> {
    const session = await requireOpenSession(db, registerId);
    const summary = await sessionSummary(db, session);
    const [{ n }] = (await db
      .select({ n: count() })
      .from(comandas)
      .where(inArray(comandas.status, ['ABERTA', 'EM_FECHAMENTO']))) as [{ n: number }];
    // Comandas abertas só importam se este é o último caixa aberto.
    const [{ others }] = (await db
      .select({ others: count() })
      .from(cashSessions)
      .where(and(isNull(cashSessions.closedAt), sql`${cashSessions.id} <> ${session.id}`))) as [{ others: number }];
    return {
      session: summary,
      expected: { ...summary.receivedByMethod, DINHEIRO: summary.expectedCashCents },
      openComandas: others > 0 ? 0 : n,
    };
  }

  app.get('/close-preview', async (request) => closePreview(registerQuery.parse(request.query).registerId));

  /** Fechamento: esperado × contado, diferença (sobra/falta) e relatório impresso (SPEC 5.7). */
  app.post('/close', async (request): Promise<CashCloseResult & { printed: boolean }> => {
    const input = closeCashSessionSchema.parse(request.body);
    const register = await getRegister(db, input.registerId);
    const preview = await closePreview(register.id);
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
        after: { register: register.name, expected: preview.expected, counted: input.counted, differenceCents, openComandas: preview.openComandas },
      });
      return enqueueCashierPrint(
        tx,
        settings,
        {
          kind: 'CAIXA',
          variant: 'FECHAMENTO',
          company: companyOf(settings),
          operator: `${request.user!.name} · ${register.name}`,
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
        },
        undefined,
        register.printerId,
      );
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
