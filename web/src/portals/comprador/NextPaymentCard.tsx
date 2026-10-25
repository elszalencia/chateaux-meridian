// Next payment: "Pagar USD 750,00 antes del 29 oct 2026" and one primary action that opens the pay
// sheet. Before the corridor's pay window opens the action stays visible but disabled with the date
// it opens; while the plan is on hold it points to the notice above. An open cash reference is
// mentioned here too, so a buyer who comes back finds it without opening the sheet.

import type { PlanView } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Badge, Button, Card } from '../../components/ui';
import { usePortalT } from './copy';
import { corridorOfView, payOpensOn } from './corridorUi';

export function NextPaymentCard({ view, onPay }: { view: PlanView; onPay: () => void }) {
  const t = useT();
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const next = view.summary.nextInstallment;
  const blocked = view.governance.fundsBlocked;
  const openRef = view.payments.find((p) => p.status === 'pending' && p.externalRef);

  if (!next) {
    return (
      <Card title={tp('next.title')}>
        <p data-testid="next-payment-done" className="text-lg font-semibold text-brand-800">
          {tp('next.allPaid')}
        </p>
        <p className="mt-1 text-sm text-ink-500">{tp('next.allPaidBody')}</p>
      </Card>
    );
  }

  return (
    <Card title={tp('next.title')} className="flex flex-col">
      <p data-testid="next-payment-headline" className="text-2xl font-semibold text-ink-900">
        {tp('next.headline', { usd: f.usd(next.usdShown), date: f.date(next.dueDate) })}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-700">
        <span>{tp('next.installment', { n: next.number, count: view.installments.length })}</span>
        {next.isLate && <Badge tone="warn">{t(next.inGrace || next.lateInGrace ? 'comprador.calendar.inGrace' : 'comprador.calendar.late')}</Badge>}
      </p>
      {openRef && (
        <p data-testid="next-open-reference" className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">
          {tp('next.openReference', { ref: openRef.externalRef ?? '', n: openRef.idx + 1 })}
        </p>
      )}
      <div className="mt-4">
        <Button
          label={tp('next.payHint', { n: next.number, usd: f.usd(next.usdShown) })}
          data-testid="pay-button"
          disabled={!next.payable}
          onClick={onPay}
          className="w-full"
        >
          {tp('next.pay')}
        </Button>
        {!next.payable && !blocked && next.status !== 'missed' && (
          <p data-testid="pay-opens" className="mt-2 text-sm text-ink-500">
            {tp('next.opensOn', { date: f.date(payOpensOn(next, c)) })}
          </p>
        )}
        {blocked && (
          <p data-testid="actions-blocked" className="mt-2 text-sm text-ink-700">
            {tp('next.blocked')}
          </p>
        )}
      </div>
    </Card>
  );
}
