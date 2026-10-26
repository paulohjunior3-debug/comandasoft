import {
  FISCAL_ENVIRONMENT_LABELS,
  FISCAL_ENVIRONMENTS,
  formatBRL,
  localDate,
  ORIGIN_LABELS,
  TAX_REGIME_LABELS,
  TAX_REGIMES,
  UFS,
  type CertificateInfo,
  type FiscalDocumentRow,
  type FiscalEnvironment,
  type FiscalMonthSummary,
  type FiscalSettings,
  type FiscalStatus,
  type NfceEmitResult,
  type PendingNfce,
  type SefazStatusResult,
  type TaxRegime,
} from '@sistema-bar/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, Button, ErrorBanner, Loading, PageHeader, SelectField, TextField, Toggle } from '../../components/ui';
import { apiDownload } from '../../lib/api';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const STATUS = '/admin/fiscal/status';
const DOCS = '/admin/fiscal/documents';
const PENDING = '/admin/fiscal/pending';
const dateBR = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * Admin → Fiscal (SPEC 5.8): emissão da NFC-e direto com a SEFAZ-MG. Primeiro em homologação
 * (teste, sem valor fiscal), depois em produção. O certificado e o CSC ficam cifrados no
 * servidor e nunca voltam para a tela.
 */
export function FiscalPage() {
  const status = useApiQuery<FiscalStatus>(STATUS);
  const s = status.data;
  if (!s) return status.isError ? <ErrorBanner message={errorMessage(status.error)} /> : <Loading />;
  const done = s.readiness.filter((r) => r.ok).length;

  return (
    <>
      <PageHeader
        title="Fiscal (NFC-e)"
        description="Emissão da NFC-e direto com a SEFAZ-MG. Teste tudo em homologação (sem valor fiscal) antes de passar para produção, junto com o contador."
        action={
          <Link to="/admin/fiscal/produtos" className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-800">
            Dados fiscais dos produtos
          </Link>
        }
      />
      <div className="space-y-5">
        <Section title={`O que falta para emitir (${done} de ${s.readiness.length})`}>
          <ul className="space-y-1.5 text-sm">
            {s.readiness.map((r) => (
              <li key={r.key} className="flex gap-2">
                <span className={r.ok ? 'text-emerald-400' : 'text-amber-400'}>{r.ok ? '✓' : '○'}</span>
                <span className={r.ok ? 'text-slate-300' : ''}>
                  {r.label}
                  {!r.ok && r.hint && <span className="block text-xs text-slate-500">{r.hint}</span>}
                </span>
              </li>
            ))}
          </ul>
          {s.productsMissingNcm > 0 && (
            <Link to="/admin/fiscal/produtos?sem-ncm=1" className="inline-block text-sm text-amber-400">
              Preencher o NCM dos {s.productsMissingNcm} produto(s) que faltam ›
            </Link>
          )}
        </Section>

        <EmissionSection environment={s.settings.environment} enabled={s.settings.emissionEnabled} />
        <CertificateSection certificate={s.certificate} emitterCnpj={s.settings.cnpj} />
        <CscSection environment="HOMOLOGACAO" configured={s.cscHomConfigured} cscId={s.cscHomId} />
        <CscSection environment="PRODUCAO" configured={s.cscConfigured} cscId={s.cscId} />
        <SettingsSection initial={s.settings} />
        <XmlSection />
      </div>
    </>
  );
}

// ---------- Certificado A1 ----------

