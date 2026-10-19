import { ROLE_LABELS, type Role } from '@sistema-bar/shared';
import { useAuth } from '../lib/auth';
import { useOnline } from '../lib/useOnline';

const AREAS: { title: string; description: string; roles: Role[] }[] = [
  { title: 'Garçom', description: 'Mapa de mesas, comandas e pedidos', roles: ['GARCOM', 'GERENTE'] },
  { title: 'Caixa', description: 'Pagamentos, sangria e fechamento', roles: ['CAIXA', 'GERENTE'] },
  { title: 'Administração', description: 'Cardápio, mesas, impressoras e usuários', roles: [] },
];

export function HomePage() {
  const { user, logout } = useAuth();
  const online = useOnline();
  if (!user) return null;

  const areas = AREAS.filter((a) => user.role === 'ADMIN' || a.roles.includes(user.role));

  return (
    <main className="mx-auto min-h-dvh max-w-2xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-8">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <p className="text-lg font-semibold">Olá, {user.name}</p>
          <p className="text-sm text-slate-400">{ROLE_LABELS[user.role]}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${online ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'}`}
          >
            {online ? 'Online' : 'Offline'}
          </span>
          <button onClick={logout} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm">
            Sair
          </button>
        </div>
      </header>

      <ul className="grid gap-3 sm:grid-cols-2">
        {areas.map((area) => (
          <li key={area.title} className="rounded-xl bg-slate-900 p-4">
            <p className="font-semibold">{area.title}</p>
            <p className="text-sm text-slate-400">{area.description}</p>
            <p className="mt-2 text-xs text-amber-400">Disponível na fase 1</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
