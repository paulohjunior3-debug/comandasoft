import { fiscalRequestSchema, receiptRequestSchema, type FiscalRequestResult } from '@sistema-bar/shared';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { comandas, fiscalRequests } from '../../db/schema';
import { audit } from '../../lib/audit';
import { loadBill } from '../../lib/billing';
import { billTicket, enqueueCashierPrint } from '../../lib/cashier-print';
import { HttpError, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { getRegister, requireOpenSession } from './session';

/**
 * Finalização da conta quitada: o caixa escolhe imprimir o cupom não fiscal, pedir o cupom
 * fiscal ou só finalizar (estabelecimentos com dois caixas/maquininhas tratam diferente).
 */
export async function cashierFinalizeRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  /** Cupom não fiscal (de consumo) das comandas, na impressora do caixa. */
  app.post('/receipts', async (request) => {
    const { registerId, comandaIds } = receiptRequestSchema.parse(request.body);
    const register = await getRegister(db, registerId);
    const settings = await getSettings(db);
    const bill = await loadBill(db, [...new Set(comandaIds)], settings);
    if (bill.comandas.length === 0) throw notFound('Comanda');
    const printed = await enqueueCashierPrint(db, settings, billTicket(bill, 'CUPOM', settings, `${request.user!.name} · ${register.name}`), undefined, register.printerId);
    if (!printed) {
      throw new HttpError(409, 'NO_CASHIER_PRINTER', 'Este caixa não tem impressora. Escolha uma em Administração > Caixas ou Configurações.');
    }
    printWorker.kick();
    return { printed };
  });

  /**
   * Pedido de cupom fiscal (NFC-e). A emissão é a fase 5: até lá o pedido fica registrado,
   * com as comandas e se vai CPF na nota, para ser emitido quando o módulo fiscal existir.
   */
  app.post('/fiscal-requests', async (request, reply): Promise<FiscalRequestResult> => {
    const input = fiscalRequestSchema.parse(request.body);
    const register = await getRegister(db, input.registerId);
    const session = await requireOpenSession(db, register.id);
    const ids = [...new Set(input.comandaIds)];
    const found = await db.select({ id: comandas.id }).from(comandas).where(inArray(comandas.id, ids));
    if (found.length !== ids.length) throw notFound('Comanda');
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(fiscalRequests)
        .values({ cashSessionId: session.id, comandaIds: ids, cpfOnNote: input.cpfOnNote, requestedBy: request.user!.id })
        .returning({ id: fiscalRequests.id });
      await audit(tx, request, {
        action: 'CUPOM_FISCAL_SOLICITADO',
        entity: 'fiscal_request',
        entityId: created!.id,
        after: { register: register.name, comandaIds: ids, cpfOnNote: input.cpfOnNote },
      });
      return created!;
    });
    reply.code(201);
    return { id: row.id, status: 'AGUARDANDO_MODULO_FISCAL' };
  });
}
