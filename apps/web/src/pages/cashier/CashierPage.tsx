import {
  formatBRL,
  formatLocalTime,
  isValidCpf,
  onlyDigits,
  type CashierTable,
  type CashMovementType,
  type CashRegister,
  type CashSessionSummary,
  type DayRules,
  type FiscalRequestResult,
  type LookupResult,
  type PrintQueueResponse,
} from '@sistema-bar/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Badge, Button, EmptyState, ErrorBanner, Loading, Modal, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatTime } from '../../lib/format';
import { errorMessage } from '../../lib/queries';
import { BillPanel, type FinalizeInfo } from './BillPanel';
import { CloseCashModal, describeRules, MovementModal, OpenCashForm } from './CashModals';

// Caixa em que este aparelho trabalha (Caixa Carlos, Caixa Paulo…). Só conveniência local.
const REGISTER_KEY = 'sb_caixa';
const savedRegister = () => {
  try {
    return localStorage.getItem(REGISTER_KEY);
  } catch {
    return null;
  }
};
const saveRegister = (id: string | null) => {
  try {
    if (id) localStorage.setItem(REGISTER_KEY, id);
    else localStorage.removeItem(REGISTER_KEY);
  } catch {
    /* sem armazenamento: escolhe de novo da próxima vez */
  }
};

