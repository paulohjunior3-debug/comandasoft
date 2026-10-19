import type { Role } from '@sistema-bar/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiRequestError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { AdminLayout } from './pages/admin/AdminLayout';
import { CategoriesPage } from './pages/admin/CategoriesPage';
import { PrintersPage } from './pages/admin/PrintersPage';
import { ProductsPage } from './pages/admin/ProductsPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { TablesPage } from './pages/admin/TablesPage';
import { UsersPage } from './pages/admin/UsersPage';
import { HomePage } from './pages/Home';
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
              <Route path="impressoras" element={<PrintersPage />} />
              <Route path="usuarios" element={<UsersPage />} />
              <Route path="configuracoes" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
