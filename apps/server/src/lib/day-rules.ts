import type { DayRules } from '@sistema-bar/shared';
import { asc, eq, isNull } from 'drizzle-orm';
import { cashRegisters, cashSessions } from '../db/schema';
import type { Queryable } from './billing';

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
  return {
    sessionId: s.id,
    registerName: row.registerName,
    openedAt: s.openedAt.toISOString(),
    expectedCloseAt: s.expectedCloseAt?.toISOString() ?? null,
    tablesInService: s.tablesInService,
    couvertCents: s.couvertCents,
    couvertStartAt: s.couvertStartAt?.toISOString() ?? null,
  };
}
