import {
  formatBRL,
  localDate,
  matchesSearch,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  type CashRegister,
  periodLabel,
  periodTable,
  WEEKDAY_NAMES,
  type ReceivedTotals,
  type SalesReport,
  type Settings,
} from '@sistema-bar/shared';
import { useState, type ReactNode } from 'react';
import { Button, EmptyState, ErrorBanner, Loading, PageHeader, SelectField, TextField } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { errorMessage, useApiQuery } from '../../lib/queries';

const DAY = 24 * 60 * 60 * 1000;
/** Ordem das colunas: como o dono confere a gaveta (espécie), depois Pix e cartão. */
const METHOD_ORDER = ['DINHEIRO', 'PIX', 'CREDITO', 'DEBITO'] as const satisfies readonly PaymentMethod[];
const shift = (date: string, days: number) => localDate(new Date(Date.parse(`${date}T12:00:00-03:00`) + days * DAY));

/** Atalhos de período, em dias de operação (data em que o caixa abriu). */
function presets(): { label: string; from: string; to: string }[] {
  const today = localDate(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const prevMonthEnd = shift(monthStart, -1);
  return [
    { label: 'Hoje', from: today, to: today },
    { label: 'Ontem', from: shift(today, -1), to: shift(today, -1) },
    { label: '7 dias', from: shift(today, -6), to: today },
    { label: 'Este mês', from: monthStart, to: today },
    { label: 'Mês passado', from: `${prevMonthEnd.slice(0, 8)}01`, to: prevMonthEnd },
  ];
}

/** "19/10/2026" a partir de "2026-10-19". */
const br = (date: string) => date.split('-').reverse().join('/');
const weekday = (date: string) => new Date(`${date}T12:00:00-03:00`).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'America/Sao_Paulo' });

