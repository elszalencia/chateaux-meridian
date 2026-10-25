// Pay at an office or licensed agency counter: which one (the buyer's nearest, as the services pick
// it), its address and hours, the amount to bring, and the phone number to give the cashier so the
// counter finds the plan. Nothing to confirm here: the cashier records the payment.

import type { InstallmentView, PayOptionView, PlanView } from '@chateaux/services';
import { useFormat } from '../../../app/format';
import { EmptyState } from '../../../components/ui';
import { Row } from '../../../views/comprador/shared';
import { usePortalT } from '../copy';
import { SimBadge } from '../SimBadge';

export function CounterPanel({ view, installment, option }: { view: PlanView; installment: InstallmentView; option: PayOptionView }) {
  const tp = usePortalT();
  const f = useFormat();
  const office = option.office;
  return (
    <div data-testid="counter-panel" className="space-y-4">
      {office ? (
        <div className="rounded-xl border border-ink-200 bg-ink-50 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{tp(office.isLicensedAgency ? 'counter.agency' : 'counter.office')}</p>
          <p data-testid="counter-office" className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold text-ink-900">
            <span>{office.name}</span>
            {office.simulated && <SimBadge />}
          </p>
          <p className="text-sm text-ink-700">{tp('counter.address', { address: office.address, city: office.city, state: office.state })}</p>
          <dl className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <Row label={tp('counter.hours')} value={<span data-testid="counter-hours">{office.hours}</span>} />
            <Row label={tp('counter.officePhone')} value={office.phone} />
          </dl>
        </div>
      ) : (
        <EmptyState title={tp('counter.noOffice')} body={tp('counter.noOfficeBody')} />
      )}
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <Row
          label={tp('counter.givePhone')}
          value={
            <span data-testid="counter-buyer-phone" className="text-2xl">
              {view.buyer.phone}
            </span>
          }
          hint={tp('counter.givePhoneHint')}
        />
        <Row
          label={tp('counter.amount')}
          value={<span className="text-2xl">{f.usd(option.totalUsd)}</span>}
          hint={option.feeUsd > 0 ? tp('feeBreakdown', { usd: f.usd(installment.usdShown), fee: f.usd(option.feeUsd) }) : tp('noFee')}
        />
      </dl>
      <p className="text-sm text-ink-700">{tp('counter.after')}</p>
    </div>
  );
}
