import {
  formatBRL,
  PAYMENT_METHOD_LABELS,
  type PublicComandaOption,
  type PublicComandaView,
  type PublicTableInfo,
  type QrUnlockResult,
} from '@sistema-bar/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Menu } from './Menu';

// ---------- Comunicação ----------

type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

async function call<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    const res = await fetch(`/api/public${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const body = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: body as T };
    return { ok: false, status: res.status, code: body?.error ?? 'ERROR', message: body?.message ?? 'Não foi possível carregar.' };
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', message: 'Sem conexão. Confira se está no Wi-Fi do estabelecimento.' };
  }
}

// Comanda liberada neste aparelho (só nesta aba): conveniência, nada que precise durar.
interface Unlocked {
  comandaId: string;
  token: string;
  expiresAt: number;
}
const storageKey = (qrToken: string) => `sb_qr_${qrToken}`;
function loadUnlocked(qrToken: string): Unlocked | null {
  try {
    const raw = sessionStorage.getItem(storageKey(qrToken));
    const u = raw ? (JSON.parse(raw) as Unlocked) : null;
    return u && u.expiresAt > Date.now() ? u : null;
  } catch {
    return null;
  }
}
function saveUnlocked(qrToken: string, u: Unlocked | null) {
  try {
    if (u) sessionStorage.setItem(storageKey(qrToken), JSON.stringify(u));
    else sessionStorage.removeItem(storageKey(qrToken));
  } catch {
    /* sem armazenamento: pede o PIN de novo se recarregar */
  }
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

// ---------- App ----------

/** Página do QR da mesa (SPEC 5.6): cardápio e, com o PIN, a própria comanda. Somente leitura. */
export function ClientApp({ qrToken }: { qrToken: string }) {
  const [info, setInfo] = useState<Result<PublicTableInfo> | null>(null);
  const [tab, setTab] = useState<'cardapio' | 'comanda'>(() => (loadUnlocked(qrToken) ? 'comanda' : 'cardapio'));

  useEffect(() => {
    if (!qrToken) {
      setInfo({ ok: false, status: 404, code: 'NOT_FOUND', message: 'Aponte a câmera para o QR Code da mesa.' });
      return;
    }
    void call<PublicTableInfo>(`/m/${encodeURIComponent(qrToken)}`).then(setInfo);
  }, [qrToken]);

  useEffect(() => {
    if (info?.ok) document.title = `${info.data.companyName || 'Cardápio'} · Mesa ${info.data.tableNumber}`;
  }, [info]);

  if (!info) return <Centered>Carregando…</Centered>;
  if (!info.ok)
    return (
      <Centered>
        <p className="text-lg font-medium">{info.message}</p>
        {info.status === 0 && (
          <button onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-amber-500 px-4 py-2 font-medium text-slate-950">
            Tentar de novo
          </button>
        )}
      </Centered>
    );
  const t = info.data;

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col">
      {/* Abertura: nome do bar e a mesa */}
      <header className="relative overflow-hidden px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-5">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-amber-500/25 via-slate-950 to-slate-950" />
        <div className="relative flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-[0.2em] text-amber-300/80 uppercase">Bem-vindo</p>
            <h1 className="truncate text-2xl font-bold">{t.companyName || 'Cardápio'}</h1>
          </div>
          <span className="shrink-0 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-center leading-tight">
            <span className="block text-[10px] tracking-wider text-amber-300 uppercase">Mesa</span>
            <span className="block text-xl font-bold text-amber-200">{t.tableNumber}</span>
          </span>
        </div>
      </header>

      {/* Abas fixas ao rolar; altura fixa (h-14) para as categorias do cardápio encostarem logo abaixo */}
      <nav className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-slate-800/80 bg-slate-950/95 px-4 backdrop-blur">
        {(
          [
            ['cardapio', 'Cardápio'],
            ['comanda', 'Minha comanda'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 rounded-full py-2 text-sm font-semibold transition-colors ${tab === key ? 'bg-amber-500 text-slate-950' : 'text-slate-300'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="flex-1 pb-6">
        {tab === 'cardapio' ? (
          <Menu info={t} />
        ) : (
          <div className="px-4 py-4">
            <MyComanda qrToken={qrToken} />
          </div>
        )}
      </main>

      <footer className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-xs text-slate-500">
        Consulta somente leitura. Pedidos e pagamentos são feitos com o garçom.
        <br />
        Seu telefone é usado só para identificar sua comanda.
      </footer>
    </div>
  );
}

// ---------- Minha comanda ----------

function MyComanda({ qrToken }: { qrToken: string }) {
  const [unlocked, setUnlocked] = useState<Unlocked | null>(() => loadUnlocked(qrToken));
  const [notice, setNotice] = useState<string | null>(null);
  const forget = useCallback(
    (message: string | null) => {
      saveUnlocked(qrToken, null);
      setUnlocked(null);
      setNotice(message);
    },
    [qrToken],
  );

  if (unlocked) return <ComandaView qrToken={qrToken} unlocked={unlocked} onExit={forget} />;
  return (
    <ChooseComanda
      qrToken={qrToken}
      notice={notice}
      onUnlocked={(u) => {
        saveUnlocked(qrToken, u);
        setNotice(null);
        setUnlocked(u);
      }}
    />
  );
}

function ChooseComanda({ qrToken, notice, onUnlocked }: { qrToken: string; notice: string | null; onUnlocked: (u: Unlocked) => void }) {
  const [list, setList] = useState<Result<PublicComandaOption[]> | null>(null);
  const [chosen, setChosen] = useState<PublicComandaOption | null>(null);
  // PIN: 4 últimos do telefone (comandas antigas, sem telefone: 3 últimos do CPF).
  const digits = chosen?.pinDigits ?? 4;
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    setList(null);
    void call<PublicComandaOption[]>(`/m/${encodeURIComponent(qrToken)}/comandas`).then(setList);
  }, [qrToken]);
  useEffect(load, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    if (pin.length !== digits) return setError(digits === 4 ? 'Digite os 4 últimos números do seu telefone.' : 'Digite os 3 últimos números do CPF.');
    setSending(true);
    const r = await call<QrUnlockResult>(`/m/${encodeURIComponent(qrToken)}/comandas/${chosen.id}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    setSending(false);
    setPin('');
    if (r.ok) return onUnlocked({ comandaId: chosen.id, token: r.data.token, expiresAt: Date.now() + r.data.expiresInSeconds * 1000 });
    setError(r.message);
    if (r.code === 'QR_LOCKED') setChosen({ ...chosen, locked: true });
  };

  if (chosen) {
    return (
      <form onSubmit={submit} className="space-y-4">
        <button type="button" onClick={() => (setChosen(null), setError(null))} className="text-sm text-slate-400">
          ‹ Voltar
        </button>
        <div className="rounded-xl bg-slate-900 p-4">
          <p className="text-sm text-slate-400">Comanda de</p>
          <p className="text-xl font-semibold">{chosen.maskedName}</p>
        </div>
        {chosen.locked ? (
          <Alert>Consulta bloqueada por tentativas erradas. Peça ao garçom para liberar esta comanda.</Alert>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">{digits === 4 ? '4 últimos números do seu telefone' : '3 últimos números do seu CPF'}</span>
              <input
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                maxLength={digits}
                placeholder={'•'.repeat(digits)}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, digits))}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-center text-3xl tracking-[0.5em] outline-none focus:border-amber-500"
              />
            </label>
            {error && <Alert>{error}</Alert>}
            <button
              type="submit"
              disabled={sending || pin.length !== digits}
              className="w-full rounded-lg bg-amber-500 py-3 text-base font-semibold text-slate-950 disabled:opacity-50"
            >
              {sending ? 'Conferindo…' : 'Ver minha comanda'}
            </button>
          </>
        )}
      </form>
    );
  }

  return (
    <div className="space-y-3">
      {notice && <Alert>{notice}</Alert>}
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Qual é a sua comanda?</h2>
        <button onClick={load} className="text-sm text-amber-400">
          Atualizar
        </button>
      </div>
      {!list ? (
        <p className="py-6 text-center text-slate-400">Carregando…</p>
      ) : !list.ok ? (
        <Alert>{list.message}</Alert>
      ) : list.data.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
          Nenhuma comanda aberta nesta mesa ainda. Peça ao garçom para abrir a sua.
        </p>
      ) : (
        <ul className="space-y-2">
          {list.data.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => (setChosen(c), setError(null))}
                className="flex w-full items-center justify-between rounded-xl bg-slate-900 px-4 py-4 text-left text-lg font-medium active:bg-slate-800"
              >
                {c.maskedName}
                <span className="text-sm font-normal text-slate-500">{c.locked ? 'bloqueada' : '›'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">Os nomes aparecem incompletos para proteger os clientes. Para ver os valores, confirme com o final do seu telefone.</p>
    </div>
  );
}

function ComandaView({ qrToken, unlocked, onExit }: { qrToken: string; unlocked: Unlocked; onExit: (message: string | null) => void }) {
  const [view, setView] = useState<PublicComandaView | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await call<PublicComandaView>(`/m/${encodeURIComponent(qrToken)}/comandas/${unlocked.comandaId}`, {
        headers: { authorization: `Bearer ${unlocked.token}` },
      });
      if (!alive) return;
      if (r.ok) {
        setView(r.data);
        setOffline(false);
      } else if (r.status === 0) setOffline(true);
      else onExit(r.message);
    };
    void load();
    // A comanda muda enquanto o garçom lança: atualiza sozinha.
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [qrToken, unlocked, onExit]);

  if (!view) return <p className="py-10 text-center text-slate-400">Carregando sua comanda…</p>;
  const t = view.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xl font-semibold">{view.customerName}</p>
          <p className="text-sm text-slate-400">
            Aberta às {time(view.openedAt)}
            {view.peopleCount > 1 && ` · ${view.peopleCount} pessoas`}
          </p>
        </div>
        <button onClick={() => onExit(null)} className="shrink-0 text-sm text-slate-400">
          Sair
        </button>
      </div>
      {view.status === 'EM_FECHAMENTO' && <Alert tone="info">Conta pedida. Aguarde o garçom ou vá ao caixa.</Alert>}

      <section className="rounded-xl bg-slate-900">
        {view.items.length === 0 ? (
          <p className="p-4 text-center text-slate-400">Nenhum item lançado ainda.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {view.items.map((i, n) => (
              <li key={n} className="flex items-start justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block">
                    {i.qty}× {i.name}
                  </span>
                  <span className="text-xs text-slate-500">
                    {time(i.at)}
                    {i.sharedWith > 1 && ` · dividido entre ${i.sharedWith}`}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatBRL(i.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <dl className="space-y-1 rounded-xl bg-slate-900 px-4 py-3 text-sm">
        <Line label="Itens" value={t.itemsCents} />
        {t.serviceFeeCents > 0 && <Line label="Taxa de serviço (10%)" value={t.serviceFeeCents} />}
        {t.couvertCents > 0 && <Line label={`Couvert${view.peopleCount > 1 ? ` (${view.peopleCount} pessoas)` : ''}`} value={t.couvertCents} />}
        {t.discountCents > 0 && <Line label="Desconto" value={-t.discountCents} />}
        <Line label="Total" value={t.totalCents} strong />
        {view.payments.map((p, n) => (
          <Line key={n} label={`Pago por ${p.payerName} (${PAYMENT_METHOD_LABELS[p.method]})`} value={-p.amountCents} />
        ))}
      </dl>

      <div className="flex items-center justify-between rounded-xl bg-amber-500 px-4 py-4 text-slate-950">
        <span className="font-medium">{t.paidCents > 0 ? 'Falta pagar' : 'Total a pagar'}</span>
        <span className="text-2xl font-bold tabular-nums">{formatBRL(t.remainingCents)}</span>
      </div>
      <p className="text-center text-xs text-slate-500">
        {offline ? 'Sem conexão: mostrando a última atualização.' : `Atualizado às ${time(view.updatedAt)} · atualiza sozinho`}
      </p>
    </div>
  );
}

// ---------- Peças ----------

function Line({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? 'border-t border-slate-800 pt-1 text-base font-semibold' : 'text-slate-300'}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value < 0 ? `− ${formatBRL(-value)}` : formatBRL(value)}</dd>
    </div>
  );
}

function Alert({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'info' }) {
  return (
    <p className={`rounded-lg p-3 text-sm ${tone === 'info' ? 'bg-sky-950 text-sky-200' : 'bg-red-950 text-red-200'}`} role="alert">
      {children}
    </p>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center text-slate-300">{children}</div>;
}
