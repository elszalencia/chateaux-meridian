// Buyer home for a corridor without rate locks: who and which unit, the property check, the next
// payment, any notice about the plan, the calendar (no lock states) and the receipts. Data comes
// from the portal (one load per source, keyed on the demo version); every action is a deep link, so
// the pay sheet and the receipt open the same way from a message or from this screen.

import { useState } from 'react';
import { minorToMajor, type PayoutView, type PlanView, type Receipt } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import type { AsyncState } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Card } from '../../components/ui';
import { AdverseNotices } from '../../views/comprador/AdverseNotices';
import { PlanCalendar } from '../../views/comprador/PlanCalendar';
import { usePortalT } from './copy';
import { corridorOfView } from './corridorUi';
import { InstallmentSheet } from './InstallmentSheet';
import { NextPaymentCard } from './NextPaymentCard';
import { PropertyBadge } from './PropertyBadge';
import { ReceiptsPanel } from './ReceiptsPanel';

export function BuyerHome({
  view,
  refreshing,
  receipts,
  payouts,
  onPay,
  onReceipt,
}: {
  view: PlanView;
  refreshing: boolean;
  receipts: AsyncState<Receipt[]>;
  payouts: AsyncState<PayoutView[]>;
  onPay: () => void;
  onReceipt: (idx: number) => void;
}) {
  const t = useT();
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const [cell, setCell] = useState<number | null>(null);
  const selected = cell == null ? null : view.installments.find((i) => i.idx === cell) ?? null;
  const { buyer, unit, plan } = view;

  return (
    <div data-testid="buyer-home" data-corridor={view.corridor} className="space-y-6">
      <h1 className="sr-only">{t('comprador.title')}</h1>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <Card as="section" className="relative">
          {refreshing && (
            <span role="status" className="absolute right-5 top-5 text-xs text-ink-500">
              {t('comprador.header.updating')}
            </span>
          )}
          <p className="text-sm text-ink-500">{t('comprador.header.buyerLine', { name: buyer.name, city: buyer.city })}</p>
          <h2 className="mt-1 text-2xl font-semibold text-ink-900">{t('comprador.header.unitLine', { unit: unit.unitName, project: unit.project, city: unit.city })}</h2>
          <p className="mt-1 text-sm text-ink-700">{tp('home.planLine', { ref: plan.encargoRef, seller: view.seller?.tradeName ?? plan.trustCompany })}</p>
          <p className="mt-1 text-sm text-ink-500">
            {tp('home.priceLine', {
              price: f.usd(minorToMajor(unit.priceCop, c)),
              down: f.usd(minorToMajor(plan.downPaymentCop, c)),
              count: plan.installmentsCount,
              usd: f.usd(minorToMajor(plan.installmentCop, c)),
            })}
          </p>
          {c.views.propertyVerification && view.seller && (
            <div className="mt-4">
              <PropertyBadge seller={view.seller} />
            </div>
          )}
        </Card>
        <NextPaymentCard view={view} onPay={onPay} />
      </div>
      <AdverseNotices view={view} />
      <PlanCalendar
        installments={view.installments}
        installmentCop={plan.installmentCop}
        subtitle={tp('home.calendarSubtitle', { count: view.installments.length, usd: f.usd(minorToMajor(plan.installmentCop, c)) })}
        lockStates={c.views.lock}
        legendLabel={(s) => tp(`legend.${s}`)}
        onSelect={(i) => setCell(i.idx)}
      />
      <ReceiptsPanel view={view} receipts={receipts} payouts={payouts} onOpen={onReceipt} />
      {selected && (
        <InstallmentSheet
          view={view}
          installment={selected}
          hasReceipt={!!receipts.data?.some((r) => r.installmentIdx === selected.idx)}
          onPay={() => {
            setCell(null);
            onPay();
          }}
          onReceipt={() => {
            setCell(null);
            onReceipt(selected.idx);
          }}
          onClose={() => setCell(null)}
        />
      )}
    </div>
  );
}
