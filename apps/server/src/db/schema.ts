import { ROLES } from '@sistema-bar/shared';
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