/** Caixa (SPEC 5.7): escolha do caixa, sessão, busca por mesa/CPF, mesas a fechar e a conta. */
export function CashierPage() {
  const { user, logout } = useAuth();
  const [registerId, setRegisterId] = useState<string | null>(savedRegister);
  const registers = useQuery({
    queryKey: ['/cashier/session/registers'],
    queryFn: () => api<CashRegister[]>('/cashier/session/registers'),
  });
  const register = registers.data?.find((r) => r.id === registerId) ?? null;
  const session = useQuery({
    queryKey: ['/cashier/session', registerId],
    queryFn: () => api<{ session: CashSessionSummary | null; rules: DayRules | null }>(`/cashier/session?registerId=${registerId}`),
    enabled: !!register,
  });
  const s = session.data?.session;
  const rules = session.data?.rules;

  const choose = (id: string | null) => {
    saveRegister(id);
    setRegisterId(id);
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <img src="/favicon.svg" alt="" className="size-7" /> {register ? register.name : 'Caixa'}
        </Link>
        {register && (
          <button onClick={() => choose(null)} className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800">
            trocar
          </button>
        )}
        {s && (
          <span className="text-sm text-slate-400">
            aberto às {formatTime(s.openedAt)} por {s.openedBy}
            {s.expectedCloseAt && ` · fecha às ${formatLocalTime(s.expectedCloseAt)}`} · gaveta{' '}
            <strong className="text-slate-200">{formatBRL(s.expectedCashCents)}</strong>
            {rules && <span className="block text-xs text-slate-500">Hoje: {describeRules(rules)}</span>}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {s && registerId && <SessionActions registerId={registerId} />}
          <PrinterAlert />
          <span className="text-xs text-slate-500">{user?.name}</span>
          <button onClick={logout} className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800">Sair</button>
        </div>
      </header>
      <main className="px-4 py-4">
        <ErrorBanner message={errorMessage(registers.error ?? session.error)} />
        {registers.isLoading ? (
          <Loading />
        ) : !register ? (
          <RegisterPicker registers={registers.data ?? []} onChoose={choose} isAdmin={user?.role === 'ADMIN'} />
        ) : session.isLoading ? (
          <Loading />
        ) : s ? (
          <Workspace registerId={register.id} />
        ) : (
          <OpenCashForm registerId={register.id} registerName={register.name} />
        )}
      </main>
    </div>
  );
}

/** Em qual caixa este computador trabalha (o aparelho lembra da escolha). */
function RegisterPicker({ registers, onChoose, isAdmin }: { registers: CashRegister[]; onChoose: (id: string) => void; isAdmin: boolean }) {
  if (registers.length === 0) {
    return (
      <EmptyState>
        Nenhum caixa cadastrado.{' '}
        {isAdmin ? (
          <Link to="/admin/caixas" className="text-amber-400 underline">Cadastre em Administração &gt; Caixas</Link>
        ) : (
          'Peça ao administrador para cadastrar em Administração > Caixas.'
        )}
      </EmptyState>
    );
  }
  return (
    <div className="mx-auto mt-10 max-w-md space-y-3">
      <h2 className="text-xl font-semibold">Em qual caixa você vai trabalhar?</h2>
      {registers.map((r) => (
        <button
          key={r.id}
          onClick={() => onChoose(r.id)}
          className="flex w-full items-center justify-between rounded-xl bg-slate-900 p-4 text-left hover:bg-slate-800"
        >
          <span>
            <span className="block font-semibold">{r.name}</span>
            <span className="block text-xs text-slate-400">
              {r.openSession ? `aberto às ${formatTime(r.openSession.openedAt)} por ${r.openSession.openedBy}` : 'fechado'}
              {r.fiscalMode === 'AUTOMATICO' && ' · fiscal automático'}
            </span>
          </span>
          {r.openSession ? <Badge tone="ok">Aberto</Badge> : <Badge>Fechado</Badge>}
        </button>
      ))}
    </div>
  );
}

function SessionActions({ registerId }: { registerId: string }) {
  const [movement, setMovement] = useState<CashMovementType | null>(null);
  const [closing, setClosing] = useState(false);
  return (
    <>
      <Button onClick={() => setMovement('SUPRIMENTO')}>Suprimento</Button>
      <Button onClick={() => setMovement('SANGRIA')}>Sangria</Button>
      <Button variant="danger" onClick={() => setClosing(true)}>Fechar caixa</Button>
      {movement && <MovementModal registerId={registerId} type={movement} onClose={() => setMovement(null)} />}
      {closing && <CloseCashModal registerId={registerId} onClose={() => setClosing(false)} />}
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

function Workspace({ registerId }: { registerId: string }) {
  const tables = useQuery({
    queryKey: ['/cashier/tables'],
    queryFn: () => api<CashierTable[]>('/cashier/tables'),
    refetchInterval: 5_000,
  });
  const [current, setCurrent] = useState<{ tableId: string; preselect: string[] | null } | null>(null);
  const [query, setQuery] = useState('');
  const [finalizing, setFinalizing] = useState<FinalizeInfo | null>(null);

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
          <BillPanel
            key={table.id}
            registerId={registerId}
            table={table}
            preselect={current?.preselect ?? null}
            onEmpty={() => setCurrent(null)}
            onFinalize={setFinalizing}
          />
        ) : (
          <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-slate-700 text-slate-500">
            Busque pela mesa ou pelo CPF, ou escolha uma mesa ao lado.
          </div>
        )}
      </section>
      {finalizing && <FinalizeModal registerId={registerId} info={finalizing} onClose={() => setFinalizing(null)} />}
    </div>
  );
}

/** Conta quitada: imprimir cupom não fiscal, pedir o cupom fiscal ou só finalizar. */
function FinalizeModal({ registerId, info, onClose }: { registerId: string; info: FinalizeInfo; onClose: () => void }) {
  const [cpfOnNote, setCpfOnNote] = useState(true);
  const body = { registerId, comandaIds: info.comandaIds };
  const receipt = useMutation({
    mutationFn: () => api('/cashier/receipts', { method: 'POST', body: JSON.stringify(body) }),
  });
  const fiscal = useMutation({
    mutationFn: () => api<FiscalRequestResult>('/cashier/fiscal-requests', { method: 'POST', body: JSON.stringify({ ...body, cpfOnNote }) }),
  });
  const fiscalDone = info.fiscalRequested || fiscal.isSuccess;

  return (
    <Modal
      title={`Mesa ${info.tableNumber} quitada`}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Finalizar
        </Button>
      }
    >
      <p className="text-sm text-slate-300">{info.names.join(', ')}</p>
      {info.changeCents > 0 && (
        <p className="rounded-lg bg-sky-950 p-3 text-center text-xl font-semibold text-sky-200">Troco: {formatBRL(info.changeCents)}</p>
      )}
      <ErrorBanner message={errorMessage(receipt.error) ?? errorMessage(fiscal.error)} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button className="py-3" onClick={() => receipt.mutate()} disabled={receipt.isPending}>
          {receipt.isSuccess ? 'Cupom enviado ✓ (imprimir de novo)' : 'Imprimir cupom (não fiscal)'}
        </Button>
        <Button className="py-3" onClick={() => fiscal.mutate()} disabled={fiscal.isPending || fiscalDone}>
          {fiscalDone ? 'Cupom fiscal solicitado ✓' : 'Emitir cupom fiscal'}
        </Button>
      </div>
      {!fiscalDone && <Toggle label="CPF do cliente na nota (se a comanda tiver CPF)" checked={cpfOnNote} onChange={setCpfOnNote} />}
      {info.fiscalRequested && <p className="text-sm text-emerald-300">Este caixa pede o cupom fiscal automaticamente.</p>}
      {fiscalDone && (
        <p className="text-xs text-slate-500">
          A emissão da NFC-e é a próxima fase do sistema. O pedido ficou registrado e será emitido quando o módulo fiscal estiver ligado.
        </p>
      )}
    </Modal>
  );
}
