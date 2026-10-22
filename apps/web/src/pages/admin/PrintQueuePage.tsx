import type { PrintJobStatus, PrintJobSummary, PrintQueueResponse } from '@sistema-bar/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, EmptyState, ErrorBanner, Loading, Modal, PageHeader } from '../../components/ui';
import { ClosedBills } from '../cashier/ClosedBills';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { errorMessage, useApiMutation } from '../../lib/queries';

const STATUS: Record<PrintJobStatus, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' }> = {
  PENDENTE: { label: 'Na fila', tone: 'warn' },
  IMPRIMINDO: { label: 'Imprimindo', tone: 'warn' },
  OK: { label: 'Impresso', tone: 'ok' },
  ERRO: { label: 'Erro', tone: 'bad' },
  PAINEL: { label: 'No painel da cozinha', tone: 'neutral' },
};

const TYPE_LABEL: Record<string, string> = { PRODUCAO: 'Produção', TESTE: 'Teste', CANCELAMENTO: 'Cancelamento', PRE_CONTA: 'Pré-conta' };

/** Fila de impressão (SPEC 5.5): acompanhar, ver o cupom, tentar de novo e reimprimir. */
/** Fila de impressão com a aba "Contas fechadas" (descritivo para o cliente que volta pedindo). */
export function PrintQueuePage() {
  const [tab, setTab] = useState<'FILA' | 'CONTAS'>('FILA');
  return (
    <>
      <div className="mb-4 flex gap-1 rounded-lg bg-slate-900 p-1 text-sm print:hidden">
        {(['FILA', 'CONTAS'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-2 ${tab === t ? 'bg-slate-700 font-medium' : 'text-slate-400'}`}>
            {t === 'FILA' ? 'Fila de impressão' : 'Contas fechadas'}
          </button>
        ))}
      </div>
      {tab === 'FILA' ? (
        <PrintQueue />
      ) : (
        <>
          <PageHeader
            title="Contas fechadas"
            description="Mesas fechadas no dia, com as comandas e os pagamentos. Reimprima o descritivo ou corrija a forma de pagamento (enquanto o caixa estiver aberto)."
          />
          <ClosedBills />
        </>
      )}
    </>
  );
}

function PrintQueue() {
  const [filter, setFilter] = useState<'ABERTOS' | 'TODOS'>('TODOS');
  const path = `/print/queue${filter === 'ABERTOS' ? '?status=ABERTOS' : ''}`;
  const queue = useQuery({ queryKey: [path], queryFn: () => api<PrintQueueResponse>(path), refetchInterval: 3_000 });
  const action = useApiMutation(['/print/queue', '/print/queue?status=ABERTOS']);
  const [preview, setPreview] = useState<PrintJobSummary | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const q = queue.data;
  const run = (path: string, message: string, body?: object) =>
    action.mutate({ method: 'POST', path, body }, { onSuccess: () => setDone(message) });

  return (
    <>
      <PageHeader title="Fila de impressão" description="Tudo que foi mandado para as impressoras. Atualiza sozinho." />
      <ErrorBanner message={errorMessage(queue.error ?? action.error)} />
      {done && <p className="mb-3 rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-300">{done}</p>}

      {q?.mode === 'emulador' && (
        <p className="mb-4 rounded-lg bg-sky-950 px-3 py-2 text-sm text-sky-200">
          <strong>Modo emulador:</strong> os cupons não vão para o papel; são gravados na pasta <code>data/impressoes</code> do
          servidor. Toque em "Ver" para conferir. No PC do caixa, use <code>PRINT_MODE=windows</code> no .env.
        </p>
      )}

      {!q ? (
        queue.isLoading && <Loading />
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {q.printers.map((p) => (
              <div key={p.printerId} className={`rounded-xl p-4 ${p.errors ? 'border border-red-900 bg-red-950/40' : 'bg-slate-900'}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{p.printerName}</p>
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-bold">{p.sectorLabel}</span>
                </div>
                <p className="mt-1 text-sm text-slate-400">
                  {!p.active ? 'Desativada' : p.errors ? `${p.errors} com erro` : p.pending ? `${p.pending} na fila` : 'Em dia'}
                  {p.lastPrintedAt && ` · último às ${formatTime(p.lastPrintedAt)}`}
                </p>
                {p.errors > 0 && (
                  <>
                    <p className="mt-2 text-sm text-red-300">{p.lastError}</p>
                    <Button
                      className="mt-3"
                      variant="primary"
                      disabled={action.isPending}
                      onClick={() => run('/print/retry-all', `Tentando de novo na ${p.printerName}.`, { printerId: p.printerId })}
                    >
                      Resolvido, tentar de novo
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="mb-3 flex gap-2">
            {(['TODOS', 'ABERTOS'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-sm ${filter === f ? 'bg-slate-700 font-medium' : 'text-slate-400 hover:bg-slate-800'}`}
              >
                {f === 'TODOS' ? 'Últimos' : 'Pendentes e com erro'}
              </button>
            ))}
          </div>

          {q.jobs.length === 0 ? (
            <EmptyState>{filter === 'ABERTOS' ? 'Nada pendente. Tudo impresso.' : 'Nenhum cupom ainda.'}</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-800 rounded-xl bg-slate-900">
              {q.jobs.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-60">
                    <p className="font-medium">
                      {j.description}
                      {j.reprintOf && <span className="ml-2 text-xs text-amber-400">reimpressão</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {formatTime(j.createdAt)} · {j.printerName} · {TYPE_LABEL[j.type] ?? j.type}
                      {j.attempts > 1 && ` · ${j.attempts} tentativas`}
                    </p>
                    {j.status === 'ERRO' && <p className="text-sm text-red-300">{j.lastError}</p>}
                  </div>
                  <Badge tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Badge>
                  <div className="flex gap-1">
                    <Button variant="ghost" onClick={() => setPreview(j)}>Ver</Button>
                    {j.status === 'ERRO' && (
                      <Button disabled={action.isPending} onClick={() => run(`/print/jobs/${j.id}/retry`, 'Tentando imprimir de novo.')}>
                        Tentar agora
                      </Button>
                    )}
                    {j.status === 'OK' && (
                      <Button
                        disabled={action.isPending}
                        onClick={() =>
                          confirm('Reimprimir este cupom? Ele sai marcado como REIMPRESSÃO.') &&
                          run(`/print/jobs/${j.id}/reprint`, 'Reimpressão enviada para a fila.')
                        }
                      >
                        Reimprimir
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {preview && <PreviewModal job={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/** Cupom exatamente como sai no papel (fonte monoespaçada, mesma largura). */
function PreviewModal({ job, onClose }: { job: PrintJobSummary; onClose: () => void }) {
  const data = useQuery({
    queryKey: ['preview', job.id],
    queryFn: () => api<{ text: string; widthMm: number }>(`/print/jobs/${job.id}/preview`),
  });
  return (
    <Modal title={`${job.printerName} · ${formatTime(job.createdAt)}`} onClose={onClose} footer={<Button onClick={onClose}>Fechar</Button>}>
      {data.data ? (
        <pre
          className="mx-auto overflow-x-auto rounded-md bg-stone-100 px-3 py-4 font-mono text-[11px] leading-snug text-stone-900 shadow-inner"
          style={{ width: `${data.data.widthMm === 58 ? 32 : 48}ch`, maxWidth: '100%', boxSizing: 'content-box' }}
        >
          {data.data.text}
        </pre>
      ) : (
        <Loading />
      )}
    </Modal>
  );
}
