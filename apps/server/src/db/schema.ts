import { COMANDA_STATUSES, ROLES } from '@sistema-bar/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
export const printJobTypeEnum = pgEnum('print_job_type', ['PRODUCAO', 'CANCELAMENTO', 'PRE_CONTA', 'CUPOM', 'DANFE', 'CAIXA', 'TESTE']);
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

/** Fila persistente de impressão (SPEC 5.5). O worker que imprime vem na próxima etapa. */
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
    printedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.status, t.createdAt), index().on(t.referenceId)],
);
