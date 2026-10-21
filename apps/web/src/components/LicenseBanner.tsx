import type { LicenseBannerInfo } from '@sistema-bar/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Faixa da licença no caixa e no admin: amarela no aviso, vermelha na carência e no bloqueio.
 * Confere a cada 10 min (a licença muda devagar).
 */
export function LicenseBanner({ className = '' }: { className?: string }) {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ['/license/status'],
    queryFn: () => api<LicenseBannerInfo>('/license/status'),
    refetchInterval: 10 * 60 * 1000,
  });
  if (!data?.message) return null;
  const tone = data.state === 'AVISO' ? 'bg-amber-950 text-amber-200' : 'bg-red-950 text-red-200';
  const content = <span>{data.message}</span>;
  const classes = `block rounded-lg px-3 py-2 text-sm print:hidden ${tone} ${className}`;
  return user?.role === 'ADMIN' ? (
    <Link to="/admin/licenca" className={classes}>
      {content}
    </Link>
  ) : (
    <div role="alert" className={classes}>
      {content}
    </div>
  );
}
