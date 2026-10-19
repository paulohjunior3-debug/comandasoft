import { z } from 'zod';
import type { ComandaTotals } from './billing';
import { isValidCpf, onlyDigits } from './cpf';
import type { ComandaStatus } from './waiter';

// Contratos do caixa (SPEC 5.7).

export const PAYMENT_METHODS = ['CREDITO', 'DEBITO', 'PIX', 'DINHEIRO'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CREDITO: 'Crédito',
  DEBITO: 'Débito',
  PIX: 'Pix',
  DINHEIRO: 'Dinheiro',
};

const cents = z.number().int('Valor inválido').min(0, 'Valor não pode ser negativo');
const positiveCents = z.number().int('Valor inválido').min(1, 'Informe um valor maior que zero');
const reason = z.string().trim().min(3, 'Informe o motivo').max(200);
/** PIN de gerente quando quem está no caixa não tem permissão para a ação (SPEC 4). */
const authorizerPin = z.string().regex(/^\d{4,6}$/, 'PIN inválido').optional();

// ---------- Sessão de caixa ----------

export const openCashSessionSchema = z.object({
  /** Fundo de troco deixado na gaveta na abertura. */
  openingFloatCents: cents,
});

export const CASH_MOVEMENT_TYPES = ['SANGRIA', 'SUPRIMENTO'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const cashMovementSchema = z.object({
  type: z.enum(CASH_MOVEMENT_TYPES),
  amountCents: positiveCents,
  reason,
});

export const closeCashSessionSchema = z.object({
  /** Valor contado por forma de pagamento. Dinheiro é obrigatório; cartões e Pix, opcionais. */
  counted: z.object({
    DINHEIRO: cents,
    CREDITO: cents.optional(),
    DEBITO: cents.optional(),
    PIX: cents.optional(),
  }),
  /** Fechar mesmo com comandas abertas (o caixa confirmou o aviso). */
  confirmOpenComandas: z.boolean().default(false),
  notes: z.string().trim().max(500).optional(),
});
export type CloseCashSessionInput = z.input<typeof closeCashSessionSchema>;

export interface CashMovement {
  id: string;
  type: CashMovementType;
  amountCents: number;
  reason: string;
  userName: string;
  createdAt: string;
}

export interface CashSessionSummary {
  id: string;
  openedAt: string;
  openedBy: string;
  openingFloatCents: number;
  /** Recebido por forma de pagamento (pagamentos válidos). */
  receivedByMethod: Record<PaymentMethod, number>;
  movements: CashMovement[];
  /** Dinheiro que deveria estar na gaveta agora. */
  expectedCashCents: number;
}

export interface CashClosePreview {
  session: CashSessionSummary;
  /** Esperado por forma: dinheiro = fundo + suprimentos − sangrias + recebido em dinheiro. */
  expected: Record<PaymentMethod, number>;
  openComandas: number;
}

export interface CashCloseResult {
  sessionId: string;
  expected: Record<PaymentMethod, number>;
  counted: Partial<Record<PaymentMethod, number>>;
  /** Contado − esperado, só das formas informadas. Positivo = sobra; negativo = falta. */
  differenceCents: number;
  differenceByMethod: Partial<Record<PaymentMethod, number>>;
}

// ---------- Busca e conta ----------

export const lookupSchema = z
  .object({
    tableNumber: z.number().int().min(1).optional(),
    cpf: z
      .string()
      .transform(onlyDigits)
      .refine(isValidCpf, 'CPF inválido')
      .optional(),
  })
  .refine((v) => v.tableNumber !== undefined || v.cpf !== undefined, 'Informe a mesa ou o CPF');
export type LookupInput = z.input<typeof lookupSchema>;

export interface CashierComanda {
  id: string;
  number: number;
  customerName: string;
  cpfLast3: string;
  status: ComandaStatus;
  openedAt: string;
  totals: ComandaTotals;
}

export interface CashierTable {
  id: string;
  number: number;
  area: string | null;
  comandas: CashierComanda[];
  totals: ComandaTotals;
  /** Alguma comanda pediu a conta. */
  closingRequested: boolean;
}

export interface LookupResult {
  table: CashierTable;
  /** Busca por CPF: a comanda daquele CPF. */
  matchedComandaId: string | null;
}

export const billRequestSchema = z.object({
  comandaIds: z.array(z.string().uuid()).min(1, 'Selecione ao menos uma comanda').max(50),
});

export interface BillItem {
  orderItemId: string;
  comandaId: string;
  productName: string;
  qty: number;
  unitPriceCents: number;
  notes: string | null;
  /** Parte desta comanda no item. */
  amountCents: number;
  sharedWith: number;
  /** Quanto desta parte já foi pago por item (pagamento por item/fração). */
  paidCents: number;
  paidFraction: { num: number; den: number };
}

export interface BillAdjustment {
  id: string;
  comandaId: string;
  type: AdjustmentType;
  amountCents: number | null;
  percentBps: number | null;
  reason: string;
  userName: string;
  authorizedBy: string | null;
  createdAt: string;
}

export interface BillPayment {
  id: string;
  method: PaymentMethod;
  amountCents: number;
  changeCents: number;
  payerName: string;
  status: 'OK' | 'ESTORNADO';
  createdAt: string;
  userName: string;
  /** Quanto deste pagamento foi para cada comanda da conta. */
  allocations: { comandaId: string; amountCents: number }[];
}

export interface BillComanda extends CashierComanda {
  serviceFeeWaived: boolean;
  couvertWaived: boolean;
}

export interface Bill {
  tableNumber: number;
  comandas: BillComanda[];
  items: BillItem[];
  adjustments: BillAdjustment[];
  payments: BillPayment[];
  totals: ComandaTotals;
  serviceFeeEnabled: boolean;
}

// ---------- Ajustes (desconto, retirar taxa/couvert) ----------

export const ADJUSTMENT_TYPES = ['DESCONTO', 'TAXA_SERVICO_REMOVIDA', 'COUVERT_REMOVIDO'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

export const createAdjustmentSchema = z
  .object({
    comandaId: z.string().uuid(),
    type: z.enum(ADJUSTMENT_TYPES),
    amountCents: positiveCents.optional(),
    /** 1 a 100% em pontos-base (1000 = 10%). */
    percentBps: z.number().int().min(1).max(10_000).optional(),
    reason,
    authorizerPin,
  })
  .refine((v) => v.type !== 'DESCONTO' || (v.amountCents !== undefined) !== (v.percentBps !== undefined), {
    message: 'Informe o desconto em valor ou em percentual',
  });
export type CreateAdjustmentInput = z.input<typeof createAdjustmentSchema>;

export const removeAdjustmentSchema = z.object({ authorizerPin });

// ---------- Pagamentos ----------

export const paymentItemSchema = z.object({
  orderItemId: z.string().uuid(),
  comandaId: z.string().uuid(),
  /** Fração do item (1/1 = inteiro, 1/3 da pizza…). */
  num: z.number().int().min(1),
  den: z.number().int().min(1).max(20),
});

export const createPaymentSchema = z
  .object({
    clientUuid: z.string().uuid(),
    /** Comandas que este pagamento abate, na ordem em que devem ser quitadas. */
    comandaIds: z.array(z.string().uuid()).min(1).max(50),
    method: z.enum(PAYMENT_METHODS),
    /** Valor cobrado (sem o troco). Por item, o servidor recalcula e confere. */
    amountCents: positiveCents,
    /** Dinheiro: quanto o cliente entregou, para calcular o troco. */
    tenderedCents: cents.optional(),
    payerName: z.string().trim().min(1, 'Informe quem está pagando').max(60),
    /** Pagamento por item ou fração (opcional). */
    items: z.array(paymentItemSchema).max(100).optional(),
  })
  .refine((v) => v.items === undefined || v.items.every((i) => i.num <= i.den), 'Fração maior que o item');
export type CreatePaymentInput = z.input<typeof createPaymentSchema>;

export interface CreatePaymentResult {
  paymentId: string;
  changeCents: number;
  /** Comandas que este pagamento quitou (foram fechadas). */
  closedComandaIds: string[];
  duplicate: boolean;
}

export const refundPaymentSchema = z.object({ reason, authorizerPin });

export const CASHIER_ERRORS = {
  NO_OPEN_SESSION: 'NO_OPEN_SESSION',
  SESSION_ALREADY_OPEN: 'SESSION_ALREADY_OPEN',
  OPEN_COMANDAS: 'OPEN_COMANDAS',
  OVERPAYMENT: 'OVERPAYMENT',
  INSUFFICIENT_CASH: 'INSUFFICIENT_CASH',
  PIN_REQUIRED: 'PIN_REQUIRED',
  PIN_INVALID: 'PIN_INVALID',
  ITEM_OVERPAID: 'ITEM_OVERPAID',
  NO_CASHIER_PRINTER: 'NO_CASHIER_PRINTER',
} as const;
