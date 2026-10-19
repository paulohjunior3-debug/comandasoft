import { formatBRL, WAITER_ERRORS, type ComandaSummary, type CreateOrderResponse, type TableDetail } from '@sistema-bar/shared';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Badge, Button, ErrorBanner, Loading, Modal, TextField } from '../../components/ui';
import { ApiRequestError } from '../../lib/api';
import { maskCpf, maskPhone } from '../../lib/format';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';
import { WaiterHeader } from './WaiterHeader';

export function TablePage() {
  const { tableId } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const sent = (useLocation().state as { sent?: CreateOrderResponse } | null)?.sent;
  const path = `/waiter/tables/${tableId}`;
  const detail = useApiQuery<TableDetail>(path);
  const visit = useApiMutation(['/waiter/tables']);
  const [newComanda, setNewComanda] = useState(false);
  const [visited, setVisited] = useState(false);

  const t = detail.data;
  const total = t?.comandas.reduce((sum, c) => sum + c.totalCents, 0) ?? 0;

  const registerVisit = () =>
    visit.mutate(
      { method: 'POST', path: `${path}/visit`, body: { clientUuid: crypto.randomUUID() } },
      { onSuccess: () => setVisited(true) },
    );

  return (
    <div className="min-h-dvh pb-28">
      <WaiterHeader title={t ? `Mesa ${t.table.number}` : 'Mesa'} back="/garcom" />
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-4">
        <ErrorBanner message={errorMessage(detail.error ?? visit.error)} />
        {sent && (
          <p role="status" className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-300">
            Pedido enviado.{' '}
            {sent.unroutedItems > 0
              ? `Atenção: ${sent.unroutedItems} item(ns) de categoria sem impressora não sairão em papel.`
              : sent.printJobs > 0
                ? `${sent.printJobs} cupom(ns) na fila de impressão.`
                : ''}
          </p>
        )}
        {!t ? (
          detail.isLoading && <Loading />
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <p className="text-sm text-slate-400">
                {t.comandas.length} comanda(s){t.table.area ? ` · ${t.table.area}` : ''}
              </p>
              {t.comandas.length > 0 && <p className="font-semibold">{formatBRL(total)}</p>}
            </div>

            {t.comandas.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
                Mesa livre. Abra uma comanda para cada pessoa.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl bg-slate-900">
                {t.comandas.map((c) => (
                  <ComandaRow key={c.id} comanda={c} />
                ))}
              </ul>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setNewComanda(true)} className="py-3">+ Nova comanda</Button>
              <Button onClick={registerVisit} disabled={visit.isPending || t.comandas.length === 0} className="py-3">
                {visited ? '✓ Atendida' : 'Atendi a mesa'}
              </Button>
            </div>
          </>
        )}
      </main>

      {t && t.comandas.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-800 bg-slate-950/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <Button variant="primary" className="mx-auto block w-full max-w-3xl py-3.5 text-base" onClick={() => navigate(`/garcom/mesa/${tableId}/pedido`)}>
            Lançar pedido
          </Button>
        </div>
      )}

      {newComanda && t && (
        <NewComandaModal
          tableId={t.table.id}
          tableNumber={t.table.number}
          onClose={() => setNewComanda(false)}
          onCreated={() => setNewComanda(false)}
          invalidate={[path]}
        />
      )}
    </div>
  );
}

function ComandaRow({ comanda: c }: { comanda: ComandaSummary }) {
  return (
    <li>
      <Link to={`/garcom/comanda/${c.id}`} className="flex items-center gap-3 px-4 py-3.5 active:bg-slate-800">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-800 font-semibold">
          {c.customerName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">{c.customerName}</span>
          {c.status === 'EM_FECHAMENTO' && <Badge tone="warn">Pediu a conta</Badge>}
        </span>
        <span className="font-medium">{formatBRL(c.totalCents)}</span>
        <span className="text-slate-500">›</span>
      </Link>
    </li>
  );
}

export function NewComandaModal({
  tableId,
  tableNumber,
  onClose,
  onCreated,
  invalidate,
}: {
  tableId: string;
  tableNumber: number;
  onClose: () => void;
  onCreated: (c: ComandaSummary) => void;
  invalidate: string[];
}) {
  const [name, setName] = useState('');
  const [cpf, setCpf] = useState('');
  const [phone, setPhone] = useState('');
  // Mesmo clientUuid em todas as tentativas desta abertura: reenviar não duplica.
  const [clientUuid] = useState(() => crypto.randomUUID());
  const save = useApiMutation<unknown, ComandaSummary>([...invalidate, '/waiter/tables']);
  const duplicateName = save.error instanceof ApiRequestError && save.error.code === WAITER_ERRORS.DUPLICATE_NAME;

  const submit = () =>
    save.mutate(
      { method: 'POST', path: '/waiter/comandas', body: { clientUuid, tableId, customerName: name, cpf, phone } },
      { onSuccess: onCreated },
    );

  return (
    <Modal
      title={`Nova comanda · Mesa ${tableNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Abrir comanda</Button>
        </>
      }
    >
      <ErrorBanner message={errorMessage(save.error)} />
      <TextField
        label="Nome do cliente"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        autoCapitalize="words"
        hint={duplicateName ? 'Ex.: "Paulo H." ou "Paulo Silva"' : 'É o nome que sai no papel para o cumim entregar.'}
      />
      <TextField
        label="CPF"
        inputMode="numeric"
        placeholder="000.000.000-00"
        value={cpf}
        onChange={(e) => setCpf(maskCpf(e.target.value))}
        hint="Obrigatório. Os 3 últimos dígitos serão o PIN do cliente no QR da mesa."
      />
      <TextField
        label="Telefone (opcional)"
        inputMode="tel"
        placeholder="(31) 99999-9999"
        value={phone}
        onChange={(e) => setPhone(maskPhone(e.target.value))}
      />
      <p className="text-xs text-slate-500">
        O CPF identifica o cliente no caixa e na nota fiscal, e fica guardado de forma protegida (LGPD).
      </p>
    </Modal>
  );
}
