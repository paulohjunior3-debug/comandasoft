import {
  fractionAmount,
  formatBRL,
  parseBRL,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  percentOf,
  SERVICE_FEE_BPS,
  type Bill,
  type BillComanda,
  type BillItem,
  type CashierTable,
  type CreatePaymentResult,
  type PaymentMethod,
} from '@sistema-bar/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, ErrorBanner, Loading, Modal, SelectField, TextField } from '../../components/ui';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { errorMessage } from '../../lib/queries';
import { usePin } from './usePin';

const FRACTIONS = [
  { label: 'Inteiro', num: 1, den: 1 },
  { label: '1/2', num: 1, den: 2 },
  { label: '1/3', num: 1, den: 3 },
  { label: '1/4', num: 1, den: 4 },
];

/** Parte de um item que a pessoa paga: fração (1/3 da pizza) ou valor (R$ 15,00 do filé). */
type ItemPick = { orderItemId: string; comandaId: string; num?: number; den?: number; amountCents?: number };

/** Conta quitada, esperando a escolha de cupom (não fiscal, fiscal ou só finalizar). */
export interface FinalizeInfo {
  comandaIds: string[];
  names: string[];
  tableNumber: number;
  changeCents: number;
  fiscalMode: CreatePaymentResult['fiscalMode'];
  fiscalRequested: boolean;
}

/**
 * Conta da mesa no caixa (SPEC 5.7): uma, várias ou todas as comandas; ajustes com PIN de
 * gerente; pagamentos parciais por valor, por item/fração ou divididos por N; troco; estorno.
 */
