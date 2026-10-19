import {
  formatBRL,
  isValidCpf,
  onlyDigits,
  type CashierTable,
  type CashMovementType,
  type CashSessionSummary,
  type LookupResult,
  type PrintQueueResponse,
} from '@sistema-bar/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, ErrorBanner, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatTime } from '../../lib/format';
import { errorMessage } from '../../lib/queries';
import { BillPanel } from './BillPanel';
import { CloseCashModal, MovementModal, OpenCashForm } from './CashModals';

/** Caixa (SPEC 5.7): sessão, busca por mesa/CPF, mapa das mesas a fechar e a conta. */
export function CashierPage() {
  const { user, logout } = useAuth();
  const session = useQuery({
    queryKey: ['/cashier/session'],
    queryFn: () => api<{ session: CashSessionSummary | null }>('/cashier/session'),
  });
  const s = session.data?.session;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <img src="/favicon.svg" alt="" className="size-7" /> Caixa
        </Link>
        {s && (
          <span className="text-sm text-slate-400">
            aberto às {formatTime(s.openedAt)} por {s.openedBy} · dinheiro na gaveta{' '}
            <strong className="text-slate-200">{formatBRL(s.expectedCashCents)}</strong>
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {s && <SessionActions />}
          <PrinterAlert />
          <span className="text-xs text-slate-500">{user?.name}</span>
          <button onClick={logout} className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800">Sair</button>
        </div>
      </header>
      <main className="px-4 py-4">
        <ErrorBanner message={errorMessage(session.error)} />
        {session.isLoading ? <Loading /> : s ? <Workspace /> : <OpenCashForm />}
      </main>
    </div>
  );
}

function SessionActions() {
  const [movement, setMovement] = useState<CashMovementType | null>(null);
  const [closing, setClosing] = useState(false);
  return (
    <>
      <Button onClick={() => setMovement('SUPRIMENTO')}>Suprimento</Button>
      <Button onClick={() => setMovement('SANGRIA')}>Sangria</Button>
      <Button variant="danger" onClick={() => setClosing(true)}>Fechar caixa</Button>
      {movement && <MovementModal type={movement} onClose={() => setMovement(null)} />}
      {closing && <CloseCashModal onClose={() => setClosing(false)} />}
    </>
  );
}

/** Impressora com erro (sem papel, desligada) aparece aqui para o caixa resolver (SPEC 5.5). */
function PrinterAlert() {
  const queue = useQuery({
    queryKey: ['/print/queue?status=ABERTOS'],
    queryFn: () => api<PrintQueueResponse>('/print/queue?status=ABERTOS'),
    refetchInterval: 5_000,
  });
  const errors = queue.data?.printers.filter((p) => p.errors > 0) ?? [];
  if (errors.length === 0) return null;
  return (
    <Link to="/caixa/impressao" className="rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white">
      ⚠ Impressora: {errors.map((p) => `${p.printerName} (${p.lastError})`).join(', ')}
    </Link>
  );
}

function Workspace() {
  const tables = useQuery({
    queryKey: ['/cashier/tables'],
    queryFn: () => api<CashierTable[]>('/cashier/tables'),
    refetchInterval: 5_000,
  });
  const [current, setCurrent] = useState<{ tableId: string; preselect: string[] | null } | null>(null);
  const [query, setQuery] = useState('');

  const lookup = useMutation({
    mutationFn: (body: object) => api<LookupResult>('/cashier/lookup', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (r) => {
      setCurrent({ tableId: r.table.id, preselect: r.matchedComandaId ? [r.matchedComandaId] : null });
      setQuery('');
    },
  });

  const search = (e: FormEvent) => {
    e.preventDefault();
    const digits = onlyDigits(query);
    if (digits.length === 11 && isValidCpf(digits)) lookup.mutate({ cpf: digits });
    else if (digits.length > 0 && digits.length <= 4) lookup.mutate({ tableNumber: Number(digits) });
    else lookup.reset();
  };

  const table = tables.data?.find((t) => t.id === current?.tableId);

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <aside className="space-y-3">
        <form onSubmit={search} className="space-y-2">
          <label htmlFor="busca" className="block text-sm text-slate-300">Mesa ou CPF do cliente</label>
          <div className="flex gap-2">
            <input
              id="busca"
              autoFocus
              inputMode="numeric"
              placeholder="Ex.: 10 ou 529.982.247-25"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-base outline-none focus:border-amber-500"
            />
            <Button variant="primary" type="submit" disabled={lookup.isPending}>Buscar</Button>
          </div>
          <ErrorBanner
            message={
              lookup.isError
                ? errorMessage(lookup.error)
                : query && onlyDigits(query).length > 4 && onlyDigits(query).length === 11 && !isValidCpf(query)
                  ? 'CPF inválido.'
                  : null
            }
          />
        </form>

        <h2 className="pt-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">Mesas abertas</h2>
        {tables.isLoading ? (
          <Loading />
        ) : tables.data?.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhuma mesa com comanda aberta.</p>
        ) : (
          <ul className="space-y-1.5">
            {tables.data?.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setCurrent({ tableId: t.id, preselect: null })}
                  className={`w-full rounded-xl border p-3 text-left ${
                    current?.tableId === t.id ? 'border-amber-500 bg-amber-500/10' : t.closingRequested ? 'border-sky-600 bg-sky-950' : 'border-slate-800 bg-slate-900'
                  }`}
                >
                  <span className="flex items-baseline justify-between">
                    <span className="text-lg font-semibold">Mesa {t.number}</span>
                    <span className="font-medium">{formatBRL(t.totals.remainingCents)}</span>
                  </span>
                  <span className="block truncate text-sm text-slate-400">{t.comandas.map((c) => c.customerName).join(', ')}</span>
                  {t.closingRequested && <span className="text-xs font-medium text-sky-300">Pediu a conta</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="min-w-0">
        {table ? (
          <BillPanel key={table.id} table={table} preselect={current?.preselect ?? null} onEmpty={() => setCurrent(null)} />
        ) : (
          <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-slate-700 text-slate-500">
            Busque pela mesa ou pelo CPF, ou escolha uma mesa ao lado.
          </div>
        )}
      </section>
    </div>
  );
}
