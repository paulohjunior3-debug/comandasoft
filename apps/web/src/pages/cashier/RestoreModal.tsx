import { useState } from 'react';
import { Button, ErrorBanner, Modal, TextField, Toggle } from '../../components/ui';
import { errorMessage } from '../../lib/queries';

/**
 * Descancelar (item ou mesa cancelada por engano): motivo e se manda de novo para a cozinha/bar.
 * O PIN do gerente vem do usePin de quem chama, dentro do `submit`.
 */
export function RestoreModal({
  title,
  description,
  onClose,
  submit,
}: {
  title: string;
  description: string;
  onClose: () => void;
  submit: (body: { reason: string; resend: boolean }) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('Cancelado por engano');
  const [resend, setResend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (reason.trim().length < 3) return setError('Informe o motivo (ao menos 3 letras).');
    setBusy(true);
    setError(null);
    try {
      await submit({ reason: reason.trim(), resend });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="primary" onClick={confirm} disabled={busy}>
            {busy ? 'Descancelando…' : 'Descancelar'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-300">{description}</p>
      <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <Toggle
        label="Mandar de novo para a cozinha/bar"
        checked={resend}
        onChange={setResend}
        hint="Desmarque se o setor já preparou ou ainda não tinha jogado fora o pedido."
      />
      <ErrorBanner message={error} />
    </Modal>
  );
}
