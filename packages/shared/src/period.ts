/**
 * Semana do bar e períodos (dias de movimento numerados). Ex.: bar que fecha na segunda,
 * semana começando na terça: terça = Período 1, quarta = 2 … domingo = 6.
 * Dias da semana como no JavaScript: 0 = domingo … 6 = sábado.
 */
export const WEEKDAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;
export const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;

export interface BusinessWeek {
  /** Dia em que a semana do bar começa (Período 1). */
  weekStartDay: number;
  /** Dias em que o bar não abre (não recebem número). */
  closedDays: number[];
}

/** Dia da semana de uma data "AAAA-MM-DD". */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Ordem dos dias abertos com o número de cada período: [{ period: 1, weekday: 2 }, …]. */
export function periodTable(week: BusinessWeek): { period: number; weekday: number }[] {
  const days: { period: number; weekday: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const weekday = (week.weekStartDay + i) % 7;
    if (!week.closedDays.includes(weekday)) days.push({ period: days.length + 1, weekday });
  }
  return days;
}

/** Período de uma data (null = dia em que o bar normalmente fecha; abriu num dia extra). */
export function periodOf(date: string, week: BusinessWeek): number | null {
  return periodTable(week).find((d) => d.weekday === weekdayOf(date))?.period ?? null;
}

/** "Período 3 (quinta)" / "Dia extra (segunda)". */
export function periodLabel(period: number | null, date?: string): string {
  const day = date ? ` (${WEEKDAY_NAMES[weekdayOf(date)]})` : '';
  return period ? `Período ${period}${day}` : `Dia extra${day}`;
}

/**
 * Dia do movimento sugerido na abertura do caixa: hoje; mas quem abre de madrugada
 * (antes das 6h) normalmente ainda está no movimento do dia anterior.
 */
export function suggestedBusinessDate(now: Date = new Date()): string {
  const local = new Date(now.getTime() - 3 * 60 * 60 * 1000); // Brasília, UTC−3
  if (local.getUTCHours() < 6) local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}
