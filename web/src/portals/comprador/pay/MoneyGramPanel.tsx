// Cash at a network agent. The sheet only opens this panel for an option the services listed as
// enabled; everything shown comes from the option and the payment row: the reference, the amount to
// hand over (installment plus fee), the time left, and a link to find an agent. States: no
// reference yet, pending, completed (the plan is credited only then), or quote_expired with
// "Nueva referencia". The network is simulated, so completing the cash-in is a demo control here.

import { useCallback, useEffect, useState } from 'react';
import type { InstallmentView, PaymentView, PayOptionView, PayStep, PlanView, Receipt } from '@casa-puente/services';
import { api } from '../../../app/api';
import { useFormat } from '../../../app/format';
import { useAction } from '../../../app/hooks';
import { Button, ErrorState } from '../../../components/ui';
import { Row } from '../../../views/comprador/shared';
import { usePortalT } from '../copy';
import { corridorOfView } from '../corridorUi';
import { SimBadge } from '../SimBadge';
import { PaySteps } from './PaySteps';
import { mmss, useCountdown } from './useCountdown';

export type Done = { receipt: Receipt; steps: Partial<Record<PayStep, boolean>> };

export function MoneyGramPanel({ view, installment, option, onPaid }: { view: PlanView; installment: InstallmentView; option: PayOptionView; onPaid: (d: Done) => void }) {
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const network = c.partners.cashNetwork ?? '';
  const seller = view.seller?.tradeName ?? view.plan.trustCompany;
  const [payment, setPayment] = useState<PaymentView | null>(option.payment);
  const [steps, setSteps] = useState<Partial<Record<PayStep, boolean>>>({});

  const request = useAction(useCallback(() => api.requestCashReference(view.plan.id, installment.idx), [view.plan.id, installment.idx]));
  const renew = useAction(useCallback((id: string) => api.renewCashReference(id), []));
  const refresh = useAction(useCallback((id: string) => api.getPayment(id), []));
  const complete = useAction(
    useCallback(async (id: string) => {
      setSteps({});
      return api.completeCashReference(id, (s) => setSteps((d) => ({ ...d, [s]: true })));
    }, []),
  );

  const left = useCountdown(payment);
  const status = payment?.status ?? 'none';

  // At zero the services already treat the reference as expired; read it back so the panel says so.
  useEffect(() => {
    if (payment && status === 'pending' && left === 0 && !refresh.busy) {
      void refresh.run(payment.id).then((p) => p && setPayment(p));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, status, payment?.id]);

  const onRequest = async () => {
    const p = await request.run();
    if (p) setPayment(p);
  };
  const onRenew = async () => {
    if (!payment) return;
    const p = await renew.run(payment.id);
    if (p) setPayment(p);
  };
  const onComplete = async () => {
    if (!payment) return;
    const r = await complete.run(payment.id);
    if (r) {
      onPaid({ receipt: r, steps: { recibido: true } });
      return;
    }
    // A failed completion may mean the reference expired meanwhile: read it back.
    const p = await refresh.run(payment.id);
    if (p) setPayment(p);
  };

  return (
    <div data-testid="mg-panel" data-status={status} className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-ink-700">
        <span>{tp('mg.intro', { network })}</span>
        <SimBadge />
      </p>
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <Row
          label={tp('mg.amount')}
          value={
            <span data-testid="mg-amount" className="text-2xl">
              {f.usd(option.totalUsd)}
            </span>
          }
          hint={tp('feeBreakdown', { usd: f.usd(installment.usdShown), fee: f.usd(option.feeUsd) })}
        />
        <Row label={tp('mg.payTo')} value={seller} hint={tp('mg.payToHint', { ref: view.plan.encargoRef })} />
      </dl>

      {status === 'none' && (
        <div className="space-y-3">
          <p className="text-sm text-ink-700">{tp('mg.howTo', { network })}</p>
          {request.status === 'error' && <ErrorState error={request.error} compact />}
          <Button label={tp('mg.requestHint', { n: installment.number })} data-testid="mg-request" busy={request.busy} onClick={() => void onRequest()} className="w-full sm:w-auto">
            {tp('mg.request')}
          </Button>
        </div>
      )}

      {status === 'pending' && payment && (
        <div className="space-y-4">
          <div className="rounded-xl border-2 border-brand-700 bg-brand-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-brand-800">{tp('mg.reference')}</p>
            <p data-testid="mg-reference" className="tabular mt-1 break-all font-mono text-3xl font-semibold tracking-wider text-ink-900">
              {payment.externalRef}
            </p>
            {left != null && (
              <p className="mt-2 text-sm text-ink-700">
                {tp('mg.expiresIn')}{' '}
                <span role="timer" aria-label={tp('mg.countdownLabel')} data-testid="mg-countdown" className="tabular font-semibold">
                  {mmss(left)}
                </span>
                {payment.expiresAt && <span> · {tp('mg.expiresAt', { time: f.dateTime(payment.expiresAt) })}</span>}
              </p>
            )}
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-700">
            <li>{tp('mg.step1', { network })}</li>
            <li>{tp('mg.step2', { usd: f.usd(option.totalUsd) })}</li>
            <li>{tp('mg.step3')}</li>
          </ol>
          <a
            href={tp('mg.locatorUrl')}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="mg-locator"
            className="inline-flex min-h-11 items-center gap-1 rounded-lg px-1 font-semibold text-brand-800 underline underline-offset-2 hover:bg-brand-50"
          >
            {tp('mg.locator', { network })}
            <span className="sr-only"> {tp('newTab')}</span>
            <span aria-hidden="true">↗</span>
          </a>
          <p className="text-sm text-ink-700">{tp('mg.pendingNote')}</p>
          <div className="rounded-lg border border-dashed border-warn-500 bg-warn-100/40 p-3">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-900">
              <span>{tp('mg.demoTitle')}</span>
              <SimBadge />
            </p>
            <p className="mt-1 text-sm text-ink-700">{tp('mg.demoBody', { network })}</p>
            {(complete.busy || complete.status === 'error') && (
              <div className="mt-3">
                <PaySteps steps={c.paySteps} done={steps} busy={complete.busy} seller={seller} />
              </div>
            )}
            {complete.status === 'error' && (
              <div className="mt-3">
                <ErrorState error={complete.error} compact />
              </div>
            )}
            <Button
              label={tp('mg.simulateHint', { network })}
              variant="secondary"
              data-testid="mg-simulate-complete"
              busy={complete.busy}
              onClick={() => void onComplete()}
              className="mt-3 w-full sm:w-auto"
            >
              {tp('mg.simulate')}
            </Button>
          </div>
        </div>
      )}

      {status === 'quote_expired' && payment && (
        <div className="space-y-3">
          <div role="status" data-testid="mg-expired" className="rounded-lg border border-warn-500 bg-warn-100 px-4 py-3 text-warn-700">
            <p className="font-semibold">{tp('mg.expiredTitle')}</p>
            <p className="mt-1 text-sm">{tp('mg.expiredBody', { ref: payment.externalRef ?? '' })}</p>
          </div>
          {renew.status === 'error' && <ErrorState error={renew.error} compact />}
          <Button label={tp('mg.renewHint', { n: installment.number })} data-testid="mg-renew" busy={renew.busy} onClick={() => void onRenew()} className="w-full sm:w-auto">
            {tp('mg.renew')}
          </Button>
        </div>
      )}

      {refresh.status === 'error' && <ErrorState error={refresh.error} compact />}
    </div>
  );
}
