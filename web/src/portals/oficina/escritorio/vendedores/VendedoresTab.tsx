// Vendedores: sellers by tier, filterable by verification status (Pendiente, Verificado, Pausado,
// Rechazado). Each row shows whether releases flow to the seller or why they are held; the row
// opens the seller drawer.

import { useMemo, useState } from 'react';
import type { SellerTier, SellerVerificationStatus, SellerView } from '@casa-puente/services';
import type { AsyncState } from '../../../../app/hooks';
import { Badge, Card, EmptyState, ErrorState, Spinner } from '../../../../components/ui';
import { useOT } from '../../shared/i18n';
import { SELLER_STATUSES, SellerStatusBadge } from '../badges';

const TIERS: SellerTier[] = [1, 2];

export function VendedoresTab({ sellers, onOpen }: { sellers: AsyncState<SellerView[]>; onOpen: (id: string) => void }) {
  const ot = useOT();
  const [status, setStatus] = useState<SellerVerificationStatus | ''>('');
  const all = sellers.data ?? [];
  const shown = useMemo(() => all.filter((s) => !status || s.verificationStatus === status), [all, status]);

  return (
    <Card title={ot('vendedores.title')}>
      <div role="group" aria-label={ot('vendedores.filter')} className="mb-4 flex flex-wrap gap-2">
        {(['', ...SELLER_STATUSES] as const).map((s) => (
          <button
            key={s || 'all'}
            type="button"
            aria-pressed={status === s}
            data-testid={`seller-filter-${s || 'all'}`}
            onClick={() => setStatus(s)}
            className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${status === s ? 'border-brand-700 bg-brand-700 text-white' : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-100'}`}
          >
            {s ? ot(`sellerStatus.${s}`) : ot('vendedores.all')} ({s ? all.filter((x) => x.verificationStatus === s).length : all.length})
          </button>
        ))}
      </div>
      {sellers.loading && !sellers.data && <Spinner />}
      {sellers.status === 'error' && <ErrorState error={sellers.error} onRetry={sellers.reload} />}
      {sellers.data && shown.length === 0 && <EmptyState title={ot('vendedores.empty')} body={ot('vendedores.emptyBody')} />}
      <div className="space-y-6">
        {TIERS.map((tier) => {
          const list = shown.filter((s) => s.tier === tier);
          if (list.length === 0) return null;
          return (
            <section key={tier} aria-labelledby={`tier-${tier}`} data-testid={`seller-tier-${tier}`}>
              <h3 id={`tier-${tier}`} className="mb-2 text-base font-semibold text-ink-900">
                {ot(`vendedores.tier.${tier}`)}
              </h3>
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{ot(`vendedores.tier.${tier}`)}</caption>
                <thead className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th scope="col" className="py-2 pr-3">{ot('vendedores.col.seller')}</th>
                    <th scope="col" className="py-2 pr-3">{ot('vendedores.col.status')}</th>
                    <th scope="col" className="py-2 pr-3">{ot('vendedores.col.releases')}</th>
                    <th scope="col" className="py-2 pr-3">{ot('vendedores.col.option')}</th>
                    <th scope="col" className="py-2 pr-3">{ot('vendedores.col.plans')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id} data-testid={`seller-row-${s.id}`} data-status={s.verificationStatus} className="cursor-pointer border-b border-ink-100 hover:bg-ink-50" onClick={() => onOpen(s.id)}>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          data-testid={`seller-open-${s.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(s.id);
                          }}
                          className="min-h-9 rounded text-left font-semibold text-brand-800 hover:underline"
                        >
                          {s.tradeName}
                        </button>
                        <span className="block text-xs text-ink-700">{s.legalName}</span>
                      </td>
                      <td className="py-2 pr-3">
                        <SellerStatusBadge status={s.verificationStatus} />
                      </td>
                      <td className="py-2 pr-3">
                        {s.gate ? (
                          <Badge tone="warn">
                            <span data-gate={s.gate}>{ot(`gate.${s.gate}.title`)}</span>
                          </Badge>
                        ) : (
                          <Badge tone="brand">{ot('vendedores.flowing')}</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3">{ot(`vendedores.option.${s.payoutOption}`)}</td>
                      <td className="tabular py-2 pr-3">{ot('vendedores.plansValue', { plans: s.planCount, releases: s.releasesCount })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
    </Card>
  );
}