import { formatBRL, matchesSearch, type MenuProduct, type PublicTableInfo } from '@sistema-bar/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

type Item = MenuProduct & { categoryName: string; color: string };
const FALLBACK_COLOR = '#f59e0b';

/**
 * Cardápio do cliente (QR da mesa): destaques com foto, categorias fixas no topo que levam à
 * seção, cartões com foto e detalhe do produto ao tocar.
 */
export function Menu({ info }: { info: PublicTableInfo }) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(info.menu[0]?.id ?? null);
  const [open, setOpen] = useState<Item | null>(null);
  // Depois de tocar numa categoria, a rolagem não troca o destaque (a última seção pode não chegar ao topo).
  const pinnedUntil = useRef(0);
  const q = search.trim();

  const all: Item[] = useMemo(
    () => info.menu.flatMap((c) => c.products.map((p) => ({ ...p, categoryName: c.name, color: c.color ?? FALLBACK_COLOR }))),
    [info.menu],
  );
  // Cardápio sem nenhuma foto: lista compacta, sem quadros vazios.
  const withPhotos = all.some((p) => p.imageUrl);
  const featured = all.filter((p) => p.imageUrl).slice(0, 8);
  const found = q ? all.filter((p) => matchesSearch(p.name, q) || matchesSearch(p.description ?? '', q)) : [];

  // Destaca a categoria que está na tela enquanto rola.
  useEffect(() => {
    if (q) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible && Date.now() > pinnedUntil.current) {
          const id = visible.target.id.replace('cat-', '');
          setActive(id);
          document.getElementById(`chip-${id}`)?.scrollIntoView({ inline: 'center', block: 'nearest' });
        }
      },
      { rootMargin: '-120px 0px -60% 0px' },
    );
    info.menu.forEach((c) => {
      const el = document.getElementById(`cat-${c.id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [info.menu, q]);

  const goTo = (id: string) => {
    setActive(id);
    pinnedUntil.current = Date.now() + 1200;
    const el = document.getElementById(`cat-${id}`);
    // Desconta as abas e as categorias fixas no topo.
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 118, behavior: 'smooth' });
  };

  if (!info.menu.length) return <p className="px-4 py-10 text-center text-slate-400">Cardápio ainda não cadastrado.</p>;

  return (
    <>
      <div className="px-4 pt-4">
        <label className="relative block">
          <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-500" aria-hidden>
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            type="search"
            placeholder="Buscar no cardápio"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-full border border-slate-800 bg-slate-900 py-2.5 pr-4 pl-10 text-base outline-none placeholder:text-slate-500 focus:border-amber-500"
          />
        </label>
      </div>

      {q ? (
        <section className="px-4 pt-5">
          <h2 className="mb-3 text-sm text-slate-400">{found.length ? `${found.length} resultado(s) para "${q}"` : `Nada encontrado para "${q}".`}</h2>
          <ProductList items={found} withPhotos={withPhotos} onOpen={setOpen} />
        </section>
      ) : (
        <>
          {/* Categorias fixas logo abaixo das abas (que têm altura fixa h-14) */}
          <div className="sticky top-14 z-10 mt-3 border-b border-slate-800/60 bg-slate-950/95 backdrop-blur">
            <div className="flex gap-2 overflow-x-auto px-4 py-2.5 [scrollbar-width:none]">
              {info.menu.map((c) => (
                <button
                  key={c.id}
                  id={`chip-${c.id}`}
                  onClick={() => goTo(c.id)}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors ${active === c.id ? 'bg-slate-100 font-semibold text-slate-950' : 'bg-slate-800/80 text-slate-300'}`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          {featured.length >= 3 && (
            <section className="pt-5">
              <h2 className="mb-3 px-4 text-lg font-bold">Destaques</h2>
              <div className="flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
                {featured.map((p) => (
                  <button key={p.id} onClick={() => setOpen(p)} className="relative w-44 shrink-0 snap-start overflow-hidden rounded-2xl bg-slate-900 text-left">
                    <img src={p.imageUrl!} alt="" loading="lazy" decoding="async" className="aspect-[4/5] w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 pt-10">
                      <span className="line-clamp-2 block text-sm leading-tight font-semibold">{p.name}</span>
                      <span className="mt-1 block text-sm font-bold text-amber-300">{formatBRL(p.priceCents)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {info.menu.map((c) => (
            <section key={c.id} id={`cat-${c.id}`} className="px-4 pt-6">
              <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
                <span className="h-5 w-1.5 rounded-full" style={{ background: c.color ?? FALLBACK_COLOR }} />
                {c.name}
              </h2>
              <ProductList
                items={c.products.map((p) => ({ ...p, categoryName: c.name, color: c.color ?? FALLBACK_COLOR }))}
                withPhotos={withPhotos}
                onOpen={setOpen}
              />
            </section>
          ))}
          {info.serviceFeeEnabled && <p className="px-4 pt-6 text-center text-xs text-slate-500">Taxa de serviço de 10% não incluída nos preços.</p>}
        </>
      )}

      {open && <ProductSheet item={open} serviceFee={info.serviceFeeEnabled} onClose={() => setOpen(null)} />}
    </>
  );
}

function ProductList({ items, withPhotos, onOpen }: { items: Item[]; withPhotos: boolean; onOpen: (p: Item) => void }) {
  return (
    <ul className="space-y-2.5">
      {items.map((p) => (
        <li key={p.id}>
          <button onClick={() => onOpen(p)} className="flex w-full items-stretch gap-3 rounded-2xl bg-slate-900 p-3 text-left active:bg-slate-800">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">{p.name}</span>
              {p.description && <span className="mt-0.5 line-clamp-2 text-sm text-slate-400">{p.description}</span>}
              <span className="mt-auto pt-2 font-bold text-amber-300 tabular-nums">{formatBRL(p.priceCents)}</span>
            </span>
            {withPhotos && <Thumb item={p} className="size-24 shrink-0 rounded-xl" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Foto do produto, ou um quadro na cor da categoria com a inicial quando não há foto. */
function Thumb({ item, className }: { item: Item; className: string }) {
  if (item.imageUrl) return <img src={item.imageUrl} alt="" loading="lazy" decoding="async" className={`${className} object-cover`} />;
  return (
    <span
      className={`${className} flex items-center justify-center text-3xl font-bold text-white/80`}
      style={{ background: `linear-gradient(135deg, ${item.color}cc, ${item.color}33)` }}
      aria-hidden
    >
      {item.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Detalhe do produto: foto grande, descrição e preço. */
function ProductSheet({ item, serviceFee, onClose }: { item: Item; serviceFee: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose} role="dialog" aria-modal aria-label={item.name}>
      <div
        className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-slate-900 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative">
          {item.imageUrl ? (
            <img src={item.imageUrl} alt={item.name} className="aspect-[4/3] w-full rounded-t-3xl object-cover" />
          ) : (
            <Thumb item={item} className="aspect-[3/1] w-full rounded-t-3xl" />
          )}
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="absolute top-3 right-3 flex size-9 items-center justify-center rounded-full bg-black/60 text-lg text-white backdrop-blur"
          >
            ✕
          </button>
        </div>
        <div className="space-y-2 px-5 pt-4">
          <p className="text-xs font-medium tracking-wider text-slate-400 uppercase">{item.categoryName}</p>
          <h3 className="text-2xl font-bold">{item.name}</h3>
          {item.description && <p className="text-slate-300">{item.description}</p>}
          <p className="pt-1 text-2xl font-bold text-amber-300 tabular-nums">{formatBRL(item.priceCents)}</p>
          <p className="pt-2 text-sm text-slate-500">Para pedir, chame o garçom.{serviceFee ? ' Taxa de serviço de 10% não incluída.' : ''}</p>
        </div>
      </div>
    </div>
  );
}
