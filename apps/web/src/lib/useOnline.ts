import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/** Estado de rede do aparelho. Na fase 1 passa a considerar também a conexão com o servidor. */
export function useOnline() {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
