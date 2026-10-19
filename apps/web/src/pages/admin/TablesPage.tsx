import type { DiningTable } from '@sistema-bar/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, EmptyState, ErrorBanner, Loading, Modal, PageHeader, TextField, Toggle } from '../../components/ui';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/tables';

const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

export function TablesPage() {
  const tables = useApiQuery<DiningTable[]>(PATH);
  const [editing, setEditing] = useState<DiningTable | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);

  const areas = [...new Set((tables.data ?? []).map((t) => t.area ?? 'Sem área'))];

  return (
    <>
      <PageHeader
        title="Mesas"
        description="Número da mesa = para onde o pedido vai. Cada mesa tem um QR próprio para o cliente."
        action={
          <div className="flex gap-2">
            <Link to="/admin/mesas/qr" className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-800">
              Imprimir QR Codes
            </Link>
            <Button onClick={() => setBulk(true)}>Criar várias</Button>
            <Button variant="primary" onClick={() => setEditing('new')}>+ Nova mesa</Button>
          </div>
        }
      />
      <ErrorBanner message={errorMessage(tables.error)} />
      {tables.isLoading ? (
        <Loading />
      ) : tables.data?.length === 0 ? (
        <EmptyState>Nenhuma mesa. Use "Criar várias" para cadastrar, por exemplo, as mesas 1 a 30 de uma vez.</EmptyState>
      ) : (
        <div className="space-y-5">
          {areas.map((area) => (
            <section key={area}>
              <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-400 uppercase">{area}</h2>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                {tables.data
                  ?.filter((t) => (t.area ?? 'Sem área') === area)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setEditing(t)}
                      className={`aspect-square rounded-xl border p-2 text-center ${t.active ? 'border-slate-700 bg-slate-900 hover:border-amber-500' : 'border-dashed border-slate-800 text-slate-600'}`}
                    >
                      <span className="block text-2xl font-semibold">{t.number}</span>
                      <span className="block text-xs text-slate-500">{t.capacity ? `${t.capacity} lug.` : ' '}</span>
                    </button>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {editing && <TableModal table={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {bulk && <BulkModal onClose={() => setBulk(false)} />}
    </>
  );
}

function TableModal({ table, onClose }: { table: DiningTable | null; onClose: () => void }) {
  const [number, setNumber] = useState(table ? String(table.number) : '');
  const [area, setArea] = useState(table?.area ?? '');
  const [capacity, setCapacity] = useState(table?.capacity ? String(table.capacity) : '');
  const [active, setActive] = useState(table?.active ?? true);
  const save = useApiMutation([PATH]);
  const [qrToken, setQrToken] = useState(table?.qrToken);

  const submit = () =>
    save.mutate(
      {
        method: table ? 'PUT' : 'POST',
        path: table ? `${PATH}/${table.id}` : PATH,
        body: { number: Number(number), area, capacity: numOrNull(capacity), active },
      },
      { onSuccess: onClose },
    );
  const regenerate = () =>
    confirm('Gerar um QR novo? O QR impresso atual desta mesa deixa de funcionar.') &&
    save.mutate(
      { method: 'POST', path: `${PATH}/${table!.id}/regenerate-qr` },
      { onSuccess: (t) => setQrToken((t as DiningTable).qrToken) },
    );
  const remove = () =>
    confirm(`Excluir a mesa ${table!.number}?`) && save.mutate({ method: 'DELETE', path: `${PATH}/${table!.id}` }, { onSuccess: onClose });

  return (
    <Modal
      title={table ? `Mesa ${table.number}` : 'Nova mesa'}
      onClose={onClose}
      footer={
        <>
          {table && <Button variant="danger" className="mr-auto" onClick={remove} disabled={save.isPending}>Excluir</Button>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Salvar</Button>
        </>
      }
    >
      <ErrorBanner message={errorMessage(save.error)} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Número" type="number" min={1} value={number} onChange={(e) => setNumber(e.target.value)} autoFocus={!table} />
        <TextField label="Lugares" type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} hint="Opcional" />
      </div>
      <TextField label="Área" placeholder="Salão, Varanda…" value={area} onChange={(e) => setArea(e.target.value)} />
      <Toggle label="Ativa" checked={active} onChange={setActive} />
      {table && (
        <div className="rounded-lg border border-slate-800 p-3 text-sm">
          <p className="text-slate-400">
            Código do QR: <code className="text-slate-200">{qrToken}</code>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Gerar um novo invalida o QR impresso desta mesa (imprima de novo em "Imprimir QR Codes").
          </p>
          <Button className="mt-2" onClick={regenerate} disabled={save.isPending}>Gerar novo QR</Button>
        </div>
      )}
    </Modal>
  );
}

function BulkModal({ onClose }: { onClose: () => void }) {
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('20');
  const [area, setArea] = useState('Salão');
  const [capacity, setCapacity] = useState('4');
  const [result, setResult] = useState<string | null>(null);
  const save = useApiMutation<unknown, { created: DiningTable[]; skipped: number[] }>([PATH]);

  const submit = () =>
    save.mutate(
      { method: 'POST', path: `${PATH}/bulk`, body: { from: Number(from), to: Number(to), area, capacity: numOrNull(capacity) } },
      {
        onSuccess: (r) =>
          setResult(
            `${r.created.length} mesa(s) criada(s).` + (r.skipped.length ? ` Já existiam: ${r.skipped.join(', ')}.` : ''),
          ),
      },
    );

  return (
    <Modal
      title="Criar várias mesas"
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Fechar</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" onClick={submit} disabled={save.isPending}>Criar</Button>
          </>
        )
      }
    >
      <ErrorBanner message={errorMessage(save.error)} />
      {result ? (
        <p className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-300">{result}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Da mesa" type="number" min={1} value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextField label="Até a mesa" type="number" min={1} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <TextField label="Área" value={area} onChange={(e) => setArea(e.target.value)} />
          <TextField label="Lugares por mesa" type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          <p className="text-xs text-slate-500">Números que já existem são pulados.</p>
        </>
      )}
    </Modal>
  );
}
