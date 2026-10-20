import { formatBRL, matchesSearch, type ProductFiscalInput, type ProductFiscalRow } from '@sistema-bar/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, ErrorBanner, Loading, PageHeader, TextField, Toggle } from '../../components/ui';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/fiscal/products';
type Field = 'ncm' | 'cfop' | 'csosn' | 'origin' | 'cest';
const FIELDS: { key: Field; label: string; width: string; max: number }[] = [
  { key: 'ncm', label: 'NCM', width: 'w-28', max: 10 },
  { key: 'cfop', label: 'CFOP', width: 'w-20', max: 4 },
  { key: 'csosn', label: 'CSOSN/CST', width: 'w-20', max: 3 },
  { key: 'origin', label: 'Origem', width: 'w-16', max: 1 },
  { key: 'cest', label: 'CEST', width: 'w-24', max: 9 },
];
type Draft = Record<Field, string>;
const toDraft = (p: ProductFiscalRow): Draft => ({ ncm: p.ncm ?? '', cfop: p.cfop ?? '', csosn: p.csosn ?? '', origin: p.origin ?? '', cest: p.cest ?? '' });

/**
 * Dados fiscais de todos os produtos numa tabela (SPEC 5.8): o contador preenche aqui, ou baixa
 * a planilha, preenche no Excel e envia de volta.
 */
