import type { CashRegister, CashRegisterInput, FiscalMode, Printer } from '@sistema-bar/shared';
import { useState } from 'react';
import { Badge, Button, EmptyState, ErrorBanner, Loading, Modal, PageHeader, SelectField, TextField, Toggle } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/registers';

const FISCAL_LABELS: Record<FiscalMode, string> = {
  PERGUNTAR: 'Perguntar ao finalizar (cupom não fiscal, fiscal ou só finalizar)',
  AUTOMATICO: 'Sempre pedir o cupom fiscal automaticamente',
};

/** Caixas (pontos de cobrança): cada um abre e fecha sua sessão, com sua impressora e regra fiscal. */
export function RegistersPage() {
  const registers = useApiQuery<CashRegister[]>(PATH);
  const printers = useApiQuery<Printer[]>('/admin/printers');
  const [editing, setEditing] = useState<CashRegister | 'new' | null>(null);
  const printerName = (id: string | null) => (id ? (printers.data?.find((p) => p.id === id)?.name ?? '?') : 'impressora do caixa (Configurações)');

  return (
    <>
      <PageHeader
        title="Caixas"
        description="Pontos de cobrança (ex.: Caixa Carlos, Caixa Paulo). Cada um abre e fecha o próprio caixa."
        action={<Button variant="primary" onClick={() => setEditing('new')}>+ Novo caixa</Button>}
      />
      <ErrorBanner message={errorMessage(registers.error)} />
      {registers.isLoading ? (
        <Loading />
      ) : registers.data?.length === 0 ? (
        <EmptyState>Nenhum caixa cadastrado. Crie pelo menos um para poder abrir o caixa e receber pagamentos.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {registers.data?.map((r) => (
            <li key={r.id}>
              <button onClick={() => setEditing(r)} className="h-full w-full rounded-xl bg-slate-900 p-4 text-left hover:bg-slate-800/60">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{r.name}</p>
                  {r.openSession ? <Badge tone="ok">Aberto</Badge> : <Badge>Fechado</Badge>}
                </div>
                <p className="mt-1 text-sm text-slate-400">
                  {r.fiscalMode === 'AUTOMATICO' ? 'Fiscal automático' : 'Pergunta o cupom ao finalizar'} · {printerName(r.printerId)}
                </p>
                {r.openSession && (
                  <p className="mt-1 text-xs text-slate-500">
                    aberto às {formatTime(r.openSession.openedAt)} por {r.openSession.openedBy}
                  </p>
                )}
                {!r.active && <Badge tone="bad">Desativado</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <RegisterModal register={editing === 'new' ? null : editing} printers={printers.data ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}

function RegisterModal({ register, printers, onClose }: { register: CashRegister | null; printers: Printer[]; onClose: () => void }) {
  const save = useApiMutation([PATH]);
  const [form, setForm] = useState<Required<Omit<CashRegisterInput, 'printerId'>> & { printerId: string }>({
    name: register?.name ?? '',
    fiscalMode: register?.fiscalMode ?? 'PERGUNTAR',
    printerId: register?.printerId ?? '',
    active: register?.active ?? true,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal
      title={register ? 'Editar caixa' : 'Novo caixa'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ method: register ? 'PUT' : 'POST', path: register ? `${PATH}/${register.id}` : PATH, body: form }, { onSuccess: onClose })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      <ErrorBanner message={errorMessage(save.error)} />
      <TextField label="Nome" placeholder="Ex.: Caixa Carlos" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus={!register} />
      <SelectField label="Cupom fiscal" value={form.fiscalMode} onChange={(e) => set('fiscalMode', e.target.value as FiscalMode)}>
        {(Object.keys(FISCAL_LABELS) as FiscalMode[]).map((m) => (
          <option key={m} value={m}>
            {FISCAL_LABELS[m]}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Impressora deste caixa"
        value={form.printerId}
        onChange={(e) => set('printerId', e.target.value)}
        hint="Cupom, comprovantes de sangria/suprimento, relatório de fechamento e gaveta."
      >
        <option value="">Usar a impressora do caixa das Configurações</option>
        {printers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.sectorLabel})
          </option>
        ))}
      </SelectField>
      <Toggle label="Ativo" checked={form.active} onChange={(v) => set('active', v)} />
      <p className="text-xs text-slate-500">
        O cupom fiscal (NFC-e) é a próxima fase do sistema. Até lá, os pedidos de cupom fiscal ficam registrados para emissão posterior.
      </p>
    </Modal>
  );
}
