import { formatBRL, tableTone, type TableMapEntry, type TableMapResponse } from '@sistema-bar/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ErrorBanner, Loading } from '../../components/ui';
import { cachedGet } from '../../lib/offline/cache';
import { useOutboxEntries } from '../../lib/offline/hooks';
import { useAuth } from '../../lib/auth';
import { formatElapsed } from '../../lib/format';
import { errorMessage } from '../../lib/queries';
import { WaiterHeader } from './WaiterHeader';

type Tone = 'free' | 'green' | 'yellow' | 'red';

const TONES: Record<Tone, { card: string; label: string }> = {
  free: { card: 'border-slate-800 bg-slate-900 text-slate-400', label: 'Livre' },
  green: { card: 'border-emerald-600 bg-emerald-950 text-emerald-50', label: 'Em atendimento' },
  yellow: { card: 'border-amber-500 bg-amber-950 text-amber-50', label: 'Sem atendimento' },
  red: { card: 'border-red-500 bg-red-900 text-red-50', label: 'Conta impressa' },
};

/** Cor da mesa: vermelho = conta impressa; amarelo = sem atendimento há N min; verde = em atendimento. */
function toneOf(t: TableMapEntry, nowMs: number, map: TableMapResponse): Tone {
  if (t.status === 'LIVRE') return 'free';
  return ({ verde: 'green', amarelo: 'yellow', vermelho: 'red' } as const)[tableTone(t, nowMs, map.alertYellowMinutes)];
}

type MapView = 'TODAS' | 'ABERTAS' | 'MINHAS';
const VIEWS: [MapView, string][] = [
  ['TODAS', 'Todas'],
  ['ABERTAS', 'Abertas'],
  ['MINHAS', 'Minhas mesas'],
];
const VIEW_KEY = 'garcom.mapa.filtro';
function readView(): MapView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'ABERTAS' || v === 'MINHAS' ? v : 'TODAS';
  } catch {
    return 'TODAS';
  }
}

