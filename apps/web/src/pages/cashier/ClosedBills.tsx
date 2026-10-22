import { formatBRL, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type ClosedBillsResponse, type ClosedTableBill, type PaymentMethod } from '@sistema-bar/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, ErrorBanner, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { formatTime, maskPhone } from '../../lib/format';
import { errorMessage } from '../../lib/queries';
import { usePin } from './usePin';

/**
 * Contas fechadas de um dia do movimento: as mesas com as comandas, o total e os pagamentos.
 * Reimprime o descritivo (cliente que volta pedindo) e corrige a forma de pagamento lançada
 * errada (gerente; só enquanto o caixa daquele pagamento está aberto).
 */
export function ClosedBills({ registerId }: { registerId?: string }) {
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const path = `/cashier/closed-comandas${date ? `?date=${date}` : ''}`;
  const list = useQuery({ queryKey: [path], queryFn: () => api<ClosedBillsResponse>(path) });
  const day = list.data?.date ?? date;
  const term = search.trim().toLowerCase();
  const bills = (list.data?.bills ?? []).filter(
    (b) =>
      !term ||
      String(b.tableNumber) === term ||
      b.comandas.some((c) => c.customerName.toLowerCase().includes(term) || (c.phone ?? '').includes(term.replace(/\D/g, '') || '-')),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-300">
          Dia do movimento
          <input
            type="date"
            value={day}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-base"
          />
        </label>
        <label className="min-w-48 flex-1 text-sm text-slate-300">
          Buscar
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Mesa, nome ou telefone"
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-base"
          />
        </label>
      </div>
      {list.data && (
        <p className="text-xs text-slate-400">
          {list.data.sessions.length === 0
            ? `Nenhum caixa com o dia do movimento ${brDate(day)}.`
            : `Movimento de ${brDate(day)}: ${list.data.sessions
                .map((s) => `${s.registerName} aberto ${dayTime(s.openedAt)}${s.closedAt ? `, fechado ${dayTime(s.closedAt)}` : ' (ainda aberto)'}`)
                .join(' · ')}.`}{' '}
          O turno que passa da meia-noite conta no dia em que o caixa abriu.
        </p>
      )}
      <ErrorBanner message={list.isError ? errorMessage(list.error) : null} />
      {list.isLoading ? (
        <Loading />
      ) : bills.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
          Nenhuma conta fechada nesse dia do movimento.
          {list.data?.sessions.length === 0 && ' Se a mesa foi fechada de madrugada, veja o dia anterior.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {bills.map((b) => (
            <BillCard key={b.key} bill={b} registerId={registerId} listPath={path} />
          ))}
        </ul>
      )}
    </div>
  );
}

const brDate = (iso: string) => (iso ? iso.split('-').reverse().join('/') : '');
const dayTime = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' às');

function BillCard({ bill: b, registerId, listPath }: { bill: ClosedTableBill; registerId?: string; listPath: string }) {
  const qc = useQueryClient();
  const pin = usePin();
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const print = useMutation({
    mutationFn: () =>
      api('/cashier/closed-comandas/print', { method: 'POST', body: JSON.stringify({ comandaIds: b.comandas.map((c) => c.id), registerId }) }),
    onSuccess: () => setNotice('Descritivo enviado para a impressora do caixa.'),
  });
  const change = useMutation({
    mutationFn: ({ paymentId, method, reason }: { paymentId: string; method: PaymentMethod; reason: string }) =>
      pin.run((authorizerPin) => api(`/cashier/payments/${paymentId}/method`, { method: 'POST', body: JSON.stringify({ method, reason, authorizerPin }) })),
    onSuccess: (_r, v) => {
      setEditing(null);
      setNotice(`Forma de pagamento alterada para ${PAYMENT_METHOD_LABELS[v.method]}.`);
      void qc.invalidateQueries({ queryKey: [listPath] });
      void qc.invalidateQueries({ queryKey: ['/cashier/session'] });
    },
  });
  const askChange = (paymentId: string, method: PaymentMethod) => {
    const reason = prompt(`Alterar para ${PAYMENT_METHOD_LABELS[method]}. Motivo:`, 'Forma lançada errada');
    if (reason === null) return;
    if (reason.trim().length < 3) return alert('Informe o motivo (ao menos 3 letras).');
    change.mutate({ paymentId, method, reason: reason.trim() });
  };

  return (
    <li className="rounded-xl bg-slate-900 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">
          {b.tableLabel ?? `Mesa ${b.tableNumber}`}
          <span className="ml-2 text-sm font-normal text-slate-400">
            {formatTime(b.openedAt)} – {formatTime(b.closedAt)}
          </span>
        </h3>
        <span className="font-semibold">{formatBRL(b.totalCents)}</span>
      </div>
      <ul className="mt-2 text-sm text-slate-300">
        {b.comandas.map((c) => (
          <li key={c.id} className="flex justify-between gap-2">
            <span>
              {c.customerName}
              {c.phone && <span className="text-slate-500"> · {maskPhone(c.phone)}</span>}
            </span>
            <span className="tabular-nums">{formatBRL(c.totalCents)}</span>
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-1.5 border-t border-slate-800 pt-2 text-sm">
        {b.payments.map((p) => (
          <li key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={p.status === 'ESTORNADO' ? 'text-slate-500 line-through' : ''}>
                {formatTime(p.createdAt)} · <strong>{PAYMENT_METHOD_LABELS[p.method]}</strong> {formatBRL(p.amountCents)} · {p.payerName}
                <span className="text-slate-500"> · {p.userName}</span>
              </span>
              {p.status === 'ESTORNADO' ? (
                <Badge tone="bad">Estornado</Badge>
              ) : p.editable ? (
                <button onClick={() => setEditing(editing === p.id ? null : p.id)} className="text-xs text-amber-400 underline">
                  Alterar forma
                </button>
              ) : (
                <span className="text-xs text-slate-500" title="O caixa deste pagamento já foi fechado">
                  caixa fechado
                </span>
              )}
            </div>
            {editing === p.id && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {PAYMENT_METHODS.filter((m) => m !== p.method).map((m) => (
                  <Button key={m} onClick={() => askChange(p.id, m)} disabled={change.isPending}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </Button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={() => print.mutate()} disabled={print.isPending}>
          🧾 Imprimir descritivo
        </Button>
        {notice && <span className="text-sm text-emerald-400">{notice}</span>}
      </div>
      <ErrorBanner message={errorMessage(print.error ?? change.error)} />
      {pin.element}
    </li>
  );
}
