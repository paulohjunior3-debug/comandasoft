import { ROLES } from '@sistema-bar/shared';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
