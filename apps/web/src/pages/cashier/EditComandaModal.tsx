import { editComandaSchema } from '@sistema-bar/shared';
import { useState } from 'react';
import { Button, ErrorBanner, Modal, TextField } from '../../components/ui';
import { api } from '../../lib/api';
import { maskPhone } from '../../lib/format';
import { errorMessage } from '../../lib/queries';
import { usePin } from './usePin';

/**
 * Corrigir nome e telefone da comanda (garçom digitou errado). Gerente/admin salva direto;
 * garçom e caixa precisam do PIN de um gerente. Fica na auditoria.
 */
export function EditComandaModal({
  comanda,
  onClose,
  onSaved,
}: {
  comanda: { id: string; customerName: string; phone: string | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const pin = usePin();
  const [name, setName] = useState(comanda.customerName);
  const [phone, setPhone] = useState(comanda.phone ? maskPhone(comanda.phone) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body = { customerName: name.trim(), phone };
    const parsed = editComandaSchema.safeParse(body);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Dados inválidos.');
    setBusy(true);
    setError(null);
    try {
      await pin.run((authorizerPin) => api(`/waiter/comandas/${comanda.id}/edit`, { method: 'POST', body: JSON.stringify({ ...body, authorizerPin }) }));
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Corrigir nome e telefone"
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
      <TextField label="Nome do cliente" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoCapitalize="words" />
      <TextField label="Telefone (com DDD)" inputMode="tel" placeholder="(34) 99999-9999" value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} />
      <p className="text-xs text-slate-500">Gerente e administrador salvam direto; os demais precisam do PIN de um gerente. A alteração fica na auditoria.</p>
      {pin.element}
    </Modal>
  );
}
