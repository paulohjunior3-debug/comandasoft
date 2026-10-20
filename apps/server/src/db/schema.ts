import { ADJUSTMENT_TYPES, CASH_MOVEMENT_TYPES, COMANDA_STATUSES, FISCAL_MODES, PAYMENT_METHODS, ROLES } from '@sistema-bar/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const id = uuid().primaryKey().default(sql`gen_random_uuid()`);

export const roleEnum = pgEnum('role', ROLES);

export const users = pgTable('users', {
  id,
  name: text().notNull(),
  login: text().notNull().unique(),
  passwordHash: text().notNull(),
  role: roleEnum().notNull(),
  pinHash: text(),
  active: boolean().notNull().default(true),
  ...timestamps,
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id,
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    userAgent: text(),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id,
    userId: uuid().references(() => users.id),
    action: text().notNull(),
    entity: text(),
    entityId: text(),
    beforeJson: jsonb(),
    afterJson: jsonb(),
    ip: text(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.at), index().on(t.entity, t.entityId)],
);

// ---------- Cadastros (SPEC 5.1) ----------

export const categories = pgTable('categories', {
  id,
  name: text().notNull().unique(),
  sortOrder: integer().notNull().default(0),
  color: text(),
  active: boolean().notNull().default(true),
  ...timestamps,
});

export const products = pgTable(
  'products',
  {
    id,
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    description: text(),
    imageUrl: text(),
    priceCents: integer().notNull(),
    sku: text(),
    active: boolean().notNull().default(true),
    soldOut: boolean().notNull().default(false),
    ncm: text(),
    cfop: text(),
    csosn: text(),
    unit: text().notNull().default('UN'),
    origin: text(),
    ...timestamps,
  },
  (t) => [
    index().on(t.categoryId),
    uniqueIndex('products_sku_unique').on(t.sku).where(sql`${t.sku} is not null`),
    check('products_price_non_negative', sql`${t.priceCents} >= 0`),
  ],
);

export const printers = pgTable('printers', {
  id,
  name: text().notNull().unique(),
  windowsName: text().notNull(),
  sectorLabel: text().notNull(),
  widthMm: integer().notNull().default(80),
  codepage: text().notNull().default('CP860'),
  cut: boolean().notNull().default(true),
  active: boolean().notNull().default(true),
  ...timestamps,
});

export const printerCategories = pgTable(
  'printer_categories',
  {
    printerId: uuid()
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.printerId, t.categoryId] }), index().on(t.categoryId)],
);

export const diningTables = pgTable('tables', {
  id,
  number: integer().notNull().unique(),
  area: text(),
  capacity: integer(),
  active: boolean().notNull().default(true),
  /** Token aleatório usado na URL do QR do cliente; nunca o número da mesa (SPEC 5.6). */
  qrToken: text().notNull().unique(),
  ...timestamps,
});

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  valueJson: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------- Comandas e pedidos (SPEC 5.2–5.5) ----------

export const comandaStatusEnum = pgEnum('comanda_status', COMANDA_STATUSES);
export const orderItemStatusEnum = pgEnum('order_item_status', ['ATIVO', 'CANCELADO']);
export const printJobTypeEnum = pgEnum('print_job_type', ['PRODUCAO', 'CANCELAMENTO', 'PRE_CONTA', 'CUPOM', 'DANFE', 'CAIXA', 'TESTE', 'GAVETA']);
export const printJobStatusEnum = pgEnum('print_job_status', ['PENDENTE', 'IMPRIMINDO', 'OK', 'ERRO']);

const OPEN_COMANDA = sql`status in ('ABERTA', 'EM_FECHAMENTO')`;

export const comandas = pgTable(
  'comandas',
  {
    id,
    /** Número interno sequencial (referência/auditoria). No dia a dia a comanda é identificada pelo nome. */
    number: integer().generatedAlwaysAsIdentity().notNull().unique(),
    tableId: uuid()
      .notNull()
      .references(() => diningTables.id, { onDelete: 'restrict' }),
    customerName: text().notNull(),
    /** HMAC do CPF: permite buscar pelo CPF no caixa sem guardar o número em claro. */
    cpfHmac: text().notNull(),
    /** CPF cifrado (AES-256-GCM), só para "CPF na nota" da NFC-e. */
    cpfEncrypted: text().notNull(),
    /** 3 últimos dígitos: PIN do QR do cliente (SPEC 5.6). */
    cpfLast3: text().notNull(),
    phone: text(),
    /** Pessoas nesta comanda (multiplica o couvert). */
    peopleCount: integer().notNull().default(1),
    /** Consulta pelo QR bloqueada por PIN errado demais (SPEC 5.6); o garçom libera. */
    qrLockedAt: timestamp({ withTimezone: true }),
    status: comandaStatusEnum().notNull().default('ABERTA'),
    clientUuid: uuid().notNull().unique(),
    openedBy: uuid()
      .notNull()
      .references(() => users.id),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closingRequestedAt: timestamp({ withTimezone: true }),
    closedAt: timestamp({ withTimezone: true }),
    notes: text(),
    qrLockedUntil: timestamp({ withTimezone: true }),
    /** Totais congelados no fechamento: mudar a taxa ou o couvert depois não altera contas fechadas. */
    finalTotals: jsonb(),
    ...timestamps,
  },
  (t) => [
    index().on(t.tableId),
    index().on(t.status),
    // Um CPF, uma comanda aberta (a busca por CPF no caixa encontra exatamente uma).
    uniqueIndex('comandas_open_cpf_unique').on(t.cpfHmac).where(OPEN_COMANDA),
    // Nomes não se repetem entre as comandas abertas da mesma mesa.
    uniqueIndex('comandas_open_name_per_table_unique').on(t.tableId, sql`lower(${t.customerName})`).where(OPEN_COMANDA),
  ],
);

