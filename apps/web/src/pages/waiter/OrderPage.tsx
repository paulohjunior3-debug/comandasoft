import {
  createOrderSchema,
  formatBRL,
  matchesSearch,
  type CreateOrderResponse,
  type MenuCategory,
  type MenuProduct,
  type TableDetail,
} from '@sistema-bar/shared';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, ErrorBanner, Loading, Modal, TakeawayButton } from '../../components/ui';
import { ApiRequestError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCachedQuery } from '../../lib/offline/cache';
import { useOutboxEntries } from '../../lib/offline/hooks';
import { isPending, mergeComandas, pendingComandas } from '../../lib/offline/local';
import { outbox } from '../../lib/offline/outbox';
import { errorMessage } from '../../lib/queries';
import { NewComandaModal, type SentState } from './TablePage';
import { WaiterHeader } from './WaiterHeader';

interface CartLine {
  key: string;
  product: MenuProduct;
  qty: number;
  notes: string;
}

/**
 * Lançamento (SPEC 5.3): escolher comanda(s) → navegar/buscar no cardápio → quantidade e
 * observação → revisar → Enviar. Uma comanda por vez; dividir entre várias (itens rateados
 * igualmente) só ligando "Dividir entre várias" e confirmando na revisão, para não ratear sem querer.
 */
