import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useConnectionStatus } from '../../lib/offline/hooks';

/**
 * Cabeçalho fixo do app do garçom. O indicador de conexão fica sempre visível, com o número
 * de envios pendentes bem destacado (no iPhone só envia com o app aberto) — SPEC 5.3/5.4.
 */
export function WaiterHeader({ title, back, action }: { title: string; back?: string; action?: ReactNode }) {
  const { online, pending, conflicts } = useConnectionStatus();

  const status = online
    ? pending > 0
      ? { text: `Enviando ${pending}…`, cls: 'bg-amber-900 text-amber-100' }
      : { text: 'Online', cls: 'bg-emerald-950 text-emerald-300' }
    : { text: pending > 0 ? `Offline · ${pending} pendente${pending > 1 ? 's' : ''}` : 'Offline', cls: 'bg-red-900 text-red-100' };

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        {back && (
          <Link to={back} aria-label="Voltar" className="-ml-2 rounded-lg px-2 py-1 text-2xl leading-none text-slate-300 active:bg-slate-800">
            ‹
          </Link>
        )}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
        {action}
        {conflicts > 0 && (
          <Link to="/garcom/pendencias" className="shrink-0 rounded-full bg-red-600 px-2.5 py-1 text-xs font-bold text-white">
            ⚠ {conflicts}
          </Link>
        )}
        <Link
          to="/garcom/pendencias"
          role="status"
          aria-live="polite"
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.cls}`}
        >
          {status.text}
        </Link>
      </div>
    </header>
  );
}
