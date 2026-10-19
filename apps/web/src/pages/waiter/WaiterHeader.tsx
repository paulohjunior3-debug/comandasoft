import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useOnline } from '../../lib/useOnline';

/** Cabeçalho fixo do app do garçom, com voltar e indicador de conexão sempre visível (SPEC 5.3). */
export function WaiterHeader({ title, back, action }: { title: string; back?: string; action?: ReactNode }) {
  const online = useOnline();
  return (
    <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        {back && (
          <Link to={back} aria-label="Voltar" className="-ml-2 rounded-lg px-2 py-1 text-2xl leading-none text-slate-300 active:bg-slate-800">
            ‹
          </Link>
        )}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
        {action}
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${online ? 'bg-emerald-950 text-emerald-300' : 'bg-red-900 text-red-200'}`}
        >
          {online ? 'Online' : 'Offline'}
        </span>
      </div>
    </header>
  );
}
