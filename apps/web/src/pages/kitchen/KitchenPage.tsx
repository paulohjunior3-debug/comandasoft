import { kitchenTone, KITCHEN_LATE_MINUTES, KITCHEN_NEW_MINUTES, type KitchenPanelResponse, type KitchenTicket } from '@sistema-bar/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/queries';

const PRINTER_KEY = 'cozinha.impressora';

function readPrinter(): string {
  try {
    return localStorage.getItem(PRINTER_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Painel da cozinha (KDS). Cada cartão é um pedido que ainda não foi feito; setas escolhem,
 * Enter marca pronto e o cupom sai na impressora da cozinha. Feito para um PC com teclado.
 */
export function KitchenPage() {
  const { logout } = useAuth();
  const qc = useQueryClient();
  const [printerId, setPrinterId] = useState(readPrinter);
  const path = `/kitchen${printerId ? `?printerId=${printerId}` : ''}`;
  const panel = useQuery({
    queryKey: [path],
    queryFn: () => api<KitchenPanelResponse>(path),
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  });

  // Pedidos já marcados nesta tela: somem na hora, sem esperar a próxima consulta.
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const tickets = (panel.data?.tickets ?? []).filter((t) => !done.has(t.id));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = Math.max(0, tickets.findIndex((t) => t.id === selectedId));
  const selected = tickets[selectedIndex] ?? null;
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Relógio pela hora do servidor (o PC da cozinha pode estar com o relógio errado).
  const offset = useRef(0);
  useEffect(() => {
    if (panel.data) offset.current = Date.parse(panel.data.now) - Date.now();
  }, [panel.data]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const serverNow = now + offset.current;
  const minutesOf = (t: KitchenTicket) => Math.max(0, Math.floor((serverNow - Date.parse(t.createdAt)) / 60_000));

  // Som quando chega pedido novo (o navegador só libera o som depois de um clique ou tecla).
  const audio = useRef<AudioContext | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const unlockSound = useCallback(() => {
    if (audio.current) return;
    try {
      audio.current = new AudioContext();
      setSoundOn(true);
    } catch {
      /* sem som neste navegador */
    }
  }, []);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!panel.data) return;
    const ids = panel.data.tickets.map((t) => t.id);
    if (seen.current && ids.some((id) => !seen.current!.has(id))) beep(audio.current);
    seen.current = new Set(ids);
  }, [panel.data]);

  // Tela sempre acesa enquanto o painel está aberto.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = () =>
      (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
        ?.request('screen')
        .then((l) => (lock = l))
        .catch(() => {});
    void request();
    const onVisible = () => document.visibilityState === 'visible' && void request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);

  const ready = useCallback(
    async (t: KitchenTicket) => {
      const index = tickets.findIndex((x) => x.id === t.id);
      setDone((d) => new Set(d).add(t.id));
      // Fica no mesmo lugar da tela: o próximo cartão ocupa a posição do que saiu.
      const next = tickets.filter((x) => x.id !== t.id)[Math.min(index, tickets.length - 2)];
      setSelectedId(next?.id ?? null);
      setToast(`${placeOf(t)} pronto · imprimindo o cupom`);
      setError(null);
      try {
        await api(`/kitchen/tickets/${t.id}/ready`, { method: 'POST', body: '{}' });
      } catch (err) {
        setDone((d) => {
          const copy = new Set(d);
          copy.delete(t.id);
          return copy;
        });
        setToast(null);
        setError(`Não deu para marcar ${placeOf(t)}: ${errorMessage(err)}`);
      } finally {
        void qc.invalidateQueries({ queryKey: [path] });
      }
    },
    [tickets, qc, path],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3_000);
    return () => clearTimeout(t);
  }, [toast]);

  // Navegação pelas setas: esquerda/direita andam um cartão, cima/baixo uma linha da grade.
  const grid = useRef<HTMLDivElement>(null);
  const lastEnter = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      unlockSound();
      if (e.target instanceof HTMLSelectElement) return;
      const cols = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length : 1;
      const move: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
      if (e.key in move) {
        e.preventDefault();
        if (!tickets.length) return;
        const to = Math.min(tickets.length - 1, Math.max(0, selectedIndex + move[e.key]!));
        setSelectedId(tickets[to]!.id);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        if (tickets.length) setSelectedId(tickets[e.key === 'Home' ? 0 : tickets.length - 1]!.id);
      } else if (e.key === 'Enter' || e.key === 'NumpadEnter') {
        e.preventDefault();
        // Tecla segurada ou dois toques seguidos não marcam dois pedidos.
        if (e.repeat || Date.now() - lastEnter.current < 600 || !selected) return;
        lastEnter.current = Date.now();
        void ready(selected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tickets, selectedIndex, selected, ready, unlockSound]);

  useLayoutEffect(() => {
    if (selected) document.getElementById(`pedido-${selected.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choosePrinter = (id: string) => {
    setPrinterId(id);
    try {
      localStorage.setItem(PRINTER_KEY, id);
    } catch {
      /* sem armazenamento: vale só nesta sessão */
    }
  };

  const late = tickets.filter((t) => kitchenTone(minutesOf(t)) === 'atrasado').length;

  return (
    <div className="flex min-h-dvh flex-col bg-black text-white" onClick={unlockSound}>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-5 py-3">
        <h1 className="text-2xl font-bold">Cozinha</h1>
        <p className="text-xl">
          <span className="font-bold tabular-nums">{tickets.length}</span> pedido(s)
          {late > 0 && <span className="ml-3 rounded bg-red-600 px-2 py-0.5 font-bold">{late} atrasado(s)</span>}
        </p>
        {(panel.data?.printers.length ?? 0) > 1 && (
          <select
            value={printerId}
            onChange={(e) => choosePrinter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-base"
            aria-label="Setor"
          >
            <option value="">Todos os setores</option>
            {panel.data!.printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm text-slate-400">
          <span className="hidden lg:inline">← ↑ → ↓ escolher · <b className="text-white">Enter</b> = pronto (imprime o cupom)</span>
          {!soundOn && <span className="text-amber-400">Aperte uma tecla para ligar o som</span>}
          <span className="text-2xl font-semibold tabular-nums text-white">{clock(serverNow)}</span>
          <button
            onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}
            className="rounded border border-slate-700 px-2 py-1"
          >
            Tela cheia
          </button>
          <button onClick={logout} className="rounded border border-slate-700 px-2 py-1">
            Sair
          </button>
        </div>
      </header>

      {(error || panel.error) && (
        <p role="alert" className="bg-red-700 px-5 py-2 text-lg font-semibold">
          {error ?? `Sem conexão com o sistema: ${errorMessage(panel.error)}`}
        </p>
      )}

      <main className="flex-1 overflow-y-auto p-4">
        {panel.isLoading ? (
          <p className="mt-20 text-center text-2xl text-slate-500">Carregando…</p>
        ) : tickets.length === 0 ? (
          <div className="mt-24 text-center text-slate-500">
            <p className="text-4xl">Nenhum pedido na fila</p>
            <p className="mt-3 text-lg">Os pedidos da cozinha aparecem aqui assim que o garçom lança.</p>
          </div>
        ) : (
          <div ref={grid} className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] items-start gap-4">
            {tickets.map((t) => (
              <TicketCard
                key={t.id}
                ticket={t}
                minutes={minutesOf(t)}
                selected={t.id === selected?.id}
                onSelect={() => setSelectedId(t.id)}
                onReady={() => void ready(t)}
              />
            ))}
          </div>
        )}
      </main>

      <footer className="flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-800 px-5 py-2 text-sm text-slate-400">
        <span><span className="mr-1.5 inline-block size-3 rounded-sm bg-emerald-600" />Novo (até {KITCHEN_NEW_MINUTES} min)</span>
        <span><span className="mr-1.5 inline-block size-3 rounded-sm bg-slate-600" />Em preparo</span>
        <span><span className="mr-1.5 inline-block size-3 rounded-sm bg-red-600" />{KITCHEN_LATE_MINUTES} min ou mais</span>
        <span><span className="mr-1.5 inline-block size-3 rounded-sm bg-orange-500" />Para viagem</span>
      </footer>

      {toast && (
        <p role="status" className="fixed bottom-14 left-1/2 -translate-x-1/2 rounded-xl bg-emerald-600 px-6 py-3 text-xl font-bold shadow-2xl">
          ✓ {toast}
        </p>
      )}
    </div>
  );
}

const TONE_HEADER = {
  novo: 'bg-emerald-600',
  normal: 'bg-slate-700',
  atrasado: 'bg-red-600',
} as const;

function TicketCard({
  ticket: t,
  minutes,
  selected,
  onSelect,
  onReady,
}: {
  ticket: KitchenTicket;
  minutes: number;
  selected: boolean;
  onSelect: () => void;
  onReady: () => void;
}) {
  const tone = kitchenTone(minutes);
  return (
    <article
      id={`pedido-${t.id}`}
      onClick={onSelect}
      onDoubleClick={onReady}
      aria-selected={selected}
      className={`cursor-pointer overflow-hidden rounded-xl bg-slate-900 transition-transform ${
        t.takeaway ? 'border-4 border-orange-500' : 'border-4 border-transparent'
      } ${selected ? 'scale-[1.02] outline-4 outline-offset-2 outline-white' : ''}`}
    >
      <div className={`flex items-baseline justify-between gap-2 px-4 py-2 ${TONE_HEADER[tone]} ${tone === 'atrasado' && minutes >= 50 ? 'animate-pulse' : ''}`}>
        <span className="text-3xl font-black">{placeOf(t)}</span>
        <span className="text-3xl font-black tabular-nums">{minutes} min</span>
      </div>
      {t.takeaway && <p className="bg-orange-500 px-4 py-1 text-center text-lg font-black tracking-wide text-black">PARA VIAGEM</p>}
      <ul className="space-y-2 px-4 py-3">
        {t.items.map((item, i) => (
          <li key={i}>
            <p className="text-2xl leading-tight font-bold">
              <span className="text-amber-300">{item.qty}×</span> {item.name}
            </p>
            {item.notes && <p className="mt-0.5 text-xl font-bold text-yellow-300 uppercase">» {item.notes}</p>}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-4 py-2 text-sm text-slate-400">
        <span className="truncate">
          {t.customers.join(', ')} · {t.waiter} · {time(t.createdAt)}
        </span>
        {selected ? (
          <button onClick={onReady} className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1 font-bold text-white">
            Pronto ↵
          </button>
        ) : (
          <span className="shrink-0">#{t.orderRef}</span>
        )}
      </div>
    </article>
  );
}

const placeOf = (t: Pick<KitchenTicket, 'tableNumber' | 'tableLabel'>) => (t.tableLabel ? t.tableLabel.toUpperCase() : `MESA ${t.tableNumber}`);

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const time = (iso: string) => clock(Date.parse(iso));

/** Dois bipes curtos. */
function beep(ctx: AudioContext | null) {
  if (!ctx) return;
  try {
    for (const start of [0, 0.25]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.2);
    }
  } catch {
    /* sem som */
  }
}
