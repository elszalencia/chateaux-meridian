// The pay sheet (bottom sheet on a phone, dialog on a desktop). It asks the services which methods
// this buyer has for this installment (`getPayOptions`) and lists them in that order, each with
// where, how long and the fee. Which methods appear, and whether one is disabled, is the services'
// decision: a hidden method is simply not in the list, a disabled one shows its reason. Picking a
// method opens its panel; a finished payment ends on the receipt. Options are only requested for a
// payable installment; otherwise the sheet says when paying opens.
// Corridors that keep the lock screens pay by bank debit through the original pay flow.

import { useCallback, useState } from 'react';
import type { PayMethod, PayOptionView, PlanView } from '@chateaux/services';
import { api } from '../../../app/api';
import { useFormat } from '../../../app/format';
import { useAsync } from '../../../app/hooks';
import { useT } from '../../../app/i18n';
import { Badge, Button, EmptyState, ErrorState, Modal, Spinner } from '../../../components/ui';
import { PayFlow } from '../../../views/comprador/PayFlow';
import { usePortalT } from '../copy';
import { corridorOfView, installmentToPay, keepsLockScreens, payOpensOn } from '../corridorUi';
import { CorridorReceipt } from '../CorridorReceipt';
import { payoutFor } from '../ReceiptsPanel';
import { AchPanel } from './AchPanel';
import { CounterPanel } from './CounterPanel';
import { MoneyGramPanel, type Done } from './MoneyGramPanel';
import { PaySteps } from './PaySteps';

export function PaySheet({ view, onPaid, onClose }: { view: PlanView; onPaid: () => void; onClose: (paid: boolean) => void }) {
  const t = useT();
  const tp = usePortalT();
  const c = corridorOfView(view);
  // The installment is fixed when the sheet opens, so a reload after paying does not move it.
  const [installment] = useState(() => installmentToPay(view));
  const idx = installment?.payable ? installment.idx : null;
  const options = useAsync(() => (idx == null ? Promise.resolve(null) : api.getPayOptions(view.plan.id, idx)), [view.plan.id, idx]);
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const finish = useCallback(
    (d: Done) => {
      setDone(d);
      onPaid();
    },
    [onPaid],
  );
  const close = () => onClose(done != null);

  if (installment && method === 'ach' && keepsLockScreens(c)) {
    return <PayFlow view={view} mode={{ kind: 'single', idx: installment.idx }} onClose={onClose} />;
  }

  const n = installment?.number ?? 0;
  const title = done ? tp('done.title', { n }) : t('comprador.pay.title', { n });
  let body;
  if (done && installment) body = <DoneView view={view} done={done} dueDate={installment.dueDate} onClose={close} />;
  else if (!installment || idx == null) body = <NotOpen view={view} />;
  else if (options.status === 'error' && !options.data) body = <ErrorState error={options.error} onRetry={options.reload} />;
  else if (!options.data) body = <Spinner />;
  else {
    const option = method ? options.data.options.find((o) => o.method === method) : undefined;
    if (!option) body = <MethodList options={options.data.options} onPick={setMethod} />;
    else
      body = (
        <div>
          <Button label={tp('sheet.backHint')} variant="ghost" size="sm" data-testid="pay-back" onClick={() => setMethod(null)} className="-ml-2 mb-3 min-h-11">
            {tp('sheet.back')}
          </Button>
          <h3 className="mb-3 text-lg font-semibold text-ink-900">{tp(`methods.${option.method}.name`)}</h3>
          {option.method === 'moneygram_cash' && <MoneyGramPanel view={view} installment={installment} option={option} onPaid={finish} />}
          {option.method === 'office_counter' && <CounterPanel view={view} installment={installment} option={option} />}
          {option.method === 'ach' && <AchPanel view={view} installment={installment} option={option} onPaid={finish} />}
        </div>
      );
  }

  return (
    <Modal title={title} onClose={close} labelClose={t('common.close')} wide={done != null}>
      <div data-testid="pay-sheet" data-idx={idx ?? ''}>
        {body}
      </div>
    </Modal>
  );
}

