import { timingSafeEqual } from 'node:crypto';
import {
  maskName,
  qrPinOf,
  PUBLIC_ERRORS,
  QR_MAX_WRONG_PINS,
  QR_WRONG_PIN_WINDOW_MINUTES,
  qrUnlockSchema,
  type PublicComandaOption,
  type PublicComandaView,
  type PublicTableInfo,
  type QrUnlockResult,
} from '@sistema-bar/shared';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { QR_TOKEN_TTL_SECONDS, type TokenService } from '../auth/tokens';
import type { Db } from '../db/client';
import { comandas, diningTables, orderItems, orderItemShares, orders, qrUnlockAttempts } from '../db/schema';
import { audit } from '../lib/audit';
import { loadBill } from '../lib/billing';
import { HttpError } from '../lib/errors';
import { loadMenu } from '../lib/menu';
import { getSettings } from '../lib/settings';

export interface PublicDeps {
  db: Db;
  tokens: TokenService;
}

const tableParams = z.object({ qrToken: z.string().min(4).max(64) });
const comandaParams = tableParams.extend({ comandaId: z.string().uuid('Comanda inválida.') });

const tableGone = () => new HttpError(404, 'NOT_FOUND', 'QR Code não reconhecido. Peça ajuda ao garçom.');
const comandaGone = () =>
  new HttpError(410, PUBLIC_ERRORS.COMANDA_CLOSED, 'Esta comanda não está mais aberta. Obrigado pela visita!');

/**
 * QR da mesa (SPEC 5.6), sem login: cardápio, lista das comandas da mesa com nome mascarado e,
 * com o PIN (4 últimos números do telefone), a própria comanda — somente leitura. PIN errado demais
 * bloqueia a consulta daquela comanda até o garçom liberar.
 */
