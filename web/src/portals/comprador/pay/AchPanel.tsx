// Bank debit (ACH): the existing pay flow (`api.pay`) for a corridor without a conversion leg. One
// confirm step (amount with the fee, source, destination), then the corridor's progress steps, then
// the receipt in the sheet's done view. A failure keeps the steps with an inline error and a retry.

import { useCallback, useState } from 'react';
import type { InstallmentView, PayOptionView, PayStep, PlanView } from '@casa-puente/services';
import { api } from '../../../app/api';
import { useFormat } from '../../../app/format';
import { useAction } from '../../../app/hooks';
import { useT } from '../../../app/i18n';
import { Button, ErrorState } from '../../../components/ui';
import { Row } from '../../../views/comprador/shared';
import { usePortalT } from '../copy';
import { corridorOfView } from '../corridorUi';
import { SimBadge } from '../SimBadge';
import type { Done } from './MoneyGramPanel';
import { PaySteps } from './PaySteps';

export function AchPanel({ view, installment, option, onPaid }: { view: PlanView; installment: InstallmentView; option: PayOptionView; onPaid: (d: Done) => void }) {
  const t = useT();
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const seller = view.seller?.tradeName ?? view.plan.trustCompany;
  const [steps, setSteps] = useState<Partial<Record<PayStep, boolean>>>({});
  const action = useAction(
    useCallback(async () => {
      setSteps({});
      return api.pay(view.plan.id, installment.idx, (s) => setSteps((d) => ({ ...d, [s]: true })));
    }, [view.plan.id, installment.idx]),
  );

  const start = async () => {
    const r = await action.run();
    if (r) onPaid({ receipt: r, steps: { ...steps, recibido: true } });
  };

  if (action.status === 'idle') {
    return (
      <div data-testid="ach-panel" className="space-y-4">
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <Row
            label={tp('ach.amount')}
            value={
              <span data-testid="ach-amount" className="text-2xl">
                {f.usd(option.totalUsd)}
              </span>
            }
            hint={option.feeUsd > 0 ? tp('feeBreakdown', { usd: f.usd(installment.usdShown), fee: f.usd(option.feeUsd) }) : tp('noFee')}
          />
          <Row
            label={t('comprador.pay.source')}
            value={
              <span className="flex flex-wrap items-center gap-2">
                <span>{tp('ach.source')}</span>
                <SimBadge />
              </span>
            }
          />
          <Row label={t('comprador.pay.destination')} value={tp('ach.destination', { target: t(c.payoutTargetKey), seller })} hint={tp('ach.destinationHint', { ref: view.plan.encargoRef })} />
        </dl>
        <Button label={tp('ach.confirmHint', { n: installment.number, usd: f.usd(option.totalUsd) })} data-testid="pay-confirm" onClick={() => void start()} className="w-full sm:w-auto">
          {tp('ach.confirm')}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="ach-panel" className="space-y-3">
      <p className="text-ink-700">{t('comprador.pay.processing')}</p>
      <PaySteps steps={c.paySteps} done={steps} busy={action.busy} seller={seller} />
      {action.status === 'error' && (
        <>
          <ErrorState error={action.error} compact />
          <Button label={t('comprador.pay.retry')} onClick={() => void start()} className="w-full sm:w-auto">
            {t('common.retry')}
          </Button>
        </>
      )}
    </div>
  );
}
