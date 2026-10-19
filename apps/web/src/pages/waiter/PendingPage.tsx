import { WAITER_ERRORS, type CreateOrderInput, type TableDetail } from '@sistema-bar/shared';
import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Modal } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { cachedGet } from '../../lib/offline/cache';
import type { OutboxEntry } from '../../lib/offline/db';
import { useConnectionStatus, useOutboxEntries } from '../../lib/offline/hooks';
import { outbox } from '../../lib/offline/outbox';
import { WaiterHeader } from './WaiterHeader';

const KIND_LABEL: Record<OutboxEntry['kind'], string> = { comanda: 'Abertura', order: 'Pedido', visit: 'Atendimento' };

/**
 * O que ainda não chegou ao servidor. Recusas (comanda encerrada, esgotado, CPF já em uso…)
 * esperam o garçom decidir: lançar em outra comanda, tentar de novo ou descartar (SPEC 5.4 item 8).
 */
export function PendingPage() {
  const entries = useOutboxEntries();
  const { online } = useConnectionStatus();
  const [moving, setMoving] = useState<OutboxEntry | null>(null);
  const [syncing, setSyncing] = useState(false);

  const syncNow = async () => {
    setSyncing(true);
    await outbox.sync().finally(() => setSyncing(false));
  };

  return (
    <div className="min-h-dvh pb-8">
      <WaiterHeader title="Pendências" back="/garcom" />
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-4">
        {entries.length === 0 ? (
          <EmptyState>Tudo enviado. Nada aguardando neste aparelho.</EmptyState>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-slate-400">
                {online ? 'Conectado. Os itens pendentes estão sendo enviados.' : 'Sem conexão. Mantenha o app aberto: tudo será enviado quando a rede voltar.'}
              </p>
              <Button onClick={syncNow} disabled={syncing}>{syncing ? 'Enviando…' : 'Enviar agora'}</Button>
            </div>
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className={`rounded-xl p-3 ${e.status === 'CONFLITO' ? 'border border-red-900 bg-red-950/40' : 'bg-slate-900'}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{e.label}</p>
                      <p className="text-xs text-slate-500">
                        {KIND_LABEL[e.kind]} · feito às {formatTime(new Date(e.createdAt / 1000).toISOString())}
                        {e.attempts > 0 && ` · ${e.attempts} tentativa(s)`}
                      </p>
                    </div>
                    {e.status === 'CONFLITO' ? <Badge tone="bad">Recusado</Badge> : <Badge tone="warn">Aguardando</Badge>}
                  </div>
                  {e.status === 'CONFLITO' && (
                    <>
                      <p className="mt-2 text-sm text-red-300">{e.error?.message}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {e.kind === 'order' &&
                          (e.error?.code === WAITER_ERRORS.COMANDA_NOT_OPEN || e.error?.code === WAITER_ERRORS.COMANDA_NOT_FOUND) && (
                            <Button variant="primary" onClick={() => setMoving(e)}>Lançar em outra comanda</Button>
                          )}
                        <Button onClick={() => outbox.retry(e.id)}>Tentar de novo</Button>
                        <Button
                          variant="danger"
                          onClick={() => confirm(`Descartar "${e.label}"? Isso não pode ser desfeito.`) && outbox.discard(e.id)}
                        >
                          Descartar
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
      {moving && <MoveOrderModal entry={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

/** Reaponta um pedido recusado para outra(s) comanda(s) abertas da mesma mesa. */
function MoveOrderModal({ entry, onClose }: { entry: OutboxEntry; onClose: () => void }) {
  const [table, setTable] = useState<TableDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    cachedGet<TableDetail>(`/waiter/tables/${entry.tableId}`)
      .then(setTable)
      .catch(() => setError('Não foi possível carregar as comandas da mesa.'));
  }, [entry.tableId]);

  const confirmMove = async () => {
    const body = { ...(entry.body as CreateOrderInput), comandaIds: selected };
    await outbox.retry(entry.id, body);
    onClose();
  };

  return (
    <Modal
      title="Lançar em outra comanda"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={selected.length === 0} onClick={confirmMove}>Enviar para estas</Button>
        </>
      }
    >
      {error && <p className="text-sm text-red-300">{error}</p>}
      {table && (
        <div className="flex flex-wrap gap-2">
          {table.comandas.map((c) => {
            const on = selected.includes(c.clientUuid);
            return (
              <button
                key={c.id}
                onClick={() => setSelected((s) => (on ? s.filter((x) => x !== c.clientUuid) : [...s, c.clientUuid]))}
                className={`rounded-full border px-4 py-2 text-sm ${on ? 'border-amber-500 bg-amber-500 text-slate-950' : 'border-slate-700'}`}
              >
                {c.customerName}
              </button>
            );
          })}
          {table.comandas.length === 0 && <p className="text-sm text-slate-400">Nenhuma comanda aberta nesta mesa.</p>}
        </div>
      )}
      <p className="text-xs text-slate-500">Mais de uma comanda = o pedido é dividido igualmente entre elas.</p>
    </Modal>
  );
}
