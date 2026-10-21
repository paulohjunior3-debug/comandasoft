import {
  PRINTER_CODEPAGES,
  type Category,
  type InstalledPrinter,
  type Printer,
  type PrinterInput,
} from '@sistema-bar/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  Button,
  CheckList,
  EmptyState,
  ErrorBanner,
  Loading,
  Modal,
  PageHeader,
  SelectField,
  TextField,
  Toggle,
} from '../../components/ui';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/printers';

type Form = Required<PrinterInput>;

const CODEPAGE_LABELS: Record<(typeof PRINTER_CODEPAGES)[number], string> = {
  CP860: 'CP860 (português, recomendado Elgin)',
  CP850: 'CP850 (multilíngue)',
  CP437: 'CP437 (padrão EUA)',
  SEM_ACENTO: 'Sem acentos (remove acentuação)',
};

export function PrintersPage() {
  const printers = useApiQuery<Printer[]>(PATH);
  const categories = useApiQuery<Category[]>('/admin/categories');
  const [editing, setEditing] = useState<Printer | 'new' | null>(null);

  const categoryName = (id: string) => categories.data?.find((c) => c.id === id)?.name ?? '?';
  const orphanCategories = (categories.data ?? []).filter((c) => c.active && c.printerIds.length === 0);

  return (
    <>
      <PageHeader
        title="Impressoras"
        description="Escolha as impressoras instaladas neste PC e diga quais categorias saem em cada uma."
        action={<Button variant="primary" onClick={() => setEditing('new')}>+ Nova impressora</Button>}
      />
      <ErrorBanner message={errorMessage(printers.error)} />
      {orphanCategories.length > 0 && (
        <p className="mb-4 rounded-lg bg-amber-950 px-3 py-2 text-sm text-amber-300">
          Categorias sem impressora (os pedidos delas não serão impressos): {orphanCategories.map((c) => c.name).join(', ')}.
        </p>
      )}
      {printers.isLoading ? (
        <Loading />
      ) : printers.data?.length === 0 ? (
        <EmptyState>Nenhuma impressora cadastrada. Instale as impressoras no Windows e depois cadastre aqui.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {printers.data?.map((p) => (
            <li key={p.id}>
              <button onClick={() => setEditing(p)} className="h-full w-full rounded-xl bg-slate-900 p-4 text-left hover:bg-slate-800/60">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{p.name}</p>
                    <p className="text-xs text-slate-400">{p.windowsName}</p>
                  </div>
                  <span className="rounded bg-slate-800 px-2 py-1 text-xs font-bold tracking-wider">{p.sectorLabel}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {!p.active && <Badge>Inativa</Badge>}
                  {p.installed === false && <Badge tone="bad">Não encontrada no Windows</Badge>}
                  {p.installed === true && <Badge tone="ok">Instalada</Badge>}
                  <Badge>{p.widthMm} mm</Badge>
                  {p.usesPanel && <Badge tone="warn">Painel da cozinha</Badge>}
                </div>
                <p className="mt-3 text-sm text-slate-400">
                  {p.categoryIds.length ? p.categoryIds.map(categoryName).join(', ') : 'Nenhuma categoria vinculada'}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <PrinterModal printer={editing === 'new' ? null : editing} categories={categories.data ?? []} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function PrinterModal({ printer, categories, onClose }: { printer: Printer | null; categories: Category[]; onClose: () => void }) {
  const installed = useApiQuery<InstalledPrinter[]>(`${PATH}/installed`);
  const save = useApiMutation([PATH, '/admin/categories']);
  const test = useApiMutation<unknown, { mode: 'emulador' | 'windows'; active: boolean }>(['/print/queue']);
  const [form, setForm] = useState<Form>(() => ({
    name: printer?.name ?? '',
    windowsName: printer?.windowsName ?? '',
    sectorLabel: printer?.sectorLabel ?? '',
    widthMm: printer?.widthMm ?? 80,
    codepage: printer?.codepage ?? 'CP860',
    cut: printer?.cut ?? true,
    active: printer?.active ?? true,
    usesPanel: printer?.usesPanel ?? false,
    categoryIds: printer?.categoryIds ?? [],
  }));
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const options = installed.data ?? [];
  const missing = form.windowsName !== '' && installed.data && !options.some((o) => o.name === form.windowsName);

  const submit = () =>
    save.mutate(
      { method: printer ? 'PUT' : 'POST', path: printer ? `${PATH}/${printer.id}` : PATH, body: form },
      { onSuccess: onClose },
    );
  const remove = () =>
    confirm(`Excluir a impressora "${printer!.name}"?`) &&
    save.mutate({ method: 'DELETE', path: `${PATH}/${printer!.id}` }, { onSuccess: onClose });

  return (
    <Modal
      title={printer ? 'Editar impressora' : 'Nova impressora'}
      onClose={onClose}
      footer={
        <>
          {printer && <Button variant="danger" className="mr-auto" onClick={remove} disabled={save.isPending}>Excluir</Button>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Salvar</Button>
        </>
      }
    >
      <ErrorBanner message={errorMessage(save.error)} />

      {installed.isError ? (
        <TextField
          label="Nome da impressora no Windows"
          value={form.windowsName}
          onChange={(e) => set('windowsName', e.target.value)}
          hint="Não consegui listar as impressoras do Windows. Digite o nome exatamente como aparece em Configurações > Impressoras."
        />
      ) : (
        <SelectField
          label="Impressora instalada no Windows"
          value={form.windowsName}
          onChange={(e) => {
            const name = e.target.value;
            setForm((f) => ({ ...f, windowsName: name, name: f.name || name }));
          }}
          hint={installed.isLoading ? 'Consultando o Windows…' : 'Rede ou USB, como foi instalada neste PC.'}
        >
          <option value="">Escolha…</option>
          {missing && <option value={form.windowsName}>{form.windowsName} (não encontrada)</option>}
          {options.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name}
              {o.portName ? ` — ${o.portName}` : ''}
            </option>
          ))}
        </SelectField>
      )}

      <div className="grid grid-cols-2 gap-3">
        <TextField label="Apelido" value={form.name} onChange={(e) => set('name', e.target.value)} hint="Ex.: Bar, Cozinha" />
        <TextField
          label="Setor no cupom"
          value={form.sectorLabel}
          onChange={(e) => set('sectorLabel', e.target.value.toUpperCase())}
          maxLength={20}
          hint="Sai em destaque: BAR, COZINHA"
        />
      </div>

      <CheckList
        label="Categorias que saem nesta impressora"
        items={categories.map((c) => ({ id: c.id, label: c.name, detail: c.active ? undefined : 'inativa' }))}
        selected={form.categoryIds}
        onChange={(ids) => set('categoryIds', ids)}
        empty="Nenhuma categoria cadastrada ainda."
      />

      <div className="grid grid-cols-2 gap-3">
        <SelectField label="Largura do papel" value={form.widthMm} onChange={(e) => set('widthMm', Number(e.target.value) as 58 | 80)}>
          <option value={80}>80 mm</option>
          <option value={58}>58 mm</option>
        </SelectField>
        <SelectField label="Acentuação" value={form.codepage} onChange={(e) => set('codepage', e.target.value as Form['codepage'])}>
          {PRINTER_CODEPAGES.map((c) => (
            <option key={c} value={c}>
              {CODEPAGE_LABELS[c]}
            </option>
          ))}
        </SelectField>
      </div>
      <Toggle label="Cortar papel (guilhotina)" checked={form.cut} onChange={(v) => set('cut', v)} />
      <Toggle label="Ativa" checked={form.active} onChange={(v) => set('active', v)} />
      <div>
        <Toggle label="Usar o painel da cozinha" checked={form.usesPanel} onChange={(v) => set('usesPanel', v)} />
        <p className="mt-1 text-xs text-slate-500">
          Ligado: os pedidos aparecem primeiro na tela da cozinha (endereço /cozinha) e o cupom só imprime quando a cozinha aperta Enter
          (pronto). Desligado: imprime na hora.
        </p>
      </div>
      {printer && (
        <div className="rounded-lg border border-slate-800 p-3">
          <Button onClick={() => test.mutate({ method: 'POST', path: `${PATH}/${printer.id}/test` })} disabled={test.isPending}>
            Imprimir teste
          </Button>
          {test.data && (
            <p className="mt-2 text-sm text-emerald-300">
              {!test.data.active
                ? 'Página de teste na fila, mas a impressora está desativada: ative para imprimir.'
                : test.data.mode === 'emulador'
                  ? 'Modo emulador: a página foi gravada em arquivo. '
                  : 'Página de teste enviada. '}
              <Link to="/admin/fila-impressao" className="underline">Ver na fila</Link>
            </p>
          )}
          <ErrorBanner message={errorMessage(test.error)} />
          <p className="mt-2 text-xs text-slate-500">Salve as alterações antes de testar. A página confere conexão, papel e acentos.</p>
        </div>
      )}
    </Modal>
  );
}
