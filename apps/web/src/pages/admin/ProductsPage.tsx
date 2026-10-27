import {
  centsToInput,
  formatBRL,
  MAX_FEATURED,
  MENU_BADGE_LABELS,
  MENU_BADGES,
  parseBRL,
  type Category,
  type MenuBadge,
  type Product,
  type ProductInput,
} from '@sistema-bar/shared';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Loading,
  Modal,
  PageHeader,
  SelectField,
  TextField,
  Toggle,
} from '../../components/ui';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { shrinkImage } from '../../lib/image';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/products';

interface Form {
  categoryId: string;
  name: string;
  price: string;
  description: string;
  sku: string;
  active: boolean;
  soldOut: boolean;
  featured: boolean;
  badges: MenuBadge[];
  ncm: string;
  cfop: string;
  csosn: string;
  unit: string;
  origin: string;
  cest: string;
}

const toForm = (p: Product | null, categoryId: string): Form => ({
  categoryId: p?.categoryId ?? categoryId,
  name: p?.name ?? '',
  price: p ? centsToInput(p.priceCents) : '',
  description: p?.description ?? '',
  sku: p?.sku ?? '',
  active: p?.active ?? true,
  soldOut: p?.soldOut ?? false,
  featured: p?.featured ?? false,
  badges: p?.badges ?? [],
  ncm: p?.ncm ?? '',
  cfop: p?.cfop ?? '',
  csosn: p?.csosn ?? '',
  unit: p?.unit ?? 'UN',
  origin: p?.origin ?? '',
  cest: p?.cest ?? '',
});

