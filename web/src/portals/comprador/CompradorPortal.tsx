// Comprador portal: the buyer's entry for #/comprador[/<plan>] and the message deep links
// #/c/<plan>/pagar (pay sheet) and #/c/<plan>/recibo/<idx> (one receipt). The plan decides the
// screen through its corridor config: corridors with rate locks keep the original buyer view
// unchanged, the others get the pay-sheet home. The sheet and the receipt are driven by the route
// for every corridor, so "Pagar" on the home and a link in a message open the same thing, and
// closing either one returns to the plan's home.

import { useCallback } from 'react';
import { DEFAULT_PLAN_BY_CORRIDOR } from '@chateaux/services';
import { api } from '../../app/api';
import { useDemo, useFollowPlanCorridor } from '../../app/demo';
import { useAsync } from '../../app/hooks';
import { deepLinks, navigateTo, useFullRoute } from '../../app/router';
import { ErrorState, Spinner } from '../../components/ui';
import CompradorView from '../../views/comprador/CompradorView';
import { BuyerHome } from './BuyerHome';
import { corridorOfView, keepsLockScreens } from './corridorUi';
import { PaySheet } from './pay/PaySheet';
import { ReceiptSheet } from './ReceiptSheet';

export default function CompradorPortal() {
  const { version, corridor, refresh } = useDemo();
  const route = useFullRoute();
  const planId = route.planId ?? DEFAULT_PLAN_BY_CORRIDOR[corridor];
  const plan = useAsync(() => api.getPlan(planId), [version, planId]);
  const receipts = useAsync(() => api.getReceipts(planId), [version, planId]);
  const payouts = useAsync(() => api.listPayouts({ planId }), [version, planId]);
  const { reload: reloadPlan } = plan;
  const { reload: reloadReceipts } = receipts;
  const { reload: reloadPayouts } = payouts;

  const onPaid = useCallback(() => {
    reloadPlan();
    reloadReceipts();
    reloadPayouts();
  }, [reloadPlan, reloadReceipts, reloadPayouts]);

  const view = plan.data && plan.data.plan.id === planId ? plan.data : null;
  useFollowPlanCorridor(view?.corridor);
  if (!view) return plan.status === 'error' ? <ErrorState error={plan.error} onRetry={plan.reload} /> : <Spinner />;

  const legacy = keepsLockScreens(corridorOfView(view));
  const home = () => navigateTo(deepLinks.plan(view.plan.id));
  const closeSheet = (paid: boolean) => {
    home();
    // The original view loads its own data; a version bump refreshes it after a payment.
    if (paid && legacy) void refresh();
  };

  return (
    <>
      {legacy ? (
        <CompradorView />
      ) : (
        <BuyerHome
          view={view}
          refreshing={plan.loading}
          receipts={receipts}
          payouts={payouts}
          onPay={() => navigateTo(deepLinks.pay(view.plan.id))}
          onReceipt={(idx) => navigateTo(deepLinks.receipt(view.plan.id, idx))}
        />
      )}
      {route.action === 'pagar' && <PaySheet key={`${view.plan.id}:pay`} view={view} onPaid={onPaid} onClose={closeSheet} />}
      {route.action === 'recibo' && route.idx != null && <ReceiptSheet view={view} idx={route.idx} receipts={receipts} payouts={payouts} onClose={home} />}
    </>
  );
}
