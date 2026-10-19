import { useState, useSyncExternalStore } from 'react';
import { serverVersion } from '../lib/api';

/**
 * O sistema foi atualizado no servidor, mas esta aba ainda roda o app antigo (fica em cache
 * para funcionar offline). Pede para recarregar: busca o service worker novo e recarrega.
 */
export function UpdateBanner() {
  const version = useSyncExternalStore(serverVersion.subscribe, serverVersion.get);
  const [reloading, setReloading] = useState(false);
  if (!version) return null;

  const reload = async () => {
    setReloading(true);
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      // Dá um instante para o service worker novo assumir antes de recarregar.
      await new Promise((r) => setTimeout(r, 1500));
    } catch {
      /* sem service worker: só recarrega */
    }
    window.location.reload();
  };

  return (
    <div role="alert" className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-3 bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950">
      <span>O sistema foi atualizado (versão {version}). Recarregue para usar a versão nova.</span>
      <button onClick={reload} disabled={reloading} className="rounded-lg bg-slate-950 px-3 py-1.5 text-amber-400">
        {reloading ? 'Recarregando…' : 'Atualizar agora'}
      </button>
    </div>
  );
}