function CertificateSection({ certificate: c, emitterCnpj }: { certificate: CertificateInfo | null; emitterCnpj: string }) {
  const upload = useApiMutation<{ pfxBase64: string; password: string }>([STATUS]);
  const remove = useApiMutation([STATUS]);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const send = async () => {
    if (!file) return setLocalError('Escolha o arquivo do certificado (.pfx ou .p12).');
    if (!password) return setLocalError('Informe a senha do certificado.');
    setLocalError(null);
    const pfxBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      reader.readAsDataURL(file);
    });
    upload.mutate(
      { method: 'POST', path: '/admin/fiscal/certificate', body: { pfxBase64, password } },
      {
        onSuccess: () => {
          setFile(null);
          setPassword('');
          setReplacing(false);
        },
      },
    );
  };

  const expiring = c && c.daysLeft <= 30;
  return (
    <Section title="Certificado digital A1">
      {c && !replacing ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{c.subject}</p>
          <p className="text-slate-400">
            {c.cnpj ? `CNPJ ${c.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}` : 'CNPJ não informado no certificado'}
            {c.cnpj && emitterCnpj && c.cnpj !== emitterCnpj && <Badge tone="bad">diferente do CNPJ do emitente</Badge>}
          </p>
          <p>
            Válido até <strong>{dateBR(c.validUntil)}</strong>{' '}
            {c.daysLeft < 0 ? (
              <Badge tone="bad">vencido</Badge>
            ) : expiring ? (
              <Badge tone="warn">vence em {c.daysLeft} dia(s): providencie a renovação</Badge>
            ) : (
              <span className="text-slate-500">({c.daysLeft} dias)</span>
            )}
          </p>
          <p className="text-xs text-slate-500">Enviado em {dateBR(c.uploadedAt)}. Guardado cifrado neste computador; a senha não é mostrada.</p>
          <div className="flex gap-2">
            <Button onClick={() => setReplacing(true)}>Trocar certificado</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => confirm('Remover o certificado deste computador?') && remove.mutate({ method: 'DELETE', path: '/admin/fiscal/certificate' })}
            >
              Remover
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Arquivo <strong>.pfx</strong> ou <strong>.p12</strong> do certificado A1 da empresa, com a senha. O sistema confere a senha e a
            validade e guarda tudo cifrado. Certificado A3 (cartão ou token USB) não serve para emissão automática.
          </p>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Arquivo do certificado</span>
            <input
              type="file"
              accept=".pfx,.p12,application/x-pkcs12"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-slate-100"
            />
          </label>
          <TextField label="Senha do certificado" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          <ErrorBanner message={localError ?? errorMessage(upload.error)} />
          <div className="flex gap-2">
            <Button variant="primary" onClick={send} disabled={upload.isPending}>
              {upload.isPending ? 'Conferindo…' : 'Enviar certificado'}
            </Button>
            {replacing && <Button onClick={() => setReplacing(false)}>Cancelar</Button>}
          </div>
        </div>
      )}
      <ErrorBanner message={errorMessage(remove.error)} />
    </Section>
  );
}

// ---------- CSC ----------

function CscSection({ environment, configured, cscId }: { environment: FiscalEnvironment; configured: boolean; cscId: string | null }) {
  const save = useApiMutation<{ environment: FiscalEnvironment; cscId: string; cscToken: string }>([STATUS]);
  const [id, setId] = useState('');
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(!configured);
  return (
    <Section title={`CSC da NFC-e — ${environment === 'PRODUCAO' ? 'produção' : 'homologação'}`}>
      <p className="text-sm text-slate-400">
        {environment === 'PRODUCAO'
          ? 'Código de Segurança do Contribuinte de produção, gerado no portal da SEFAZ-MG. Vai no QR Code de cada cupom.'
          : 'O CSC de homologação é outro, gerado no mesmo portal da SEFAZ-MG, só para os testes.'}
      </p>
      {configured && !editing ? (
        <div className="flex items-center gap-3 text-sm">
          <span>
            Configurado <span className="text-slate-400">(ID {cscId})</span>
          </span>
          <Button onClick={() => setEditing(true)}>Trocar</Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <TextField label="ID do CSC" inputMode="numeric" placeholder="000001" value={id} onChange={(e) => setId(e.target.value)} />
            <TextField label="Código CSC" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <ErrorBanner message={errorMessage(save.error)} />
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  { method: 'PUT', path: '/admin/fiscal/csc', body: { environment, cscId: id, cscToken: token } },
                  {
                    onSuccess: () => {
                      setEditing(false);
                      setToken('');
                    },
                  },
                )
              }
            >
              Salvar CSC
            </Button>
            {configured && <Button onClick={() => setEditing(false)}>Cancelar</Button>}
          </div>
        </>
      )}
    </Section>
  );
}