export function ProductsPage() {
  const products = useApiQuery<Product[]>(PATH);
  const categories = useApiQuery<Category[]>('/admin/categories');
  const toggleSoldOut = useApiMutation([PATH]);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ product: Product | null } | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products.data ?? []).filter(
      (p) => (!filter || p.categoryId === filter) && (!q || p.name.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q)),
    );
  }, [products.data, filter, search]);

  const groups = (categories.data ?? [])
    .map((c) => ({ category: c, items: visible.filter((p) => p.categoryId === c.id) }))
    .filter((g) => g.items.length > 0);

  const noCategories = categories.data?.length === 0;

  return (
    <>
      <PageHeader
        title="Produtos"
        description="Cardápio com preços. Toque em Esgotado para bloquear um item na hora."
        action={
          <Button variant="primary" disabled={noCategories} onClick={() => setEditing({ product: null })}>
            + Novo produto
          </Button>
        }
      />
      <ErrorBanner message={errorMessage(products.error ?? toggleSoldOut.error)} />

      {noCategories ? (
        <EmptyState>Cadastre as categorias primeiro (menu Categorias).</EmptyState>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <TextField label="Buscar" placeholder="Nome ou código" value={search} onChange={(e) => setSearch(e.target.value)} />
            <SelectField label="Categoria" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">Todas</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
          </div>

          {products.isLoading ? (
            <Loading />
          ) : groups.length === 0 ? (
            <EmptyState>{products.data?.length ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado ainda.'}</EmptyState>
          ) : (
            <div className="space-y-5">
              {groups.map(({ category, items }) => (
                <section key={category.id}>
                  <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-400 uppercase">
                    <span className="size-2.5 rounded-full" style={{ background: category.color ?? '#475569' }} />
                    {category.name}
                  </h2>
                  <ul className="divide-y divide-slate-800 rounded-xl bg-slate-900">
                    {items.map((p) => (
                      <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                        <button onClick={() => setEditing({ product: p })} className="shrink-0" aria-label={`Editar ${p.name}`}>
                          {p.imageUrl ? (
                            <img src={p.imageUrl} alt="" loading="lazy" className="size-12 rounded-lg object-cover" />
                          ) : (
                            <span className="flex size-12 items-center justify-center rounded-lg bg-slate-800 text-xs text-slate-500">sem foto</span>
                          )}
                        </button>
                        <button onClick={() => setEditing({ product: p })} className="min-w-0 flex-1 text-left">
                          <span className={`block truncate font-medium ${p.active ? '' : 'text-slate-500 line-through'}`}>
                            {p.featured && <span title="Destaque no cardápio do cliente">⭐ </span>}
                            {p.name}
                          </span>
                          <span className="block text-sm text-slate-400">
                            {formatBRL(p.priceCents)}
                            {p.sku && <span className="text-slate-500"> · {p.sku}</span>}
                            {p.badges.length > 0 && <span className="text-amber-300/80"> · {p.badges.map((b) => MENU_BADGE_LABELS[b]).join(', ')}</span>}
                          </span>
                        </button>
                        {!p.active && <Badge>Inativo</Badge>}
                        <button
                          onClick={() =>
                            toggleSoldOut.mutate({ method: 'PATCH', path: `${PATH}/${p.id}/sold-out`, body: { soldOut: !p.soldOut } })
                          }
                          className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${p.soldOut ? 'bg-red-900 text-red-200' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                        >
                          {p.soldOut ? 'Esgotado' : 'Disponível'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {editing && (
        <ProductModal
          product={editing.product}
          featuredCount={(products.data ?? []).filter((p) => p.featured && p.imageUrl && p.id !== editing.product?.id).length}
          categories={categories.data ?? []}
          defaultCategory={filter || categories.data?.[0]?.id || ''}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ProductModal({
  product,
  categories,
  defaultCategory,
  featuredCount,
  onClose,
}: {
  product: Product | null;
  featuredCount: number;
  categories: Category[];
  defaultCategory: string;
  onClose: () => void;
}) {
  const [form, setForm] = useState(() => toForm(product, defaultCategory));
  const [localError, setLocalError] = useState<string | null>(null);
  const [showFiscal, setShowFiscal] = useState(false);
  // Foto: a escolhida agora (ainda não enviada), ou a que já está salva.
  const [photo, setPhoto] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const qc = useQueryClient();
  const save = useApiMutation<ProductInput, Product>([PATH, '/admin/categories']);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = () => {
    const priceCents = parseBRL(form.price);
    if (priceCents === null) return setLocalError('Preço inválido. Exemplo: 12,50');
    setLocalError(null);
    const { price: _price, ...rest } = form;
    const body: ProductInput = { ...rest, priceCents };
    save.mutate(
      { method: product ? 'PUT' : 'POST', path: product ? `${PATH}/${product.id}` : PATH, body },
      {
        // Depois de salvar (o produto novo já tem id), envia ou remove a foto.
        onSuccess: async (saved) => {
          const id = product?.id ?? saved.id;
          try {
            setPhotoBusy(true);
            if (photo) await api(`${PATH}/${id}/image`, { method: 'PUT', body: JSON.stringify({ dataUrl: photo }) });
            else if (removePhoto && product?.imageUrl) await api(`${PATH}/${id}/image`, { method: 'DELETE' });
            void qc.invalidateQueries({ queryKey: [PATH] });
            onClose();
          } catch (err) {
            setLocalError(`Produto salvo, mas a foto não: ${errorMessage(err)}`);
          } finally {
            setPhotoBusy(false);
          }
        },
      },
    );
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPhotoBusy(true);
      setPhoto(await shrinkImage(file));
      setRemovePhoto(false);
      setLocalError(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Não foi possível usar esta imagem.');
    } finally {
      setPhotoBusy(false);
    }
  };
  const shownPhoto = photo ?? (removePhoto ? null : product?.imageUrl ?? null);
  const remove = () =>
    confirm(`Excluir "${product!.name}"? Se ele já tiver sido vendido, prefira desativar.`) &&
    save.mutate({ method: 'DELETE', path: `${PATH}/${product!.id}` }, { onSuccess: onClose });

  return (
    <Modal
      title={product ? 'Editar produto' : 'Novo produto'}
      onClose={onClose}
      footer={
        <>
          {product && <Button variant="danger" className="mr-auto" onClick={remove} disabled={save.isPending}>Excluir</Button>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending || photoBusy}>Salvar</Button>
        </>
      }
    >
      <ErrorBanner message={localError ?? errorMessage(save.error)} />
      <SelectField label="Categoria" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <TextField label="Nome" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus={!product} />
      <div className="flex items-center gap-3">
        {shownPhoto ? (
          <img src={shownPhoto} alt="" className="size-24 rounded-xl object-cover" />
        ) : (
          <span className="flex size-24 items-center justify-center rounded-xl border border-dashed border-slate-700 text-center text-xs text-slate-500">
            sem foto
          </span>
        )}
        <div className="space-y-2">
          <label className="inline-block cursor-pointer rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-800">
            {photoBusy ? 'Preparando…' : shownPhoto ? 'Trocar foto' : 'Escolher foto'}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => void pickPhoto(e.target.files?.[0])} />
          </label>
          {shownPhoto && (
            <button
              type="button"
              className="block text-sm text-red-300"
              onClick={() => {
                setPhoto(null);
                setRemovePhoto(true);
              }}
            >
              Remover foto
            </button>
          )}
          <p className="text-xs text-slate-500">Aparece no cardápio do cliente (QR). A foto é reduzida automaticamente.</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Preço (R$)" inputMode="decimal" placeholder="0,00" value={form.price} onChange={(e) => set('price', e.target.value)} />
        <TextField label="Código interno" value={form.sku} onChange={(e) => set('sku', e.target.value)} hint="Opcional" />
      </div>
      <TextField label="Descrição" value={form.description} onChange={(e) => set('description', e.target.value)} hint="Aparece no cardápio do cliente" />
      <Toggle label="Ativo" checked={form.active} onChange={(v) => set('active', v)} />
      <Toggle label="Esgotado" checked={form.soldOut} onChange={(v) => set('soldOut', v)} hint="Bloqueia o item para o garçom" />

      <p className="pt-1 text-sm font-medium text-slate-300">Cardápio do cliente (QR)</p>
      <Toggle
        label="⭐ Destacar no topo do cardápio"
        checked={form.featured}
        onChange={(v) => set('featured', v)}
        hint={
          !shownPhoto
            ? 'Só aparece nos destaques com foto.'
            : form.featured && featuredCount >= MAX_FEATURED
              ? `Já há ${featuredCount} destaques: aparecem os ${MAX_FEATURED} primeiros do cardápio.`
              : `Fotos grandes no topo (até ${MAX_FEATURED}). Bom para o carro-chefe e as promoções.`
        }
      />
      <div>
        <span className="mb-1 block text-sm text-slate-300">Selos (até 3)</span>
        <div className="flex flex-wrap gap-2">
          {MENU_BADGES.map((b) => {
            const on = form.badges.includes(b);
            return (
              <button
                key={b}
                type="button"
                aria-pressed={on}
                disabled={!on && form.badges.length >= 3}
                onClick={() => set('badges', on ? form.badges.filter((x) => x !== b) : [...form.badges, b])}
                className={`rounded-full border px-3 py-1 text-sm disabled:opacity-40 ${on ? 'border-amber-500 bg-amber-500/15 text-amber-200' : 'border-slate-700 text-slate-300'}`}
              >
                {MENU_BADGE_LABELS[b]}
              </button>
            );
          })}
        </div>
      </div>

      <button type="button" onClick={() => setShowFiscal((s) => !s)} className="text-sm text-amber-400">
        {showFiscal ? '▾' : '▸'} Dados fiscais (NFC-e)
      </button>
      {showFiscal && (
        <div className="grid grid-cols-2 gap-3">
          <TextField label="NCM" inputMode="numeric" maxLength={8} value={form.ncm} onChange={(e) => set('ncm', e.target.value)} />
          <TextField label="CFOP" inputMode="numeric" maxLength={4} value={form.cfop} onChange={(e) => set('cfop', e.target.value)} />
          <TextField label="CSOSN/CST" maxLength={4} value={form.csosn} onChange={(e) => set('csosn', e.target.value)} />
          <TextField label="Unidade" maxLength={6} value={form.unit} onChange={(e) => set('unit', e.target.value.toUpperCase())} />
          <TextField label="Origem" maxLength={1} value={form.origin} onChange={(e) => set('origin', e.target.value)} hint="0 = nacional" />
          <TextField label="CEST" inputMode="numeric" maxLength={7} value={form.cest} onChange={(e) => set('cest', e.target.value)} hint="Só produtos com substituição tributária" />
          <p className="col-span-2 text-xs text-slate-500">
            Confirme esses códigos com o contador. Para preencher vários de uma vez, use Fiscal → Dados fiscais dos produtos.
          </p>
        </div>
      )}
    </Modal>
  );
}
