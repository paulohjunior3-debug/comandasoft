import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { auditLogs } from '../db/schema';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

/** Grava no log de auditoria quem fez o quê (SPEC 5.10). Aceita `tx` para ficar na mesma transação. */
export async function audit(db: Pick<Db, 'insert'>, request: FastifyRequest, entry: AuditEntry) {
  await db.insert(auditLogs).values({
    userId: request.user?.id ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    beforeJson: entry.before ?? null,
    afterJson: entry.after ?? null,
    ip: request.ip,
  });
}

/** Remove campos sensíveis antes de gravar um registro na auditoria. */
export function redact<T extends Record<string, unknown>>(row: T): Omit<T, 'passwordHash' | 'pinHash'> {
  const { passwordHash: _p, pinHash: _n, ...rest } = row;
  return rest;
}
