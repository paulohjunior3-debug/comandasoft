import type { MyOrder, OrderTakeawayResult } from '@sistema-bar/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Badge, ErrorBanner, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatTime } from '../../lib/format';
import { useOutboxEntries } from '../../lib/offline/hooks';
import { errorMessage } from '../../lib/queries';
import { WaiterHeader } from './WaiterHeader';

interface QueuedItem {
  qty: number;
  notes?: string;
  productName?: string;
}

/**
 * Meus lançamentos: o garçom confere o que já pediu nas últimas horas (só os pedidos dele),
 * para lembrar se esqueceu algo. Os que ainda estão na fila do aparelho aparecem no topo.
 */
export function MyOrdersPage() {
  const { user } = useAuth();
  const mine = useQuery({
    queryKey: ['/waiter/orders/mine'],
    queryFn: () => api<MyOrder[]>('/waiter/orders/mine'),
    refetchInterval: 15_000,
  });
  const queued = useOutboxEntries().filter((e) => e.kind === 'order' && e.userId === user?.id);

  return (
    <div className="min-h-dvh pb-8">
      <WaiterHeader title="Meus lançamentos" back="/garcom" />
      <main className="mx-auto max-w-3xl space-y-3 px-4 pt-4">
        <p className="text-sm text-slate-400">Pedidos que você lançou desde a abertura do caixa de hoje, do mais recente para o mais antigo.</p>
        <ErrorBanner message={mine.isError ? errorMessage(mine.error) : null} />

        {queued.map((e) => {
          const body = e.body as { items: QueuedItem[]; takeaway?: boolean };
          return (
            <article key={e.id} className="rounded-xl border border-amber-700 bg-amber-950/40 p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-semibold">{e.label}</span>
                <Badge tone={e.status === 'CONFLITO' ? 'bad' : 'warn'}>{e.status === 'CONFLITO' ? 'Recusado · ver pendências' : 'Aguardando envio'}</Badge>
              </div>
              <ul className="mt-2 space-y-0.5 text-sm">
                {body.items.map((i, n) => (
                  <li key={n}>
                    {i.qty}× {i.productName ?? 'item'}
                    {i.notes && <span className="text-amber-300"> · {i.notes}</span>}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}

        {mine.isLoading ? (
          <Loading />
        ) : (mine.data ?? []).length === 0 && queued.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">Nenhum lançamento seu desde a abertura do caixa.</p>
        ) : (
          (mine.data ?? []).map((o) => (
            <Link key={o.id} to={`/garcom/mesa/${o.tableId}`} className="block rounded-xl bg-slate-900 p-3 active:bg-slate-800">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">
                  {o.tableLabel ?? `Mesa ${o.tableNumber}`}
                  <span className="font-normal text-slate-400"> · {o.customers.join(', ')}</span>
                </span>
                <span className="shrink-0 text-sm text-slate-400">{formatTime(o.receivedAt)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                {o.takeaway && <Badge tone="warn">Para viagem</Badge>}
                <TakeawayToggle orderId={o.id} takeaway={o.takeaway} />
              </div>
              <ul className="mt-1.5 space-y-0.5 text-sm">
                {o.items.map((i, n) => (
                  <li key={n} className={i.canceled ? 'text-slate-500 line-through' : ''}>
                    {i.qty}× {i.name}
                    {i.notes && <span className="text-amber-300/90 no-underline"> · {i.notes}</span>}
                    {i.canceled && <span className="ml-1 text-xs text-red-400 no-underline">cancelado</span>}
                  </li>
                ))}
              </ul>
            </Link>
          ))
        )}
      </main>
    </div>
  );
}

/** Esqueceu de marcar para viagem: muda o lançamento já enviado (a cozinha/bar é avisada). */
function TakeawayToggle({ orderId, takeaway }: { orderId: string; takeaway: boolean }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api<OrderTakeawayResult>(`/waiter/orders/${orderId}/takeaway`, { method: 'POST', body: JSON.stringify({ takeaway: !takeaway }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['/waiter/orders/mine'] }),
    onError: (err) => alert(errorMessage(err)),
  });
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault(); // o cartão é um link para a mesa
        if (!takeaway || confirm('Este pedido não é mais para viagem?')) toggle.mutate();
      }}
      disabled={toggle.isPending}
      className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 active:bg-slate-800"
    >
      {toggle.isPending ? 'Salvando…' : takeaway ? 'Desmarcar viagem' : '🥡 Marcar para viagem'}
    </button>
  );
}
