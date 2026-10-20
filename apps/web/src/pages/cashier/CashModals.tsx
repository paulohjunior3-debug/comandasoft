import {
  centsToInput,
  formatBRL,
  formatLocalTime,
  parseBRL,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  periodLabel,
  WEEKDAY_NAMES,
  weekdayOf,
  type CashClosePreview,
  type CashCloseResult,
  type CashMovementType,
  type DayRules,
  type OpenCashSessionInput,
  type PaymentMethod,
} from '@sistema-bar/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, ErrorBanner, Loading, Modal, SelectField, TextField, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage, useApiMutation } from '../../lib/queries';

export interface DayRulesResponse {
  rules: DayRules | null;
  defaultCouvertCents: number;
  activeTables: number;
  /** Dia do movimento e período sugeridos para o primeiro caixa do dia. */
  suggested: { businessDate: string; period: number | null };
  /** Numeração da semana do bar (Configurações): [{ period: 1, weekday: 2 }, …]. */
  periods: { period: number; weekday: number }[];
}

const brDate = (d: string) => d.split('-').reverse().join('/');

/** Resumo das regras do dia: "Turno até 01:00 · 20 mesas · Couvert R$ 15,00 desde 14:00". */
export function describeRules(rules: DayRules): string {
  const parts: string[] = [`${periodLabel(rules.period, rules.businessDate)} · ${brDate(rules.businessDate)}`];
  if (rules.expectedCloseAt) parts.push(`turno até ${formatLocalTime(rules.expectedCloseAt)}`);
  if (rules.tablesInService) parts.push(`${rules.tablesInService} mesas`);
  // Couvert por show: diz se está valendo agora (ou programado), senão "sem couvert agora".
  const open = rules.couvertWindows.find((w) => !w.endAt);
  if (open && Date.parse(open.startAt) <= Date.now()) parts.push(`couvert ${formatBRL(open.amountCents)}/pessoa ativo desde ${formatLocalTime(open.startAt)}`);
  else if (open) parts.push(`couvert ${formatBRL(open.amountCents)}/pessoa a partir de ${formatLocalTime(open.startAt)}`);
  else parts.push(rules.couvertWindows.length ? 'sem couvert agora (encerrado)' : 'sem couvert');
  return parts.join(' · ');
}

/**
 * Abertura do caixa (SPEC 5.7 + decisões do dono): fundo de troco e, no primeiro caixa do dia,
 * o turno (até que horas, pode passar da meia-noite), quantas mesas funcionam e o couvert do dia.
 */
