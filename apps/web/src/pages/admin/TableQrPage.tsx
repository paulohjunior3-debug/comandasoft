import type { DiningTable, QrInfo, Settings } from '@sistema-bar/shared';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button, ErrorBanner, Loading, PageHeader, SelectField, TextField } from '../../components/ui';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

/**
 * Impressão dos QR Codes das mesas (SPEC 5.6): um cartão por mesa, 6 por folha A4. O QR leva ao
 * servidor do cliente (HTTP, porta própria) pelo IP deste PC na rede do bar.
 */
export function TableQrPage() {
  const tables = useApiQuery<DiningTable[]>('/admin/tables');
  const info = useApiQuery<QrInfo>('/admin/tables/qr-info');
  const settings = useApiQuery<Settings>('/admin/settings');
  const save = useApiMutation<Settings>(['/admin/settings']);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [wifi, setWifi] = useState<string | null>(null);
  const [area, setArea] = useState('');
  const [saved, setSaved] = useState(false);

  const fallback = info.data?.publicPort ? `http://${window.location.hostname}:${info.data.publicPort}` : '';
  const savedBase = settings.data?.qrBaseUrl || info.data?.suggestedBaseUrls[0] || fallback;
  const base = (baseUrl ?? savedBase).replace(/\/$/, '');
  const wifiName = wifi ?? settings.data?.guestWifiName ?? '';
  // Também "sujo" quando o endereço é só a sugestão: precisa ser salvo para ficar fixo.
  const dirty = Boolean(settings.data) && (base !== settings.data!.qrBaseUrl || wifiName.trim() !== settings.data!.guestWifiName);

  const active = (tables.data ?? []).filter((t) => t.active);
  const areas = [...new Set(active.map((t) => t.area ?? 'Sem área'))];
  const shown = area ? active.filter((t) => (t.area ?? 'Sem área') === area) : active;

  if (tables.isLoading || info.isLoading || settings.isLoading) return <Loading />;

  const persist = () =>
    settings.data &&
    save.mutate(
      { method: 'PUT', path: '/admin/settings', body: { ...settings.data, qrBaseUrl: base, guestWifiName: wifiName.trim() } },
      {
        onSuccess: () => {
          setBaseUrl(null);
          setWifi(null);
          setSaved(true);
        },
      },
    );

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title="QR Codes das mesas"
          description="Imprima, recorte e deixe um em cada mesa. O cliente vê o cardápio e acompanha a própria comanda."
          action={
            <div className="flex gap-2">
              <Link to="/admin/mesas" className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
                ‹ Mesas
              </Link>
              <Button variant="primary" onClick={() => window.print()} disabled={!base || shown.length === 0}>
                Imprimir
              </Button>
            </div>
          }
        />

        <div className="mb-6 space-y-3 rounded-xl bg-slate-900 p-4">
          {info.data?.publicPort == null && (
            <ErrorBanner message="O servidor do QR está desligado neste computador. Atualize a instalação (ATUALIZAR.bat) para ligá-lo." />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <TextField
                label="Endereço do QR"
                value={base}
                onChange={(e) => {
                  setSaved(false);
                  setBaseUrl(e.target.value);
                }}
                placeholder="http://192.168.0.10:8080"
                hint="IP deste PC na rede do bar. Fixe esse IP no roteador: se ele mudar, os QR impressos param de funcionar."
              />
              {(info.data?.suggestedBaseUrls.length ?? 0) > 1 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {info.data!.suggestedBaseUrls.map((u) => (
                    <button key={u} onClick={() => setBaseUrl(u)} className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                      {u}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <TextField
              label="Nome do Wi-Fi dos clientes (opcional)"
              value={wifiName}
              onChange={(e) => {
                setSaved(false);
                setWifi(e.target.value);
              }}
              placeholder="Ex.: Bar-Clientes"
              hint="Sai impresso no cartão. O celular do cliente precisa estar nessa rede."
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {areas.length > 1 && (
              <div className="w-48">
                <SelectField label="Área" value={area} onChange={(e) => setArea(e.target.value)}>
                  <option value="">Todas ({active.length})</option>
                  {areas.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}
            <Button onClick={persist} disabled={!dirty || save.isPending}>
              Salvar endereço e Wi-Fi
            </Button>
            {saved && <span className="text-sm text-emerald-400">Salvo.</span>}
            {base && shown[0] && (
              <a href={`${base}/m/${shown[0].qrToken}`} target="_blank" rel="noreferrer" className="text-sm text-amber-400">
                Testar o QR da mesa {shown[0].number} ↗
              </a>
            )}
          </div>
          <ErrorBanner message={errorMessage(save.error)} />
          {dirty && <p className="text-xs text-amber-300">Salve antes de imprimir, para o endereço ficar guardado.</p>}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="text-slate-400">Nenhuma mesa ativa.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2 print:gap-0">
          {shown.map((t) => (
            <QrCard key={t.id} table={t} url={`${base}/m/${t.qrToken}`} company={settings.data?.companyName ?? ''} wifi={wifiName.trim()} />
          ))}
        </div>
      )}
    </>
  );
}

function QrCard({ table, url, company, wifi }: { table: DiningTable; url: string; company: string; wifi: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''));
    return () => {
      alive = false;
    };
  }, [url]);

  return (
    <div className="flex flex-col items-center rounded-xl bg-white p-5 text-center text-slate-900 print:h-[92mm] print:break-inside-avoid print:rounded-none print:border print:border-dashed print:border-slate-400 print:p-4">
      {company && <p className="text-sm font-semibold tracking-wide uppercase">{company}</p>}
      <p className="text-3xl font-bold">Mesa {table.number}</p>
      <div className="my-2 size-40 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} aria-label={`QR Code da mesa ${table.number}`} />
      <p className="text-sm font-medium">Aponte a câmera do celular</p>
      <p className="text-xs text-slate-600">Veja o cardápio e acompanhe sua comanda</p>
      {wifi && <p className="mt-1 text-xs font-medium">Wi-Fi: {wifi}</p>}
    </div>
  );
}
