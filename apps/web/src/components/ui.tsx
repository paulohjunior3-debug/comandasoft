import { createPortal } from 'react-dom';
import { useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

// Componentes básicos do painel. Tema escuro, alvos de toque grandes (uso também no celular).

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-amber-500 text-slate-950 hover:bg-amber-400 active:bg-amber-600',
  secondary: 'border border-slate-700 bg-slate-800 hover:bg-slate-700',
  danger: 'border border-red-900 bg-red-950 text-red-300 hover:bg-red-900',
  ghost: 'text-slate-300 hover:bg-slate-800',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-base outline-none focus:border-amber-500 disabled:opacity-60 sm:text-sm';

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm text-slate-300">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function TextField({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return <Field label={label} hint={hint}>{(id) => <input id={id} {...props} className={inputClass} />}</Field>;
}

export function SelectField({
  label,
  hint,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} {...props} className={inputClass}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-amber-500' : 'bg-slate-700'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`}
        />
      </button>
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

/** Lista de opções marcáveis (ex.: categorias de uma impressora). */
export function CheckList<T extends { id: string; label: string; detail?: string }>({
  label,
  items,
  selected,
  onChange,
  empty,
}: {
  label: string;
  items: T[];
  selected: string[];
  onChange: (ids: string[]) => void;
  empty: string;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <fieldset>
      <legend className="mb-1 text-sm text-slate-300">{label}</legend>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-700 p-3 text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-700 p-2">
          {items.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-800">
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={() => toggle(item.id)}
                className="size-4 accent-amber-500"
              />
              <span className="text-sm">{item.label}</span>
              {item.detail && <span className="ml-auto text-xs text-slate-500">{item.detail}</span>}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Janela larga (ex.: escolher produtos no caixa). */
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portal no <body>: um ancestral com backdrop-filter/transform (ex.: cabeçalho com blur)
  // faria o "fixed" se posicionar em relação a ele, e não à tela.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[92dvh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} flex-col rounded-t-2xl bg-slate-900 shadow-2xl sm:rounded-2xl`}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-800">
            ✕
          </button>
        </header>
        <div className="space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="text-sm text-slate-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300">
      {message}
    </p>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-slate-800 text-slate-300',
    ok: 'bg-emerald-950 text-emerald-300',
    warn: 'bg-amber-950 text-amber-300',
    bad: 'bg-red-950 text-red-300',
  };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-slate-400">{children}</div>;
}

export function Loading() {
  return <p className="py-8 text-center text-slate-500">Carregando…</p>;
}

/** Botão grande "Para viagem" do lançamento de pedido: laranja quando marcado (igual ao painel da cozinha). */
export function TakeawayButton({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-center gap-2 rounded-xl border-2 px-4 py-3 text-base font-semibold transition-colors ${
        checked ? 'border-orange-500 bg-orange-500 text-slate-950' : 'border-slate-700 bg-slate-900 text-slate-300'
      }`}
    >
      🥡 {checked ? 'Para viagem ✓' : 'Marcar para viagem'}
    </button>
  );
}
