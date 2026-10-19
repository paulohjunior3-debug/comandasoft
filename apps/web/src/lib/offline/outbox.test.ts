import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api';
import { OfflineDb, type OutboxEntry } from './db';
import { createOutbox, type NewEntry } from './outbox';

// Simula o servidor: cada envio passa por `server`, que decide o que acontece.
let db: OfflineDb;
let sent: string[];
let online: boolean;
let server: (entry: OutboxEntry) => Promise<unknown>;

const offline = () => Promise.reject(new ApiRequestError(0, 'NETWORK', 'Sem conexão com o servidor.'));

function make() {
  return createOutbox({
    db,
    isOnline: () => online,
    sender: async (entry) => {
      const result = await server(entry);
      sent.push(entry.id);
      return result;
    },
  });
}

const entry = (id: string, kind: OutboxEntry['kind'] = 'order'): NewEntry => ({
  id,
  kind,
  method: 'POST',
  path: `/waiter/${kind}`,
  body: { clientUuid: id },
  tableId: 'mesa-10',
  label: id,
  userId: 'u1',
});

beforeEach(async () => {
  db = new OfflineDb(`teste-${Math.random()}`);
  sent = [];
  online = true;
  server = async (e) => ({ ok: e.id });
});

describe('outbox', () => {
  it('online e com a fila vazia: envia na hora e não guarda nada', async () => {
    const box = make();
    const r = await box.submit(entry('a'));
    expect(r).toEqual({ sent: true, result: { ok: 'a' } });
    expect(await db.outbox.count()).toBe(0);
  });

  it('sem conexão: guarda e envia tudo, na ordem, quando a rede volta', async () => {
    online = false;
    server = offline;
    const box = make();
    for (const id of ['abre-comanda', 'pedido-1', 'pedido-2']) {
      expect(await box.submit(entry(id))).toEqual({ sent: false });
    }
    await box.sync();
    expect(await box.pendingCount()).toBe(3);
    expect(sent).toEqual([]);

    online = true;
    server = async () => ({});
    await box.sync();
    expect(sent).toEqual(['abre-comanda', 'pedido-1', 'pedido-2']);
    expect(await db.outbox.count()).toBe(0);
  });

  it('a rede cai no meio: para no primeiro que falhou e mantém a ordem', async () => {
    online = false;
    server = offline;
    const box = make();
    for (const id of ['1', '2', '3']) await box.submit(entry(id));
    await box.sync(); // deixa terminar as tentativas de fundo disparadas pelos submits

    let calls = 0;
    server = async () => (++calls === 2 ? offline() : {});
    await box.sync();
    expect(sent).toEqual(['1']);
    const left = await db.outbox.orderBy('createdAt').toArray();
    expect(left.map((e) => e.id)).toEqual(['2', '3']);
    expect(left[0]!.attempts).toBe(1);

    server = async () => ({});
    await box.sync();
    expect(sent).toEqual(['1', '2', '3']);
  });

  it('com algo já na fila, um novo envio entra atrás (não fura a fila mesmo online)', async () => {
    online = false;
    server = offline;
    const box = make();
    await box.submit(entry('comanda-offline', 'comanda'));

    online = true;
    server = async () => ({});
    const r = await box.submit(entry('pedido-da-comanda'));
    expect(r).toEqual({ sent: false });
    await box.sync();
    expect(sent).toEqual(['comanda-offline', 'pedido-da-comanda']);
  });

  it('recusa do servidor vira conflito e o resto da fila continua', async () => {
    online = false;
    server = offline;
    const box = make();
    for (const id of ['ok-1', 'recusado', 'ok-2']) await box.submit(entry(id));

    server = async (e) => {
      if (e.id === 'recusado') throw new ApiRequestError(409, 'COMANDA_NOT_OPEN', 'Comanda já encerrada: Ana.');
      return {};
    };
    await box.sync();
    expect(sent).toEqual(['ok-1', 'ok-2']);
    const [conflict] = await db.outbox.toArray();
    expect(conflict).toMatchObject({ id: 'recusado', status: 'CONFLITO', error: { code: 'COMANDA_NOT_OPEN' } });
    expect(await box.pendingCount()).toBe(0);
  });

  it('conflito resolvido: reenviar com outra comanda usa o mesmo clientUuid', async () => {
    online = false;
    server = offline;
    const box = make();
    await box.submit(entry('pedido'));
    server = async () => Promise.reject(new ApiRequestError(409, 'COMANDA_NOT_OPEN', 'Encerrada'));
    await box.sync();

    let body: unknown;
    server = async (e) => {
      body = e.body;
      return {};
    };
    await box.retry('pedido', { clientUuid: 'pedido', comandaIds: ['outra'] });
    expect(sent).toEqual(['pedido']);
    expect(body).toEqual({ clientUuid: 'pedido', comandaIds: ['outra'] });
  });

  it('erro de validação no envio direto (online) volta para a tela em vez de ir para a fila', async () => {
    server = async () => Promise.reject(new ApiRequestError(409, 'DUPLICATE_NAME', 'Já existe "Paulo" na mesa 10.'));
    const box = make();
    await expect(box.submit(entry('abre', 'comanda'))).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    expect(await db.outbox.count()).toBe(0);
  });

  it('servidor fora do ar (5xx) no envio direto: guarda para depois', async () => {
    server = async () => Promise.reject(new ApiRequestError(502, 'ERROR', 'Bad gateway'));
    const box = make();
    expect(await box.submit(entry('a'))).toEqual({ sent: false });
    expect(await box.pendingCount()).toBe(1);
  });

  it('sincronizações simultâneas não enviam o mesmo item duas vezes', async () => {
    online = false;
    server = offline;
    const box = make();
    for (const id of ['1', '2']) await box.submit(entry(id));
    server = async () => new Promise((r) => setTimeout(() => r({}), 5));
    await Promise.all([box.sync(), box.sync(), box.sync()]);
    expect(sent).toEqual(['1', '2']);
  });
});
