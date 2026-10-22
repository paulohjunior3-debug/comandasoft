import { useEffect, useRef } from 'react';

/** Atalhos de teclado do caixa (lista mostrada no F1 e no menu Funções). */
export const CASHIER_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'F1', label: 'Ver os atalhos' },
  { keys: 'F2', label: 'Buscar mesa, nome, telefone ou CPF' },
  { keys: 'F3', label: 'Imprimir a pré-conta das comandas selecionadas' },
  { keys: 'F4', label: 'Lançar itens na mesa aberta' },
  { keys: 'F6', label: 'Abrir mesa' },
  { keys: 'F7', label: 'Venda no balcão' },
  { keys: 'F8', label: 'Couvert (iniciar ou encerrar o show)' },
  { keys: 'Ctrl + A', label: 'Cancelar a mesa (ou as comandas selecionadas)' },
  { keys: 'F11', label: 'Tela cheia (liga e desliga)' },
  { keys: 'Esc', label: 'Fechar a janela aberta' },
];

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

/**
 * Atalho do caixa: "F3", "Ctrl+A"... Não dispara com uma janela (modal) aberta, para não agir
 * por trás dela. Ctrl+A digitando num campo continua sendo "selecionar tudo".
 */
export function useShortcut(combo: string, handler: () => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1]!;
    const ctrl = parts.includes('ctrl');
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key || e.ctrlKey !== ctrl || e.altKey || e.repeat) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (ctrl && typing(e.target)) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, enabled]);
}

/** Liga/desliga a tela cheia do navegador. */
export function toggleFullscreen() {
  const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  void p?.catch(() => {});
}

/** Etiqueta de tecla nos botões. */
export const kbdClass = 'ml-1.5 hidden rounded border border-current/30 px-1 text-[10px] font-normal opacity-70 2xl:inline';
