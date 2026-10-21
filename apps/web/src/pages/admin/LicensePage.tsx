import type { LicenseRenewal, LicenseState, LicenseStatus } from '@sistema-bar/shared';
import { useState, type ReactNode } from 'react';
import { Badge, Button, ErrorBanner, Loading, PageHeader } from '../../components/ui';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const STATUS = '/admin/license';
const BANNER = '/license/status';
const dateTimeBR = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

const STATE_BADGE: Record<LicenseState, { tone: 'ok' | 'warn' | 'bad'; label: string }> = {
  VALIDA: { tone: 'ok', label: 'Válida' },
  AVISO: { tone: 'warn', label: 'Vence em breve' },
  CARENCIA: { tone: 'bad', label: 'Vencida (carência)' },
  BLOQUEADA: { tone: 'bad', label: 'Bloqueada' },
};

/** Admin › Licença (docs/licenciamento.md): estado, colar licença ou renovação e renovar na hora. */
export function LicensePage() {
  const status = useApiQuery<LicenseStatus>(STATUS);
  const s = status.data;
  if (!s) return status.isError ? <ErrorBanner message={errorMessage(status.error)} /> : <Loading />;
  const badge = STATE_BADGE[s.state];

  return (
    <>
      <PageHeader
        title="Licença"
        description="Fechar contas, relatórios e exportações nunca são bloqueados. Sem licença válida, só abrir caixa e lançar pedidos param."
      />
      <div className="space-y-5">
        <Section title="Situação">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <span className="text-sm text-slate-300">{s.mode === 'AVALIACAO' ? 'Período de avaliação' : `Licenciado para ${s.customer}`}</span>
          </div>
          {s.message && <p className="text-sm text-slate-300">{s.message}</p>}
          {!s.enforced && <p className="text-xs text-slate-500">Desenvolvimento: o estado aparece aqui, mas nada é bloqueado.</p>}
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {s.cnpj && <Item label="CNPJ">{s.cnpj}</Item>}
            {s.licenseId && <Item label="Licença">{s.licenseId}</Item>}
            <Item label="Vence em">
              {s.expiresAt ? `${dateTimeBR(s.expiresAt)} (${s.daysLeft} dia(s))` : 'Não vence'}
            </Item>
            {s.blocksAt && <Item label="Bloqueia em">{dateTimeBR(s.blocksAt)}</Item>}
            {s.features.length > 0 && <Item label="Recursos">{s.features.join(', ')}</Item>}
            {s.support && <Item label="Suporte">{s.support}</Item>}
          </dl>
        </Section>

        <Section title="Código deste computador">
          <p className="font-mono text-lg tracking-wider">{s.machineId ?? 'não identificado'}</p>
          <p className="text-xs text-slate-500">
            Mande este código ao suporte para receber a licença. {s.machineBound ? 'A licença instalada é deste computador.' : ''}
          </p>
        </Section>

        {s.mode === 'LICENCIADA' && <RenewSection autoRenew={s.autoRenew} lastRenewal={s.lastRenewal} />}
        <InstallSection />
      </div>
    </>
  );
}

function RenewSection({ autoRenew, lastRenewal }: { autoRenew: boolean; lastRenewal: LicenseRenewal | null }) {
  const renew = useApiMutation<undefined, { renewal: LicenseRenewal }>([STATUS, BANNER]);
  if (!autoRenew) {
    return (
      <Section title="Renovação">
        <p className="text-sm text-slate-400">Esta licença não usa renovação automática.</p>
      </Section>
    );
  }
  return (
    <Section title="Renovação automática">
      <p className="text-sm text-slate-300">
        O sistema renova sozinho pela internet, ao ligar e a cada 6 horas.{' '}
        {lastRenewal ? (
          <span className={lastRenewal.ok ? 'text-emerald-400' : 'text-amber-400'}>
            Última tentativa: {dateTimeBR(lastRenewal.at)}, {lastRenewal.ok ? 'renovada' : lastRenewal.message}
          </span>
        ) : (
          'Ainda não houve tentativa.'
        )}
      </p>
      <Button onClick={() => renew.mutate({ method: 'POST', path: `${STATUS}/renew` })} disabled={renew.isPending}>
        {renew.isPending ? 'Renovando…' : 'Renovar agora'}
      </Button>
      <ErrorBanner message={errorMessage(renew.error)} />
    </Section>
  );
}

function InstallSection() {
  const [token, setToken] = useState('');
  const install = useApiMutation<{ token: string }>([STATUS, BANNER]);
  return (
    <Section title="Colar licença ou renovação">
      <p className="text-sm text-slate-400">
        Cole o texto recebido do suporte (começa com <span className="font-mono">SB1.</span>). Serve tanto para a licença nova quanto
        para a renovação manual, quando a loja está sem internet.
      </p>
      <textarea
        value={token}
        onChange={(e) => setToken(e.target.value)}
        rows={4}
        spellCheck={false}
        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 font-mono text-xs outline-none focus:border-amber-500"
        placeholder="SB1.…"
      />
      <ErrorBanner message={errorMessage(install.error)} />
      {install.isSuccess && <p className="text-sm text-emerald-400">Instalado.</p>}
      <Button
        variant="primary"
        disabled={install.isPending || token.trim().length < 10}
        onClick={() => install.mutate({ method: 'POST', path: STATUS, body: { token } }, { onSuccess: () => setToken('') })}
      >
        {install.isPending ? 'Conferindo…' : 'Instalar'}
      </Button>
    </Section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd>{children}</dd>
    </div>
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