export function BillPanel({
  registerId,
  table,
  preselect,
  onEmpty,
  onFinalize,
}: {
  registerId: string;
  table: CashierTable;
  preselect: string[] | null;
  onEmpty: () => void;
  onFinalize: (info: FinalizeInfo) => void;
}) {
  const qc = useQueryClient();
  const pin = usePin();
  const [selected, setSelected] = useState<string[]>(() => preselect ?? table.comandas.map((c) => c.id));
  const [modal, setModal] = useState<'DESCONTO' | 'TAXA_SERVICO_REMOVIDA' | 'COUVERT_REMOVIDO' | null>(null);
  const [canceling, setCanceling] = useState<BillItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setSelected(preselect ?? table.comandas.map((c) => c.id)), [table.id, preselect]);

  const ordered = table.comandas.map((c) => c.id).filter((id) => selected.includes(id));
  const key = ['bill', ...ordered];
  const bill = useQuery({
    queryKey: key,
    queryFn: () => api<Bill>('/cashier/bill', { method: 'POST', body: JSON.stringify({ comandaIds: ordered }) }),
    enabled: ordered.length > 0,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bill'] });
    void qc.invalidateQueries({ queryKey: ['/cashier/tables'] });
    void qc.invalidateQueries({ queryKey: ['/cashier/session'] });
  };

  const printBill = useMutation({
    mutationFn: () => api('/cashier/bill/print', { method: 'POST', body: JSON.stringify({ comandaIds: ordered, registerId }) }),
    onSuccess: () => setNotice('Pré-conta enviada para a impressora do caixa.'),
  });
  const action = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
  });

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const b = bill.data;
  const single = b && b.comandas.length === 1 ? b.comandas[0]! : null;

  const refund = (paymentId: string) => {
    const reason = prompt('Motivo do estorno:');
    if (!reason) return;
    action.mutate(() =>
      pin.run((authorizerPin) =>
        api(`/cashier/payments/${paymentId}/refund`, { method: 'POST', body: JSON.stringify({ reason, authorizerPin }) }),
      ),
    );
  };
  const removeAdjustment = (id: string) =>
    action.mutate(() =>
      pin.run((authorizerPin) => api(`/cashier/adjustments/${id}/remove`, { method: 'POST', body: JSON.stringify({ authorizerPin }) })),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-semibold">Mesa {table.number}</h2>
        <div className="flex gap-2">
          <Button onClick={() => setSelected(table.comandas.map((c) => c.id))}>Mesa inteira</Button>
          <Button onClick={() => printBill.mutate()} disabled={!ordered.length || printBill.isPending}>Imprimir pré-conta</Button>
        </div>
      </div>
      <ErrorBanner message={errorMessage(bill.error ?? printBill.error ?? action.error)} />
      {notice && (
        <p className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-300" onClick={() => setNotice(null)}>
          {notice}
        </p>
      )}

      {/* Quem está pagando */}
      <div className="flex flex-wrap gap-2">
        {table.comandas.map((c) => {
          const on = selected.includes(c.id);
          return (
            <button
              key={c.id}
              onClick={() => toggle(c.id)}
              aria-pressed={on}
              className={`rounded-xl border px-3 py-2 text-left ${on ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 opacity-70'}`}
            >
              <span className="block font-medium">
                {c.customerName} {c.status === 'EM_FECHAMENTO' && <span className="text-xs text-sky-300">· pediu a conta</span>}
              </span>
              <span className="block text-sm text-slate-400">resta {formatBRL(c.totals.remainingCents)}</span>
            </button>
          );
        })}
      </div>

      {!ordered.length ? (
        <p className="text-slate-400">Selecione ao menos uma comanda.</p>
      ) : !b ? (
        <Loading />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            {b.comandas.map((c) => (
              <ComandaBlock key={c.id} comanda={c} bill={b} onCancelItem={setCanceling} />
            ))}

            {b.adjustments.length > 0 && (
              <section className="rounded-xl bg-slate-900 p-3">
                <h3 className="mb-2 text-sm font-semibold text-slate-400">Ajustes</h3>
                <ul className="space-y-1 text-sm">
                  {b.adjustments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <span className="flex-1">
                        {b.comandas.find((c) => c.id === a.comandaId)?.customerName}:{' '}
                        {a.type === 'DESCONTO'
                          ? `desconto ${a.amountCents ? formatBRL(a.amountCents) : `${(a.percentBps ?? 0) / 100}%`}`
                          : a.type === 'TAXA_SERVICO_REMOVIDA'
                            ? 'taxa de serviço retirada'
                            : 'couvert retirado'}{' '}
                        <span className="text-slate-500">
                          ({a.reason} · {a.userName}
                          {a.authorizedBy ? `, autorizado por ${a.authorizedBy}` : ''})
                        </span>
                      </span>
                      <Button variant="ghost" onClick={() => removeAdjustment(a.id)}>Desfazer</Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="flex flex-wrap gap-2">
              <Button disabled={!single} onClick={() => setModal('DESCONTO')} title={single ? '' : 'Selecione uma comanda'}>Desconto</Button>
              <Button
                disabled={!single || !b.serviceFeeEnabled || single.serviceFeeWaived}
                onClick={() => setModal('TAXA_SERVICO_REMOVIDA')}
              >
                Retirar taxa de serviço
              </Button>
              <Button disabled={!single || single.totals.couvertCents === 0} onClick={() => setModal('COUVERT_REMOVIDO')}>
                Retirar couvert
              </Button>
              {!single && <span className="self-center text-xs text-slate-500">Ajustes: selecione uma comanda só.</span>}
            </div>

            {b.payments.length > 0 && (
              <section className="rounded-xl bg-slate-900 p-3">
                <h3 className="mb-2 text-sm font-semibold text-slate-400">Pagamentos</h3>
                <ul className="space-y-1 text-sm">
                  {b.payments.map((p) => (
                    <li key={p.id} className={`flex items-center gap-2 ${p.status === 'ESTORNADO' ? 'text-slate-500 line-through' : ''}`}>
                      <span className="flex-1">
                        {formatTime(p.createdAt)} · Pago por <strong>{p.payerName}</strong> ({PAYMENT_METHOD_LABELS[p.method]})
                        {p.changeCents > 0 && ` · troco ${formatBRL(p.changeCents)}`}
                        {p.items.length > 0 && (
                          <span className="block text-xs text-slate-400">
                            {p.items.map((i) => `${i.whole ? '' : `${formatBRL(i.amountCents)} do `}${i.productName}`).join(' + ')}
                          </span>
                        )}
                      </span>
                      <span>{formatBRL(p.allocations.filter((a) => ordered.includes(a.comandaId)).reduce((s, a) => s + a.amountCents, 0))}</span>
                      {p.status === 'OK' ? (
                        <Button variant="ghost" onClick={() => refund(p.id)}>Estornar</Button>
                      ) : (
                        <Badge tone="bad">Estornado</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <div className="space-y-4">
            <Totals bill={b} />
            {b.totals.remainingCents > 0 ? (
              <PaymentForm
                registerId={registerId}
                bill={b}
                comandaIds={ordered}
                onPaid={(r) => {
                  refresh();
                  const closed = b.comandas.filter((c) => r.closedComandaIds.includes(c.id));
                  if (closed.length) {
                    // Conta quitada: o caixa escolhe cupom não fiscal, fiscal ou só finalizar.
                    onFinalize({
                      comandaIds: closed.map((c) => c.id),
                      names: closed.map((c) => c.customerName),
                      tableNumber: table.number,
                      changeCents: r.changeCents,
                      fiscalMode: r.fiscalMode,
                      fiscalRequested: r.fiscalRequested,
                    });
                  } else {
                    setNotice((r.changeCents ? `Troco: ${formatBRL(r.changeCents)}. ` : '') + 'Pagamento registrado.');
                  }
                  const left = table.comandas.filter((c) => !r.closedComandaIds.includes(c.id)).map((c) => c.id);
                  // Quem pagou saiu da conta; se não sobrou ninguém selecionado, seleciona o resto da mesa.
                  setSelected((s) => {
                    const kept = s.filter((id) => !r.closedComandaIds.includes(id));
                    return kept.length ? kept : left;
                  });
                  if (left.length === 0) onEmpty();
                }}
              />
            ) : (
              <p className="rounded-xl bg-emerald-950 p-4 text-center text-emerald-300">Conta quitada.</p>
            )}
          </div>
        </div>
      )}

      {modal && single && (
        <AdjustmentModal
          type={modal}
          comanda={single}
          onClose={() => setModal(null)}
          submit={(body) =>
            pin.run((authorizerPin) => api('/cashier/adjustments', { method: 'POST', body: JSON.stringify({ ...body, authorizerPin }) })).then(() => {
              refresh();
              setModal(null);
            })
          }
        />
      )}
      {canceling && (
        <CancelItemModal
          item={canceling}
          onClose={() => setCanceling(null)}
          submit={(body) =>
            pin
              .run((authorizerPin) =>
                api<{ printed: boolean }>(`/cashier/order-items/${canceling.orderItemId}/cancel`, {
                  method: 'POST',
                  body: JSON.stringify({ ...body, authorizerPin }),
                }),
              )
              .then((r) => {
                refresh();
                setCanceling(null);
                setNotice(
                  `${body.qty}× ${canceling.productName} cancelado.${r.printed ? ' Aviso de cancelamento enviado ao setor.' : ''}`,
                );
              })
          }
        />
      )}
      {pin.element}
    </div>
  );
}

function ComandaBlock({ comanda: c, bill, onCancelItem }: { comanda: BillComanda; bill: Bill; onCancelItem: (item: BillItem) => void }) {
  const items = bill.items.filter((i) => i.comandaId === c.id);
  const open = c.status === 'ABERTA' || c.status === 'EM_FECHAMENTO';
  return (
    <section className="rounded-xl bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <span className="font-semibold">{c.customerName}</span>
        <span className="text-sm text-slate-400">CPF final {c.cpfLast3} · nº {c.number}</span>
      </header>
      <ul className="divide-y divide-slate-800/60 text-sm">
        {items.length === 0 && <li className="px-4 py-2 text-slate-500">Sem itens.</li>}
        {items.map((i) => (
          <li key={`${i.orderItemId}-${i.comandaId}`} className={`group flex items-center gap-2 px-4 py-2 ${i.canceled ? 'text-slate-600' : ''}`}>
            <span className={`w-8 font-semibold ${i.canceled ? 'line-through' : ''}`}>{i.qty}×</span>
            <span className="flex-1">
              <span className={i.canceled ? 'line-through' : ''}>{i.productName}</span>
              {i.canceled && <span className="ml-2 text-xs text-red-400 no-underline">cancelado</span>}
              {i.sharedWith > 1 && <span className="text-slate-500"> · rateado entre {i.sharedWith}</span>}
              {i.paidCents > 0 && (
                <span className="ml-2 text-xs text-emerald-400">
                  pago{' '}
                  {i.paidFraction.num === i.paidFraction.den
                    ? 'inteiro'
                    : i.paidFraction.den <= 12 // fração "de gente" (1/2, 1/3…); pagamento por valor vira R$
                      ? `${i.paidFraction.num}/${i.paidFraction.den}`
                      : formatBRL(i.paidCents)}
                </span>
              )}
            </span>
            <span className={i.canceled ? 'line-through' : ''}>{formatBRL(i.amountCents)}</span>
            {open && !i.canceled && i.paidCents === 0 && (
              <button
                onClick={() => onCancelItem(i)}
                className="rounded px-2 py-0.5 text-xs text-red-300 hover:bg-red-950"
                title="Cancelar este item (pede o PIN do gerente)"
              >
                Cancelar
              </button>
            )}
          </li>
        ))}
      </ul>
      <footer className="flex justify-between border-t border-slate-800 px-4 py-2 text-sm">
        <span className="text-slate-400">
          {c.serviceFeeWaived && 'sem taxa · '}
          {c.couvertWaived && 'sem couvert · '}
          pago {formatBRL(c.totals.paidCents)}
        </span>
        <span>
          total {formatBRL(c.totals.totalCents)} · <strong>resta {formatBRL(c.totals.remainingCents)}</strong>
        </span>
      </footer>
    </section>
  );
}

function Totals({ bill: b }: { bill: Bill }) {
  const t = b.totals;
  const row = (label: string, value: string, cls = '') => (
    <div className={`flex justify-between ${cls}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className="space-y-1 rounded-xl bg-slate-900 p-4 text-sm">
      {row('Itens', formatBRL(t.itemsCents))}
      {t.serviceFeeCents > 0 && row('Taxa de serviço (10%)', formatBRL(t.serviceFeeCents))}
      {t.couvertCents > 0 && row('Couvert', formatBRL(t.couvertCents))}
      {t.discountCents > 0 && row('Desconto', `− ${formatBRL(t.discountCents)}`, 'text-emerald-300')}
      {row('Total', formatBRL(t.totalCents), 'border-t border-slate-800 pt-1 font-semibold')}
      {t.paidCents > 0 && row('Já pago', `− ${formatBRL(t.paidCents)}`, 'text-slate-400')}
      {row('Restante', formatBRL(t.remainingCents), 'text-2xl font-bold text-amber-400')}
    </dl>
  );
}

function PaymentForm({
  registerId,
  bill: b,
  comandaIds,
  onPaid,
}: {
  registerId: string;
  bill: Bill;
  comandaIds: string[];
  onPaid: (r: CreatePaymentResult) => void;
}) {
  const [mode, setMode] = useState<'VALOR' | 'ITENS'>('VALOR');
  const [method, setMethod] = useState<PaymentMethod>('PIX');
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [split, setSplit] = useState('');
  const [payer, setPayer] = useState('');
  const [picks, setPicks] = useState<ItemPick[]>([]);
  const [valueInputs, setValueInputs] = useState<Record<string, string>>({});
  const [clientUuid, setClientUuid] = useState(() => crypto.randomUUID());
  const [localError, setLocalError] = useState<string | null>(null);
  const remaining = b.totals.remainingCents;

  useEffect(() => {
    setAmount('');
    setPicks([]);
    setValueInputs({});
    setPayer(b.comandas.length === 1 ? b.comandas[0]!.customerName : '');
  }, [comandaIds.join(',')]);

  // Pagamento por item: mesmo cálculo do servidor (fração + taxa da comanda, limitado ao restante dela).
  const itemsAmount = useMemo(() => {
    const perComanda = new Map<string, number>();
    for (const p of picks) {
      const item = b.items.find((i) => i.orderItemId === p.orderItemId && i.comandaId === p.comandaId);
      const comanda = b.comandas.find((c) => c.id === p.comandaId);
      if (!item || !comanda) continue;
      const part =
        p.amountCents !== undefined
          ? p.amountCents > 0 && item.paidCents + p.amountCents <= item.amountCents
            ? p.amountCents
            : null
          : fractionAmount(item.amountCents, { num: p.num!, den: p.den! }, { fraction: item.paidFraction, cents: item.paidCents });
      if (part === null) continue;
      const fee = b.serviceFeeEnabled && !comanda.serviceFeeWaived ? percentOf(part, SERVICE_FEE_BPS) : 0;
      perComanda.set(p.comandaId, (perComanda.get(p.comandaId) ?? 0) + part + fee);
    }
    return [...perComanda].reduce((s, [id, v]) => s + Math.min(v, b.comandas.find((c) => c.id === id)!.totals.remainingCents), 0);
  }, [picks, b]);

  const amountCents = mode === 'ITENS' ? itemsAmount : (parseBRL(amount || '') ?? (amount ? null : remaining));
  const tenderedCents = method === 'DINHEIRO' && tendered ? parseBRL(tendered) : null;
  const change = amountCents && tenderedCents ? tenderedCents - amountCents : 0;

  const pay = useMutation({
    mutationFn: () =>
      api<CreatePaymentResult>('/cashier/payments', {
        method: 'POST',
        body: JSON.stringify({
          clientUuid,
          registerId,
          comandaIds,
          method,
          amountCents,
          tenderedCents: tenderedCents ?? undefined,
          payerName: payer.trim(),
          items: mode === 'ITENS' ? picks : undefined,
        }),
      }),
    onSuccess: (r) => {
      setClientUuid(crypto.randomUUID()); // próximo pagamento é outro
      setAmount('');
      setTendered('');
      setPicks([]);
      setValueInputs({});
      onPaid(r);
    },
  });

  const invalidValue = picks.some((p) => {
    if (p.amountCents === undefined) return false;
    const item = b.items.find((i) => i.orderItemId === p.orderItemId && i.comandaId === p.comandaId);
    return !item || p.amountCents <= 0 || item.paidCents + p.amountCents > item.amountCents;
  });

  const submit = () => {
    if (mode === 'ITENS' && invalidValue) return setLocalError('Confira os valores digitados: cada um deve ser maior que zero e até o que falta do item.');
    if (!amountCents || amountCents <= 0) return setLocalError(mode === 'ITENS' ? 'Escolha os itens.' : 'Valor inválido.');
    if (amountCents > remaining) return setLocalError(`O valor passa do restante (${formatBRL(remaining)}).`);
    if (!payer.trim()) return setLocalError('Informe quem está pagando.');
    if (method === 'DINHEIRO' && tenderedCents !== null && tenderedCents < amountCents) return setLocalError('Valor entregue menor que o valor a pagar.');
    setLocalError(null);
    pay.mutate();
  };

  const pickOf = (orderItemId: string, comandaId: string) => picks.find((p) => p.orderItemId === orderItemId && p.comandaId === comandaId);

  return (
    <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="flex gap-1 rounded-lg bg-slate-800 p-1 text-sm">
        {(['VALOR', 'ITENS'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`flex-1 rounded-md py-1.5 ${mode === m ? 'bg-slate-600 font-medium' : 'text-slate-400'}`}>
            {m === 'VALOR' ? 'Por valor' : 'Por item'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-1">
        {PAYMENT_METHODS.map((m) => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            className={`rounded-lg border py-2.5 text-sm font-medium ${method === m ? 'border-amber-500 bg-amber-500 text-slate-950' : 'border-slate-700'}`}
          >
            {PAYMENT_METHOD_LABELS[m]}
          </button>
        ))}
      </div>

      {mode === 'VALOR' ? (
        <>
          <TextField
            label="Valor a pagar (R$)"
            inputMode="decimal"
            placeholder={formatBRL(remaining).replace('R$ ', '')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint="Vazio = paga todo o restante."
          />
          <div className="flex items-end gap-2">
            <TextField label="Dividir por" inputMode="numeric" placeholder="nº de pessoas" value={split} onChange={(e) => setSplit(e.target.value.replace(/\D/g, ''))} />
            <Button
              disabled={!split || Number(split) < 2}
              onClick={() => setAmount((Math.ceil(remaining / Number(split)) / 100).toFixed(2).replace('.', ','))}
            >
              Calcular
            </Button>
          </div>
        </>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {b.items
            .filter((i) => i.amountCents > 0 && i.paidCents < i.amountCents)
            .map((i) => {
              const current = pickOf(i.orderItemId, i.comandaId);
              const k = `${i.orderItemId}-${i.comandaId}`;
              const left = i.amountCents - i.paidCents;
              const who = b.comandas.length > 1 ? `${b.comandas.find((c) => c.id === i.comandaId)?.customerName}: ` : '';
              return (
                <li key={k} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="flex-1">
                    {who}
                    {i.qty}× {i.productName} <span className="text-slate-500">{formatBRL(i.amountCents)}</span>
                    {i.paidCents > 0 && <span className="text-xs text-amber-300"> · falta {formatBRL(left)}</span>}
                  </span>
                  <SelectField
                    label=""
                    aria-label={`Parte de ${i.productName}`}
                    value={current ? (current.amountCents !== undefined ? 'valor' : `${current.num}/${current.den}`) : ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      const others = picks.filter((p) => !(p.orderItemId === i.orderItemId && p.comandaId === i.comandaId));
                      if (v === 'valor') {
                        const typed = parseBRL(valueInputs[k] ?? '') ?? 0;
                        setPicks([...others, { orderItemId: i.orderItemId, comandaId: i.comandaId, amountCents: typed }]);
                        return;
                      }
                      const [num, den] = v.split('/').map(Number);
                      setPicks([...others, ...(num && den ? [{ orderItemId: i.orderItemId, comandaId: i.comandaId, num, den }] : [])]);
                    }}
                  >
                    <option value="">—</option>
                    {FRACTIONS.filter(
                      (f) => fractionAmount(i.amountCents, f, { fraction: i.paidFraction, cents: i.paidCents }) !== null,
                    ).map((f) => (
                      <option key={f.label} value={`${f.num}/${f.den}`}>
                        {f.label}
                      </option>
                    ))}
                    {i.paidFraction.num > 0 && (
                      <option value={`${i.paidFraction.den - i.paidFraction.num}/${i.paidFraction.den}`}>O que falta</option>
                    )}
                    <option value="valor">Valor (R$)</option>
                  </SelectField>
                  {current?.amountCents !== undefined && (
                    <input
                      aria-label={`Valor de ${i.productName}`}
                      inputMode="decimal"
                      autoFocus
                      placeholder="0,00"
                      value={valueInputs[k] ?? ''}
                      onChange={(e) => {
                        const text = e.target.value;
                        setValueInputs((vs) => ({ ...vs, [k]: text }));
                        const cents = parseBRL(text) ?? 0;
                        setPicks((ps) => ps.map((p) => (p.orderItemId === i.orderItemId && p.comandaId === i.comandaId ? { ...p, amountCents: cents } : p)));
                      }}
                      className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-right"
                    />
                  )}
                </li>
              );
            })}
        </ul>
      )}

      <TextField label="Quem está pagando" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="Nome" />

      {method === 'DINHEIRO' && (
        <TextField label="Valor entregue (R$)" inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} hint="Para calcular o troco." />
      )}
      {method === 'DINHEIRO' && change > 0 && <p className="rounded-lg bg-sky-950 p-3 text-center text-xl font-semibold text-sky-200">Troco: {formatBRL(change)}</p>}

      <ErrorBanner message={localError ?? errorMessage(pay.error)} />
      <Button variant="primary" className="w-full py-3.5 text-base" onClick={submit} disabled={pay.isPending}>
        Receber {amountCents ? formatBRL(amountCents) : ''} · {PAYMENT_METHOD_LABELS[method]}
      </Button>
    </section>
  );
}

function AdjustmentModal({
  type,
  comanda,
  onClose,
  submit,
}: {
  type: 'DESCONTO' | 'TAXA_SERVICO_REMOVIDA' | 'COUVERT_REMOVIDO';
  comanda: BillComanda;
  onClose: () => void;
  submit: (body: object) => Promise<void>;
}) {
  const [kind, setKind] = useState<'VALOR' | 'PERCENTUAL'>('VALOR');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = { DESCONTO: 'Desconto', TAXA_SERVICO_REMOVIDA: 'Retirar taxa de serviço', COUVERT_REMOVIDO: 'Retirar couvert' }[type];

  const go = async () => {
    const body: Record<string, unknown> = { comandaId: comanda.id, type, reason };
    if (type === 'DESCONTO') {
      if (kind === 'VALOR') {
        const cents = parseBRL(value);
        if (!cents) return setError('Informe o valor do desconto.');
        body.amountCents = cents;
      } else {
        const pct = Number(value.replace(',', '.'));
        if (!(pct > 0 && pct <= 100)) return setError('Percentual entre 0 e 100.');
        body.percentBps = Math.round(pct * 100);
      }
    }
    setBusy(true);
    setError(null);
    try {
      await submit(body);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${title} · ${comanda.customerName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={go} disabled={busy}>Aplicar</Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      {type === 'DESCONTO' && (
        <div className="flex gap-2">
          <SelectField label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as 'VALOR' | 'PERCENTUAL')}>
            <option value="VALOR">Valor (R$)</option>
            <option value="PERCENTUAL">Percentual (%)</option>
          </SelectField>
          <TextField label={kind === 'VALOR' ? 'Valor' : '%'} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </div>
      )}
      <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus={type !== 'DESCONTO'} />
      <p className="text-xs text-slate-500">Fica registrado na auditoria. Se você não for gerente, será pedido o PIN de um gerente.</p>
    </Modal>
  );
}

const CANCEL_REASONS = ['Lançado errado', 'Cliente desistiu', 'Demorou demais', 'Produto em falta'];

/** Cancelar item lançado: quantidade (todo ou parte) e motivo; o PIN do gerente vem do usePin. */
function CancelItemModal({
  item,
  onClose,
  submit,
}: {
  item: BillItem;
  onClose: () => void;
  submit: (body: { qty: number; reason: string }) => Promise<void>;
}) {
  const [qty, setQty] = useState(item.qty);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (reason.trim().length < 3) return setError('Informe o motivo do cancelamento.');
    setBusy(true);
    setError(null);
    try {
      await submit({ qty, reason: reason.trim() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Cancelar item"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="danger" onClick={go} disabled={busy}>
            Cancelar {qty}× {item.productName}
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <p className="text-base font-medium">
        {item.qty}× {item.productName} <span className="text-slate-400">· {formatBRL(item.unitPriceCents)} cada</span>
      </p>
      {item.sharedWith > 1 && (
        <p className="rounded-lg bg-amber-950 px-3 py-2 text-sm text-amber-200">
          Este item está rateado entre {item.sharedWith} comandas: o cancelamento vale para todas.
        </p>
      )}
      {item.qty > 1 && (
        <SelectField label="Quantas unidades cancelar" value={qty} onChange={(e) => setQty(Number(e.target.value))}>
          {Array.from({ length: item.qty }, (_, n) => item.qty - n).map((n) => (
            <option key={n} value={n}>
              {n === item.qty ? `Todas (${n})` : n}
            </option>
          ))}
        </SelectField>
      )}
      <div className="flex flex-wrap gap-2">
        {CANCEL_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setReason(r)}
            className={`rounded-full px-3 py-1 text-sm ${reason === r ? 'bg-slate-100 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
          >
            {r}
          </button>
        ))}
      </div>
      <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <p className="text-xs text-slate-500">
        Fica registrado na auditoria e o setor (bar/cozinha) recebe um aviso de cancelamento. Se você não for gerente, será pedido o PIN de
        um gerente ou do administrador.
      </p>
    </Modal>
  );
}