export async function publicRoutes(app: FastifyInstance, { db, tokens }: PublicDeps) {
  async function tableOf(qrToken: string) {
    const [t] = await db
      .select()
      .from(diningTables)
      .where(and(eq(diningTables.qrToken, qrToken), eq(diningTables.active, true), eq(diningTables.isCounter, false)));
    if (!t) throw tableGone();
    return t;
  }

  async function openComandaOf(tableId: string, comandaId: string) {
    const [c] = await db.select().from(comandas).where(and(eq(comandas.id, comandaId), eq(comandas.tableId, tableId)));
    if (!c || (c.status !== 'ABERTA' && c.status !== 'EM_FECHAMENTO')) throw comandaGone();
    return c;
  }

  app.get('/m/:qrToken', async (request): Promise<PublicTableInfo> => {
    const table = await tableOf(tableParams.parse(request.params).qrToken);
    const settings = await getSettings(db);
    return {
      tableNumber: table.number,
      companyName: settings.companyName,
      guestWifiName: settings.guestWifiName,
      serviceFeeEnabled: settings.serviceFeeEnabled,
      menu: await loadMenu(db, { hideSoldOut: true }),
    };
  });

  app.get('/m/:qrToken/comandas', async (request): Promise<PublicComandaOption[]> => {
    const table = await tableOf(tableParams.parse(request.params).qrToken);
    const rows = await db
      .select({ id: comandas.id, name: comandas.customerName, lockedAt: comandas.qrLockedAt, phone: comandas.phone, cpfLast3: comandas.cpfLast3 })
      .from(comandas)
      .where(and(eq(comandas.tableId, table.id), inArray(comandas.status, ['ABERTA', 'EM_FECHAMENTO'])))
      .orderBy(asc(comandas.openedAt), asc(comandas.number));
    return rows.map((r) => ({
      id: r.id,
      maskedName: maskName(r.name),
      locked: r.lockedAt !== null,
      pinDigits: (qrPinOf(r)?.length === 3 ? 3 : 4) as 3 | 4,
    }));
  });

  app.post(
    '/m/:qrToken/comandas/:comandaId/unlock',
    // Além do limite por comanda, um limite por aparelho (IP) contra quem tenta em várias comandas.
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply): Promise<QrUnlockResult | undefined> => {
      const { qrToken, comandaId } = comandaParams.parse(request.params);
      const { pin } = qrUnlockSchema.parse(request.body);
      const table = await tableOf(qrToken);
      const c = await openComandaOf(table.id, comandaId);
      if (c.qrLockedAt) throw locked();

      // PIN: 4 últimos do telefone (ou 3 do CPF nas comandas antigas). Sem nenhum dos dois, nunca libera.
      const expected = qrPinOf(c);
      const ok = expected !== null && pin.length === expected.length && timingSafeEqual(Buffer.from(pin), Buffer.from(expected));
      await db.insert(qrUnlockAttempts).values({ comandaId: c.id, ok, ip: request.ip });
      if (ok) return { token: await tokens.signQr(c.id), expiresInSeconds: QR_TOKEN_TTL_SECONDS };

      const since = new Date(Date.now() - QR_WRONG_PIN_WINDOW_MINUTES * 60 * 1000);
      const [{ wrong }] = (await db
        .select({ wrong: sql<number>`count(*)::int` })
        .from(qrUnlockAttempts)
        .where(and(eq(qrUnlockAttempts.comandaId, c.id), eq(qrUnlockAttempts.ok, false), gte(qrUnlockAttempts.createdAt, since)))) as [
        { wrong: number },
      ];
      if (wrong >= QR_MAX_WRONG_PINS) {
        await db.update(comandas).set({ qrLockedAt: new Date() }).where(eq(comandas.id, c.id));
        await audit(db, request, {
          action: 'QR_BLOQUEADO',
          entity: 'comanda',
          entityId: c.id,
          after: { tableNumber: table.number, customerName: c.customerName, wrongPins: wrong },
        });
        throw locked();
      }
      const left = QR_MAX_WRONG_PINS - wrong;
      reply.code(401).send({
        error: PUBLIC_ERRORS.WRONG_PIN,
        message: `Números não conferem. ${left === 1 ? 'Resta 1 tentativa' : `Restam ${left} tentativas`}.`,
      });
      return undefined;
    },
  );

  app.get('/m/:qrToken/comandas/:comandaId', async (request): Promise<PublicComandaView> => {
    const { qrToken, comandaId } = comandaParams.parse(request.params);
    await requireQrToken(request, comandaId);
    const table = await tableOf(qrToken);
    const c = await openComandaOf(table.id, comandaId);
    if (c.qrLockedAt) throw locked();

    const settings = await getSettings(db);
    const bill = await loadBill(db, [c.id], settings);
    const mine = bill.comandas[0]!;

    const shareCount = db
      .select({ orderItemId: orderItemShares.orderItemId, n: sql<number>`count(*)::int`.as('n') })
      .from(orderItemShares)
      .groupBy(orderItemShares.orderItemId)
      .as('share_count');
    const items = await db
      .select({
        name: orderItems.productNameSnapshot,
        qty: orderItems.qty,
        amountCents: orderItemShares.amountCents,
        sharedWith: shareCount.n,
        at: orders.receivedAt,
      })
      .from(orderItemShares)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(shareCount, eq(shareCount.orderItemId, orderItems.id))
      .where(and(eq(orderItemShares.comandaId, c.id), eq(orderItems.status, 'ATIVO')))
      .orderBy(orders.receivedAt, orderItems.createdAt);

    return {
      customerName: c.customerName,
      tableNumber: table.number,
      status: c.status as PublicComandaView['status'],
      openedAt: c.openedAt.toISOString(),
      peopleCount: c.peopleCount,
      items: items.map((i) => ({ ...i, at: i.at.toISOString() })),
      totals: mine.totals,
      serviceFeeWaived: mine.serviceFeeWaived,
      payments: bill.payments
        .filter((p) => p.status === 'OK')
        .map((p) => ({
          payerName: p.payerName,
          method: p.method,
          amountCents: p.allocations.find((a) => a.comandaId === c.id)?.amountCents ?? 0,
          at: p.createdAt,
        })),
      updatedAt: new Date().toISOString(),
    };
  });

  async function requireQrToken(request: FastifyRequest, comandaId: string) {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let sub: string | null = null;
    try {
      sub = token ? await tokens.verifyQr(token) : null;
    } catch {
      sub = null;
    }
    if (sub !== comandaId) throw new HttpError(401, 'UNAUTHENTICATED', 'Digite de novo os 4 últimos números do telefone.');
  }
}

function locked() {
  return new HttpError(
    423,
    PUBLIC_ERRORS.QR_LOCKED,
    'Consulta bloqueada por tentativas erradas. Peça ao garçom para liberar esta comanda.',
  );
}
