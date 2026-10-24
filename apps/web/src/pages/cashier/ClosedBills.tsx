import { formatBRL, parseBRL, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type ClosedBillsResponse, type ClosedTableBill, type PaymentMethod } from '@sistema-bar/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, ErrorBanner, Loading, Modal, TextField } from '../../components/ui';
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

/** O descritivo na tela, igual ao papel (fonte monoespaçada, mesma largura da impressora). */
function ReceiptPreview({
  title,
  comandaIds,
  registerId,
  onClose,
  onPrint,
}: {
  title: string;
  comandaIds: string[];
  registerId?: string;
  onClose: () => void;
  onPrint: () => void;
}) {
  const data = useQuery({
    queryKey: ['closed-preview', ...comandaIds],
    queryFn: () =>
      api<{ text: string; widthMm: number }>('/cashier/closed-comandas/preview', { method: 'POST', body: JSON.stringify({ comandaIds, registerId }) }),
  });
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" onClick={onPrint}>
            🧾 Imprimir
          </Button>
        </>
      }
    >
      <ErrorBanner message={data.isError ? errorMessage(data.error) : null} />
      {data.data ? (
        <pre
          className="mx-auto overflow-x-auto rounded-md bg-stone-100 px-3 py-4 font-mono text-[11px] leading-snug text-stone-900 shadow-inner"
          style={{ width: `${data.data.widthMm === 58 ? 32 : 48}ch`, maxWidth: '100%', boxSizing: 'content-box' }}
        >
          {data.data.text}
        </pre>
      ) : (
        !data.isError && <Loading />
      )}
    </Modal>
  );
}

/**
 * Corrigir como o pagamento foi feito: uma ou várias formas (ex.: R$ 30 dinheiro, R$ 40 débito
 * e o resto crédito). A soma tem de dar o valor do pagamento; o botão "o resto" completa a linha.
 */
