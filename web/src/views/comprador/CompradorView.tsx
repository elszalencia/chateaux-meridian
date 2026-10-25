// Buyer view: María's plan (`PLAN_MARIA`) unless the route names another buyer's plan, which is how
// the presenter shows the adverse-event states. One `useAsync` per data source (plan, receipts),
// both keyed on the demo version so the clock, reset and error switch refresh everything. Data
// already on screen stays visible while a reload runs (no flicker after an action), and the four
// modal flows (installment card, lock, pay, pay ahead) are owned here so each can trigger a reload.

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PLAN_BY_CORRIDOR, type LockQuote, type Tenor } from '@chateaux/services';
import { api } from '../../app/api';
import { useDemo } from '../../app/demo';
import { useAsync } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { useBuyerPlan } from '../../app/router';
import { AdverseNotices } from './AdverseNotices';
import { Button, ErrorState, Spinner } from '../../components/ui';
import { InstallmentCard } from './InstallmentCard';
import { LockFlow } from './LockFlow';
import { PayFlow, type PayMode } from './PayFlow';
import { PlanCalendar } from './PlanCalendar';
import { PlanHeader } from './PlanHeader';
import { ReceiptsList } from './ReceiptsList';
import { RenewalBanner } from './RenewalBanner';

type Flow = { kind: 'none' } | { kind: 'cell'; idx: number } | { kind: 'lock'; tenor: Tenor | null } | { kind: 'pay'; mode: PayMode };

export default function CompradorView() {
  const t = useT();
  const { version, corridor } = useDemo();
  const planId = useBuyerPlan()[0] ?? DEFAULT_PLAN_BY_CORRIDOR[corridor];
  const plan = useAsync(() => api.getPlan(planId), [version, planId]);
  const receipts = useAsync(() => api.getReceipts(planId), [version, planId]);
  const [flow, setFlow] = useState<Flow>({ kind: 'none' });
  const [flash, setFlash] = useState<string | null>(null);
  const closeFlow = useCallback(() => setFlow({ kind: 'none' }), []);

  useEffect(() => {
    setFlash(null);
    setFlow({ kind: 'none' });
  }, [version, planId]);

  const onLocked = (quote: LockQuote) => {
    const first = quote.installments[0]!.number;
    const last = quote.installments[quote.installments.length - 1]!.number;
    setFlash(t('comprador.lock.success', { from: first, to: last }));
    closeFlow();
    plan.reload();
  };

  const onPayClosed = (paid: boolean) => {
    closeFlow();
    if (paid) {
      plan.reload();
      receipts.reload();
    }
  };

  const view = plan.data;
  const selected = flow.kind === 'cell' && view ? view.installments.find((i) => i.idx === flow.idx) ?? null : null;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">{t('comprador.title')}</h1>
      {plan.status === 'error' ? (
        <ErrorState error={plan.error} onRetry={plan.reload} />
      ) : !view ? (
        <Spinner />
      ) : (
        <>
          <PlanHeader
            view={view}
            refreshing={plan.loading}
            onPay={(idx) => setFlow({ kind: 'pay', mode: { kind: 'single', idx } })}
            onLock={() => setFlow({ kind: 'lock', tenor: null })}
            onPayAhead={() => setFlow({ kind: 'pay', mode: { kind: 'ahead' } })}
          />
          <AdverseNotices view={view} />
          {flash && (
            <div role="status" className="flex items-center justify-between gap-4 rounded-xl border border-brand-200 bg-brand-50 px-5 py-3 text-brand-900">
              <span>{flash}</span>
              <Button label={t('common.close')} variant="ghost" size="sm" onClick={() => setFlash(null)}>
                ✕
              </Button>
            </div>
          )}
          {view.activeOffer && <RenewalBanner view={view} onAccept={() => setFlow({ kind: 'lock', tenor: 'trimestral' })} />}
          <PlanCalendar installments={view.installments} installmentCop={view.plan.installmentCop} onSelect={(i) => setFlow({ kind: 'cell', idx: i.idx })} />
          <ReceiptsList receipts={receipts} trust={view.plan.trustCompany} />
          {selected && <InstallmentCard installment={selected} onClose={closeFlow} />}
          {flow.kind === 'lock' && <LockFlow planId={view.plan.id} initialTenor={flow.tenor} onClose={closeFlow} onLocked={onLocked} />}
          {flow.kind === 'pay' && <PayFlow view={view} mode={flow.mode} onClose={onPayClosed} />}
        </>
      )}
    </div>
  );
}