/** "Atendi a mesa": registra visita sem pedido (SPEC 5.3). */
export const tableVisits = pgTable(
  'table_visits',
  {
    id,
    clientUuid: uuid().notNull().unique(),
    tableId: uuid()
      .notNull()
      .references(() => diningTables.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    visitedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.tableId, t.visitedAt)],
);

export const orders = pgTable(
  'orders',
  {
    id,
    clientUuid: uuid().notNull().unique(),
    tableId: uuid()
      .notNull()
      .references(() => diningTables.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    createdAtDevice: timestamp({ withTimezone: true }).notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.tableId, t.receivedAt)],
);

export const orderItems = pgTable(
  'order_items',
  {
    id,
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** Nome, categoria e preço copiados: mudar o cardápio não altera o histórico. */
    productNameSnapshot: text().notNull(),
    categoryId: uuid().notNull(),
    qty: integer().notNull(),
    unitPriceCents: integer().notNull(),
    notes: text(),
    status: orderItemStatusEnum().notNull().default('ATIVO'),
    canceledBy: uuid().references(() => users.id),
    cancelReason: text(),
    canceledAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.orderId), check('order_items_qty_positive', sql`${t.qty} > 0`)],
);

/**
 * Parte de cada comanda em um item. Item lançado para uma comanda = 1 linha com o valor cheio;
 * rateado entre N comandas = N linhas cuja soma é exatamente o total do item.
 */
export const orderItemShares = pgTable(
  'order_item_shares',
  {
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    comandaId: uuid()
      .notNull()
      .references(() => comandas.id),
    amountCents: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderItemId, t.comandaId] }), index().on(t.comandaId)],
);

/** Fila persistente de impressão (SPEC 5.5). O worker em src/printing/worker.ts consome. */
export const printJobs = pgTable(
  'print_jobs',
  {
    id,
    printerId: uuid()
      .notNull()
      .references(() => printers.id),
    type: printJobTypeEnum().notNull(),
    payload: jsonb().notNull(),
    status: printJobStatusEnum().notNull().default('PENDENTE'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    referenceId: uuid(),
    /** Reimpressão: aponta para o cupom original. */
    reprintOf: uuid(),
    /** Depois de uma falha, só tenta de novo a partir deste momento (backoff). */
    nextAttemptAt: timestamp({ withTimezone: true }),
    printedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.status, t.createdAt), index().on(t.referenceId)],
);

// ---------- Caixa (SPEC 5.7) ----------

export const paymentMethodEnum = pgEnum('payment_method', PAYMENT_METHODS);
export const paymentStatusEnum = pgEnum('payment_status', ['OK', 'ESTORNADO']);
export const cashMovementTypeEnum = pgEnum('cash_movement_type', CASH_MOVEMENT_TYPES);
export const adjustmentTypeEnum = pgEnum('adjustment_type', ADJUSTMENT_TYPES);

export const fiscalModeEnum = pgEnum('fiscal_mode', FISCAL_MODES);

/** Pontos de cobrança (Caixa Carlos, Caixa Paulo…), cada um com sua sessão e sua impressora. */
export const cashRegisters = pgTable('cash_registers', {
  id,
  name: text().notNull().unique(),
  fiscalMode: fiscalModeEnum().notNull().default('PERGUNTAR'),
  printerId: uuid().references(() => printers.id, { onDelete: 'set null' }),
  active: boolean().notNull().default(true),
  ...timestamps,
});

