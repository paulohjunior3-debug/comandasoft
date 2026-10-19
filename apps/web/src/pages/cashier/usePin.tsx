import { CASHIER_ERRORS } from '@sistema-bar/shared';
import { useRef, useState, type ReactNode } from 'react';
import { Button, ErrorBanner, Modal, TextField } from '../../components/ui';
import { ApiRequestError } from '../../lib/api';

type Action<T> = (pin?: string) => Promise<T>;

/**
 * Ações de gerente no caixa (SPEC 4): tenta sem PIN; se o servidor pedir, abre a janela do PIN
 * e repete a ação com ele. Gerente logado nem vê a janela.
 */
export function usePin() {
  const [prompt, setPrompt] = useState<{ error: string | null } | null>(null);
  const [pin, setPin] = useState('');
  const pending = useRef<{ action: Action<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void } | null>(null);

  async function attempt(withPin?: string) {
    const p = pending.current!;
    try {
      const result = await p.action(withPin);
      setPrompt(null);
      setPin('');
      pending.current = null;
      p.resolve(result);
    } catch (err) {
      if (err instanceof ApiRequestError && (err.code === CASHIER_ERRORS.PIN_REQUIRED || err.code === CASHIER_ERRORS.PIN_INVALID)) {
        setPrompt({ error: err.code === CASHIER_ERRORS.PIN_INVALID ? err.message : null });
        return;
      }
      setPrompt(null);
      pending.current = null;
      p.reject(err);
    }
  }

  function run<T>(action: Action<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.current = { action, resolve: resolve as (v: unknown) => void, reject };
      void attempt();
    });
  }

  const cancel = () => {
    pending.current?.reject(new ApiRequestError(403, 'CANCELLED', 'Ação cancelada.'));
    pending.current = null;
    setPrompt(null);
    setPin('');
  };

  const element: ReactNode = prompt && (
    <Modal
      title="Autorização do gerente"
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>Cancelar</Button>
          <Button variant="primary" disabled={pin.length < 4} onClick={() => void attempt(pin)}>
            Autorizar
          </Button>
        </>
      }
    >
      <ErrorBanner message={prompt.error} />
      <p className="text-sm text-slate-300">Esta ação precisa da autorização de um gerente. Peça para ele digitar o PIN.</p>
      <TextField
        label="PIN do gerente"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        maxLength={6}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => e.key === 'Enter' && pin.length >= 4 && void attempt(pin)}
      />
    </Modal>
  );

  return { run, element };
}