export function OrderPage() {
  const { tableId } = useParams<{ tableId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tablePath = `/waiter/tables/${tableId}`;
  const table = useCachedQuery<TableDetail>(tablePath);
  const menu = useCachedQuery<MenuCategory[]>('/waiter/menu');
  const entries = useOutboxEntries(tableId);

  const [selected, setSelected] = useState<string[]>(() => {
    const pre = params.get('comanda');
    return pre ? [pre] : [];
  });
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [newComanda, setNewComanda] = useState(false);
  // Modo dividir: só nele um toque soma comandas; fora dele o toque troca a comanda escolhida.
  const [splitMode, setSplitMode] = useState(false);

  // Comandas do servidor + abertas offline. A seleção usa o clientUuid, que o servidor também aceita.
  const comandas = (
    table.data ? mergeComandas(table.data.comandas, pendingComandas(entries, table.data.table.id, table.data.table.number)) : []
  )
    .filter((c) => !(isPending(c) && c.conflict))
    .map((c) => ({ ...c, id: c.clientUuid }));
  // Com uma única comanda na mesa, ela já vem marcada.
  const effectiveSelected = selected.length === 0 && comandas.length === 1 ? [comandas[0]!.id] : selected;

  const activeCategory = category ?? menu.data?.[0]?.id ?? null;
  const products = useMemo(() => {
    const q = search.trim();
    const all = menu.data ?? [];
    // Ignora acentos: "file" acha "Filé", "acai" acha "Açaí".
    if (q) return all.flatMap((c) => c.products).filter((p) => matchesSearch(p.name, q));
    return all.find((c) => c.id === activeCategory)?.products ?? [];
  }, [menu.data, activeCategory, search]);

  const qtyOf = (productId: string) => cart.filter((l) => l.product.id === productId).reduce((s, l) => s + l.qty, 0);
  const itemCount = cart.reduce((s, l) => s + l.qty, 0);
  const total = cart.reduce((s, l) => s + l.qty * l.product.priceCents, 0);

  const add = (product: MenuProduct) =>
    setCart((c) => {
      const plain = c.find((l) => l.product.id === product.id && l.notes === '');
      if (plain) return c.map((l) => (l === plain ? { ...l, qty: Math.min(99, l.qty + 1) } : l));
      return [...c, { key: crypto.randomUUID(), product, qty: 1, notes: '' }];
    });
  const remove = (product: MenuProduct) =>
    setCart((c) => {
      const lines = c.filter((l) => l.product.id === product.id);
      const last = lines[lines.length - 1];
      if (!last) return c;
      return last.qty > 1 ? c.map((l) => (l === last ? { ...l, qty: l.qty - 1 } : l)) : c.filter((l) => l !== last);
    });

  const toggleComanda = (id: string) =>
    setSelected((s) => {
      if (!splitMode) return [id];
      const base = s.length === 0 && comandas.length === 1 ? [comandas[0]!.id] : s;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  const toggleSplit = () => {
    // Saindo do modo dividir: fica só a primeira comanda escolhida.
    if (splitMode) setSelected((s) => s.slice(0, 1));
    setSplitMode(!splitMode);
  };

  if (!table.data || !menu.data) {
    return (
      <div className="min-h-dvh">
        <WaiterHeader title="Lançar pedido" back={`/garcom/mesa/${tableId}`} />
        <main className="mx-auto max-w-3xl px-4 pt-4">
          <ErrorBanner message={errorMessage(table.error ?? menu.error)} />
          {(table.isLoading || menu.isLoading) && <Loading />}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh pb-28">
      <WaiterHeader title={`Pedido · Mesa ${table.data.table.number}`} back={`/garcom/mesa/${tableId}`} />

      {/* Para quem */}
      <section className="border-b border-slate-800 px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
              Para quem {effectiveSelected.length > 1 && <span className="text-amber-400 normal-case">· dividido entre {effectiveSelected.length}</span>}
            </p>
            {comandas.length > 1 && (
              <button
                onClick={toggleSplit}
                aria-pressed={splitMode}
                className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs ${splitMode ? 'border-amber-500 bg-amber-500/15 text-amber-300' : 'border-slate-700 text-slate-400'}`}
              >
                {splitMode ? '✓ Dividindo — toque para sair' : 'Dividir entre várias'}
              </button>
            )}
          </div>
          {splitMode && <p className="mb-2 text-xs text-amber-300">Toque em cada comanda que vai dividir os itens deste pedido.</p>}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {comandas.map((c) => {
              const on = effectiveSelected.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleComanda(c.id)}
                  aria-pressed={on}
                  className={`shrink-0 rounded-full border px-4 py-2 text-sm font-medium ${on ? 'border-amber-500 bg-amber-500 text-slate-950' : 'border-slate-700 text-slate-300'}`}
                >
                  {c.customerName}
                </button>
              );
            })}
            <button onClick={() => setNewComanda(true)} className="shrink-0 rounded-full border border-dashed border-slate-600 px-4 py-2 text-sm text-slate-400">
              + Nova
            </button>
          </div>
        </div>
      </section>

      {/* Cardápio */}
      <section className="sticky top-[calc(env(safe-area-inset-top)+3.6rem)] z-20 border-b border-slate-800 bg-slate-950 px-4 pt-3">
        <div className="mx-auto max-w-3xl">
          <input
            type="search"
            placeholder="Buscar no cardápio"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-base outline-none focus:border-amber-500"
          />
          {!search && (
            <div className="-mx-1 flex gap-1 overflow-x-auto pb-2">
              {menu.data.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategory(c.id)}
                  className={`shrink-0 rounded-lg px-3 py-2 text-sm whitespace-nowrap ${c.id === activeCategory ? 'bg-slate-800 font-semibold text-white' : 'text-slate-400'}`}
                  style={c.id === activeCategory && c.color ? { boxShadow: `inset 0 -3px 0 ${c.color}` } : undefined}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <main className="mx-auto max-w-3xl px-4 pt-2">
        {menu.data.length === 0 ? (
          <p className="py-10 text-center text-slate-400">Cardápio vazio. Peça ao administrador para cadastrar os produtos.</p>
        ) : products.length === 0 ? (
          <p className="py-10 text-center text-slate-400">Nenhum produto encontrado.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {products.map((p) => {
              const qty = qtyOf(p.id);
              return (
                <li key={p.id} className={`flex items-center gap-3 py-3 ${p.soldOut ? 'opacity-40' : ''}`}>
                  <button className="min-w-0 flex-1 text-left" disabled={p.soldOut} onClick={() => add(p)}>
                    <span className="block font-medium">{p.name}</span>
                    <span className="block text-sm text-slate-400">{p.soldOut ? 'Esgotado' : formatBRL(p.priceCents)}</span>
                  </button>
                  {!p.soldOut && (
                    <div className="flex items-center gap-1">
                      {qty > 0 && (
                        <>
                          <button onClick={() => remove(p)} aria-label={`Menos ${p.name}`} className="size-10 rounded-full bg-slate-800 text-xl active:bg-slate-700">
                            −
                          </button>
                          <span className="w-7 text-center font-semibold">{qty}</span>
                        </>
                      )}
                      <button onClick={() => add(p)} aria-label={`Mais ${p.name}`} className="size-10 rounded-full bg-amber-500 text-xl font-semibold text-slate-950 active:bg-amber-600">
                        +
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {itemCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-800 bg-slate-950/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <Button variant="primary" className="mx-auto flex w-full max-w-3xl justify-between py-3.5 text-base" onClick={() => setReviewing(true)}>
            <span className="min-w-0 truncate text-left">
              Revisar · {itemCount} {itemCount === 1 ? 'item' : 'itens'}
              {effectiveSelected.length === 1 && ` · ${comandas.find((c) => c.id === effectiveSelected[0])?.customerName ?? ''}`}
              {effectiveSelected.length > 1 && ` · dividido entre ${effectiveSelected.length}`}
            </span>
            <span>{formatBRL(total)}</span>
          </Button>
        </div>
      )}

      {reviewing && (
        <ReviewModal
          tableId={tableId!}
          cart={cart}
          setCart={setCart}
          comandaIds={effectiveSelected}
          comandaNames={comandas.filter((c) => effectiveSelected.includes(c.id)).map((c) => c.customerName)}
          onClose={() => setReviewing(false)}
          onSent={(r) => navigate(`/garcom/mesa/${tableId}`, { replace: true, state: { sent: r } })}
        />
      )}
      {newComanda && (
        <NewComandaModal
          tableId={table.data.table.id}
          tableNumber={table.data.table.number}
          existingNames={comandas.map((c) => c.customerName)}
          onClose={() => setNewComanda(false)}
          onCreated={(c) => {
            setNewComanda(false);
            setSelected((s) => (splitMode ? [...(s.length === 0 && comandas.length === 1 ? [comandas[0]!.id] : s), c.clientUuid] : [c.clientUuid]));
          }}
        />
      )}
    </div>
  );
}

function ReviewModal({
  tableId,
  cart,
  setCart,
  comandaIds,
  comandaNames,
  onClose,
  onSent,
}: {
  tableId: string;
  cart: CartLine[];
  setCart: (fn: (c: CartLine[]) => CartLine[]) => void;
  comandaIds: string[];
  comandaNames: string[];
  onClose: () => void;
  onSent: (state: SentState) => void;
}) {
  const { user } = useAuth();
  // Um clientUuid por pedido: se a rede falhar e o garçom tocar em Enviar de novo, não duplica.
  const [clientUuid] = useState(() => crypto.randomUUID());
  const [createdAtDevice] = useState(() => new Date().toISOString());
  const [takeaway, setTakeaway] = useState(false);
  // Várias comandas: o garçom confirma que é para dividir (evita ratear por um toque errado).
  const [splitOk, setSplitOk] = useState(false);
  const needsSplitOk = comandaIds.length > 1 && !splitOk;
  const send = useMutation({
    mutationFn: async () => {
      const body = {
        clientUuid,
        tableId,
        comandaIds,
        createdAtDevice,
        takeaway,
        items: cart.map((l) => ({
          productId: l.product.id,
          qty: l.qty,
          notes: l.notes,
          expectedUnitPriceCents: l.product.priceCents,
          productName: l.product.name, // só para exibir na fila; o servidor ignora
        })),
      };
      const parsed = createOrderSchema.safeParse(body);
      if (!parsed.success) throw new ApiRequestError(400, 'VALIDATION', parsed.error.issues[0]?.message ?? 'Pedido inválido.');
      const itemCount = cart.reduce((s, l) => s + l.qty, 0);
      return outbox.submit<CreateOrderResponse>({
        id: clientUuid,
        kind: 'order',
        method: 'POST',
        path: '/waiter/orders',
        body,
        tableId,
        label: `${itemCount} item(ns) para ${comandaNames.join(', ')}${takeaway ? ' (para viagem)' : ''}`,
        userId: user!.id,
      });
    },
    onSuccess: (r) => onSent(r.sent ? { result: r.result } : { queued: true }),
  });
  const total = cart.reduce((s, l) => s + l.qty * l.product.priceCents, 0);

  const update = (key: string, patch: Partial<CartLine>) =>
    setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)).filter((l) => l.qty > 0));

  const submit = () => send.mutate();

  return (
    <Modal
      title="Revisar pedido"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="primary" onClick={submit} disabled={send.isPending || comandaIds.length === 0 || cart.length === 0 || needsSplitOk}>
            {send.isPending ? 'Enviando…' : `Enviar · ${formatBRL(total)}`}
          </Button>
        </>
      }
    >
      <ErrorBanner message={comandaIds.length === 0 ? 'Escolha para quem é o pedido.' : errorMessage(send.error)} />
      {comandaIds.length === 1 && (
        <p className="text-sm text-slate-300">
          Para <strong>{comandaNames[0]}</strong>
        </p>
      )}
      {comandaIds.length > 1 && (
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-600 bg-amber-950/40 p-3 text-sm">
          <input type="checkbox" checked={splitOk} onChange={(e) => setSplitOk(e.target.checked)} className="mt-0.5 size-5 accent-amber-500" />
          <span>
            <strong className="text-amber-300">Dividir entre {comandaIds.length} comandas?</strong>
            <span className="block text-slate-300">
              Cada item deste pedido fica rateado igualmente entre <strong>{comandaNames.join(', ')}</strong>. Marque para confirmar.
            </span>
          </span>
        </label>
      )}
      <TakeawayButton checked={takeaway} onChange={setTakeaway} />
      <ul className="space-y-3">
        {cart.map((l) => (
          <li key={l.key} className="rounded-xl bg-slate-800/60 p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-medium">{l.product.name}</span>
              <button onClick={() => update(l.key, { qty: l.qty - 1 })} aria-label="Menos" className="size-9 rounded-full bg-slate-700 text-lg">
                −
              </button>
              <span className="w-6 text-center font-semibold">{l.qty}</span>
              <button onClick={() => update(l.key, { qty: Math.min(99, l.qty + 1) })} aria-label="Mais" className="size-9 rounded-full bg-slate-700 text-lg">
                +
              </button>
            </div>
            <input
              placeholder="Observação (ex.: sem cebola)"
              value={l.notes}
              maxLength={140}
              onChange={(e) => update(l.key, { notes: e.target.value })}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-base outline-none focus:border-amber-500 sm:text-sm"
            />
          </li>
        ))}
      </ul>
    </Modal>
  );
}
