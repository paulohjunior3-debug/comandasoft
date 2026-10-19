import { formatBRL, type ComandaDetail, type CreateOrderInput, type OpenComandaInput } from '@sistema-bar/shared';
import { useNavigate, useParams } from 'react-router';
import { Badge, Button, ErrorBanner, Loading } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { useCachedQuery } from '../../lib/offline/cache';
import { useOutboxEntries } from '../../lib/offline/hooks';
import { pendingOrdersFor } from '../../lib/offline/local';
import { errorMessage, useApiMutation } from '../../lib/queries';
import { WaiterHeader } from './WaiterHeader';

export function ComandaPage() {
  // Pode ser o id do servidor ou o clientUuid (links do app usam o clientUuid, que funciona offline).
  const { comandaId } = useParams<{ comandaId: string }>();
  const navigate = useNavigate();
  const path = `/waiter/comandas/${comandaId}`;
  const entries = useOutboxEntries();
  const localOpen = entries.find((e) => e.kind === 'comanda' && e.id === comandaId);
  const detail = useCachedQuery<ComandaDetail>(path, { enabled: !localOpen });
  const requestClose = useApiMutation([path, '/waiter/tables']);
  const releaseQr = useApiMutation([path]);

  const c = detail.data;
  const local = localOpen ? (localOpen.body as OpenComandaInput) : null;
  const ref = c ? { id: c.id, clientUuid: c.clientUuid } : { id: comandaId!, clientUuid: comandaId! };
  const queuedOrders = pendingOrdersFor(entries, ref);
  const tableId = c?.tableId ?? localOpen?.tableId;
  const name = c?.customerName ?? local?.customerName ?? 'Comanda';
  const canOrder = local ? localOpen!.status === 'PENDENTE' : c && (c.status === 'ABERTA' || c.status === 'EM_FECHAMENTO');

  const askClose = () =>
    confirm(`Pedir o fechamento da comanda de ${name}? O caixa será avisado.`) &&
    requestClose.mutate({ method: 'POST', path: `${path}/request-close` });

  return (
    <div className="min-h-dvh pb-28">
      <WaiterHeader title={name} back={tableId ? `/garcom/mesa/${tableId}` : '/garcom'} />
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-4">
        <ErrorBanner message={!c && !local ? errorMessage(detail.error) : errorMessage(requestClose.error ?? releaseQr.error)} />

        {localOpen && (
          <p className={`rounded-lg px-3 py-2 text-sm ${localOpen.status === 'CONFLITO' ? 'bg-red-950 text-red-300' : 'bg-amber-950 text-amber-200'}`}>
            {localOpen.status === 'CONFLITO'
              ? `O servidor recusou esta abertura: ${localOpen.error?.message} Veja em Pendências.`
              : 'Comanda aberta neste aparelho, aguardando envio ao servidor. Já dá para lançar pedidos.'}
          </p>
        )}

        {c && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <span>Mesa {c.tableNumber}</span>
            <span>·</span>
            <span>Comanda nº {c.number}</span>
            <span>·</span>
            <span>aberta às {formatTime(c.openedAt)}</span>
            {c.status === 'EM_FECHAMENTO' && <Badge tone="warn">Pediu a conta</Badge>}
          </div>
        )}

        {c?.qrLocked && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">
            <span className="flex-1">
              QR bloqueado: erraram o CPF várias vezes ao consultar esta comanda. Confira com {name} antes de liberar.
            </span>
            <Button onClick={() => releaseQr.mutate({ method: 'POST', path: `/waiter/comandas/${c.id}/qr-release` })} disabled={releaseQr.isPending}>
              Liberar QR
            </Button>
          </div>
        )}

        {queuedOrders.length > 0 && (
          <section className="rounded-xl border border-amber-900 bg-amber-950/40 p-3">
            <h2 className="mb-2 text-sm font-semibold text-amber-200">⏳ Aguardando envio</h2>
            <ul className="space-y-1 text-sm">
              {queuedOrders.flatMap((e) =>
                (e.body as CreateOrderInput).items.map((i, idx) => (
                  <li key={`${e.id}-${idx}`} className="flex gap-2">
                    <span className="font-semibold">{i.qty}×</span>
                    <span className="flex-1">
                      {(i as QueuedItem).productName ?? 'Item'}
                      {i.notes && <span className="block text-amber-300">{i.notes}</span>}
                    </span>
                    {e.status === 'CONFLITO' && <Badge tone="bad">Recusado</Badge>}
                  </li>
                )),
              )}
            </ul>
          </section>
        )}

        {!c ? (
          detail.isLoading && <Loading />
        ) : (
          <>
            {c.items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">Nenhum item lançado ainda.</p>
            ) : (
              <ul className="divide-y divide-slate-800 rounded-xl bg-slate-900">
                {c.items.map((i) => (
                  <li key={i.orderItemId} className={`flex gap-3 px-4 py-3 ${i.status === 'CANCELADO' ? 'opacity-50' : ''}`}>
                    <span className="w-7 shrink-0 font-semibold">{i.qty}×</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block ${i.status === 'CANCELADO' ? 'line-through' : ''}`}>{i.productName}</span>
                      {i.notes && <span className="block text-sm font-medium text-amber-300">{i.notes}</span>}
                      <span className="block text-xs text-slate-500">
                        {formatTime(i.createdAt)} · {i.waiterName}
                        {i.sharedWith > 1 && ` · rateado entre ${i.sharedWith}`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      {formatBRL(i.amountCents)}
                      {i.sharedWith > 1 && <span className="block text-xs text-slate-500">de {formatBRL(i.qty * i.unitPriceCents)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <dl className="space-y-1 rounded-xl bg-slate-900 px-4 py-3">
              <Row label="Subtotal" value={formatBRL(c.subtotalCents)} />
              {c.serviceFeeCents > 0 && <Row label="Taxa de serviço (10%)" value={formatBRL(c.serviceFeeCents)} />}
              {c.couvertCents > 0 && (
                <Row label={`Couvert${c.peopleCount > 1 ? ` (${c.peopleCount} pessoas)` : ''}`} value={formatBRL(c.couvertCents)} />
              )}
              <Row label="Total" value={formatBRL(c.totalWithFeeCents)} strong />
            </dl>
            <p className="text-xs text-slate-500">
              Pagamentos e descontos são feitos no caixa.{queuedOrders.length > 0 && ' Os itens aguardando envio ainda não entram no total.'}
            </p>

            {c.status === 'ABERTA' && (
              <Button onClick={askClose} disabled={requestClose.isPending} className="w-full py-3">
                Pedir fechamento
              </Button>
            )}
          </>
        )}
      </main>

      {canOrder && tableId && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-800 bg-slate-950/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <Button
            variant="primary"
            className="mx-auto block w-full max-w-3xl py-3.5 text-base"
            onClick={() => navigate(`/garcom/mesa/${tableId}/pedido?comanda=${ref.clientUuid}`)}
          >
            Lançar para {name}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Itens na fila levam também o nome do produto, só para exibição (o servidor ignora). */
type QueuedItem = CreateOrderInput['items'][number] & { productName?: string };

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-slate-800 pt-2 text-lg font-semibold' : 'text-slate-300'}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