/** Relatórios (SPEC 5.9): vendas por data e resumo das entradas por caixa, forma de pagamento e cupom fiscal. */
export function ReportsPage() {
  const initial = presets()[0]!;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [registerId, setRegisterId] = useState('');
  const [period, setPeriod] = useState('');
  const registers = useApiQuery<CashRegister[]>('/admin/registers');
  const settings = useApiQuery<Settings>('/admin/settings');
  const periods = settings.data ? periodTable(settings.data) : [];
  const qs = new URLSearchParams({ from, to, ...(registerId ? { registerId } : {}), ...(period ? { period } : {}) });
  const report = useApiQuery<SalesReport>(`/admin/reports/sales?${qs}`, Boolean(from && to));
  const r = report.data;
  const registerName = registers.data?.find((x) => x.id === registerId)?.name;

  return (
    <>
      <PageHeader
        title="Relatórios"
        description="Vendas e entradas pelo dia do movimento informado na abertura do caixa (o turno que passa da meia-noite continua no mesmo dia)."
        action={
          r && (
            <div className="flex gap-2 print:hidden">
              <Button onClick={() => downloadCsv(r, registerName)}>Exportar planilha</Button>
              <Button onClick={() => window.print()}>Imprimir</Button>
            </div>
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
          <SelectField label="Caixa" value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
            <option value="">Todos os caixas</option>
            {registers.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Período"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            hint={period ? 'Ex.: Período 5 em "Este mês" = todos os dias desse período no mês.' : undefined}
          >
            <option value="">Todos</option>
            {periods.map((p) => (
              <option key={p.period} value={p.period}>
                Período {p.period} ({WEEKDAY_NAMES[p.weekday]})
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      <p className="mb-4 hidden text-sm print:block">
        Datas: {br(from)} a {br(to)} · {registerName ?? 'Todos os caixas'}
        {period && ` · Período ${period}`}
      </p>

      <ErrorBanner message={errorMessage(report.error)} />
      {report.isLoading ? <Loading /> : r && <ReportBody r={r} />}
    </>
  );
}

function ReportBody({ r }: { r: SalesReport }) {
  if (r.cash.sessions === 0) return <EmptyState>Nenhum caixa aberto nessas datas.</EmptyState>;
  const rc = r.received;

  return (
    <div className="space-y-5">
      {/* ---- Entradas ---- */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Total recebido" value={rc.totalCents} strong note={`${rc.payments} pagamento(s)`} />
        <Card label="Dinheiro (espécie)" value={rc.byMethod.DINHEIRO} />
        <Card label="Pix" value={rc.byMethod.PIX} />
        <Card label="Cartão" value={rc.cardCents} note={`Crédito ${formatBRL(rc.byMethod.CREDITO)} · Débito ${formatBRL(rc.byMethod.DEBITO)}`} />
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          label="Cupom fiscal (NFC-e)"
          value={r.fiscal.requestedCents}
          note={`${r.fiscal.comandas} comanda(s) · ${r.fiscal.automatic} automático(s)${r.fiscal.pending ? ' · aguardando o módulo fiscal' : ''}`}
        />
        <Card label="Sem nota fiscal" value={r.fiscal.withoutNoteCents} />
        <Card label="Estornos" value={r.refunds.totalCents} note={`${r.refunds.count} estorno(s), fora do total`} tone={r.refunds.count ? 'warn' : undefined} />
        <Card
          label="Diferença nos fechamentos"
          value={r.cash.differenceCents}
          signed
          note={r.cash.openSessions ? `${r.cash.openSessions} caixa(s) ainda aberto(s)` : 'sobra (+) ou falta (−)'}
          tone={r.cash.differenceCents < 0 ? 'bad' : r.cash.differenceCents > 0 ? 'warn' : undefined}
        />
      </section>
      {r.fiscal.pending > 0 && (
        <p className="text-xs text-slate-500">
          A emissão da NFC-e entra na próxima fase do sistema. Os valores de cupom fiscal são os pedidos registrados no caixa, que serão emitidos quando o módulo fiscal for ligado.
        </p>
      )}

      {/* ---- Vendas e caixa ---- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Vendas (comandas fechadas)">
          <Rows
            rows={[
              ['Comandas', String(r.sales.comandas)],
              ['Pessoas', String(r.sales.people)],
              ['Itens', formatBRL(r.sales.itemsCents)],
              ['Taxa de serviço', formatBRL(r.sales.serviceFeeCents)],
              ['Couvert', formatBRL(r.sales.couvertCents)],
              ['Descontos', r.sales.discountCents ? `− ${formatBRL(r.sales.discountCents)}` : formatBRL(0)],
              ['Total vendido', formatBRL(r.sales.totalCents), true],
              ['Ticket médio por comanda', formatBRL(r.sales.averageTicketCents)],
            ]}
          />
        </Panel>
        <Panel title="Caixa (dinheiro na gaveta)">
          <Rows
            rows={[
              ['Aberturas de caixa', String(r.cash.sessions)],
              ['Fundo de troco (aberturas)', formatBRL(r.cash.openingFloatCents)],
              ['Recebido em dinheiro', formatBRL(rc.byMethod.DINHEIRO)],
              ['Suprimentos', formatBRL(r.cash.suprimentoCents)],
              ['Sangrias', r.cash.sangriaCents ? `− ${formatBRL(r.cash.sangriaCents)}` : formatBRL(0)],
              ['Diferença nos fechamentos', signedBRL(r.cash.differenceCents), true],
            ]}
          />
        </Panel>
      </div>

      {/* ---- Por dia ---- */}
      <Panel title="Vendas por data">
        <MethodTable
          first="Data"
          rows={r.days.map((d) => ({
            key: d.date,
            label: (
              <>
                {br(d.date)} <span className="text-xs text-slate-500">{weekday(d.date)}</span>
                <span className="block text-xs text-amber-300/80">{periodLabel(d.period)}</span>
              </>
            ),
            totals: d,
            extra: [String(d.comandas), formatBRL(d.salesCents)],
          }))}
          extraHeads={['Comandas', 'Vendido']}
          total={rc}
          totalExtra={[String(r.sales.comandas), formatBRL(r.sales.totalCents)]}
        />
      </Panel>

      {/* ---- Por produto ---- */}
      <Products products={r.products} />

      {/* ---- Por caixa ---- */}
      <Panel title="Entradas por caixa">
        <MethodTable
          first="Caixa"
          rows={r.registers.map((x) => ({ key: x.registerId, label: x.name, totals: x, extra: [String(x.sessions)] }))}
          extraHeads={['Aberturas']}
          total={rc}
          totalExtra={[String(r.cash.sessions)]}
        />
      </Panel>

      {/* ---- Garçons (bonificação) ---- */}
      <Waiters waiters={r.waiters} />

      {/* ---- Sessões ---- */}
      <Panel title="Aberturas e fechamentos de caixa">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr>
                <Th>Caixa</Th>
                <Th>Abertura</Th>
                <Th>Fechamento</Th>
                <Th right>Fundo</Th>
                <Th right>Recebido</Th>
                <Th right>Sangria</Th>
                <Th right>Diferença</Th>
              </tr>
            </thead>
            <tbody>
              {r.sessions.map((s) => (
                <tr key={s.id} className="border-t border-slate-800">
                  <Td>{s.registerName}</Td>
                  <Td>
                    {br(s.date)} · {s.period ? `P${s.period}` : 'extra'} · {formatTime(s.openedAt)}
                    <span className="block text-xs text-slate-500">{s.openedBy}</span>
                  </Td>
                  <Td>
                    {s.closedAt ? (
                      <>
                        {formatTime(s.closedAt)}
                        <span className="block text-xs text-slate-500">{s.closedBy}</span>
                      </>
                    ) : (
                      <span className="text-amber-300">aberto</span>
                    )}
                  </Td>
                  <Td right>{formatBRL(s.openingFloatCents)}</Td>
                  <Td right>{formatBRL(s.receivedCents)}</Td>
                  <Td right>{s.sangriaCents ? formatBRL(s.sangriaCents) : '—'}</Td>
                  <Td right className={s.differenceCents && s.differenceCents < 0 ? 'text-red-300' : ''}>
                    {s.differenceCents === null ? '—' : signedBRL(s.differenceCents)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

    </div>
  );
}

/**
 * Vendas por garçom, para a bonificação: o que cada um lançou nas comandas fechadas do período,
 * a taxa de serviço proporcional e quantas vezes tocou em "Atendi a mesa".
 */
function Waiters({ waiters }: { waiters: SalesReport['waiters'] }) {
  if (waiters.length === 0) return null;
  const topSales = waiters.reduce((a, b) => (b.itemsCents > a.itemsCents ? b : a)).userId;
  const topVisits = waiters.reduce((a, b) => (b.visits > a.visits ? b : a));
  return (
    <Panel title="Vendas por garçom (bonificação)">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-400">
            <tr>
              <Th>Garçom</Th>
              <Th right>Vendido</Th>
              <Th right>Taxa de serviço</Th>
              <Th right>Itens</Th>
              <Th right>Pedidos</Th>
              <Th right>Comandas</Th>
              <Th right>Mesas</Th>
              <Th right>Atendi a mesa</Th>
            </tr>
          </thead>
          <tbody>
            {waiters.map((w) => (
              <tr key={w.userId} className="border-t border-slate-800">
                <Td>
                  {w.name}
                  {w.userId === topSales && w.itemsCents > 0 && <span title="Quem mais vendeu"> 🏆</span>}
                  {w.userId === topVisits.userId && topVisits.visits > 0 && <span title="Quem mais atendeu mesas"> ⭐</span>}
                </Td>
                <Td right className="font-semibold">{formatBRL(w.itemsCents)}</Td>
                <Td right>{formatBRL(w.serviceFeeCents)}</Td>
                <Td right>{w.qty}</Td>
                <Td right>{w.orders}</Td>
                <Td right>{w.comandas}</Td>
                <Td right>{w.tables}</Td>
                <Td right>{w.visits}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        🏆 quem mais vendeu · ⭐ quem mais tocou em "Atendi a mesa". Vendido = itens que a pessoa lançou nas comandas fechadas (sem taxa e
        couvert). A taxa de serviço de cada comanda é dividida pelo valor que cada um lançou nela. Caixa e gerente aparecem se lançaram pedidos.
      </p>
    </Panel>
  );
}

function Products({ products }: { products: SalesReport['products'] }) {
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const q = search.trim();
  // Busca sem acento: "file" acha "Filé à parmegiana".
  const found = q ? products.filter((p) => matchesSearch(p.name, q)) : products;
  const shown = q || all ? found : found.slice(0, 15);
  const total = found.reduce((acc, p) => ({ qty: acc.qty + p.qty, cents: acc.cents + p.totalCents }), { qty: 0, cents: 0 });

  return (
    <Panel title="Vendas por produto">
      <div className="mb-3 flex flex-wrap items-end gap-3 print:hidden">
        <div className="min-w-56 flex-1">
          <TextField
            label="Produto"
            type="search"
            placeholder="Ex.: filé, heineken, porção"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            hint="Usa as datas, o caixa e o período escolhidos acima. Conta as comandas já fechadas."
          />
        </div>
      </div>
      {q && <p className="mb-3 hidden text-sm print:block">Produto: {q}</p>}

      {q && found.length > 0 && (
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-800 p-3 print:border print:border-slate-300 print:bg-white">
            <p className="text-xs text-slate-400 uppercase">Quantidade vendida</p>
            <p className="text-2xl font-semibold tabular-nums text-amber-400">{total.qty}</p>
          </div>
          <div className="rounded-lg bg-slate-800 p-3 print:border print:border-slate-300 print:bg-white">
            <p className="text-xs text-slate-400 uppercase">Valor vendido</p>
            <p className="text-2xl font-semibold tabular-nums">{formatBRL(total.cents)}</p>
          </div>
        </div>
      )}

      {found.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">
          {q ? `Nenhuma venda de "${q}" nessas datas.` : 'Nenhuma comanda fechada nessas datas.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr>
                <Th>{q ? 'Produto / data' : 'Produto'}</Th>
                <Th right>Qtd.</Th>
                <Th right>Valor</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <ProductRows key={p.name} product={p} withDays={Boolean(q)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!q && found.length > 15 && (
        <button onClick={() => setAll((v) => !v)} className="mt-2 text-sm text-amber-400 print:hidden">
          {all ? 'Mostrar só os 15 primeiros' : `Mostrar todos (${found.length})`}
        </button>
      )}
    </Panel>
  );
}

/** Linha do produto e, na busca, uma linha por dia em que ele vendeu. */
function ProductRows({ product: p, withDays }: { product: SalesReport['products'][number]; withDays: boolean }) {
  return (
    <>
      <tr className="border-t border-slate-800 font-medium">
        <Td>{p.name}</Td>
        <Td right>{p.qty}</Td>
        <Td right>{formatBRL(p.totalCents)}</Td>
      </tr>
      {withDays &&
        p.days.map((d) => (
          <tr key={d.date} className="text-slate-400">
            <Td className="pl-6">
              {br(d.date)} <span className="text-xs text-slate-500">{weekday(d.date)}</span>
            </Td>
            <Td right>{d.qty}</Td>
            <Td right>{formatBRL(d.totalCents)}</Td>
          </tr>
        ))}
    </>
  );
}

// ---------- Peças ----------

const signedBRL = (cents: number) => (cents > 0 ? `+ ${formatBRL(cents)}` : cents < 0 ? `− ${formatBRL(-cents)}` : formatBRL(0));

function Card({ label, value, note, strong, signed, tone }: { label: string; value: number; note?: string; strong?: boolean; signed?: boolean; tone?: 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-red-300' : tone === 'warn' ? 'text-amber-300' : strong ? 'text-amber-400' : '';
  return (
    <div className="rounded-xl bg-slate-900 p-4 print:border print:border-slate-300 print:bg-white">
      <p className="text-xs font-medium tracking-wide text-slate-400 uppercase">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{signed ? signedBRL(value) : formatBRL(value)}</p>
      {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-slate-900 p-4 print:break-inside-avoid print:border print:border-slate-300 print:bg-white">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-slate-400 uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, string, boolean?][] }) {
  return (
    <dl className="space-y-1 text-sm">
      {rows.map(([k, v, strong]) => (
        <div key={k} className={`flex justify-between gap-3 ${strong ? 'border-t border-slate-800 pt-1 font-semibold' : ''}`}>
          <dt className={strong ? '' : 'text-slate-400'}>{k}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const Th = ({ children, right }: { children: ReactNode; right?: boolean }) => (
  <th className={`px-2 py-1.5 font-medium whitespace-nowrap ${right ? 'text-right' : ''}`}>{children}</th>
);
const Td = ({ children, right, className = '' }: { children: ReactNode; right?: boolean; className?: string }) => (
  <td className={`px-2 py-2 ${right ? 'text-right tabular-nums whitespace-nowrap' : ''} ${className}`}>{children}</td>
);

function MethodTable({
  first,
  rows,
  extraHeads,
  total,
  totalExtra,
}: {
  first: string;
  rows: { key: string; label: ReactNode; totals: ReceivedTotals; extra: string[] }[];
  extraHeads: string[];
  total: ReceivedTotals;
  totalExtra: string[];
}) {
  const cells = (t: ReceivedTotals) => [
    ...METHOD_ORDER.map((m) => formatBRL(t.byMethod[m])),
    formatBRL(t.totalCents),
    formatBRL(t.fiscalCents),
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-400">
          <tr>
            <Th>{first}</Th>
            {METHOD_ORDER.map((m) => (
              <Th key={m} right>
                {m === 'DINHEIRO' ? 'Espécie' : PAYMENT_METHOD_LABELS[m]}
              </Th>
            ))}
            <Th right>Total</Th>
            <Th right>Fiscal</Th>
            {extraHeads.map((h) => (
              <Th key={h} right>
                {h}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-slate-800">
              <Td>{row.label}</Td>
              {[...cells(row.totals), ...row.extra].map((c, i) => (
                <Td key={i} right>
                  {c}
                </Td>
              ))}
            </tr>
          ))}
          {rows.length > 1 && (
            <tr className="border-t-2 border-slate-700 font-semibold">
              <Td>Total</Td>
              {[...cells(total), ...totalExtra].map((c, i) => (
                <Td key={i} right>
                  {c}
                </Td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Planilha (CSV para o Excel em português) ----------

function downloadCsv(r: SalesReport, registerName: string | undefined) {
  const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const lines: (string | number)[][] = [
    ['Relatório de vendas e entradas'],
    ['Datas', `${br(r.from)} a ${br(r.to)}`],
    ...(r.period ? [['Período', r.period]] : []),
    ['Caixa', registerName ?? 'Todos os caixas'],
    [],
    ['Resumo', 'Valor (R$)'],
    ['Total recebido', money(r.received.totalCents)],
    ...METHOD_ORDER.map((m) => [m === 'DINHEIRO' ? 'Dinheiro (espécie)' : PAYMENT_METHOD_LABELS[m], money(r.received.byMethod[m])]),
    ['Cartão (crédito + débito)', money(r.received.cardCents)],
    ['Cupom fiscal pedido', money(r.fiscal.requestedCents)],
    ['Sem nota fiscal', money(r.fiscal.withoutNoteCents)],
    ['Estornos', money(r.refunds.totalCents)],
    ['Total vendido (comandas fechadas)', money(r.sales.totalCents)],
    ['Comandas', r.sales.comandas],
    ['Ticket médio', money(r.sales.averageTicketCents)],
    ['Taxa de serviço', money(r.sales.serviceFeeCents)],
    ['Couvert', money(r.sales.couvertCents)],
    ['Descontos', money(r.sales.discountCents)],
    ['Fundo de troco', money(r.cash.openingFloatCents)],
    ['Suprimentos', money(r.cash.suprimentoCents)],
    ['Sangrias', money(r.cash.sangriaCents)],
    ['Diferença nos fechamentos', money(r.cash.differenceCents)],
    [],
    ['Data', 'Período', 'Espécie', 'Pix', 'Crédito', 'Débito', 'Total', 'Fiscal', 'Comandas', 'Vendido'],
    ...r.days.map((d) => [br(d.date), d.period ?? 'extra', money(d.byMethod.DINHEIRO), money(d.byMethod.PIX), money(d.byMethod.CREDITO), money(d.byMethod.DEBITO), money(d.totalCents), money(d.fiscalCents), d.comandas, money(d.salesCents)]),
    [],
    ['Caixa', 'Espécie', 'Pix', 'Crédito', 'Débito', 'Total', 'Fiscal', 'Aberturas'],
    ...r.registers.map((x) => [x.name, money(x.byMethod.DINHEIRO), money(x.byMethod.PIX), money(x.byMethod.CREDITO), money(x.byMethod.DEBITO), money(x.totalCents), money(x.fiscalCents), x.sessions]),
    [],
    ['Garçom', 'Vendido', 'Taxa de serviço', 'Itens', 'Pedidos', 'Comandas', 'Mesas', 'Atendi a mesa'],
    ...r.waiters.map((w) => [w.name, money(w.itemsCents), money(w.serviceFeeCents), w.qty, w.orders, w.comandas, w.tables, w.visits]),
    [],
    ['Produto', 'Quantidade', 'Valor'],
    ...r.products.map((p) => [p.name, p.qty, money(p.totalCents)]),
    [],
    ['Produto', 'Data', 'Quantidade', 'Valor'],
    ...r.products.flatMap((p) => p.days.map((d) => [p.name, br(d.date), d.qty, money(d.totalCents)])),
  ];
  const cell = (v: string | number) => {
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM + ";" : o Excel em português abre com acentos e colunas certas.
  const csv = '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `vendas-${r.from}${r.to !== r.from ? `-a-${r.to}` : ''}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
