import { z } from 'zod';
import type { PaymentMethod } from './cashier';
import { daysBetween } from './time';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).');

/** Período do relatório, em dias de operação (o dia em que o caixa abriu, no horário de Brasília). */
export const salesReportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    registerId: z.string().uuid('Caixa inválido.').optional(),
    /** Só um período da semana do bar (ex.: 5 = todos os sábados do intervalo). */
    period: z.coerce.number().int().min(1).max(7).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'A data inicial é depois da final.', path: ['to'] })
  .refine((q) => daysBetween(q.from, q.to) <= 366, { message: 'Escolha um período de até 1 ano.', path: ['to'] });
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;

export type MethodTotals = Record<PaymentMethod, number>;

/** Entradas de um recorte (dia, caixa ou período todo). Cartão = crédito + débito. */
export interface ReceivedTotals {
  byMethod: MethodTotals;
  cardCents: number;
  totalCents: number;
  payments: number;
  /** Valor das comandas com pedido de cupom fiscal (NFC-e). */
  fiscalCents: number;
}

export interface SalesReport {
  from: string;
  to: string;
  registerId: string | null;
  period: number | null;
  generatedAt: string;
  /** Entradas do período (pagamentos válidos, sem os estornados). */
  received: ReceivedTotals;
  refunds: { count: number; totalCents: number };
  /** Vendas: comandas fechadas no período (pela data do caixa que recebeu o último pagamento). */
  sales: {
    comandas: number;
    people: number;
    itemsCents: number;
    serviceFeeCents: number;
    couvertCents: number;
    discountCents: number;
    totalCents: number;
    /** Total ÷ comandas. */
    averageTicketCents: number;
  };
  /**
   * Cupom fiscal. A emissão da NFC-e é a fase 5: até lá, os pedidos ficam registrados
   * ("aguardando o módulo fiscal") e o valor aqui é o das comandas pedidas.
   */
  fiscal: { requests: number; automatic: number; comandas: number; requestedCents: number; withoutNoteCents: number; pending: number };
  cash: { sessions: number; openSessions: number; openingFloatCents: number; suprimentoCents: number; sangriaCents: number; differenceCents: number };
  days: (ReceivedTotals & { date: string; period: number | null; comandas: number; salesCents: number })[];
  registers: (ReceivedTotals & { registerId: string; name: string; sessions: number })[];
  sessions: {
    id: string;
    registerName: string;
    /** Dia do movimento e período da abertura. */
    date: string;
    period: number | null;
    openedAt: string;
    closedAt: string | null;
    openedBy: string;
    closedBy: string | null;
    openingFloatCents: number;
    receivedCents: number;
    suprimentoCents: number;
    sangriaCents: number;
    /** Contado − esperado no fechamento (null = ainda aberto). */
    differenceCents: number | null;
  }[];
  /** Produtos das comandas fechadas, do maior valor para o menor, com o detalhe por dia. */
  products: { name: string; qty: number; totalCents: number; days: { date: string; qty: number; totalCents: number }[] }[];
}
