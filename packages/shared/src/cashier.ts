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

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido (use HH:MM)');
const registerId = z.string().uuid('Escolha o caixa');

// ---------- Caixas (pontos de cobrança: Caixa Carlos, Caixa Paulo…) ----------

/**
 * AUTOMATICO: toda conta quitada neste caixa já pede o cupom fiscal.
 * PERGUNTAR: ao quitar, o caixa escolhe entre cupom não fiscal, fiscal ou só finalizar.
 */
export const FISCAL_MODES = ['PERGUNTAR', 'AUTOMATICO'] as const;
export type FiscalMode = (typeof FISCAL_MODES)[number];

export const cashRegisterInputSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do caixa').max(40),
  fiscalMode: z.enum(FISCAL_MODES).default('PERGUNTAR'),
  /** Impressora deste caixa (cupom, comprovantes, gaveta). Vazio = impressora do caixa das Configurações. */
  printerId: z
    .string()
    .uuid()
    .or(z.literal(''))
    .nullish()
    .transform((v) => v || null),
  active: z.boolean().default(true),
});
export type CashRegisterInput = z.input<typeof cashRegisterInputSchema>;

export interface CashRegister {
  id: string;
  name: string;
  fiscalMode: FiscalMode;
  printerId: string | null;
  active: boolean;
  /** Sessão aberta agora neste caixa, se houver. */
  openSession: { id: string; openedAt: string; openedBy: string } | null;
}

// ---------- Regras do dia (definidas na abertura do primeiro caixa) ----------

/** Tolerância do couvert: quem chegou antes do início e ficou além dela também paga. */
export const COUVERT_TOLERANCE_MINUTES = 15;

export interface DayRules {
  /** Sessão que definiu as regras (o primeiro caixa aberto). */
  sessionId: string;
  registerName: string;
  openedAt: string;
  /** Horário previsto para fechar (pode ser depois da meia-noite). */
  expectedCloseAt: string | null;
  /** Mesas em funcionamento hoje (as N primeiras pelo número). null = todas. */
  tablesInService: number | null;
  /** Couvert por pessoa e a partir de quando. 0 = sem couvert hoje. */
  couvertCents: number;
  couvertStartAt: string | null;
  /** Dia do movimento e período (Ter = 1 … Dom = 6; null = dia extra). */
  businessDate: string;
  period: number | null;
}

// ---------- Sessão de caixa ----------

export const openCashSessionSchema = z.object({
  registerId,
  /** Fundo de troco deixado na gaveta na abertura. */
  openingFloatCents: cents,
  /** Previsão de fechamento (HH:MM). Antes da hora de abertura = dia seguinte (ex.: abre 16:00, fecha 01:00). */
  expectedCloseTime: time.optional(),
  /** Mesas em funcionamento hoje. */
  tablesInService: z.number().int().min(1, 'Ao menos 1 mesa').max(999).optional(),
  /** Couvert do dia: valor por pessoa e horário de início. Ausente = sem couvert. */
  couvert: z.object({ amountCents: positiveCents, startTime: time }).nullish(),
  /** Dia do movimento (o turno que passa da meia-noite continua nele). Padrão: sugerido pelo servidor. */
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dia do movimento inválido.').optional(),
  /** Período da semana do bar (Ter = 1 … Dom = 6). null = dia extra. Padrão: pela semana configurada. */
  period: z.number().int().min(1, 'Período inválido').max(7, 'Período inválido').nullish(),
});
export type OpenCashSessionInput = z.input<typeof openCashSessionSchema>;