// ---------- Emitente, numeração e padrões ----------

function SettingsSection({ initial }: { initial: FiscalSettings }) {
  const save = useApiMutation<FiscalSettings>([STATUS]);
  const [form, setForm] = useState<FiscalSettings>(initial);
  const [saved, setSaved] = useState(false);
  // Recarrega só quando os dados salvos mudam (não a cada atualização do status).
  const initialKey = JSON.stringify(initial);
  useEffect(() => setForm(initial), [initialKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof FiscalSettings>(k: K, v: FiscalSettings[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const field = (k: keyof FiscalSettings, label: string, extra: Record<string, unknown> = {}) => (
    <TextField label={label} value={String(form[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} {...extra} />
  );

  return (
    <Section title="Emitente e numeração">
      <div className="grid gap-3 sm:grid-cols-2">
        {field('legalName', 'Razão social')}
        {field('tradeName', 'Nome fantasia')}
        {field('cnpj', 'CNPJ', { inputMode: 'numeric', placeholder: '00.000.000/0000-00' })}
        {field('stateRegistration', 'Inscrição estadual')}
        <SelectField label="Regime tributário" value={form.regime} onChange={(e) => set('regime', e.target.value as TaxRegime)}>
          {TAX_REGIMES.map((r) => (
            <option key={r} value={r}>
              {TAX_REGIME_LABELS[r]}
            </option>
          ))}
        </SelectField>
        {field('phone', 'Telefone')}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        {field('street', 'Logradouro (rua, avenida)')}
        {field('number', 'Número')}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {field('complement', 'Complemento')}
        {field('district', 'Bairro')}
        {field('zip', 'CEP', { inputMode: 'numeric' })}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px_100px]">
        {field('city', 'Município')}
        {field('cityCode', 'Código IBGE do município', { inputMode: 'numeric', hint: '7 dígitos (o contador informa)' })}
        <SelectField label="UF" value={form.uf} onChange={(e) => set('uf', e.target.value as FiscalSettings['uf'])}>
          {UFS.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="Ambiente" value={form.environment} onChange={(e) => set('environment', e.target.value as FiscalEnvironment)}>
          {FISCAL_ENVIRONMENTS.map((env) => (
            <option key={env} value={env}>
              {FISCAL_ENVIRONMENT_LABELS[env]}
            </option>
          ))}
        </SelectField>
        <TextField label="Série" type="number" min={1} value={form.series} onChange={(e) => set('series', Number(e.target.value))} />
        <TextField
          label="Próximo número"
          type="number"
          min={1}
          value={form.nextNumber}
          onChange={(e) => set('nextNumber', Number(e.target.value))}
          hint="Se já emitia NFC-e em outro sistema, continue a numeração."
        />
      </div>
      <p className="pt-2 text-sm font-medium text-slate-300">Padrões para produtos sem dado fiscal próprio</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {field('defaultCfop', 'CFOP padrão', { inputMode: 'numeric', hint: 'Comum: 5102 (venda) ou 5405 (com ST)' })}
        {field('defaultCsosn', 'CSOSN/CST padrão', { inputMode: 'numeric', hint: 'Simples: 102, 500…' })}
        <SelectField label="Origem padrão" value={form.defaultOrigin} onChange={(e) => set('defaultOrigin', e.target.value)}>
          {Object.entries(ORIGIN_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="PIX na nota (tPag)" value={form.pixTPag} onChange={(e) => set('pixTPag', e.target.value as FiscalSettings['pixTPag'])}>
          <option value="20">20 - PIX estático (QR fixo / chave)</option>
          <option value="17">17 - PIX dinâmico (QR gerado na maquininha)</option>
        </SelectField>
        {field('pisCofinsCst', 'CST de PIS/COFINS', { inputMode: 'numeric', hint: 'Simples Nacional: normalmente 07 ou 49 (o contador confirma)' })}
      </div>
      <p className="pt-2 text-sm font-medium text-slate-300">Responsável técnico (vai em toda nota)</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('respTecCnpj', 'CNPJ', { inputMode: 'numeric' })}
        {field('respTecContact', 'Nome do contato')}
        {field('respTecEmail', 'E-mail', { type: 'email' })}
        {field('respTecPhone', 'Telefone', { inputMode: 'tel' })}
      </div>
      {field('accountantEmail', 'E-mail do contador', { type: 'email', hint: 'Para quem os XMLs do mês serão enviados.' })}
      <Toggle
        label="Emitir NFC-e direto com a SEFAZ"
        checked={form.emissionEnabled}
        onChange={(v) => set('emissionEnabled', v)}
        hint="Ligado: o pedido de cupom fiscal no caixa emite a nota na hora e imprime o DANFE. Desligado: o pedido só fica registrado."
      />
      {form.emissionEnabled && form.environment === 'PRODUCAO' && (
        <p className="rounded-lg bg-amber-950 p-3 text-sm text-amber-200">
          Produção: as notas têm valor fiscal. Confira com o contador a série e o próximo número para não repetir os do sistema antigo.
        </p>
      )}
      <ErrorBanner message={errorMessage(save.error)} />
      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-emerald-400">Dados fiscais salvos.</span>}
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate({ method: 'PUT', path: '/admin/fiscal/settings', body: form }, { onSuccess: () => setSaved(true) })}>
          Salvar dados fiscais
        </Button>
      </div>
    </Section>
  );
}

// ---------- Emissão: teste de comunicação, nota de teste, notas sem confirmação e últimas notas ----------

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { AUTORIZADA: 'ok', CONTINGENCIA: 'warn', CANCELADA: 'neutral', REJEITADA: 'bad' };

function EmissionSection({ environment, enabled }: { environment: FiscalEnvironment; enabled: boolean }) {
  const docs = useApiQuery<FiscalDocumentRow[]>(DOCS);
  const pending = useApiQuery<PendingNfce[]>(PENDING);
  const ping = useApiMutation<undefined, SefazStatusResult>([]);
  const testNote = useApiMutation<undefined, NfceEmitResult>([DOCS, PENDING, STATUS]);
  const resolve = useApiMutation<undefined, NfceEmitResult[]>([DOCS, PENDING]);
  const [error, setError] = useState<string | null>(null);
  const hom = environment === 'HOMOLOGACAO';

  const xml = async (d: FiscalDocumentRow) => {
    setError(null);
    try {
      await apiDownload(`/admin/fiscal/documents/${d.id}/xml`, `${d.accessKey}-nfce.xml`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Section title={`Emissão — ${hom ? 'homologação (teste, sem valor fiscal)' : 'produção'}`}>
      <p className="text-sm text-slate-400">
        {enabled ? 'Emissão ligada: o cupom fiscal pedido no caixa sai na hora.' : 'Emissão desligada: ligue em "Emitir NFC-e direto com a SEFAZ", mais abaixo, depois dos testes.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => ping.mutate({ method: 'POST', path: '/admin/fiscal/sefaz-status' })} disabled={ping.isPending}>
          {ping.isPending ? 'Consultando…' : 'Testar comunicação com a SEFAZ'}
        </Button>
        {hom && (
          <Button variant="primary" onClick={() => testNote.mutate({ method: 'POST', path: '/admin/fiscal/test-note' })} disabled={testNote.isPending}>
            {testNote.isPending ? 'Emitindo…' : 'Emitir NFC-e de teste'}
          </Button>
        )}
      </div>
      {ping.data && <Result ok={ping.data.ok} text={`SEFAZ-MG (${ping.data.environment === 'PRODUCAO' ? 'produção' : 'homologação'}): ${ping.data.message}`} />}
      {testNote.data && <Result ok={testNote.data.status === 'AUTORIZADA'} text={testNote.data.message} />}
      <ErrorBanner message={error ?? errorMessage(ping.error) ?? errorMessage(testNote.error) ?? errorMessage(resolve.error)} />

      {!!pending.data?.length && (
        <div className="space-y-2 rounded-lg border border-amber-700 p-3">
          <p className="text-sm font-medium text-amber-300">Notas sem confirmação da SEFAZ (a internet caiu no envio)</p>
          <ul className="text-sm text-slate-300">
            {pending.data.map((p) => (
              <li key={p.accessKey}>
                NFC-e {p.number} · {formatBRL(p.totalCents)} · desde {new Date(p.since).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                {p.environment !== environment && <span className="text-slate-500"> (outro ambiente)</span>}
              </li>
            ))}
          </ul>
          <Button onClick={() => resolve.mutate({ method: 'POST', path: '/admin/fiscal/pending/resolve' })} disabled={resolve.isPending}>
            {resolve.isPending ? 'Consultando…' : 'Consultar na SEFAZ agora'}
          </Button>
          {resolve.data?.map((r, i) => <Result key={i} ok={r.status === 'AUTORIZADA'} text={r.message} />)}
        </div>
      )}

      <p className="pt-2 text-sm font-medium text-slate-300">Últimas notas</p>
      {!docs.data?.length ? (
        <p className="text-sm text-slate-500">Nenhuma nota emitida ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3">Nº</th>
                <th className="pr-3">Data</th>
                <th className="pr-3">Ambiente</th>
                <th className="pr-3 text-right">Valor</th>
                <th className="pr-3">Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.data.map((d) => (
                <tr key={d.id} className="border-t border-slate-800">
                  <td className="py-1.5 pr-3 tabular-nums">
                    {d.series}-{d.number}
                  </td>
                  <td className="pr-3 whitespace-nowrap">{new Date(d.issuedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td className="pr-3">{d.environment === 'PRODUCAO' ? 'Produção' : 'Homologação'}</td>
                  <td className="pr-3 text-right tabular-nums">{formatBRL(d.totalCents)}</td>
                  <td className="pr-3">
                    <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status.toLowerCase()}</Badge>
                  </td>
                  <td className="text-right">
                    <button type="button" className="text-amber-400 hover:underline" onClick={() => xml(d)}>
                      XML
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Result({ ok, text }: { ok: boolean; text: string }) {
  return <p className={`rounded-lg p-3 text-sm ${ok ? 'bg-emerald-950 text-emerald-200' : 'bg-red-950 text-red-200'}`}>{text}</p>;
}

// ---------- XMLs para a contabilidade ----------

function XmlSection() {
  const lastMonth = (() => {
    const [y, m] = localDate(new Date()).split('-').map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  })();
  const [month, setMonth] = useState(lastMonth);
  const summary = useApiQuery<FiscalMonthSummary>(`/admin/fiscal/summary?month=${month}`, /^\d{4}-\d{2}$/.test(month));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiDownload(`/admin/fiscal/export?month=${month}`, `xml-nfce-${month}.zip`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="XMLs para a contabilidade">
      <p className="text-sm text-slate-400">
        Cada nota autorizada (e cada cancelamento) gera um XML, guardado aqui e no backup por 5 anos. Baixe o mês em .zip e mande ao contador.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <TextField label="Mês" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <Button variant="primary" onClick={download} disabled={busy}>
          {busy ? 'Gerando…' : 'Baixar XMLs (.zip)'}
        </Button>
      </div>
      {summary.data && (
        <p className="text-sm text-slate-300">
          {summary.data.authorized} nota(s) autorizada(s) · {formatBRL(summary.data.totalCents)}
          {summary.data.canceled > 0 && ` · ${summary.data.canceled} cancelada(s) (${formatBRL(summary.data.canceledCents)})`}
          {summary.data.authorized + summary.data.canceled === 0 && <span className="text-slate-500"> — nenhuma nota emitida nesse mês ainda.</span>}
        </p>
      )}
      <ErrorBanner message={error ?? errorMessage(summary.error)} />
    </Section>
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
