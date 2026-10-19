import {
  formatBRL,
  parseBRL,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type CashClosePreview,
  type CashCloseResult,
  type CashMovementType,
  type PaymentMethod,
} from '@sistema-bar/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBanner, Loading, Modal, TextField, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage, useApiMutation } from '../../lib/queries';

/** Abertura do caixa com o fundo de troco (SPEC 5.7). */
export function OpenCashForm() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = useApiMutation(['/cashier/session']);
  const submit = () => {
    const cents = parseBRL(value || '0');
    if (cents === null) return setError('Valor inválido. Exemplo: 150,00');
    setError(null);
    open.mutate({ method: 'POST', path: '/cashier/session/open', body: { openingFloatCents: cents } });
  };
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 rounded-2xl bg-slate-900 p-6">
      <div>
        <h2 className="text-xl font-semibold">Abrir caixa</h2>
        <p className="text-sm text-slate-400">Informe o dinheiro deixado na gaveta para troco.</p>
      </div>
      <ErrorBanner message={error ?? errorMessage(open.error)} />
      <TextField
        label="Fundo de troco (R$)"
        inputMode="decimal"
        placeholder="0,00"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <Button variant="primary" className="w-full py-3" onClick={submit} disabled={open.isPending}>
        Abrir caixa
      </Button>
    </div>
  );
}

/** Sangria (retirada) ou suprimento (entrada), com motivo e comprovante impresso. */
export function MovementModal({ type, onClose }: { type: CashMovementType; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation<unknown, { printed: boolean }>(['/cashier/session']);
  const submit = () => {
    const cents = parseBRL(amount);
    if (!cents) return setError('Informe o valor.');
    setError(null);
    save.mutate({ method: 'POST', path: '/cashier/session/movements', body: { type, amountCents: cents, reason } }, { onSuccess: onClose });
  };
  return (
    <Modal
      title={type === 'SANGRIA' ? 'Sangria (retirada)' : 'Suprimento (entrada)'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Registrar</Button>
        </>
      }
    >
      <ErrorBanner message={error ?? errorMessage(save.error)} />
      <TextField label="Valor (R$)" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
      <TextField
        label="Motivo"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={type === 'SANGRIA' ? 'Ex.: depósito no banco' : 'Ex.: troco extra'}
      />
      <p className="text-xs text-slate-500">Sai um comprovante na impressora do caixa para assinatura.</p>
    </Modal>
  );
}

/** Fechamento: o sistema calcula o esperado, o operador informa o contado e vê a diferença (SPEC 5.7). */
export function CloseCashModal({ onClose }: { onClose: () => void }) {
  const preview = useQuery({ queryKey: ['close-preview'], queryFn: () => api<CashClosePreview>('/cashier/session/close-preview') });
  const close = useApiMutation<unknown, CashCloseResult & { printed: boolean }>(['/cashier/session', '/cashier/tables']);
  const [counted, setCounted] = useState<Record<PaymentMethod, string>>({ DINHEIRO: '', CREDITO: '', DEBITO: '', PIX: '' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;

  const parsed = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, counted[m].trim() === '' ? undefined : parseBRL(counted[m])])) as Record<
    PaymentMethod,
    number | null | undefined
  >;
  const diff = (m: PaymentMethod) => (p && typeof parsed[m] === 'number' ? parsed[m]! - p.expected[m] : null);
  const totalDiff = PAYMENT_METHODS.reduce((s, m) => s + (diff(m) ?? 0), 0);

  const submit = () => {
    if (typeof parsed.DINHEIRO !== 'number') return setError('Conte e informe o dinheiro da gaveta.');
    if (PAYMENT_METHODS.some((m) => parsed[m] === null)) return setError('Há um valor inválido.');
    if (p && p.openComandas > 0 && !confirmOpen) return setError('Confirme que deseja fechar com comandas abertas.');
    setError(null);
    const body = {
      counted: Object.fromEntries(PAYMENT_METHODS.filter((m) => typeof parsed[m] === 'number').map((m) => [m, parsed[m]])),
      confirmOpenComandas: confirmOpen,
      notes: notes || undefined,
    };
    close.mutate({ method: 'POST', path: '/cashier/session/close', body });
  };

  if (close.data) {
    const r = close.data;
    return (
      <Modal title="Caixa fechado" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Concluir</Button>}>
        <p className={`rounded-xl p-4 text-center text-2xl font-semibold ${r.differenceCents === 0 ? 'bg-emerald-950 text-emerald-300' : r.differenceCents > 0 ? 'bg-sky-950 text-sky-200' : 'bg-red-950 text-red-300'}`}>
          {r.differenceCents === 0 ? 'Sem diferença' : `${r.differenceCents > 0 ? 'Sobra' : 'Falta'} de ${formatBRL(Math.abs(r.differenceCents))}`}
        </p>
        <p className="text-sm text-slate-400">{r.printed ? 'O relatório de fechamento foi para a impressora do caixa.' : 'Sem impressora do caixa configurada: relatório não impresso.'}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Fechar caixa"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={close.isPending || !p}>Fechar caixa</Button>
        </>
      }
    >
      <ErrorBanner message={error ?? errorMessage(preview.error ?? close.error)} />
      {!p ? (
        <Loading />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="py-1 font-normal">Forma</th>
                <th className="py-1 text-right font-normal">Esperado</th>
                <th className="py-1 pl-3 font-normal">Contado</th>
                <th className="py-1 text-right font-normal">Diferença</th>
              </tr>
            </thead>
            <tbody>
              {PAYMENT_METHODS.map((m) => {
                const d = diff(m);
                return (
                  <tr key={m} className="border-t border-slate-800">
                    <td className="py-2">{PAYMENT_METHOD_LABELS[m]}{m === 'DINHEIRO' && <span className="text-red-400"> *</span>}</td>
                    <td className="py-2 text-right">{formatBRL(p.expected[m])}</td>
                    <td className="py-2 pl-3">
                      <input
                        inputMode="decimal"
                        aria-label={`Contado em ${PAYMENT_METHOD_LABELS[m]}`}
                        placeholder={m === 'DINHEIRO' ? 'obrigatório' : 'opcional'}
                        value={counted[m]}
                        onChange={(e) => setCounted((c) => ({ ...c, [m]: e.target.value }))}
                        className="w-28 rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 outline-none focus:border-amber-500"
                      />
                    </td>
                    <td className={`py-2 text-right ${d === null || d === 0 ? 'text-slate-400' : d > 0 ? 'text-sky-300' : 'text-red-300'}`}>
                      {d === null ? '—' : `${d > 0 ? '+' : ''}${formatBRL(d)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-slate-500">
            Dinheiro esperado = fundo {formatBRL(p.session.openingFloatCents)} + suprimentos − sangrias + recebido em dinheiro.
          </p>
          <p className="text-right font-semibold">
            Diferença total: <span className={totalDiff < 0 ? 'text-red-300' : totalDiff > 0 ? 'text-sky-300' : ''}>{formatBRL(totalDiff)}</span>
          </p>
          {p.openComandas > 0 && (
            <div className="rounded-lg bg-amber-950 p-3">
              <p className="mb-2 text-sm text-amber-200">Atenção: {p.openComandas} comanda(s) ainda aberta(s).</p>
              <Toggle label="Fechar o caixa mesmo assim" checked={confirmOpen} onChange={setConfirmOpen} />
            </div>
          )}
          <TextField label="Observações (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </>
      )}
    </Modal>
  );
}
