import { useState } from 'react';
import { Button, ErrorBanner, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/queries';
import { usePin } from './usePin';

/**
 * Pessoas da comanda (esqueceu de pôr na abertura). O couvert do dia é recalculado na conta.
 * Aumentar salva direto; diminuir pede o PIN de um gerente (garçom e caixa). Fica na auditoria.
 */
export function PeopleModal({
  comanda,
  onClose,
  onSaved,
}: {
  comanda: { id: string; customerName: string; peopleCount: number };
  onClose: () => void;
  onSaved: (peopleCount: number) => void;
}) {
  const pin = usePin();
  const [count, setCount] = useState(comanda.peopleCount);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (count === comanda.peopleCount) return onClose();
    setBusy(true);
    setError(null);
    try {
      await pin.run((authorizerPin) =>
        api(`/waiter/comandas/${comanda.id}/people`, { method: 'POST', body: JSON.stringify({ peopleCount: count, authorizerPin }) }),
      );
      onSaved(count);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const step = (d: number) => setCount((c) => Math.min(30, Math.max(1, c + d)));
  return (
    <Modal
      title={`Pessoas · ${comanda.customerName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            Salvar
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <div className="flex items-center justify-center gap-5 py-2">
        <button onClick={() => step(-1)} aria-label="Menos uma pessoa" className="size-12 rounded-full bg-slate-800 text-2xl active:bg-slate-700">
          −
        </button>
        <span className="w-12 text-center text-3xl font-semibold" aria-live="polite">
          {count}
        </span>
        <button onClick={() => step(1)} aria-label="Mais uma pessoa" className="size-12 rounded-full bg-amber-500 text-2xl font-semibold text-slate-950 active:bg-amber-600">
          +
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Se o couvert estiver valendo, ele é cobrado por pessoa. Aumentar salva direto; diminuir pede o PIN de um gerente. A alteração fica na auditoria.
      </p>
      {pin.element}
    </Modal>
  );
}
