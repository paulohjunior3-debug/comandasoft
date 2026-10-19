import { formatBRL, type TableMapEntry, type TableMapResponse } from '@sistema-bar/shared';
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

type Tone = 'free' | 'green' | 'yellow' | 'red' | 'closing';

const TONES: Record<Tone, { card: string; label: string }> = {
  free: { card: 'border-slate-800 bg-slate-900 text-slate-400', label: 'Livre' },
  green: { card: 'border-emerald-600 bg-emerald-950 text-emerald-50', label: 'Atendida' },
  yellow: { card: 'border-amber-500 bg-amber-950 text-amber-50', label: 'Atenção' },
  red: { card: 'border-red-500 bg-red-950 text-red-50', label: 'Sem atendimento' },
  closing: { card: 'border-sky-500 bg-sky-950 text-sky-50', label: 'Em fechamento' },
};

/** Cor da mesa pelo tempo sem atendimento (SPEC 5.3). */
function toneOf(t: TableMapEntry, minutes: number | null, map: TableMapResponse): Tone {
  if (t.status === 'LIVRE') return 'free';
  if (t.status === 'EM_FECHAMENTO') return 'closing';
  if (minutes === null || minutes < map.alertYellowMinutes) return 'green';
  return minutes < map.alertRedMinutes ? 'yellow' : 'red';
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
  const areas = [...new Set((data?.tables ?? []).map((t) => t.area ?? ''))];
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
            <p className="mb-3 text-sm text-slate-400">
              {occupied} de {data.tables.length} mesas ocupadas
            </p>
            {areas.map((area) => (
              <section key={area} className="mb-5">
                {areas.length > 1 && <h2 className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">{area || 'Sem área'}</h2>}
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                  {data.tables
                    .filter((t) => (t.area ?? '') === area)
                    .map((t) => {
                      const minutes = t.lastAttendedAt
                        ? Math.max(0, Math.floor((now + data.clockOffset - new Date(t.lastAttendedAt).getTime()) / 60_000))
                        : null;
                      const queued = queuedByTable.get(t.id) ?? 0;
                      // Comanda aberta offline: a mesa já conta como ocupada no aparelho.
                      const tone = TONES[t.status === 'LIVRE' && queued > 0 ? 'green' : toneOf(t, minutes, data)];
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
                            {t.comandaCount > 0 && (
                              <span className="rounded-full bg-black/30 px-1.5 py-0.5 text-xs font-semibold" title="Comandas">
                                👤{t.comandaCount}
                              </span>
                            )}
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
      {(['free', 'green', 'yellow', 'red', 'closing'] as Tone[]).map((t) => (
        <li key={t} className="flex items-center gap-1.5">
          <span className={`size-3 rounded-sm border-2 ${TONES[t].card}`} />
          {TONES[t].label}
        </li>
      ))}
    </ul>
  );
}
