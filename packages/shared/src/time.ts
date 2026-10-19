/**
 * Horários do bar no fuso de Brasília. Desde 2019 não há horário de verão: UTC−3 fixo.
 * (Se voltar a existir, troque por Intl com timeZone 'America/Sao_Paulo'.)
 */
const OFFSET_MS = -3 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** O horário HH:MM (de Brasília) no mesmo dia de Brasília da data de referência. */
export function atLocalTime(reference: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const local = new Date(reference.getTime() + OFFSET_MS); // "relógio de Brasília" em campos UTC
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(localMidnight + (h * 60 + m) * 60 * 1000 - OFFSET_MS);
}

/** Próxima ocorrência do horário depois da referência (ex.: abre 16:00, fecha "01:00" = amanhã 01:00). */
export function nextLocalTime(reference: Date, hhmm: string): Date {
  const t = atLocalTime(reference, hhmm);
  return t.getTime() <= reference.getTime() ? new Date(t.getTime() + DAY) : t;
}

/**
 * Início do couvert informado na abertura. Normalmente no mesmo dia (abre 12:00, couvert 14:00;
 * ou abre 16:00 e o couvert "desde 14:00" já começou). Só vai para o dia seguinte quando o horário
 * fica mais de 6 h antes da abertura (abre 23:00, couvert a partir de 01:00).
 */
export function couvertStart(openedAt: Date, hhmm: string): Date {
  const t = atLocalTime(openedAt, hhmm);
  return openedAt.getTime() - t.getTime() > 6 * HOUR ? new Date(t.getTime() + DAY) : t;
}

/** "16:05" no horário de Brasília. */
export function formatLocalTime(date: Date | string): string {
  const d = new Date(new Date(date).getTime() + OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
