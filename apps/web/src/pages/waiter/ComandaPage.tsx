import { formatBRL, type ComandaDetail } from '@sistema-bar/shared';
import { useNavigate, useParams } from 'react-router';
import { Badge, Button, ErrorBanner, Loading } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';
import { WaiterHeader } from './WaiterHeader';

export function ComandaPage() {
  const { comandaId } = useParams<{ comandaId: string }>();
  const navigate = useNavigate();
  const path = `/waiter/comandas/${comandaId}`;
  const detail = useApiQuery<ComandaDetail>(path);
  const requestClose = useApiMutation([path, '/waiter/tables']);
  const c = detail.data;
  const open = c && (c.status === 'ABERTA' || c.status === 'EM_FECHAMENTO');

  const askClose = () =>
    confirm(`Pedir o fechamento da comanda de ${c!.customerName}? O caixa será avisado.`) &&
    requestClose.mutate({ method: 'POST', path: `${path}/request-close` });

  return (
    <div className="min-h-dvh pb-28">
      <WaiterHeader title={c ? c.customerName : 'Comanda'} back={c ? `/garcom/mesa/${c.tableId}` : '/garcom'} />
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-4">
        <ErrorBanner message={errorMessage(detail.error ?? requestClose.error)} />
        {!c ? (
          detail.isLoading && <Loading />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
              <span>Mesa {c.tableNumber}</span>
              <span>·</span>
              <span>Comanda nº {c.number}</span>
              <span>·</span>
              <span>aberta às {formatTime(c.openedAt)}</span>
              {c.status === 'EM_FECHAMENTO' && <Badge tone="warn">Pediu a conta</Badge>}
            </div>

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
              <Row label="Total" value={formatBRL(c.totalWithFeeCents)} strong />
            </dl>
            <p className="text-xs text-slate-500">Pagamentos, descontos e couvert são feitos no caixa.</p>

            {c.status === 'ABERTA' && (
              <Button onClick={askClose} disabled={requestClose.isPending} className="w-full py-3">
                Pedir fechamento
              </Button>
            )}
          </>
        )}
      </main>

      {open && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-800 bg-slate-950/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <Button
            variant="primary"
            className="mx-auto block w-full max-w-3xl py-3.5 text-base"
            onClick={() => navigate(`/garcom/mesa/${c.tableId}/pedido?comanda=${c.id}`)}
          >
            Lançar para {c.customerName}
          </Button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-slate-800 pt-2 text-lg font-semibold' : 'text-slate-300'}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