export const cashSessions = pgTable(
  'cash_sessions',
  {
    id,
    registerId: uuid()
      .notNull()
      .references(() => cashRegisters.id),
    openedBy: uuid()
      .notNull()
      .references(() => users.id),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Fundo de troco (suprimento inicial). */
    openingFloatCents: integer().notNull(),
    /** Regras do dia, informadas na abertura: previsão de fechamento, mesas e couvert. */
    expectedCloseAt: timestamp({ withTimezone: true }),
    tablesInService: integer(),
    couvertCents: integer().notNull().default(0),
    couvertStartAt: timestamp({ withTimezone: true }),
    /** Dia do movimento (AAAA-MM-DD): o turno que passa da meia-noite continua no dia em que abriu. */
    businessDate: date({ mode: 'string' }).notNull(),
    /** Período da semana do bar (Ter = 1 … Dom = 6). null = dia extra. */
    period: integer(),
    closedBy: uuid().references(() => users.id),
    closedAt: timestamp({ withTimezone: true }),
    expectedJson: jsonb(),
    countedJson: jsonb(),
    differenceCents: integer(),
    notes: text(),
    ...timestamps,
  },
  // Uma sessão aberta por caixa.
  (t) => [uniqueIndex('cash_sessions_one_open_per_register').on(t.registerId).where(sql`${t.closedAt} is null`)],
);

/**
 * Pedidos de cupom fiscal (NFC-e). A emissão é a fase 5; até lá o pedido fica registrado
 * aqui (com as comandas e se vai CPF na nota) para ser emitido quando o módulo existir.
 */
export const fiscalRequests = pgTable('fiscal_requests', {
  id,
  cashSessionId: uuid()
    .notNull()
    .references(() => cashSessions.id),
  comandaIds: jsonb().$type<string[]>().notNull(),
  cpfOnNote: boolean().notNull().default(true),
  automatic: boolean().notNull().default(false),
  status: text().notNull().default('AGUARDANDO_MODULO_FISCAL'),
  requestedBy: uuid()
    .notNull()
    .references(() => users.id),
  ...timestamps,
});

export const cashMovements = pgTable(
  'cash_movements',
  {
    id,
    cashSessionId: uuid()
      .notNull()
      .references(() => cashSessions.id),
    type: cashMovementTypeEnum().notNull(),
    amountCents: integer().notNull(),
    reason: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.cashSessionId), check('cash_movements_positive', sql`${t.amountCents} > 0`)],
);

export const payments = pgTable(
  'payments',
  {
    id,
    /** Gerado na tela do caixa: clique duplo ou reenvio não cobram duas vezes. */
    clientUuid: uuid().notNull().unique(),
    cashSessionId: uuid()
      .notNull()
      .references(() => cashSessions.id),
    method: paymentMethodEnum().notNull(),
    /** Valor cobrado (abate a conta). */
    amountCents: integer().notNull(),
    /** Dinheiro entregue pelo cliente e troco devolvido. */
    tenderedCents: integer(),
    changeCents: integer().notNull().default(0),
    payerName: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    status: paymentStatusEnum().notNull().default('OK'),
    refundedBy: uuid().references(() => users.id),
    refundReason: text(),
    refundedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.cashSessionId), check('payments_positive', sql`${t.amountCents} > 0`)],
);

/** Quanto de cada pagamento foi para cada comanda (um pagamento pode quitar várias). */
export const paymentComandas = pgTable(
  'payment_comandas',
  {
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    comandaId: uuid()
      .notNull()
      .references(() => comandas.id),
    amountCents: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.paymentId, t.comandaId] }), index().on(t.comandaId)],
);

/** Pagamento por item ou fração de item (ex.: 1/3 da pizza). */
export const paymentItems = pgTable(
  'payment_items',
  {
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id),
    comandaId: uuid()
      .notNull()
      .references(() => comandas.id),
    fractionNum: integer().notNull(),
    fractionDen: integer().notNull(),
    /** Parte do item paga (sem a taxa de serviço). */
    itemAmountCents: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.paymentId, t.orderItemId, t.comandaId] }), index().on(t.orderItemId)],
);

export const adjustments = pgTable(
  'adjustments',
  {
    id,
    comandaId: uuid()
      .notNull()
      .references(() => comandas.id),
    type: adjustmentTypeEnum().notNull(),
    amountCents: integer(),
    percentBps: integer(),
    reason: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Gerente que autorizou com PIN, quando quem fez não tinha permissão. */
    authorizedBy: uuid().references(() => users.id),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [index().on(t.comandaId)],
);

/** Tentativas de PIN no QR da mesa: base do bloqueio por comanda (SPEC 5.6). */
export const qrUnlockAttempts = pgTable(
  'qr_unlock_attempts',
  {
    id,
    comandaId: uuid()
      .notNull()
      .references(() => comandas.id, { onDelete: 'cascade' }),
    ok: boolean().notNull(),
    ip: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.comandaId, t.createdAt)],
);