function SplitPaymentModal({
  payment,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  payment: ClosedTableBill['payments'][number];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (parts: { method: PaymentMethod; amountCents: number }[], reason: string) => void;
}) {
  const toText = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const [rows, setRows] = useState<{ method: PaymentMethod; value: string }[]>([{ method: payment.method, value: toText(payment.amountCents) }]);
  const [reason, setReason] = useState('Forma lançada errada');
  const [localError, setLocalError] = useState<string | null>(null);
  const cents = rows.map((r) => parseBRL(r.value) ?? 0);
  const sum = cents.reduce((a, v) => a + v, 0);
  const diff = payment.amountCents - sum;
  const set = (i: number, patch: Partial<{ method: PaymentMethod; value: string }>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const confirm = () => {
    if (diff !== 0) return setLocalError(diff > 0 ? `Falta distribuir ${formatBRL(diff)}.` : `Passou ${formatBRL(-diff)} do valor do pagamento.`);
    if (cents.some((c) => c <= 0)) return setLocalError('Cada forma precisa de um valor maior que zero (ou remova a linha).');
    if (reason.trim().length < 3) return setLocalError('Informe o motivo.');
    setLocalError(null);
    // Mesma forma em duas linhas: junta.
    const merged = new Map<PaymentMethod, number>();
    rows.forEach((r, i) => merged.set(r.method, (merged.get(r.method) ?? 0) + cents[i]!));
    onConfirm([...merged].map(([method, amountCents]) => ({ method, amountCents })), reason.trim());
  };

  return (
    <Modal
      title={`Alterar pagamento de ${formatBRL(payment.amountCents)}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={confirm} disabled={busy || diff !== 0}>
            Salvar
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-400">
        Lançado como <b className="text-slate-200">{PAYMENT_METHOD_LABELS[payment.method]}</b> · {payment.payerName}. Informe como foi pago de verdade (pode ser em várias formas).
      </p>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Forma"
              value={r.method}
              onChange={(e) => set(i, { method: e.target.value as PaymentMethod })}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
            <input
              aria-label="Valor"
              inputMode="decimal"
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
              className="w-28 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-right tabular-nums"
            />
            {diff > 0 && (
              <button onClick={() => set(i, { value: toText((parseBRL(r.value) ?? 0) + diff) })} className="text-xs text-amber-400 underline">
                + o resto
              </button>
            )}
            {rows.length > 1 && (
              <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-xs text-red-300 underline">
                remover
              </button>
            )}
          </li>
        ))}
      </ul>
      {rows.length < 4 && (
        <Button
          onClick={() =>
            setRows((rs) => [...rs, { method: PAYMENT_METHODS.find((m) => !rs.some((r) => r.method === m)) ?? 'CREDITO', value: diff > 0 ? toText(diff) : '' }])
          }
        >
          + Adicionar forma
        </Button>
      )}
      <p className={`text-sm font-semibold ${diff === 0 ? 'text-emerald-400' : 'text-amber-300'}`}>
        {diff === 0 ? 'Valores conferem.' : diff > 0 ? `Falta distribuir ${formatBRL(diff)}` : `Passou ${formatBRL(-diff)}`}
      </p>
      <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
      <ErrorBanner message={localError ?? error} />
    </Modal>
  );
}

function BillCard({ bill: b, registerId, listPath }: { bill: ClosedTableBill; registerId?: string; listPath: string }) {
  const qc = useQueryClient();
  const pin = usePin();
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const print = useMutation({
    mutationFn: () =>
      api('/cashier/closed-comandas/print', { method: 'POST', body: JSON.stringify({ comandaIds: b.comandas.map((c) => c.id), registerId }) }),
    onSuccess: () => setNotice('Descritivo enviado para a impressora do caixa.'),
  });
  const change = useMutation({
    mutationFn: ({ paymentId, parts, reason }: { paymentId: string; parts: { method: PaymentMethod; amountCents: number }[]; reason: string }) =>
      pin.run((authorizerPin) => api(`/cashier/payments/${paymentId}/split`, { method: 'POST', body: JSON.stringify({ parts, reason, authorizerPin }) })),
    onSuccess: (_r, v) => {
      setEditing(null);
      setNotice(`Pagamento corrigido: ${v.parts.map((x) => `${PAYMENT_METHOD_LABELS[x.method]} ${formatBRL(x.amountCents)}`).join(' + ')}.`);
      void qc.invalidateQueries({ queryKey: [listPath] });
      void qc.invalidateQueries({ queryKey: ['/cashier/session'] });
    },
  });
  const editingPayment = b.payments.find((p) => p.id === editing) ?? null;

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
                <button onClick={() => setEditing(p.id)} className="text-xs text-amber-400 underline">
                  Alterar forma
                </button>
              ) : (
                <span className="text-xs text-slate-500" title="O caixa deste pagamento já foi fechado">
                  caixa fechado
                </span>
              )}
            </div>

          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={() => setViewing(true)}>👁 Ver cupom</Button>
        <Button onClick={() => print.mutate()} disabled={print.isPending}>
          🧾 Imprimir descritivo
        </Button>
        {notice && <span className="text-sm text-emerald-400">{notice}</span>}
      </div>
      <ErrorBanner message={errorMessage(print.error ?? change.error)} />
      {editingPayment && (
        <SplitPaymentModal
          payment={editingPayment}
          busy={change.isPending}
          error={change.error ? errorMessage(change.error) : null}
          onClose={() => {
            setEditing(null);
            change.reset();
          }}
          onConfirm={(parts, reason) => change.mutate({ paymentId: editingPayment.id, parts, reason })}
        />
      )}
      {pin.element}
      {viewing && (
        <ReceiptPreview
          title={`${b.tableLabel ?? `Mesa ${b.tableNumber}`} · ${formatTime(b.closedAt)}`}
          comandaIds={b.comandas.map((c) => c.id)}
          registerId={registerId}
          onClose={() => setViewing(false)}
          onPrint={() => print.mutate()}
        />
      )}
    </li>
  );
}
