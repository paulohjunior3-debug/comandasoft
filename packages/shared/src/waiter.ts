import { z } from 'zod';
import { isValidCpf, onlyDigits } from './cpf';

// Contratos do app do garçom: comandas, mapa de mesas e lançamento de pedidos (SPEC 5.2–5.4).
// Toda escrita carrega um `clientUuid` gerado no aparelho: reenviar nunca duplica (SPEC 5.4).

export const COMANDA_STATUSES = ['ABERTA', 'EM_FECHAMENTO', 'FECHADA', 'CANCELADA'] as const;
export type ComandaStatus = (typeof COMANDA_STATUSES)[number];

export const TABLE_STATUSES = ['LIVRE', 'OCUPADA', 'EM_FECHAMENTO'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

const clientUuid = z.string().uuid('Identificador do aparelho inválido');

// ---------- Comandas ----------

export const openComandaSchema = z.object({
  clientUuid,
  tableId: z.string().uuid('Escolha a mesa'),
  customerName: z.string().trim().min(2, 'Informe o nome do cliente').max(40, 'Nome muito longo'),
  cpf: z
    .string()
    .transform(onlyDigits)
    .refine(isValidCpf, 'CPF inválido'),
  phone: z
    .string()
    .transform(onlyDigits)
    .refine((v) => v === '' || (v.length >= 10 && v.length <= 11), 'Telefone inválido')
    .transform((v) => v || null)
    .nullish()
    .transform((v) => v ?? null),
  /** Pessoas que consomem nesta comanda (ex.: casal numa comanda só = 2). Multiplica o couvert. */
  peopleCount: z.number().int().min(1, 'Ao menos 1 pessoa').max(30, 'Máximo de 30 pessoas').default(1),
});
export type OpenComandaInput = z.input<typeof openComandaSchema>;

export interface ComandaSummary {
  id: string;
  /** Gerado no aparelho na abertura; o app usa como id provisório enquanto offline. */
  clientUuid: string;
  number: number;
  tableId: string;
  tableNumber: number;
  customerName: string;
  peopleCount: number;
  status: ComandaStatus;
  openedAt: string;
  totalCents: number;
}

// ---------- Mapa de mesas ----------

export interface TableMapEntry {
  id: string;
  number: number;
  area: string | null;
  status: TableStatus;
  comandaCount: number;
  totalCents: number;
  /** Último pedido, "atendi a mesa" ou abertura de comanda. null se a mesa está livre. */
  lastAttendedAt: string | null;
}

export interface TableMapResponse {
  tables: TableMapEntry[];
  alertYellowMinutes: number;
  alertRedMinutes: number;
  serverTime: string;
}

export interface TableDetail {
  table: { id: string; number: number; area: string | null };
  comandas: ComandaSummary[];
}

export const tableVisitSchema = z.object({ clientUuid });

// ---------- Cardápio para o garçom ----------

export interface MenuCategory {
  id: string;
  name: string;
  color: string | null;
  products: MenuProduct[];
}

export interface MenuProduct {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  soldOut: boolean;
  /** Foto (/fotos/<id>?v=…), quando cadastrada. */
  imageUrl: string | null;
}

// ---------- Pedidos ----------

export const orderItemInputSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().min(1, 'Quantidade mínima é 1').max(99, 'Quantidade máxima é 99'),
  notes: z
    .string()
    .trim()
    .max(140, 'Observação muito longa')
    .transform((v) => v || null)
    .nullish()
    .transform((v) => v ?? null),
  /** Preço que o aparelho mostrou (cache). Se diferir do vigente, o servidor registra a divergência. */
  expectedUnitPriceCents: z.number().int().min(0).optional(),
});
export type OrderItemInput = z.input<typeof orderItemInputSchema>;

export const createOrderSchema = z.object({
  clientUuid,
  tableId: z.string().uuid(),
  /**
   * Uma comanda, ou várias para ratear os itens igualmente entre elas. Aceita o id da comanda
   * ou o clientUuid da abertura (comanda aberta offline que acabou de ser sincronizada).
   */
  comandaIds: z.array(z.string().uuid()).min(1, 'Escolha ao menos uma comanda').max(30),
  items: z.array(orderItemInputSchema).min(1, 'O pedido está vazio').max(100),
  /** Quando o garçom tocou em Enviar (pode ser bem antes, se estava offline). */
  createdAtDevice: z.string().datetime({ offset: true }),
});
export type CreateOrderInput = z.input<typeof createOrderSchema>;

export interface CreateOrderResponse {
  orderId: string;
  /** true quando o servidor já tinha recebido este pedido (reenvio). */
  duplicate: boolean;
  printJobs: number;
  /** Itens de categorias sem impressora vinculada (não saem em papel). */
  unroutedItems: number;
}

export interface ComandaItem {
  orderItemId: string;
  productName: string;
  qty: number;
  unitPriceCents: number;
  notes: string | null;
  status: 'ATIVO' | 'CANCELADO';
  /** Parte desta comanda no item (difere do total quando rateado). */
  amountCents: number;
  sharedWith: number;
  createdAt: string;
  waiterName: string;
}

export interface ComandaDetail extends ComandaSummary {
  phone: string | null;
  /** null = venda no balcão sem CPF. */
  cpfLast3: string | null;
  items: ComandaItem[];
  subtotalCents: number;
  serviceFeeCents: number;
  /** Couvert do dia × pessoas, se aplicável (regra das 14h + 15 min de tolerância). */
  couvertCents: number;
  /** Total da comanda (itens + taxa + couvert − descontos). */
  totalWithFeeCents: number;
  /** Consulta pelo QR bloqueada por PIN errado demais: o garçom libera. */
  qrLocked: boolean;
}

// ---------- Erros com tratamento específico no app ----------

export const WAITER_ERRORS = {
  /** Já existe comanda aberta com esse nome na mesa: pedir um complemento (sobrenome/inicial). */
  DUPLICATE_NAME: 'DUPLICATE_NAME',
  /** O CPF já tem comanda aberta (em qualquer mesa). */
  CPF_HAS_OPEN_COMANDA: 'CPF_HAS_OPEN_COMANDA',
  /** Comanda fechada/cancelada enquanto o pedido estava pendente (SPEC 5.4 item 8). */
  COMANDA_NOT_OPEN: 'COMANDA_NOT_OPEN',
  /** A comanda não existe no servidor (ex.: abertura offline recusada). */
  COMANDA_NOT_FOUND: 'COMANDA_NOT_FOUND',
  SOLD_OUT: 'SOLD_OUT',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
} as const;
