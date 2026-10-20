import {
  formatBRL,
  formatLocalTime,
  isValidCpf,
  matchesSearch,
  onlyDigits,
  parseBRL,
  centsToInput,
  type BillItem,
  type CashierTable,
  type CounterComandaResult,
  type CouvertWindow,
  type CreateOrderResponse,
  type LookupResult,
  type MenuCategory,
  type MenuProduct,
} from '@sistema-bar/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button, ErrorBanner, Loading, Modal, SelectField, TextField } from '../../components/ui';
import { api } from '../../lib/api';
import { maskCpf } from '../../lib/format';
import { errorMessage } from '../../lib/queries';
import type { usePin } from './usePin';

// ---------- Escolha de produtos (lançar itens e venda no balcão) ----------

interface CartLine {
  product: MenuProduct;
  qty: number;
  notes: string;
}

function useMenu() {
  return useQuery({ queryKey: ['/waiter/menu'], queryFn: () => api<MenuCategory[]>('/waiter/menu'), staleTime: 60_000 });
}

/** Busca/categorias à esquerda, carrinho à direita. Usado no lançamento pelo caixa e no balcão. */
function ProductPicker({ cart, setCart }: { cart: CartLine[]; setCart: (f: (c: CartLine[]) => CartLine[]) => void }) {
  const menu = useMenu();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const cats = menu.data ?? [];
  const active = category ?? cats[0]?.id ?? null;
  const products = useMemo(() => {
    const q = search.trim();
    if (q) return cats.flatMap((c) => c.products).filter((p) => matchesSearch(p.name, q));
    return cats.find((c) => c.id === active)?.products ?? [];
  }, [cats, search, active]);

  const add = (p: MenuProduct) =>
    setCart((c) => {
      const line = c.find((l) => l.product.id === p.id && !l.notes);
      return line ? c.map((l) => (l === line ? { ...l, qty: l.qty + 1 } : l)) : [...c, { product: p, qty: 1, notes: '' }];
    });

  if (menu.isLoading) return <Loading />;
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_260px]">
      <div className="min-w-0 space-y-2">
        <TextField label="" aria-label="Buscar produto" placeholder="Buscar produto (sem acento)" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        {!search.trim() && (
          <div className="flex flex-wrap gap-1">
            {cats.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={`rounded-full px-2.5 py-1 text-xs ${active === c.id ? 'bg-slate-100 font-medium text-slate-950' : 'bg-slate-800 text-slate-300'}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        <ul className="max-h-72 divide-y divide-slate-800 overflow-y-auto rounded-lg bg-slate-950/50">
          {products.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={p.soldOut}
                onClick={() => add(p)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800 disabled:opacity-40"
              >
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 tabular-nums text-slate-400">{p.soldOut ? 'esgotado' : formatBRL(p.priceCents)}</span>
              </button>
            </li>
          ))}
          {products.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-500">Nada encontrado.</li>}
        </ul>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-300">Itens ({cart.reduce((s, l) => s + l.qty, 0)})</p>
        {cart.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-3 text-center text-sm text-slate-500">Toque nos produtos para adicionar.</p>
        ) : (
          <ul className="max-h-72 space-y-1.5 overflow-y-auto">
            {cart.map((l, i) => (
              <li key={i} className="rounded-lg bg-slate-800 p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{l.product.name}</span>
                  <button type="button" aria-label="Menos" className="size-7 rounded bg-slate-700" onClick={() => setCart((c) => c.map((x, j) => (j === i ? { ...x, qty: x.qty - 1 } : x)).filter((x) => x.qty > 0))}>
                    −
                  </button>
                  <span className="w-5 text-center tabular-nums">{l.qty}</span>
                  <button type="button" aria-label="Mais" className="size-7 rounded bg-slate-700" onClick={() => setCart((c) => c.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)))}>
                    +
                  </button>
                </div>
                <input
                  placeholder="Observação"
                  value={l.notes}
                  onChange={(e) => setCart((c) => c.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs outline-none focus:border-amber-500"
                />
              </li>
            ))}
          </ul>
        )}
        <p className="text-right text-sm font-semibold tabular-nums">{formatBRL(cart.reduce((s, l) => s + l.qty * l.product.priceCents, 0))}</p>
      </div>
    </div>
  );
}

async function sendOrder(tableId: string, comandaIds: string[], cart: CartLine[]) {
  return api<CreateOrderResponse>('/waiter/orders', {
    method: 'POST',
    body: JSON.stringify({
      clientUuid: crypto.randomUUID(),
      tableId,
      comandaIds,
      createdAtDevice: new Date().toISOString(),
      items: cart.map((l) => ({ productId: l.product.id, qty: l.qty, notes: l.notes.trim() || undefined, expectedUnitPriceCents: l.product.priceCents })),
    }),
  });
}

const printedNote = (r: CreateOrderResponse) =>
  r.unroutedItems ? ` Atenção: ${r.unroutedItems} item(ns) sem impressora vinculada.` : r.printJobs ? ' Enviado para impressão.' : '';

/** Lançar itens pelo caixa numa comanda da mesa (ou dividido entre as selecionadas). */
export function LaunchItemsModal({
  table,
  selected,
  onClose,
  onDone,
}: {
  table: CashierTable;
  selected: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [target, setTarget] = useState(selected.length > 1 ? 'dividir' : (selected[0] ?? table.comandas[0]?.id ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (!cart.length) return setError('Escolha ao menos um produto.');
    const comandaIds = target === 'dividir' ? selected : [target];
    setBusy(true);
    setError(null);
    try {
      const r = await sendOrder(table.id, comandaIds, cart);
      onDone(`${cart.reduce((s, l) => s + l.qty, 0)} item(ns) lançado(s).${printedNote(r)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Lançar itens · ${table.label}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={go} disabled={busy || !cart.length}>
            Lançar {formatBRL(cart.reduce((s, l) => s + l.qty * l.product.priceCents, 0))}
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <SelectField label="Para quem" value={target} onChange={(e) => setTarget(e.target.value)}>
        {table.comandas.map((c) => (
          <option key={c.id} value={c.id}>
            {c.customerName}
          </option>
        ))}
        {selected.length > 1 && <option value="dividir">Dividir entre as selecionadas ({selected.length})</option>}
      </SelectField>
      <ProductPicker cart={cart} setCart={setCart} />
    </Modal>
  );
}

// ---------- Abrir mesa pelo caixa ----------

interface TableOption {
  id: string;
  number: number;
  area: string | null;
  openNames: string[];
}

/** Abre uma comanda numa mesa (nome, CPF obrigatório, pessoas), como o garçom faz. */
export function OpenTableModal({
  initialNumber,
  onClose,
  onDone,
}: {
  /** Já na conta de uma mesa: "Nova comanda" nela. */
  initialNumber?: number;
  onClose: () => void;
  onDone: (tableId: string, comandaId: string) => void;
}) {
  const tables = useQuery({ queryKey: ['/cashier/all-tables'], queryFn: () => api<TableOption[]>('/cashier/all-tables') });
  const [number, setNumber] = useState(initialNumber ? String(initialNumber) : '');
  const [name, setName] = useState('');
  const [cpf, setCpf] = useState('');
  const [people, setPeople] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientUuid] = useState(() => crypto.randomUUID());
  const table = tables.data?.find((t) => t.number === Number(number));

  const go = async () => {
    if (!table) return setError(number ? `Mesa ${number} não existe ou está desativada.` : 'Informe o número da mesa.');
    if (!name.trim()) return setError('Informe o nome do cliente.');
    if (!isValidCpf(onlyDigits(cpf))) return setError('CPF inválido.');
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ id: string }>('/waiter/comandas', {
        method: 'POST',
        body: JSON.stringify({ clientUuid, tableId: table.id, customerName: name.trim(), cpf, peopleCount: people }),
      });
      onDone(table.id, c.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initialNumber ? `Nova comanda na mesa ${initialNumber}` : 'Abrir mesa'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={go} disabled={busy}>
            Abrir comanda
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <div className="grid grid-cols-[110px_1fr] gap-3">
        <TextField label="Mesa" inputMode="numeric" autoFocus={!initialNumber} value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} />
        <TextField label="Nome do cliente" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="words" autoFocus={Boolean(initialNumber)} />
      </div>
      {table && (
        <p className="-mt-1 text-xs text-slate-400">
          {table.openNames.length ? `Já na mesa ${table.number}: ${table.openNames.join(', ')}` : `Mesa ${table.number} livre${table.area ? ` · ${table.area}` : ''}`}
        </p>
      )}
      <TextField label="CPF" inputMode="numeric" placeholder="000.000.000-00" value={cpf} onChange={(e) => setCpf(maskCpf(e.target.value))} />
      <div>
        <span className="mb-1 block text-sm text-slate-300">Pessoas nesta comanda</span>
        <div className="flex items-center gap-3">
          <Button aria-label="Menos uma pessoa" onClick={() => setPeople((n) => Math.max(1, n - 1))}>
            −
          </Button>
          <span className="w-8 text-center text-xl font-semibold">{people}</span>
          <Button aria-label="Mais uma pessoa" onClick={() => setPeople((n) => Math.min(30, n + 1))}>
            +
          </Button>
          <span className="text-xs text-slate-500">multiplica o couvert</span>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Venda no balcão ----------

/** Venda direta no balcão: escolhe os produtos, sai impresso como BALCÃO e a conta abre para receber. */
export function CounterSaleModal({ onClose, onDone }: { onClose: () => void; onDone: (tableId: string, comandaId: string, message: string) => void }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [name, setName] = useState('');
  const [cpf, setCpf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientUuid] = useState(() => crypto.randomUUID());
  const total = cart.reduce((s, l) => s + l.qty * l.product.priceCents, 0);

  const go = async () => {
    if (!cart.length) return setError('Escolha ao menos um produto.');
    if (cpf && !isValidCpf(onlyDigits(cpf))) return setError('CPF inválido (ou deixe em branco).');
    setBusy(true);
    setError(null);
    try {
      const c = await api<CounterComandaResult>('/cashier/counter/comanda', {
        method: 'POST',
        body: JSON.stringify({ clientUuid, customerName: name.trim() || undefined, cpf: cpf || undefined }),
      });
      const r = await sendOrder(c.tableId, [c.comandaId], cart);
      onDone(c.tableId, c.comandaId, `Venda no balcão lançada.${printedNote(r)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Venda no balcão"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={go} disabled={busy || !cart.length}>
            Lançar e receber {formatBRL(total)}
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <ProductPicker cart={cart} setCart={setCart} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Nome (opcional)" placeholder="Balcão 1, Balcão 2…" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="CPF na nota (opcional)" inputMode="numeric" placeholder="000.000.000-00" value={cpf} onChange={(e) => setCpf(maskCpf(e.target.value))} />
      </div>
    </Modal>
  );
}

// ---------- Mover item para outra comanda ----------

/** Item lançado na comanda errada: vai para outra comanda da mesa ou de outra mesa. */
export function MoveItemModal({
  item,
  table,
  onClose,
  onDone,
}: {
  item: BillItem;
  table: CashierTable;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const shared = item.sharedWith > 1;
  const [qty, setQty] = useState(item.qty);
  const [otherNumber, setOtherNumber] = useState('');
  const [other, setOther] = useState<CashierTable | null>(null);
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = table.comandas.filter((c) => c.id !== item.comandaId);
  const options = other ? other.comandas.filter((c) => c.id !== item.comandaId) : here;

  const findTable = async () => {
    setError(null);
    setTo('');
    try {
      const r = await api<LookupResult>('/cashier/lookup', { method: 'POST', body: JSON.stringify({ tableNumber: Number(otherNumber) }) });
      setOther(r.table);
    } catch (err) {
      setOther(null);
      setError(errorMessage(err));
    }
  };

  const go = async () => {
    if (!to) return setError('Escolha a comanda de destino.');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ to: string }>(`/cashier/order-items/${item.orderItemId}/move`, {
        method: 'POST',
        body: JSON.stringify({ fromComandaId: item.comandaId, toComandaId: to, qty: shared ? undefined : qty }),
      });
      onDone(`${shared ? '' : `${qty}× `}${item.productName} movido para ${r.to}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Mover item"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={go} disabled={busy || !to}>
            Mover
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <p className="font-medium">
        {item.qty}× {item.productName} <span className="text-slate-400">· {formatBRL(item.amountCents)}</span>
      </p>
      {shared ? (
        <p className="rounded-lg bg-amber-950 px-3 py-2 text-sm text-amber-200">Item rateado: move a parte desta comanda ({formatBRL(item.amountCents)}).</p>
      ) : (
        item.qty > 1 && (
          <SelectField label="Quantas unidades" value={qty} onChange={(e) => setQty(Number(e.target.value))}>
            {Array.from({ length: item.qty }, (_, n) => item.qty - n).map((n) => (
              <option key={n} value={n}>
                {n === item.qty ? `Todas (${n})` : n}
              </option>
            ))}
          </SelectField>
        )
      )}
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => (setOther(null), setTo(''))} className={`rounded-lg px-3 py-1.5 ${!other ? 'bg-slate-100 text-slate-950' : 'bg-slate-800'}`}>
          Nesta mesa
        </button>
        <span className="self-center text-slate-500">ou outra mesa:</span>
        <input
          aria-label="Número da outra mesa"
          inputMode="numeric"
          placeholder="nº"
          value={otherNumber}
          onChange={(e) => setOtherNumber(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && otherNumber && void findTable()}
          className="w-16 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 outline-none focus:border-amber-500"
        />
        <Button onClick={findTable} disabled={!otherNumber}>
          Ver
        </Button>
      </div>
      <p className="text-sm text-slate-400">Para qual comanda{other ? ` da ${other.label.toLowerCase()}` : ''}?</p>
      {options.length === 0 ? (
        <p className="text-sm text-slate-500">{other ? 'Essa mesa não tem outra comanda aberta.' : 'Não há outra comanda nesta mesa. Escolha outra mesa.'}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setTo(c.id)}
              className={`rounded-lg border px-3 py-2 text-sm ${to === c.id ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700'}`}
            >
              {c.customerName}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-500">Fica registrado na auditoria. Item já pago precisa ser estornado antes.</p>
    </Modal>
  );
}

// ---------- Couvert por show ----------

interface CouvertState {
  businessDate: string | null;
  windows: CouvertWindow[];
  active: CouvertWindow | null;
  scheduled: CouvertWindow | null;
  defaultCents: number;
  mode: 'UMA_VEZ' | 'POR_SHOW';
}

/** Iniciar/encerrar o couvert (show começou / acabou). Perfil Caixa: PIN de gerente/admin. */
export function CouvertModal({ pin, onClose, onChanged }: { pin: ReturnType<typeof usePin>; onClose: () => void; onChanged: () => void }) {
  const state = useQuery({ queryKey: ['/cashier/couvert'], queryFn: () => api<CouvertState>('/cashier/couvert') });
  const [amount, setAmount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = state.data;
  const value = amount ?? (s?.defaultCents ? centsToInput(s.defaultCents) : '');
  const open = s?.active ?? s?.scheduled ?? null;

  const act = async (path: 'start' | 'stop') => {
    const cents = parseBRL(value);
    if (path === 'start' && !cents) return setError('Informe o valor do couvert por pessoa.');
    setBusy(true);
    setError(null);
    try {
      await pin.run((authorizerPin) =>
        api(`/cashier/couvert/${path}`, { method: 'POST', body: JSON.stringify(path === 'start' ? { amountCents: cents, authorizerPin } : { authorizerPin }) }),
      );
      await state.refetch();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Couvert do dia" onClose={onClose} footer={<Button onClick={onClose}>Fechar</Button>}>
      <ErrorBanner message={error ?? errorMessage(state.error)} />
      {!s ? (
        <Loading />
      ) : (
        <>
          {s.windows.length > 0 && (
            <ul className="space-y-1 text-sm">
              {s.windows.map((w) => (
                <li key={w.id} className="flex justify-between rounded-lg bg-slate-800 px-3 py-2">
                  <span>
                    {formatLocalTime(w.startAt)} – {w.endAt ? formatLocalTime(w.endAt) : <strong className="text-emerald-300">{Date.parse(w.startAt) > Date.now() ? 'programado' : 'ativo'}</strong>}
                  </span>
                  <span className="tabular-nums">{formatBRL(w.amountCents)}/pessoa</span>
                </li>
              ))}
            </ul>
          )}
          {open ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-300">
                {s.active ? `Couvert ativo desde ${formatLocalTime(open.startAt)}.` : `Couvert programado para ${formatLocalTime(open.startAt)}.`} Quem abrir comanda agora paga.
              </p>
              <Button variant="danger" className="w-full py-3" onClick={() => act('stop')} disabled={busy}>
                {s.active ? 'Encerrar couvert (show acabou)' : 'Cancelar o couvert programado'}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <TextField label="Couvert por pessoa (R$)" inputMode="decimal" value={value} onChange={(e) => setAmount(e.target.value)} />
              <Button variant="primary" className="w-full py-3" onClick={() => act('start')} disabled={busy || !s.businessDate}>
                Iniciar couvert agora (show começou)
              </Button>
              {!s.businessDate && <p className="text-xs text-amber-300">Abra o caixa antes de iniciar o couvert.</p>}
            </div>
          )}
          <p className="text-xs text-slate-500">
            Quem abre comanda com o couvert ativo paga. Quem já estava paga se continuar na mesa 15 minutos depois do início.
            {s.mode === 'UMA_VEZ' ? ' Com vários shows no dia, cada pessoa paga uma vez só.' : ' Com vários shows no dia, cobra a cada show.'} Gerente e admin não precisam de PIN.
          </p>
        </>
      )}
    </Modal>
  );
}
