import { centsToInput, parseBRL, periodTable, WEEKDAY_NAMES, WEEKDAY_SHORT, type Printer, type Settings } from '@sistema-bar/shared';
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
            hint="Valor sugerido ao iniciar o couvert. O gerente inicia e encerra o couvert no caixa (botão Couvert), a cada show."
          />
          <SelectField
            label="Mais de um show no mesmo dia"
            value={form.couvertMode}
            onChange={(e) => set('couvertMode', e.target.value as Settings['couvertMode'])}
            hint="Para quem fica na mesa durante dois ou mais shows."
          >
            <option value="UMA_VEZ">Cobrar o couvert uma vez só por pessoa</option>
            <option value="POR_SHOW">Cobrar o couvert a cada show</option>
          </SelectField>
        </Section>

        <Section title="Semana do bar (períodos)">
          <p className="text-sm text-slate-400">
            Cada dia de funcionamento recebe um número de período, que vem preenchido na abertura do caixa e serve de filtro nos
            relatórios.
          </p>
          <SelectField label="A semana começa na" value={form.weekStartDay} onChange={(e) => set('weekStartDay', Number(e.target.value))}>
            {WEEKDAY_NAMES.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </SelectField>
          <div>
            <span className="mb-1 block text-sm text-slate-300">Dias em que o bar fecha</span>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_SHORT.map((d, i) => {
                const closed = form.closedDays.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={closed}
                    onClick={() => set('closedDays', closed ? form.closedDays.filter((x) => x !== i) : [...form.closedDays, i])}
                    className={`rounded-lg px-3 py-1.5 text-sm ${closed ? 'bg-red-950 text-red-300 line-through' : 'bg-slate-800 text-slate-300'}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-300">
            {periodTable(form).length
              ? periodTable(form)
                  .map((p) => `${WEEKDAY_SHORT[p.weekday]} = ${p.period}`)
                  .join(' · ')
              : 'Marque pelo menos um dia aberto.'}
          </p>
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
