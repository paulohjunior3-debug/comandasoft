import type { CouvertWindow, DayRules } from '@sistema-bar/shared';
import { asc, eq, isNull } from 'drizzle-orm';
import { cashRegisters, cashSessions, couvertWindows, users } from '../db/schema';
import type { Queryable } from './billing';

/** Janelas de couvert (shows) de um dia do movimento, na ordem em que começaram. */
export async function couvertWindowsOf(db: Queryable, businessDate: string): Promise<CouvertWindow[]> {
  const rows = await db
    .select({ w: couvertWindows, startedBy: users.name })
    .from(couvertWindows)
    .innerJoin(users, eq(users.id, couvertWindows.startedBy))
    .where(eq(couvertWindows.businessDate, businessDate))
    .orderBy(asc(couvertWindows.startAt));
  return rows.map(({ w, startedBy }) => ({
    id: w.id,
    amountCents: w.amountCents,
    startAt: w.startAt.toISOString(),
    endAt: w.endAt?.toISOString() ?? null,
    startedBy,
  }));
}

/**
 * Regras do dia (turno, mesas em funcionamento, couvert): valem as do primeiro caixa aberto.
 * Os caixas abertos depois (Caixa Paulo, quando o Caixa Carlos já abriu) seguem as mesmas.
 * Sem caixa aberto: sem regras (sem couvert, todas as mesas).
 */
export async function getDayRules(db: Queryable): Promise<DayRules | null> {
  const [row] = await db
    .select({ session: cashSessions, registerName: cashRegisters.name })
    .from(cashSessions)
    .innerJoin(cashRegisters, eq(cashRegisters.id, cashSessions.registerId))
    .where(isNull(cashSessions.closedAt))
    .orderBy(asc(cashSessions.openedAt))
    .limit(1);
  if (!row) return null;
  const s = row.session;
  const windows = await couvertWindowsOf(db, s.businessDate);
  // Para o resumo do dia: o couvert ativo agora, senão o último que houve.
  const now = Date.now();
  const current =
    windows.find((w) => Date.parse(w.startAt) <= now && !w.endAt) ?? windows.findLast((w) => Date.parse(w.startAt) <= now) ?? windows[0];
  return {
    sessionId: s.id,
    registerName: row.registerName,
    openedAt: s.openedAt.toISOString(),
    expectedCloseAt: s.expectedCloseAt?.toISOString() ?? null,
    tablesInService: s.tablesInService,
    couvertCents: current?.amountCents ?? 0,
    couvertStartAt: current?.startAt ?? null,
    businessDate: s.businessDate,
    period: s.period,
    couvertWindows: windows,
  };
}
