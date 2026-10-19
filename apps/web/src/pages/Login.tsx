import { loginRequestSchema } from '@sistema-bar/shared';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { ApiRequestError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { user, login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = loginRequestSchema.safeParse({ login: form.get('login'), password: form.get('password') });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Dados inválidos.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await login(parsed.data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Sem conexão com o servidor.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5 rounded-2xl bg-slate-900 p-6 shadow-xl">
        <div className="text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-3 size-14" />
          <h1 className="text-2xl font-semibold">Sistema Bar</h1>
          <p className="text-sm text-slate-400">Entre com seu usuário</p>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm text-slate-300">Usuário</span>
          <input
            name="login"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-3 text-base outline-none focus:border-amber-500"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm text-slate-300">Senha</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-3 text-base outline-none focus:border-amber-500"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-amber-500 py-3 text-base font-semibold text-slate-950 active:bg-amber-600 disabled:opacity-60"
        >
          {submitting ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
