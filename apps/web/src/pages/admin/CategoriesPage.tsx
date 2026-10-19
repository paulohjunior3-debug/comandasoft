import type { Category, CategoryInput, Printer } from '@sistema-bar/shared';
import { useState } from 'react';
import { Badge, Button, CheckList, EmptyState, ErrorBanner, Loading, Modal, PageHeader, TextField, Toggle } from '../../components/ui';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/categories';
const COLORS = ['#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#64748b'];

type Form = Required<Omit<CategoryInput, 'color'>> & { color: string | null };

export function CategoriesPage() {
  const categories = useApiQuery<Category[]>(PATH);
  const printers = useApiQuery<Printer[]>('/admin/printers');
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);

  const open = (c?: Category) =>
    setEditing({
      id: c?.id ?? null,
      form: c
        ? { name: c.name, sortOrder: c.sortOrder, color: c.color, active: c.active, printerIds: c.printerIds }
        : { name: '', sortOrder: (categories.data?.length ?? 0) + 1, color: COLORS[0]!, active: true, printerIds: [] },
    });

  const printerName = (id: string) => printers.data?.find((p) => p.id === id)?.sectorLabel ?? '?';

  return (
    <>
      <PageHeader
        title="Categorias"
        description="Organizam o cardápio e definem em qual impressora cada item sai."
        action={<Button variant="primary" onClick={() => open()}>+ Nova categoria</Button>}
      />
      <ErrorBanner message={errorMessage(categories.error)} />
      {categories.isLoading ? (
        <Loading />
      ) : categories.data?.length === 0 ? (
        <EmptyState>Nenhuma categoria ainda. Comece criando, por exemplo, "Cervejas" e "Porções".</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl bg-slate-900">
          {categories.data?.map((c) => (
            <li key={c.id}>
              <button onClick={() => open(c)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/60">
                <span className="size-3 shrink-0 rounded-full" style={{ background: c.color ?? '#475569' }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block text-xs text-slate-400">
                    {c.productCount} produto(s) ·{' '}
                    {c.printerIds.length ? `sai em ${c.printerIds.map(printerName).join(', ')}` : 'sem impressora'}
                  </span>
                </span>
                {!c.active && <Badge>Inativa</Badge>}
                {c.printerIds.length === 0 && <Badge tone="warn">Sem impressora</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <CategoryModal
          id={editing.id}
          initial={editing.form}
          printers={printers.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function CategoryModal({ id, initial, printers, onClose }: { id: string | null; initial: Form; printers: Printer[]; onClose: () => void }) {
  const [form, setForm] = useState(initial);
  const save = useApiMutation([PATH, '/admin/printers']);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = () =>
    save.mutate({ method: id ? 'PUT' : 'POST', path: id ? `${PATH}/${id}` : PATH, body: form }, { onSuccess: onClose });
  const remove = () =>
    confirm(`Excluir a categoria "${initial.name}"?`) && save.mutate({ method: 'DELETE', path: `${PATH}/${id}` }, { onSuccess: onClose });

  return (
    <Modal
      title={id ? 'Editar categoria' : 'Nova categoria'}
      onClose={onClose}
      footer={
        <>
          {id && <Button variant="danger" className="mr-auto" onClick={remove} disabled={save.isPending}>Excluir</Button>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Salvar</Button>
        </>
      }
    >
      <ErrorBanner message={errorMessage(save.error)} />
      <TextField label="Nome" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
      <TextField
        label="Ordem no cardápio"
        type="number"
        min={0}
        value={form.sortOrder}
        onChange={(e) => set('sortOrder', Number(e.target.value))}
      />
      <div>
        <span className="mb-1 block text-sm text-slate-300">Cor</span>
        <div className="flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Cor ${c}`}
              onClick={() => set('color', c)}
              className={`size-8 rounded-full ring-offset-2 ring-offset-slate-900 ${form.color === c ? 'ring-2 ring-white' : ''}`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      <CheckList
        label="Sai nas impressoras"
        items={printers.map((p) => ({ id: p.id, label: p.name, detail: p.sectorLabel }))}
        selected={form.printerIds}
        onChange={(ids) => set('printerIds', ids)}
        empty="Nenhuma impressora cadastrada. Cadastre em Impressoras."
      />
      <Toggle label="Ativa" checked={form.active} onChange={(v) => set('active', v)} hint="Inativa some do cardápio do garçom." />
    </Modal>
  );
}
