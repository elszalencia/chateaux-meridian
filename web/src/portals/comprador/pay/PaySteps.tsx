// Progress of a payment, one row per step the corridor lists (`paySteps`). A step the payment did
// not reach yet because the installment is not due (delivery to the seller on the due date) says
// when it will happen instead of spinning.

import type { PayStep } from '@casa-puente/services';
import { useT } from '../../../app/i18n';
import { SpinnerIcon } from '../../../components/ui';
import { CheckIcon } from '../../../views/comprador/shared';
import { usePortalT } from '../copy';

export function PaySteps({
  steps,
  done,
  busy,
  seller,
  laterNote,
}: {
  steps: readonly PayStep[];
  done: Partial<Record<PayStep, boolean>>;
  busy: boolean;
  seller: string;
  /** Shown on steps still open once the payment finished (for example "el 29 oct 2026"). */
  laterNote?: string;
}) {
  const t = useT();
  const tp = usePortalT();
  const current = steps.find((s) => !done[s]);
  return (
    <ol aria-label={t('comprador.pay.progressLabel')} className="space-y-2">
      {steps.map((s) => {
        const isDone = !!done[s];
        const isCurrent = !isDone && s === current && busy;
        const state = isDone ? t('comprador.pay.stepDone') : isCurrent ? t('comprador.pay.stepCurrent') : !busy && laterNote ? laterNote : t('comprador.pay.stepPending');
        return (
          <li
            key={s}
            data-testid={`pay-step-${s}`}
            data-done={isDone ? 'true' : 'false'}
            aria-current={isCurrent ? 'step' : undefined}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${isDone ? 'border-brand-200 bg-brand-50 text-brand-800' : isCurrent ? 'border-brand-500 bg-white text-ink-900' : 'border-ink-200 bg-white text-ink-700'}`}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current" aria-hidden="true">
              {isDone ? <CheckIcon /> : isCurrent ? <SpinnerIcon className="h-4 w-4" /> : null}
            </span>
            <span className="font-medium">{tp(`steps.${s}`, { seller })}</span>
            <span className="ml-auto text-right text-xs">{state}</span>
          </li>
        );
      })}
    </ol>
  );
}
