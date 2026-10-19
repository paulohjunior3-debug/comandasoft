import { centsToInput, parseBRL, type Printer, type Settings } from '@sistema-bar/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, ErrorBanner, Loading, PageHeader, SelectField, TextField, Toggle } from '../../components/ui';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/settings';

export function SettingsPage() {
  const settings = useApiQuery<Settings>(PATH);
  const save = useApiMutation<Settings>([PATH]);
  const printers = useApiQuery<Printer[]>('/admin/printers');
  const [form, setForm] = useState<Settings | null>(null);
  const [couvert, setCouvert] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data && !form) {
      setForm(settings.data);
      setCouvert(centsToInput(settings.data.couvertCents));
    }
  }, [settings.data, form]);

  if (!form) return settings.isError ? <ErrorBanner message={errorMessage(settings.error)} /> : <Loading />;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  const submit = () => {
    const couvertCents = parseBRL(couvert || '0');
    if (couvertCents === null) return setLocalError('Valor do couvert inválido.');
    setLocalError(null);
    save.mutate({ method: 'PUT', path: PATH, body: { ...form, couvertCents } }, { onSuccess: () => setSaved(true) });
  };

  return (
    <>
      <PageHeader title="Configurações" description="Regras de cobrança e dados que saem no cupom." />
      <div className="space-y-5">
        <Section title="Cobrança">
          <Toggle
            label="Cobrar taxa de serviço (10%)"
            checked={form.serviceFeeEnabled}
            onChange={(v) => set('serviceFeeEnabled', v)}
            hint="Ligada: 10% sobre os itens de toda comanda. O gerente pode retirar de uma comanda específica, com motivo."
          />
          <TextField
            label="Couvert padrão por pessoa (R$)"
            inputMode="decimal"
            value={couvert}
            onChange={(e) => {
              setSaved(false);
              setCouvert(e.target.value);
            }}
            hint="Valor sugerido na abertura do caixa. Se vai ter couvert e a partir de que horas é decidido em cada abertura."
          />
        </Section>

        <Section title="Caixa">
          <SelectField
            label="Impressora do caixa"
            value={form.cashierPrinterId ?? ''}
            onChange={(e) => set('cashierPrinterId', e.target.value || null)}
            hint="Pré-conta, cupom final, comprovantes de sangria/suprimento, relatório de fechamento e abertura da gaveta."
          >
            <option value="">Nenhuma (não imprime)</option>
            {printers.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sectorLabel}){p.active ? '' : ' — desativada'}
              </option>
            ))}
          </SelectField>
        </Section>

        <Section title="Mapa de mesas">
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Amarelo após (min)"
              type="number"
              min={1}
              value={form.alertYellowMinutes}
              onChange={(e) => set('alertYellowMinutes', Number(e.target.value))}
            />
            <TextField
              label="Vermelho após (min)"
              type="number"
              min={1}
              value={form.alertRedMinutes}
              onChange={(e) => set('alertRedMinutes', Number(e.target.value))}
            />
          </div>
          <p className="text-xs text-slate-500">Tempo sem atendimento para a mesa mudar de cor no app do garçom.</p>
        </Section>

        <Section title="Estabelecimento (cabeçalho do cupom)">
          <TextField label="Nome" value={form.companyName} onChange={(e) => set('companyName', e.target.value)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="CNPJ" value={form.companyDocument} onChange={(e) => set('companyDocument', e.target.value)} />
            <TextField label="Telefone" value={form.companyPhone} onChange={(e) => set('companyPhone', e.target.value)} />
          </div>
          <TextField label="Endereço" value={form.companyAddress} onChange={(e) => set('companyAddress', e.target.value)} />
          <TextField label="Rodapé do cupom" value={form.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} />
        </Section>

        <ErrorBanner message={localError ?? errorMessage(save.error)} />
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-sm text-emerald-400">Configurações salvas.</span>}
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Salvar configurações</Button>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl bg-slate-900 p-4">
      <h2 className="text-sm font-semibold tracking-wide text-slate-400 uppercase">{title}</h2>
      {children}
    </section>
  );
}
