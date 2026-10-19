import { NavLink, Outlet, Link } from 'react-router';
import { useAuth } from '../../lib/auth';

export const ADMIN_SECTIONS = [
  { to: '/admin/relatorios', label: 'Relatórios' },
  { to: '/admin/categorias', label: 'Categorias' },
  { to: '/admin/produtos', label: 'Produtos' },
  { to: '/admin/mesas', label: 'Mesas' },
  { to: '/admin/impressoras', label: 'Impressoras' },
  { to: '/admin/fila-impressao', label: 'Fila de impressão' },
  { to: '/admin/usuarios', label: 'Usuários' },
  { to: '/admin/caixas', label: 'Caixas' },
  { to: '/admin/configuracoes', label: 'Configurações' },
] as const;

export function AdminLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="print:hidden border-b border-slate-800 bg-slate-900/60 lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 lg:block lg:pt-5">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="size-7" />
            Administração
          </Link>
          <div className="flex items-center gap-2 lg:mt-3 lg:justify-between">
            <span className="hidden text-xs text-slate-400 sm:inline">{user?.name}</span>
            <button onClick={logout} className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800">
              Sair
            </button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:px-3">
          {ADMIN_SECTIONS.map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              className={({ isActive }) =>
                `shrink-0 rounded-lg px-3 py-2 text-sm whitespace-nowrap ${isActive ? 'bg-amber-500 font-medium text-slate-950' : 'text-slate-300 hover:bg-slate-800'}`
              }
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-5xl min-w-0 px-4 py-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