export function TableMapPage() {
  const { logout } = useAuth();
  const [now, setNow] = useState(Date.now());
  const map = useQuery({
    queryKey: ['/waiter/tables'],
    queryFn: async () => {
      const data = await cachedGet<TableMapResponse>('/waiter/tables');
      // Corrige diferença de relógio entre o celular e o servidor.
      return { ...data, clockOffset: new Date(data.serverTime).getTime() - Date.now() };
    },
    refetchInterval: 10_000,
    retry: false,
  });
  const queuedByTable = new Map<string, number>();
  for (const e of useOutboxEntries()) queuedByTable.set(e.tableId, (queuedByTable.get(e.tableId) ?? 0) + 1);

  // Deixa o cardápio guardado no aparelho desde já, para lançar pedidos mesmo se a rede cair depois.
  const qc = useQueryClient();
  useEffect(() => {
    void qc.prefetchQuery({ queryKey: ['/waiter/menu'], queryFn: () => cachedGet('/waiter/menu') });
  }, [qc]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const data = map.data;
  const [view, setView] = useState<MapView>(readView);
  const chooseView = (v: MapView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* sem armazenamento: vale só agora */
    }
  };
  // Comanda aberta offline: a mesa já conta como aberta (e minha) no aparelho.
  const shown = (data?.tables ?? []).filter((t) => {
    const queued = (queuedByTable.get(t.id) ?? 0) > 0;
    if (view === 'ABERTAS') return t.status !== 'LIVRE' || queued;
    if (view === 'MINHAS') return t.mine || queued;
    return true;
  });
  const areas = [...new Set(shown.map((t) => t.area ?? ''))];
  const occupied = data?.tables.filter((t) => t.status !== 'LIVRE').length ?? 0;

  return (
    <div className="min-h-dvh pb-8">
      <WaiterHeader
        title="Mesas"
        back="/"
        action={
          <button onClick={logout} className="rounded-lg px-2 py-1 text-xs text-slate-400 active:bg-slate-800">
            Sair
          </button>
        }
      />
      <main className="mx-auto max-w-3xl px-4 pt-4">
        <ErrorBanner message={map.isError && !data ? errorMessage(map.error) : null} />
        {!data ? (
          map.isLoading && <Loading />
        ) : data.tables.length === 0 ? (
          <p className="py-10 text-center text-slate-400">Nenhuma mesa cadastrada. Peça ao administrador para cadastrar.</p>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm text-slate-400">
                {occupied} de {data.tables.length} mesas ocupadas
              </p>
              <Link to="/garcom/meus-lancamentos" className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 active:bg-slate-800">
                📝 Meus lançamentos
              </Link>
            </div>
            <div className="mb-3 flex gap-1 rounded-lg bg-slate-900 p-1 text-sm" role="tablist" aria-label="Quais mesas mostrar">
              {VIEWS.map(([v, label]) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => chooseView(v)}
                  className={`flex-1 rounded-md py-2 ${view === v ? 'bg-slate-700 font-semibold text-white' : 'text-slate-400'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {shown.length === 0 && (
              <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
                {view === 'MINHAS' ? 'Nenhuma mesa sua neste turno ainda (abra comanda, lance pedido ou toque em "Atendi a mesa").' : 'Nenhuma mesa aberta.'}
              </p>
            )}
            {areas.map((area) => (
              <section key={area} className="mb-5">
                {areas.length > 1 && <h2 className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">{area || 'Sem área'}</h2>}
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                  {shown
                    .filter((t) => (t.area ?? '') === area)
                    .map((t) => {
                      const minutes = t.lastAttendedAt
                        ? Math.max(0, Math.floor((now + data.clockOffset - new Date(t.lastAttendedAt).getTime()) / 60_000))
                        : null;
                      const queued = queuedByTable.get(t.id) ?? 0;
                      // Comanda aberta offline: a mesa já conta como ocupada no aparelho.
                      const tone = TONES[t.status === 'LIVRE' && queued > 0 ? 'green' : toneOf(t, now + data.clockOffset, data)];
                      return (
                        <Link
                          key={t.id}
                          to={`/garcom/mesa/${t.id}`}
                          aria-label={`Mesa ${t.number}, ${tone.label}`}
                          className={`flex aspect-square flex-col justify-between rounded-2xl border-2 p-2.5 active:scale-95 ${tone.card}`}
                        >
                          <div className="flex items-start justify-between">
                            <span className="text-3xl leading-none font-bold">{t.number}</span>
                            {queued > 0 && (
                              <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-bold text-slate-950" title="Aguardando envio">
                                ⏳{queued}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              {t.partialPaid && (
                                <span className="text-base leading-none" title="Pago parcial">
                                  ⭐
                                </span>
                              )}
                              {t.status === 'EM_FECHAMENTO' && (
                                <span className="text-base leading-none" title="Pediu a conta">
                                  🧾
                                </span>
                              )}
                              {t.comandaCount > 0 && (
                                <span className="rounded-full bg-black/30 px-1.5 py-0.5 text-xs font-semibold" title="Comandas">
                                  👤{t.comandaCount}
                                </span>
                              )}
                            </span>
                          </div>
                          {t.status !== 'LIVRE' && (
                            <div className="text-left">
                              <p className="text-xs font-medium opacity-90">{formatBRL(t.totalCents)}</p>
                              <p className="text-xs opacity-75">{minutes === null ? '' : formatElapsed(minutes)}</p>
                            </div>
                          )}
                        </Link>
                      );
                    })}
                </div>
              </section>
            ))}
            <Legend />
          </>
        )}
      </main>
    </div>
  );
}

function Legend() {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
      {(['free', 'green', 'yellow', 'red'] as Tone[]).map((t) => (
        <li key={t} className="flex items-center gap-1.5">
          <span className={`size-3 rounded-sm border-2 ${TONES[t].card}`} />
          {TONES[t].label}
        </li>
      ))}
      <li>⭐ Pago parcial</li>
      <li>🧾 Pediu a conta</li>
    </ul>
  );
}