export function OpenCashForm({ registerId, registerName }: { registerId: string; registerName: string }) {
  const day = useQuery({ queryKey: ['/cashier/session/day-rules'], queryFn: () => api<DayRulesResponse>('/cashier/session/day-rules') });
  const open = useApiMutation<OpenCashSessionInput>(['/cashier/session', '/cashier/session/day-rules', '/cashier/session/registers']);
  const [float, setFloat] = useState('');
  const [closeTime, setCloseTime] = useState('');
  const [tables, setTables] = useState('');
  const [hasCouvert, setHasCouvert] = useState(false);
  const [couvert, setCouvert] = useState('');
  const [couvertFrom, setCouvertFrom] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [period, setPeriod] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!day.data) return;
    if (day.data.activeTables && !tables) setTables(String(day.data.activeTables));
    if (day.data.defaultCouvertCents && !couvert) setCouvert(centsToInput(day.data.defaultCouvertCents));
    if (!businessDate) {
      setBusinessDate(day.data.suggested.businessDate);
      setPeriod(day.data.suggested.period ? String(day.data.suggested.period) : 'extra');
    }
  }, [day.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rules = day.data?.rules ?? null;
  const firstOfDay = !rules;

  const submit = () => {
    const floatCents = parseBRL(float || '0');
    if (floatCents === null) return setError('Fundo de troco inválido. Exemplo: 150,00');
    const body: OpenCashSessionInput = { registerId, openingFloatCents: floatCents };
    if (closeTime) body.expectedCloseTime = closeTime;
    if (firstOfDay) {
      if (businessDate) body.businessDate = businessDate;
      body.period = period && period !== 'extra' ? Number(period) : null;
      if (tables) {
        const n = Number(tables);
        if (!Number.isInteger(n) || n < 1) return setError('Número de mesas inválido.');
        body.tablesInService = n;
      }
      if (hasCouvert) {
        const c = parseBRL(couvert);
        if (!c) return setError('Informe o valor do couvert por pessoa.');
        if (!couvertFrom) return setError('Informe a partir de que horas o couvert é cobrado.');
        body.couvert = { amountCents: c, startTime: couvertFrom };
      }
    }
    setError(null);
    open.mutate({ method: 'POST', path: '/cashier/session/open', body });
  };

  return (
    <div className="mx-auto mt-10 max-w-md space-y-4 rounded-2xl bg-slate-900 p-6">
      <div>
        <h2 className="text-xl font-semibold">Abrir {registerName}</h2>
        <p className="text-sm text-slate-400">
          {firstOfDay ? 'Primeiro caixa do dia: defina o dia, o turno, as mesas e o couvert.' : 'As regras do dia já foram definidas.'}
        </p>
      </div>
      <ErrorBanner message={error ?? errorMessage(open.error ?? day.error)} />
      {day.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Fundo de troco (R$)" inputMode="decimal" placeholder="0,00" autoFocus value={float} onChange={(e) => setFloat(e.target.value)} />
            <TextField
              label="Fecha às"
              type="time"
              value={closeTime}
              onChange={(e) => setCloseTime(e.target.value)}
              hint="Pode passar da meia-noite (ex.: 01:00)"
            />
          </div>

          {rules ? (
            <p className="rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-300">
              Definido pelo {rules.registerName}: {describeRules(rules)}.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Dia do movimento"
                  type="date"
                  value={businessDate}
                  onChange={(e) => {
                    const d = e.target.value;
                    setBusinessDate(d);
                    // Muda o dia: o período acompanha a semana do bar (dá para trocar depois).
                    const p = d ? day.data?.periods.find((x) => x.weekday === weekdayOf(d)) : undefined;
                    setPeriod(p ? String(p.period) : 'extra');
                  }}
                  hint="Abrindo de madrugada pelo movimento de ontem? Deixe ontem."
                />
                <SelectField label="Período" value={period} onChange={(e) => setPeriod(e.target.value)}>
                  {day.data?.periods.map((p) => (
                    <option key={p.period} value={p.period}>
                      Período {p.period} ({WEEKDAY_NAMES[p.weekday]})
                    </option>
                  ))}
                  <option value="extra">Dia extra (sem número)</option>
                </SelectField>
              </div>
              <TextField
                label="Mesas em funcionamento hoje"
                inputMode="numeric"
                value={tables}
                onChange={(e) => setTables(e.target.value.replace(/\D/g, ''))}
                hint={`O garçom vê só as primeiras mesas pela numeração. Cadastradas: ${day.data?.activeTables ?? '?'}.`}
              />
              <Toggle label="Terá couvert hoje" checked={hasCouvert} onChange={setHasCouvert} />
              {hasCouvert && (
                <div className="grid grid-cols-2 gap-3">
                  <TextField label="Couvert por pessoa (R$)" inputMode="decimal" value={couvert} onChange={(e) => setCouvert(e.target.value)} />
                  <TextField label="A partir de" type="time" value={couvertFrom} onChange={(e) => setCouvertFrom(e.target.value)} />
                  <p className="col-span-2 text-xs text-slate-500">
                    Comanda aberta depois desse horário já entra com couvert (× pessoas). Quem chegou antes paga se ainda estiver
                    na mesa 15 minutos depois do início.
                  </p>
                </div>
              )}
            </>
          )}

          <Button variant="primary" className="w-full py-3" onClick={submit} disabled={open.isPending}>
            Abrir caixa
          </Button>
        </>
      )}
    </div>
  );
}