export const CASH_MOVEMENT_TYPES = ['SANGRIA', 'SUPRIMENTO'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const cashMovementSchema = z.object({
  registerId,
  type: z.enum(CASH_MOVEMENT_TYPES),
  amountCents: positiveCents,
  reason,
});

export const closeCashSessionSchema = z.object({
  registerId,
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
  registerId: string;
  registerName: string;
  fiscalMode: FiscalMode;
  expectedCloseAt: string | null;
  /** Dia do movimento e período desta abertura. */
  businessDate: string;
  period: number | null;
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
  /** Pessoas nesta comanda (multiplica o couvert). */
  peopleCount: number;
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
  /** Item cancelado (valor zerado; aparece riscado). */
  canceled: boolean;
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
  /** Pagamento por item: o que a pessoa pagou (ex.: R$ 15,00 do Filé, Água, Coca). Valores sem a taxa. */
  items: { productName: string; amountCents: number; whole: boolean }[];
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

/**
 * Item pago por fração (1/1 = inteiro, 1/3 da pizza) ou por valor
 * ("R$ 15,00 do filé de R$ 100,00", quem vai embora antes e paga só a parte dele).
 */
export const paymentItemSchema = z
  .object({
    orderItemId: z.string().uuid(),
    comandaId: z.string().uuid(),
    num: z.number().int().min(1).optional(),
    den: z.number().int().min(1).max(20).optional(),
    amountCents: positiveCents.optional(),
  })
  .refine((v) => (v.amountCents !== undefined) !== (v.num !== undefined && v.den !== undefined), {
    message: 'Informe a fração ou o valor do item',
  })
  .refine((v) => v.num === undefined || v.den === undefined || v.num <= v.den, 'Fração maior que o item');
export type PaymentItemInput = z.input<typeof paymentItemSchema>;

export const createPaymentSchema = z
  .object({
    clientUuid: z.string().uuid(),
    registerId,
    /** Comandas que este pagamento abate, na ordem em que devem ser quitadas. */
    comandaIds: z.array(z.string().uuid()).min(1).max(50),
    method: z.enum(PAYMENT_METHODS),
    /** Valor cobrado (sem o troco). Por item, o servidor recalcula e confere. */
    amountCents: positiveCents,
    /** Dinheiro: quanto o cliente entregou, para calcular o troco. */
    tenderedCents: cents.optional(),
    payerName: z.string().trim().min(1, 'Informe quem está pagando').max(60),
    /** Pagamento por item, fração ou valor de item (opcional). */
    items: z.array(paymentItemSchema).max(100).optional(),
  });
export type CreatePaymentInput = z.input<typeof createPaymentSchema>;

export interface CreatePaymentResult {
  paymentId: string;
  changeCents: number;
  /** Comandas que este pagamento quitou (foram fechadas). */
  closedComandaIds: string[];
  duplicate: boolean;
  /** Como o caixa trata o cupom fiscal ao quitar. */
  fiscalMode: FiscalMode;
  /** true quando o cupom fiscal já foi pedido automaticamente (caixa em modo AUTOMATICO). */
  fiscalRequested: boolean;
}

// ---------- Finalização da conta ----------

/** Cupom não fiscal (de conferência/consumo) das comandas quitadas. */
export const receiptRequestSchema = z.object({
  registerId,
  comandaIds: z.array(z.string().uuid()).min(1).max(50),
});

/**
 * Pedido de cupom fiscal (NFC-e). A emissão é a fase 5 (provedor fiscal + contador):
 * até lá o pedido fica registrado para ser emitido quando o módulo estiver ativo.
 */
export const fiscalRequestSchema = z.object({
  registerId,
  comandaIds: z.array(z.string().uuid()).min(1).max(50),
  /** Colocar o CPF da comanda na nota. */
  cpfOnNote: z.boolean().default(true),
});

export interface FiscalRequestResult {
  id: string;
  status: 'AGUARDANDO_MODULO_FISCAL';
}

export const refundPaymentSchema = z.object({ reason, authorizerPin });

/** Cancelar item lançado (SPEC 4): todo ou parte da quantidade, com motivo e PIN de gerente/admin. */
export const cancelItemSchema = z.object({
  qty: z.number().int().min(1, 'Quantidade inválida'),
  reason,
  authorizerPin,
});
export type CancelItemInput = z.infer<typeof cancelItemSchema>;

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