export function ProductFiscalPage() {
  const list = useApiQuery<ProductFiscalRow[]>(PATH);
  const save = useApiMutation<{ items: ProductFiscalInput[] }, { changed: number }>([PATH, '/admin/fiscal/status', '/admin/products']);
  const [params] = useSearchParams();
  const [onlyMissing, setOnlyMissing] = useState(params.get('sem-ncm') === '1');
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [bulk, setBulk] = useState<Partial<Draft>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const rows = list.data ?? [];
  useEffect(() => setDrafts({}), [list.data]);
  const valueOf = (p: ProductFiscalRow) => drafts[p.id] ?? toDraft(p);
  const dirtyIds = rows.filter((p) => drafts[p.id] && JSON.stringify(drafts[p.id]) !== JSON.stringify(toDraft(p))).map((p) => p.id);

  const shown = useMemo(
    () =>
      rows.filter(
        (p) =>
          (showInactive || p.active) &&
          // Pelo valor salvo: a linha não some da lista enquanto o NCM está sendo digitado.
          (!onlyMissing || !p.ncm) &&
          (!search.trim() || matchesSearch(`${p.name} ${p.categoryName}`, search.trim())),
      ),
    [rows, showInactive, onlyMissing, search],
  );

  const edit = (p: ProductFiscalRow, field: Field, value: string) => {
    setNotice(null);
    setDrafts((d) => ({ ...d, [p.id]: { ...valueOf(p), [field]: value } }));
  };

  const applyBulk = () => {
    const entries = Object.entries(bulk).filter(([, v]) => v !== undefined && v !== '') as [Field, string][];
    if (!entries.length) return setLocalError('Preencha ao menos um campo para aplicar.');
    setLocalError(null);
    setDrafts((d) => {
      const next = { ...d };
      for (const p of shown) next[p.id] = { ...(next[p.id] ?? toDraft(p)), ...Object.fromEntries(entries) };
      return next;
    });
    setNotice(`Aplicado a ${shown.length} produto(s) da lista. Confira e clique em Salvar.`);
  };

  const submit = () => {
    const items = dirtyIds.map((id) => ({ id, ...drafts[id]! }));
    save.mutate({ method: 'PUT', path: PATH, body: { items } }, { onSuccess: (r) => setNotice(`${r.changed} produto(s) salvo(s).`) });
  };

  const importCsv = async (file: File) => {
    setLocalError(null);
    const text = (await file.text()).replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const sep = lines[0]?.includes(';') ? ';' : ',';
    const head = splitCsv(lines[0] ?? '', sep).map((h) => h.toLowerCase());
    const col = (name: string) => head.findIndex((h) => h.startsWith(name));
    const iId = col('id');
    const iName = col('produto');
    if (iId < 0 && iName < 0) return setLocalError('A planilha precisa das colunas "id" ou "produto". Use a planilha baixada aqui.');
    const map: Record<Field, number> = { ncm: col('ncm'), cfop: col('cfop'), csosn: col('csosn'), origin: col('origem'), cest: col('cest') };
    let matched = 0;
    const next = { ...drafts };
    for (const line of lines.slice(1)) {
      const cells = splitCsv(line, sep);
      const p = rows.find((r) => (iId >= 0 && r.id === cells[iId]) || (iName >= 0 && r.name.toLowerCase() === (cells[iName] ?? '').toLowerCase()));
      if (!p) continue;
      const d = { ...(next[p.id] ?? toDraft(p)) };
      for (const f of Object.keys(map) as Field[]) if (map[f] >= 0) d[f] = (cells[map[f]] ?? '').trim();
      next[p.id] = d;
      matched++;
    }
    setDrafts(next);
    setNotice(`Planilha lida: ${matched} produto(s) atualizado(s) na tela. Confira e clique em Salvar.`);
  };

  if (list.isLoading) return <Loading />;
  const missing = rows.filter((p) => p.active && !valueOf(p).ncm).length;

  return (
    <>
      <PageHeader
        title="Dados fiscais dos produtos"
        description="NCM, CFOP, CSOSN/CST, origem e CEST de cada produto, para a NFC-e. Quem define os códigos é o contador."
        action={
          <Link to="/admin/fiscal" className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
            ‹ Fiscal
          </Link>
        }
      />
      <div className="mb-4 space-y-3 rounded-xl bg-slate-900 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <TextField label="Buscar" type="search" placeholder="Produto ou categoria" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Toggle label={`Só sem NCM (${missing})`} checked={onlyMissing} onChange={setOnlyMissing} />
          <Toggle label="Mostrar inativos" checked={showInactive} onChange={setShowInactive} />
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-800 pt-3">
          <span className="w-full text-sm text-slate-400">Aplicar a todos os produtos da lista ({shown.length}):</span>
          {FIELDS.map((f) => (
            <div key={f.key} className={f.width}>
              <TextField label={f.label} maxLength={f.max} value={bulk[f.key] ?? ''} onChange={(e) => setBulk((b) => ({ ...b, [f.key]: e.target.value }))} />
            </div>
          ))}
          <Button onClick={applyBulk}>Aplicar</Button>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-3">
          <Button onClick={() => downloadCsv(rows.filter((p) => showInactive || p.active))}>Baixar planilha para o contador</Button>
          <label className="cursor-pointer rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-800">
            Enviar planilha preenchida
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void importCsv(e.target.files[0])} />
          </label>
        </div>
      </div>

      <ErrorBanner message={localError ?? errorMessage(save.error ?? list.error)} />
      {notice && <p className="mb-3 rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-300">{notice}</p>}

      <div className="overflow-x-auto rounded-xl bg-slate-900">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Produto</th>
              {FIELDS.map((f) => (
                <th key={f.key} className="px-1 py-2 font-medium">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const v = valueOf(p);
              const dirty = dirtyIds.includes(p.id);
              return (
                <tr key={p.id} className={`border-t border-slate-800 ${dirty ? 'bg-amber-500/5' : ''}`}>
                  <td className="px-3 py-1.5">
                    <span className={p.active ? '' : 'text-slate-500 line-through'}>{p.name}</span>
                    <span className="block text-xs text-slate-500">
                      {p.categoryName} · {formatBRL(p.priceCents)}
                    </span>
                  </td>
                  {FIELDS.map((f) => (
                    <td key={f.key} className="px-1 py-1.5">
                      <input
                        aria-label={`${f.label} de ${p.name}`}
                        inputMode="numeric"
                        maxLength={f.max}
                        value={v[f.key]}
                        onChange={(e) => edit(p, f.key, e.target.value)}
                        className={`${f.width} rounded-md border bg-slate-950 px-2 py-1.5 tabular-nums outline-none focus:border-amber-500 ${f.key === 'ncm' && !v.ncm && p.active ? 'border-amber-700' : 'border-slate-700'}`}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <p className="p-6 text-center text-slate-500">Nenhum produto com esses filtros.</p>}
      </div>

      <div className="sticky bottom-0 mt-4 flex items-center justify-end gap-3 bg-slate-950/90 py-3 backdrop-blur">
        {dirtyIds.length > 0 && <span className="text-sm text-amber-300">{dirtyIds.length} produto(s) alterado(s), ainda não salvos</span>}
        <Button onClick={() => setDrafts({})} disabled={!dirtyIds.length}>
          Desfazer
        </Button>
        <Button variant="primary" onClick={submit} disabled={!dirtyIds.length || save.isPending}>
          Salvar
        </Button>
      </div>
    </>
  );
}

function splitCsv(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function downloadCsv(rows: ProductFiscalRow[]) {
  const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    ['id', 'Produto', 'Categoria', 'Preço', 'NCM', 'CFOP', 'CSOSN/CST', 'Origem', 'CEST'],
    ...rows.map((p) => [
      p.id,
      p.name,
      p.categoryName,
      (p.priceCents / 100).toFixed(2).replace('.', ','),
      p.ncm ?? '',
      p.cfop ?? '',
      p.csosn ?? '',
      p.origin ?? '',
      p.cest ?? '',
    ]),
  ];
  const csv = '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'produtos-dados-fiscais.csv';
  a.click();
  URL.revokeObjectURL(url);
}
