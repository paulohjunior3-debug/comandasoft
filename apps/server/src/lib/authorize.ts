import { CASHIER_ERRORS } from '@sistema-bar/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { verifyPassword } from '../auth/password';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { HttpError } from './errors';

export interface Authorizer {
  id: string;
  name: string;
  /** true quando quem está logado já tinha permissão (não precisou de PIN). */
  self: boolean;
}

/**
 * Ações sensíveis (desconto, retirar taxa, estorno…) exigem gerente (SPEC 4).
 * Gerente ou admin logado: autorizado. Caixa: precisa do PIN de um gerente/admin ativo,
 * e quem autorizou fica registrado na auditoria.
 */
export async function authorizeManager(db: Db, request: FastifyRequest, pin: string | undefined): Promise<Authorizer> {
  const user = request.user!;
  if (user.role === 'GERENTE' || user.role === 'ADMIN') return { id: user.id, name: user.name, self: true };
  if (!pin) {
    throw new HttpError(403, CASHIER_ERRORS.PIN_REQUIRED, 'Esta ação precisa da autorização de um gerente (PIN).');
  }
  const managers = await db
    .select({ id: users.id, name: users.name, pinHash: users.pinHash })
    .from(users)
    .where(and(inArray(users.role, ['GERENTE', 'ADMIN']), eq(users.active, true), isNotNull(users.pinHash)));
  for (const m of managers) {
    if (await verifyPassword(m.pinHash!, pin)) return { id: m.id, name: m.name, self: false };
  }
  throw new HttpError(403, CASHIER_ERRORS.PIN_INVALID, 'PIN de gerente inválido.');
}
