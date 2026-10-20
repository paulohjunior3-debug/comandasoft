import {
  AUDIT_ACTIONS,
  AUDIT_GROUP_LABELS,
  AUDIT_GROUPS,
  auditActionLabel,
  auditActionsOf,
  formatBRL,
  localDate,
  PAYMENT_METHOD_LABELS,
  ROLE_LABELS,
  type AuditEntry,
  type AuditGroup,
  type AuditOptions,
  type AuditPage as AuditPageData,
  type PaymentMethod,
  type Role,
} from '@sistema-bar/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, EmptyState, ErrorBanner, Loading, PageHeader, SelectField, TextField, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage, useApiQuery } from '../../lib/queries';

const DAY = 24 * 60 * 60 * 1000;
const shift = (date: string, days: number) => localDate(new Date(Date.parse(`${date}T12:00:00-03:00`) + days * DAY));
function presets() {
  const today = localDate(new Date());
  return [
    { label: 'Hoje', from: today, to: today },
    { label: 'Ontem', from: shift(today, -1), to: shift(today, -1) },
    { label: '7 dias', from: shift(today, -6), to: today },
    { label: '30 dias', from: shift(today, -29), to: today },
  ];
}

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' });

/** Auditoria (SPEC 5.10): quem fez o quê e quando, com filtros e detalhes. Somente leitura. */
export function AuditPage() {
  const initial = presets()[0]!;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [userId, setUserId] = useState('');
  const [group, setGroup] = useState<AuditGroup | ''>('');
  const [action, setAction] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const options = useApiQuery<AuditOptions>('/admin/audit/options');

  // Busca só depois de parar de digitar.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({
    from,
    to,
    ...(userId ? { userId } : {}),
    ...(action ? { action } : group ? { group } : {}),
    ...(sensitive ? { sensitive: '1' } : {}),
    ...(q ? { q } : {}),
  });
  const list = useInfiniteQuery({
    queryKey: ['/admin/audit', params.toString()],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      if (pageParam) p.set('before', pageParam);
      return api<AuditPageData>(`/admin/audit?${p}`);
    },
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: Boolean(from && to),
  });
  const entries = list.data?.pages.flatMap((p) => p.entries) ?? [];

  const actionChoices = (options.data?.actions ?? [])
    .filter((a) => !group || AUDIT_ACTIONS[a]?.group === group || (!AUDIT_ACTIONS[a] && !group))
    .concat(group ? auditActionsOf(group).filter((a) => !options.data?.actions.includes(a)) : [])
    .sort((a, b) => auditActionLabel(a).localeCompare(auditActionLabel(b)));

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Tudo o que foi feito no sistema: quem, quando e o quê. O registro não pode ser alterado nem apagado."
        action={
          entries.length > 0 && (
            <Button className="print:hidden" onClick={() => downloadCsv(entries, from, to)}>
              Exportar planilha
            </Button>
          )
        }
      />

      <div className="mb-5 space-y-3 rounded-xl bg-slate-900 p-4 print:hidden">
        <div className="flex flex-wrap gap-2">
          {presets().map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setFrom(p.from);
                setTo(p.to);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm ${p.from === from && p.to === to ? 'bg-amber-500 font-medium text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label="De" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="Até" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          <SelectField label="Usuário" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Todos</option>
            {options.data?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({ROLE_LABELS[u.role as Role] ?? u.role}){u.active ? '' : ' — desativado'}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Tipo"
            value={group}
            onChange={(e) => {
              setGroup(e.target.value as AuditGroup | '');
              setAction('');
            }}
          >
            <option value="">Tudo</option>
            {AUDIT_GROUPS.map((g) => (
              <option key={g} value={g}>
                {AUDIT_GROUP_LABELS[g]}
              </option>
            ))}
          </SelectField>
          <SelectField label="Ação" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Todas</option>
            {actionChoices.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </SelectField>
          <div className="sm:col-span-1 lg:col-span-2">
            <TextField
              label="Buscar"
              type="search"
              placeholder="Produto, cliente, motivo, mesa…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Toggle label="Só ações sensíveis" checked={sensitive} onChange={setSensitive} hint="Cancelamentos, descontos, estornos, preços, senhas" />
          </div>
        </div>
      </div>

      <ErrorBanner message={errorMessage(list.error)} />
      {list.isLoading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <EmptyState>Nada registrado com esses filtros.</EmptyState>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-400">
            {entries.length}
            {list.hasNextPage ? '+' : ''} registro(s), do mais recente para o mais antigo.
          </p>
          <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl bg-slate-900">
            {entries.map((e) => (
              <EntryRow key={e.id} entry={e} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="mt-3 text-center print:hidden">
              <Button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function EntryRow({ entry: e }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const meta = AUDIT_ACTIONS[e.action];
  const summary = summarize(e);
  return (
    <li>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-800/50" aria-expanded={open}>
        <span className="w-36 shrink-0 text-xs text-slate-400 tabular-nums sm:text-sm">{dateTime(e.at)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{auditActionLabel(e.action)}</span>
            {meta?.sensitive && <Badge tone="warn">sensível</Badge>}
          </span>
          {summary && <span className="block truncate text-sm text-slate-400">{summary}</span>}
        </span>
        <span className="hidden w-40 shrink-0 text-right text-sm sm:block">
          {e.userName ?? <span className="text-slate-500">{e.action.startsWith('QR_') ? 'cliente (QR)' : 'sistema'}</span>}
          {e.userRole && <span className="block text-xs text-slate-500">{ROLE_LABELS[e.userRole as Role] ?? e.userRole}</span>}
        </span>
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && <EntryDetails entry={e} />}
    </li>
  );
}

function EntryDetails({ entry: e }: { entry: AuditEntry }) {
  const before = asRecord(e.before);
  const after = asRecord(e.after);
  const both = before && after;
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(visibleKey);
  const changed = both ? keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])) : keys;

  return (
    <div className="space-y-3 border-t border-slate-800 bg-slate-950/40 px-4 py-3 text-sm">
      <p className="text-slate-400 sm:hidden">
        Por: <span className="text-slate-200">{e.userName ?? 'sistema / cliente'}</span>
      </p>
      {both ? (
        changed.length === 0 ? (
          <p className="text-slate-500">Sem mudanças nos campos.</p>
        ) : (
          <table className="w-full">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Campo</th>
                <th className="py-1 pr-3 font-medium">Antes</th>
                <th className="py-1 font-medium">Depois</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((k) => (
                <tr key={k} className="border-t border-slate-800/60 align-top">
                  <td className="py-1 pr-3 text-slate-400">{fieldLabel(k)}</td>
                  <td className="py-1 pr-3 text-red-300/80">{formatValue(k, before[k])}</td>
                  <td className="py-1 text-emerald-300">{formatValue(k, after[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : keys.length ? (
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          {keys.map((k) => (
            <Pair key={k} label={fieldLabel(k)}>
              {formatValue(k, (after ?? before)![k])}
            </Pair>
          ))}
        </dl>
      ) : (
        <p className="text-slate-500">Sem detalhes adicionais.</p>
      )}
      <p className="text-xs text-slate-500">
        {e.ip && <>Aparelho (IP): {e.ip} · </>}
        {e.entity && <>Registro: {e.entity}</>}
        {e.entityId && <> · {e.entityId.slice(0, 8)}</>}
      </p>
    </div>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}

// ---------- Formatação dos detalhes ----------

const FIELD_LABELS: Record<string, string> = {
  amountCents: 'Valor',
  priceCents: 'Preço',
  unitPriceCents: 'Preço unitário',
  openingFloatCents: 'Fundo de troco',
  couvertCents: 'Couvert',
  differenceCents: 'Diferença',
  tenderedCents: 'Valor entregue',
  changeCents: 'Troco',
  reason: 'Motivo',
  authorizedBy: 'Autorizado por',
  tableNumber: 'Mesa',
  table: 'Mesa',
  customerName: 'Cliente',
  peopleCount: 'Pessoas',
  register: 'Caixa',
  method: 'Forma de pagamento',
  payerName: 'Quem pagou',
  canceledQty: 'Qtd. cancelada',
  qty: 'Quantidade',
  product: 'Produto',
  name: 'Nome',
  login: 'Login',
  role: 'Perfil',
  active: 'Ativo',
  soldOut: 'Esgotado',
  description: 'Descrição',
  number: 'Número',
  area: 'Área',
  capacity: 'Lugares',
  serviceFeeEnabled: 'Taxa de serviço',
  companyName: 'Nome do estabelecimento',
  percentBps: 'Percentual',
  status: 'Situação',
  notes: 'Observação',
  expected: 'Esperado',
  counted: 'Contado',
  openComandas: 'Comandas abertas',
  wrongPins: 'Tentativas erradas',
  fiscalMode: 'Cupom fiscal',
  sectorLabel: 'Setor',
  windowsName: 'Impressora no Windows',
  guestWifiName: 'Wi-Fi dos clientes',
  qrBaseUrl: 'Endereço do QR',
  receiptFooter: 'Rodapé do cupom',
  items: 'Itens pagos',
  closedIds: 'Comandas quitadas',
  allocations: 'Comandas no pagamento',
  fiscalRequested: 'Cupom fiscal pedido',
  comandaIds: 'Comandas',
  comandas: 'Comandas',
  reopened: 'Comandas reabertas',
  cpfOnNote: 'CPF na nota',
  automatic: 'Automático',
  expectedCloseTime: 'Fecha às',
  tablesInService: 'Mesas no dia',
  couvert: 'Couvert do dia',
  newJobId: 'Nova impressão',
  deviceCents: 'Preço no celular',
  serverCents: 'Preço no servidor',
  hasPin: 'Tem PIN',
  categoryId: 'Categoria',
};

const visibleKey = (k: string) => k !== 'id' && !/Id$/.test(k) && !['createdAt', 'updatedAt', 'clientUuid', 'qrToken'].includes(k);
const fieldLabel = (k: string) => FIELD_LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^\w/, (c) => c.toUpperCase());
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (typeof v === 'number' && /Cents$/.test(key)) return formatBRL(v);
  if (key === 'percentBps' && typeof v === 'number') return `${v / 100}%`;
  if (key === 'method' && typeof v === 'string') return PAYMENT_METHOD_LABELS[v as PaymentMethod] ?? v;
  if (key === 'role' && typeof v === 'string') return ROLE_LABELS[v as Role] ?? v;
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    // Listas de ids (comandas, pagamentos) só interessam pela quantidade.
    if (v.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x))) return String(v.length);
    return v
      .map((x) => {
        const r = asRecord(x);
        if (!r) return String(x);
        const name = r.productName ?? r.product ?? r.name;
        const cents = r.amountCents ?? r.serverCents;
        const label = [typeof r.qty === 'number' ? `${r.qty}×` : '', typeof name === 'string' ? name : ''].join(' ').trim();
        return [label || null, typeof cents === 'number' ? formatBRL(cents) : null].filter(Boolean).join(' ') || '1 registro';
      })
      .join(' · ');
  }
  if (typeof v === 'object') {
    // Ex.: esperado/contado por forma de pagamento no fechamento do caixa.
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${PAYMENT_METHOD_LABELS[k as PaymentMethod] ?? fieldLabel(k)}: ${typeof x === 'number' ? formatBRL(x) : String(x)}`)
      .join(' · ');
  }
  return String(v);
}

/** Linha curta embaixo da ação: "Mesa 3 · Paulo · 1× Heineken · motivo: Lançado errado · autorizado por admin". */
function summarize(e: AuditEntry): string {
  const a = asRecord(e.after) ?? {};
  const b = asRecord(e.before) ?? {};
  const parts: string[] = [];
  const table = a.tableNumber ?? a.table;
  if (table !== undefined) parts.push(`Mesa ${table}`);
  if (typeof a.customerName === 'string') parts.push(a.customerName);
  if (typeof a.register === 'string') parts.push(a.register);
  if (e.action === 'ITEM_CANCELADO' && typeof b.product === 'string') parts.push(`${a.canceledQty ?? ''}× ${b.product}`);
  const name = a.name ?? b.name;
  if (typeof name === 'string' && !parts.includes(name)) parts.push(name);
  if (e.action === 'PRODUTO_PRECO_ALTERADO' && typeof b.priceCents === 'number' && typeof a.priceCents === 'number') {
    parts.push(`${formatBRL(b.priceCents)} → ${formatBRL(a.priceCents)}`);
  } else if (typeof a.amountCents === 'number') parts.push(formatBRL(a.amountCents));
  else if (typeof b.amountCents === 'number') parts.push(formatBRL(b.amountCents));
  if (typeof a.percentBps === 'number') parts.push(`${a.percentBps / 100}%`);
  if (typeof a.method === 'string') parts.push(PAYMENT_METHOD_LABELS[a.method as PaymentMethod] ?? a.method);
  if (typeof a.reason === 'string') parts.push(`motivo: ${a.reason}`);
  if (typeof a.authorizedBy === 'string') parts.push(`autorizado por ${a.authorizedBy}`);
  if (typeof a.differenceCents === 'number' && e.action === 'CAIXA_FECHADO') parts.push(`diferença ${formatBRL(a.differenceCents)}`);
  return parts.join(' · ');
}

// ---------- Planilha ----------

function downloadCsv(entries: AuditEntry[], from: string, to: string) {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ['Data e hora', 'Usuário', 'Perfil', 'Ação', 'Resumo', 'IP', 'Antes', 'Depois'],
    ...entries.map((e) => [
      dateTime(e.at),
      e.userName ?? '',
      e.userRole ? (ROLE_LABELS[e.userRole as Role] ?? e.userRole) : '',
      auditActionLabel(e.action),
      summarize(e),
      e.ip ?? '',
      e.before ? JSON.stringify(e.before) : '',
      e.after ? JSON.stringify(e.after) : '',
    ]),
  ];
  const csv = '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `auditoria-${from}${to !== from ? `-a-${to}` : ''}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
