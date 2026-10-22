import type { Role } from '@sistema-bar/shared';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { UpdateBanner } from './components/UpdateBanner';
import { ApiRequestError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { outbox } from './lib/offline/outbox';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AuditPage } from './pages/admin/AuditPage';
import { CategoriesPage } from './pages/admin/CategoriesPage';
import { FiscalPage } from './pages/admin/FiscalPage';
import { LicensePage } from './pages/admin/LicensePage';
import { ProductFiscalPage } from './pages/admin/ProductFiscalPage';
import { PrintersPage } from './pages/admin/PrintersPage';
import { PrintQueuePage } from './pages/admin/PrintQueuePage';
import { ProductsPage } from './pages/admin/ProductsPage';
import { RegistersPage } from './pages/admin/RegistersPage';
import { ReportsPage } from './pages/admin/ReportsPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { TableQrPage } from './pages/admin/TableQrPage';
import { TablesPage } from './pages/admin/TablesPage';
import { UsersPage } from './pages/admin/UsersPage';
import { CashierPage } from './pages/cashier/CashierPage';
import { HomePage } from './pages/Home';
import { KitchenPage } from './pages/kitchen/KitchenPage';
import { ComandaPage } from './pages/waiter/ComandaPage';
import { OrderPage } from './pages/waiter/OrderPage';
import { MyOrdersPage } from './pages/waiter/MyOrdersPage';
import { PendingPage } from './pages/waiter/PendingPage';
import { TableMapPage } from './pages/waiter/TableMapPage';
import { TablePage } from './pages/waiter/TablePage';
import { LoginPage } from './pages/Login';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Erros de permissão/validação não melhoram tentando de novo.
      retry: (count, err) => !(err instanceof ApiRequestError && err.status < 500) && count < 2,
    },
  },
});

const WAITER_ROLES: Role[] = ['GARCOM', 'GERENTE'];
const CASHIER_ROLES: Role[] = ['CAIXA', 'GERENTE'];
const KITCHEN_ROLES: Role[] = ['COZINHA', 'GERENTE'];

/** Liga a fila offline enquanto há alguém logado e atualiza as telas a cada envio confirmado. */
function OutboxRunner() {
  const { user } = useAuth();
  const qc = useQueryClient();
  useEffect(() => {
    if (!user) return;
    const offSynced = outbox.onSynced(() => {
      // refetchType 'all': recarrega também telas fechadas, para o cache offline não ficar velho.
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/waiter'), refetchType: 'all' });
    });
    const stop = outbox.start();
    return () => {
      offSynced();
      stop();
    };
  }, [user, qc]);
  return null;
}

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="flex min-h-dvh items-center justify-center text-slate-400">Carregando…</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  if (roles && user.role !== 'ADMIN' && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OutboxRunner />
        <UpdateBanner />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <HomePage />
                </RequireAuth>
              }
            />
            <Route
              path="/garcom"
              element={
                <RequireAuth roles={WAITER_ROLES}>
                  <TableMapPage />
                </RequireAuth>
              }
            />
            <Route
              path="/garcom/mesa/:tableId"
              element={
                <RequireAuth roles={WAITER_ROLES}>
                  <TablePage />
                </RequireAuth>
              }
            />
            <Route
              path="/garcom/mesa/:tableId/pedido"
              element={
                <RequireAuth roles={WAITER_ROLES}>
                  <OrderPage />
                </RequireAuth>
              }
            />
            <Route
              path="/garcom/comanda/:comandaId"
              element={
                <RequireAuth roles={WAITER_ROLES}>
                  <ComandaPage />
                </RequireAuth>
              }
            />
            <Route
              path="/garcom/meus-lancamentos"
              element={
                <RequireAuth roles={WAITER_ROLES}>
                  <MyOrdersPage />
                </RequireAuth>
              }
            />
            <Route
              path="/garcom/pendencias"
              element={
                <RequireAuth roles={WAITER_ROLES}>
                  <PendingPage />
                </RequireAuth>
              }
            />
            <Route
              path="/caixa"
              element={
                <RequireAuth roles={CASHIER_ROLES}>
                  <CashierPage />
                </RequireAuth>
              }
            />
            <Route
              path="/cozinha"
              element={
                <RequireAuth roles={KITCHEN_ROLES}>
                  <KitchenPage />
                </RequireAuth>
              }
            />
            <Route
              path="/caixa/impressao"
              element={
                <RequireAuth roles={CASHIER_ROLES}>
                  <div className="mx-auto max-w-5xl px-4 py-6">
                    <Link to="/caixa" className="mb-4 inline-block text-sm text-slate-400">‹ Voltar ao caixa</Link>
                    <PrintQueuePage />
                  </div>
                </RequireAuth>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireAuth roles={[]}>
                  <AdminLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="categorias" replace />} />
              <Route path="categorias" element={<CategoriesPage />} />
              <Route path="produtos" element={<ProductsPage />} />
              <Route path="mesas" element={<TablesPage />} />
              <Route path="mesas/qr" element={<TableQrPage />} />
              <Route path="impressoras" element={<PrintersPage />} />
              <Route path="fila-impressao" element={<PrintQueuePage />} />
              <Route path="usuarios" element={<UsersPage />} />
              <Route path="caixas" element={<RegistersPage />} />
              <Route path="relatorios" element={<ReportsPage />} />
              <Route path="auditoria" element={<AuditPage />} />
              <Route path="fiscal" element={<FiscalPage />} />
              <Route path="fiscal/produtos" element={<ProductFiscalPage />} />
              <Route path="configuracoes" element={<SettingsPage />} />
              <Route path="licenca" element={<LicensePage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