function MethodList({ options, onPick }: { options: PayOptionView[]; onPick: (m: PayMethod) => void }) {
  const tp = usePortalT();
  const f = useFormat();
  if (options.length === 0) return <EmptyState title={tp('sheet.noMethods')} body={tp('sheet.noMethodsBody')} />;
  return (
    <div>
      <p className="mb-3 text-ink-700">{tp('sheet.intro')}</p>
      <ul aria-label={tp('sheet.methodsLabel')} className="space-y-3">
        {options.map((o) => {
          const where = o.method === 'office_counter' && o.office ? o.office.name : tp(`methods.${o.method}.where`);
          const fee = o.feeUsd > 0 ? tp('sheet.fee', { fee: f.usd(o.feeUsd) }) : tp('noFee');
          const content = (
            <>
              <span className="flex w-full flex-wrap items-center justify-between gap-2">
                <span className="text-base font-semibold text-ink-900">{tp(`methods.${o.method}.name`)}</span>
                <span className="tabular text-sm font-semibold text-ink-900">{f.usd(o.totalUsd)}</span>
              </span>
              <span className="text-sm text-ink-700">
                {tp('sheet.where')}: {where}
              </span>
              <span className="text-sm text-ink-700">
                {tp('sheet.time')}: {tp(`methods.${o.method}.time`)}
              </span>
              <span className="text-sm text-ink-700">{fee}</span>
              {o.payment?.status === 'pending' && <Badge tone="info">{tp('sheet.openReference', { ref: o.payment.externalRef ?? '' })}</Badge>}
              {o.payment?.status === 'quote_expired' && <Badge tone="warn">{tp('sheet.expiredReference')}</Badge>}
            </>
          );
          return (
            <li key={o.method}>
              {o.enabled ? (
                <button
                  type="button"
                  data-testid={`method-${o.method}`}
                  data-enabled="true"
                  onClick={() => onPick(o.method)}
                  className="flex min-h-11 w-full flex-col items-start gap-1 rounded-xl border border-ink-300 bg-white px-4 py-3 text-left transition-colors hover:border-brand-700 hover:bg-brand-50"
                >
                  {content}
                </button>
              ) : (
                <div data-testid={`method-${o.method}`} data-enabled="false" aria-disabled="true" className="flex w-full flex-col items-start gap-1 rounded-xl border border-dashed border-ink-300 bg-ink-50 px-4 py-3">
                  {content}
                  <p data-testid={`method-${o.method}-reason`} className="mt-1 text-sm font-medium text-warn-700">
                    {tp(`disabled.${o.disabledReason ?? 'method_not_offered'}`, {
                      max: o.limits ? f.usd(o.limits.maxUsd) : '',
                      min: o.limits ? f.usd(o.limits.minUsd) : '',
                    })}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NotOpen({ view }: { view: PlanView }) {
  const t = useT();
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const next = view.summary.nextInstallment;
  if (view.governance.fundsBlocked) return <EmptyState title={tp('sheet.blocked')} body={t('errors.plan_blocked')} />;
  if (!next) return <EmptyState title={tp('next.allPaid')} body={tp('next.allPaidBody')} />;
  return (
    <div data-testid="pay-not-open">
      <EmptyState title={tp('sheet.notOpen', { n: next.number })} body={tp('sheet.notOpenBody', { date: f.date(payOpensOn(next, c)), due: f.date(next.dueDate) })} />
    </div>
  );
}

function DoneView({ view, done, dueDate, onClose }: { view: PlanView; done: Done; dueDate: string; onClose: () => void }) {
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const payouts = useAsync(() => api.listPayouts({ planId: view.plan.id }), [view.plan.id, done.receipt.id]);
  const delivered = done.receipt.payoutId != null;
  const steps = { ...done.steps, ...(delivered ? { entregado: true } : {}) };
  return (
    <div data-testid="pay-done">
      <p role="status" className="mb-3 font-semibold text-brand-800">
        {tp(delivered ? 'done.bodyDelivered' : 'done.body', { date: f.date(dueDate) })}
      </p>
      <div className="mb-4">
        <PaySteps steps={c.paySteps} done={steps} busy={false} seller={view.seller?.tradeName ?? view.plan.trustCompany} laterNote={tp('steps.on', { date: f.date(dueDate) })} />
      </div>
      <CorridorReceipt receipt={done.receipt} view={view} payout={payoutFor(done.receipt, payouts.data)} variant="full" withTestIds />
      <div className="mt-4 flex justify-end">
        <Button label={tp('done.close')} data-testid="receipt-close" onClick={onClose} className="w-full sm:w-auto">
          {tp('done.close')}
        </Button>
      </div>
    </div>
  );
}
