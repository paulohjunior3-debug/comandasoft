import {
  formatBRL,
  openComandaSchema,
  WAITER_ERRORS,
  type ComandaSummary,
  type CreateOrderResponse,
  type TableDetail,
} from '@sistema-bar/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Badge, Button, ErrorBanner, Loading, Modal, TextField } from '../../components/ui';
import { ApiRequestError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { maskCpf, maskPhone } from '../../lib/format';
import { useCachedQuery } from '../../lib/offline/cache';
import { useOutboxEntries } from '../../lib/offline/hooks';
import { isPending, mergeComandas, pendingComandas, type PendingComanda } from '../../lib/offline/local';
import { outbox, type SubmitResult } from '../../lib/offline/outbox';
import { errorMessage } from '../../lib/queries';
import { WaiterHeader } from './WaiterHeader';

export type SentState = { result: CreateOrderResponse } | { queued: true };

export function TablePage() {
  const { tableId } = useParams<{ tableId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const sent = (useLocation().state as { sent?: SentState } | null)?.sent;
  const detail = useCachedQuery<TableDetail>(`/waiter/tables/${tableId}`);
  const entries = useOutboxEntries(tableId);
  const [newComanda, setNewComanda] = useState(false);
  const [visited, setVisited] = useState(false);

  const t = detail.data;
  const list = t ? mergeComandas(t.comandas, pendingComandas(entries, t.table.id, t.table.number)) : [];
  const total = list.reduce((sum, c) => sum + c.totalCents, 0);
  const pendingOrders = entries.filter((e) => e.kind === 'order').length;

  const registerVisit = async () => {
    await outbox.submit({
      id: crypto.randomUUID(),
      kind: 'visit',
      method: 'POST',
      path: `/waiter/tables/${tableId}/visit`,
      body: {},
      tableId: tableId!,
      label: `Atendi a mesa ${t?.table.number ?? ''}`,
      userId: user!.id,
    }).catch(() => {});
    setVisited(true);
  };

  return (
    <div className="min-h-dvh pb-28">
      <WaiterHeader title={t ? `Mesa ${t.table.number}` : 'Mesa'} back="/garcom" />
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-4">
        <ErrorBanner message={!t ? errorMessage(detail.error) : null} />
        <SentBanner sent={sent} stillQueued={pendingOrders > 0} />
        {pendingOrders > 0 && (
          <Link to="/garcom/pendencias" className="block rounded-lg bg-amber-950 px-3 py-2 text-sm text-amber-200">
            ⏳ {pendingOrders} pedido(s) desta mesa aguardando envio. Mantenha o app aberto.
          </Link>
        )}
        {!t ? (
          detail.isLoading && <Loading />
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <p className="text-sm text-slate-400">
                {list.length} comanda(s){t.table.area ? ` · ${t.table.area}` : ''}
              </p>
              {list.length > 0 && <p className="font-semibold">{formatBRL(total)}</p>}
            </div>

            {list.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
                Mesa livre. Abra uma comanda para cada pessoa.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl bg-slate-900">
                {list.map((c) => (
                  <ComandaRow key={c.clientUuid} comanda={c} />
                ))}
              </ul>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setNewComanda(true)} className="py-3">+ Nova comanda</Button>
              <Button onClick={registerVisit} disabled={list.length === 0} className="py-3">
                {visited ? '✓ Atendida' : 'Atendi a mesa'}
              </Button>
            </div>
          </>
        )}
      </main>

      {t && list.length > 0 && (
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
          existingNames={list.map((c) => c.customerName)}
          onClose={() => setNewComanda(false)}
          onCreated={() => setNewComanda(false)}
        />
      )}
    </div>
  );
}

function SentBanner({ sent, stillQueued }: { sent?: SentState; stillQueued: boolean }) {
  if (!sent) return null;
  if ('queued' in sent && !stillQueued) {
    return (
      <p role="status" className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-300">
        Conexão de volta: os pedidos guardados foram enviados.
      </p>
    );
  }
  if ('queued' in sent) {
    return (
      <p role="status" className="rounded-lg bg-amber-950 px-3 py-2 text-sm text-amber-200">
        Sem conexão: pedido guardado no aparelho. Ele será enviado e impresso assim que a conexão voltar.
      </p>
    );
  }
  const r = sent.result;
  return (
    <p role="status" className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-300">
      Pedido enviado.{' '}
      {r.unroutedItems > 0
        ? `Atenção: ${r.unroutedItems} item(ns) de categoria sem impressora não sairão em papel.`
        : r.printJobs > 0
          ? `${r.printJobs} cupom(ns) na fila de impressão.`
          : ''}
    </p>
  );
}

function ComandaRow({ comanda: c }: { comanda: ComandaSummary | PendingComanda }) {
  const pending = isPending(c);
  return (
    <li>
      <Link to={`/garcom/comanda/${c.clientUuid}`} className="flex items-center gap-3 px-4 py-3.5 active:bg-slate-800">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-800 font-semibold">
          {c.customerName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">
            {c.customerName}
            {c.peopleCount > 1 && <span className="text-sm font-normal text-slate-400"> · {c.peopleCount} pessoas</span>}
          </span>
          {pending && (c.conflict ? <Badge tone="bad">Recusada · ver pendências</Badge> : <Badge tone="warn">Aguardando envio</Badge>)}
          {!pending && c.status === 'EM_FECHAMENTO' && <Badge tone="warn">Pediu a conta</Badge>}
        </span>
        {!pending && <span className="font-medium">{formatBRL(c.totalCents)}</span>}
        <span className="text-slate-500">›</span>
      </Link>
    </li>
  );
}

export function NewComandaModal({
  tableId,
  tableNumber,
  existingNames,
  onClose,
  onCreated,
}: {
  tableId: string;
  tableNumber: number;
  /** Nomes já na mesa (inclusive pendentes): checados no aparelho, para funcionar offline. */
  existingNames: string[];
  onClose: () => void;
  /** Recebe o clientUuid, que serve de id da comanda mesmo antes de chegar ao servidor. */
  onCreated: (comanda: { clientUuid: string; customerName: string }) => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [cpf, setCpf] = useState('');
  const [phone, setPhone] = useState('');
  const [people, setPeople] = useState(1);
  // Mesmo clientUuid em todas as tentativas desta abertura: reenviar não duplica.
  const [clientUuid] = useState(() => crypto.randomUUID());
  const save = useMutation({
    mutationFn: async () => {
      const body = { clientUuid, tableId, customerName: name.trim(), cpf, phone, peopleCount: people };
      // Mesmas regras do servidor, checadas aqui para o garçom saber na hora mesmo sem rede.
      const parsed = openComandaSchema.safeParse(body);
      if (!parsed.success) throw new ApiRequestError(400, 'VALIDATION', parsed.error.issues[0]?.message ?? 'Dados inválidos.');
      if (existingNames.some((n) => n.toLowerCase() === body.customerName.toLowerCase())) {
        throw new ApiRequestError(
          409,
          WAITER_ERRORS.DUPLICATE_NAME,
          `Já existe "${body.customerName}" na mesa ${tableNumber}. Acrescente o sobrenome ou uma inicial.`,
        );
      }
      return outbox.submit<ComandaSummary>({
        id: clientUuid,
        kind: 'comanda',
        method: 'POST',
        path: '/waiter/comandas',
        body,
        tableId,
        label: `Abrir comanda de ${body.customerName} (mesa ${tableNumber})`,
        userId: user!.id,
      });
    },
    onSuccess: (_r: SubmitResult<ComandaSummary>) => onCreated({ clientUuid, customerName: name.trim() }),
  });
  const duplicateName = save.error instanceof ApiRequestError && save.error.code === WAITER_ERRORS.DUPLICATE_NAME;

  return (
    <Modal
      title={`Nova comanda · Mesa ${tableNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>Abrir comanda</Button>
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
      <div>
        <span className="mb-1 block text-sm text-slate-300">Pessoas nesta comanda</span>
        <div className="flex items-center gap-3">
          <Button aria-label="Menos uma pessoa" className="size-11 text-xl" onClick={() => setPeople((n) => Math.max(1, n - 1))}>−</Button>
          <span className="w-10 text-center text-2xl font-semibold" aria-live="polite">{people}</span>
          <Button aria-label="Mais uma pessoa" className="size-11 text-xl" onClick={() => setPeople((n) => Math.min(30, n + 1))}>+</Button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Ex.: casal numa comanda só = 2. Se tiver couvert, é cobrado por pessoa.</p>
      </div>
      <TextField
        label="Telefone (opcional)"
        inputMode="tel"
        placeholder="(31) 99999-9999"
        value={phone}
        onChange={(e) => setPhone(maskPhone(e.target.value))}
      />
      <p className="text-xs text-slate-500">
        O CPF identifica o cliente no caixa e na nota fiscal, e fica guardado de forma protegida (LGPD). Sem conexão, a
        comanda é aberta no aparelho e enviada quando a rede voltar.
      </p>
    </Modal>
  );
}