/** Sangria (retirada) ou suprimento (entrada), com motivo e comprovante impresso. */
export function MovementModal({ registerId, type, onClose }: { registerId: string; type: CashMovementType; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation<unknown, { printed: boolean }>(['/cashier/session']);
  const submit = () => {
    const cents = parseBRL(amount);
    if (!cents) return setError('Informe o valor.');
    setError(null);
    save.mutate({ method: 'POST', path: '/cashier/session/movements', body: { registerId, type, amountCents: cents, reason } }, { onSuccess: onClose });
  };
  return (
    <Modal
      title={type === 'SANGRIA' ? 'Sangria (retirada)' : 'Suprimento (entrada)'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Registrar</Button>
        </>
      }
    >
      <ErrorBanner message={error ?? errorMessage(save.error)} />
      <TextField label="Valor (R$)" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
      <TextField
        label="Motivo"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={type === 'SANGRIA' ? 'Ex.: depósito no banco' : 'Ex.: troco extra'}
      />
      <p className="text-xs text-slate-500">Sai um comprovante na impressora do caixa para assinatura.</p>
    </Modal>
  );
}

/** Fechamento: o sistema calcula o esperado, o operador informa o contado e vê a diferença (SPEC 5.7). */
export function CloseCashModal({ registerId, onClose }: { registerId: string; onClose: () => void }) {
  const preview = useQuery({
    queryKey: ['close-preview', registerId],
    queryFn: () => api<CashClosePreview>(`/cashier/session/close-preview?registerId=${registerId}`),
  });
  const close = useApiMutation<unknown, CashCloseResult & { printed: boolean }>([
    '/cashier/session',
    '/cashier/tables',
    '/cashier/session/day-rules',
    '/cashier/session/registers',
  ]);
  const [counted, setCounted] = useState<Record<PaymentMethod, string>>({ DINHEIRO: '', CREDITO: '', DEBITO: '', PIX: '' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;

  const parsed = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, counted[m].trim() === '' ? undefined : parseBRL(counted[m])])) as Record<
    PaymentMethod,
    number | null | undefined
  >;
  const diff = (m: PaymentMethod) => (p && typeof parsed[m] === 'number' ? parsed[m]! - p.expected[m] : null);
  const totalDiff = PAYMENT_METHODS.reduce((s, m) => s + (diff(m) ?? 0), 0);

  const submit = () => {
    if (typeof parsed.DINHEIRO !== 'number') return setError('Conte e informe o dinheiro da gaveta.');
    if (PAYMENT_METHODS.some((m) => parsed[m] === null)) return setError('Há um valor inválido.');
    if (p && p.openComandas > 0 && !confirmOpen) return setError('Confirme que deseja fechar com comandas abertas.');
    setError(null);
    const body = {
      registerId,
      counted: Object.fromEntries(PAYMENT_METHODS.filter((m) => typeof parsed[m] === 'number').map((m) => [m, parsed[m]])),
      confirmOpenComandas: confirmOpen,
      notes: notes || undefined,
    };
    close.mutate({ method: 'POST', path: '/cashier/session/close', body });
  };

  if (close.data) {
    const r = close.data;
    return (
      <Modal title="Caixa fechado" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Concluir</Button>}>
        <p
          className={`rounded-xl p-4 text-center text-2xl font-semibold ${r.differenceCents === 0 ? 'bg-emerald-950 text-emerald-300' : r.differenceCents > 0 ? 'bg-sky-950 text-sky-200' : 'bg-red-950 text-red-300'}`}
        >
          {r.differenceCents === 0 ? 'Sem diferença' : `${r.differenceCents > 0 ? 'Sobra' : 'Falta'} de ${formatBRL(Math.abs(r.differenceCents))}`}
        </p>
        <p className="text-sm text-slate-400">
          {r.printed ? 'O relatório de fechamento foi para a impressora do caixa.' : 'Sem impressora do caixa configurada: relatório não impresso.'}
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title={p ? `Fechar ${p.session.registerName}` : 'Fechar caixa'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={close.isPending || !p}>Fechar caixa</Button>
        </>
      }
    >
      <ErrorBanner message={error ?? errorMessage(preview.error ?? close.error)} />
      {!p ? (
        <Loading />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="py-1 font-normal">Forma</th>
                <th className="py-1 text-right font-normal">Esperado</th>
                <th className="py-1 pl-3 font-normal">Contado</th>
                <th className="py-1 text-right font-normal">Diferença</th>
              </tr>
            </thead>
            <tbody>
              {PAYMENT_METHODS.map((m) => {
                const d = diff(m);
                return (
                  <tr key={m} className="border-t border-slate-800">
                    <td className="py-2">
                      {PAYMENT_METHOD_LABELS[m]}
                      {m === 'DINHEIRO' && <span className="text-red-400"> *</span>}
                    </td>
                    <td className="py-2 text-right">{formatBRL(p.expected[m])}</td>
                    <td className="py-2 pl-3">
                      <input
                        inputMode="decimal"
                        aria-label={`Contado em ${PAYMENT_METHOD_LABELS[m]}`}
                        placeholder={m === 'DINHEIRO' ? 'obrigatório' : 'opcional'}
                        value={counted[m]}
                        onChange={(e) => setCounted((c) => ({ ...c, [m]: e.target.value }))}
                        className="w-28 rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 outline-none focus:border-amber-500"
                      />
                    </td>
                    <td className={`py-2 text-right ${d === null || d === 0 ? 'text-slate-400' : d > 0 ? 'text-sky-300' : 'text-red-300'}`}>
                      {d === null ? '—' : `${d > 0 ? '+' : ''}${formatBRL(d)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-slate-500">
            Dinheiro esperado = fundo {formatBRL(p.session.openingFloatCents)} + suprimentos − sangrias + recebido em dinheiro neste caixa.
          </p>
          <p className="text-right font-semibold">
            Diferença total: <span className={totalDiff < 0 ? 'text-red-300' : totalDiff > 0 ? 'text-sky-300' : ''}>{formatBRL(totalDiff)}</span>
          </p>
          {p.openComandas > 0 && (
            <div className="rounded-lg bg-amber-950 p-3">
              <p className="mb-2 text-sm text-amber-200">Atenção: {p.openComandas} comanda(s) ainda aberta(s) e este é o último caixa aberto.</p>
              <Toggle label="Fechar o caixa mesmo assim" checked={confirmOpen} onChange={setConfirmOpen} />
            </div>
          )}
          <TextField label="Observações (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </>
      )}
    </Modal>
  );
}
