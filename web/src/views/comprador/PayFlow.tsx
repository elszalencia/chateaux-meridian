// Pay flow for one installment or for the next open quarter (pay ahead). One confirm screen (amount,
// source, destination), then a three-step progress list driven by the API's progress callback
// (Recibido · Convertido · Entregado), then the receipt(s). A failure keeps the steps visible with
// an inline error and a retry; closing after success asks the parent to reload the plan.

import { useCallback, useState } from 'react';
import { ApiError, nextLockableIdxs, type PayStep, type PlanView, type Receipt } from '@chateaux/services';
import { api } from '../../app/api';
import { useFormat } from '../../app/format';
import { useAction } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Button, ErrorState, Modal, SpinnerIcon } from '../../components/ui';
import { ReceiptView } from './ReceiptView';
import { CheckIcon, Row } from './shared';

export type PayMode = { kind: 'single'; idx: number } | { kind: 'ahead' };

const STEPS: PayStep[] = ['recibido', 'convertido', 'entregado'];
const NONE: Record<PayStep, boolean> = { recibido: false, convertido: false, entregado: false };

function ceilUsd(cop: number, rate: number): number {
  return Math.ceil((cop / rate) * 100) / 100;
}

export function PayFlow({ view, mode, onClose }: { view: PlanView; mode: PayMode; onClose: (paid: boolean) => void }) {
  const t = useT();
  const f = useFormat();
  const [phase, setPhase] = useState<'confirm' | 'progress' | 'done'>('confirm');
  const [done, setDone] = useState<Record<PayStep, boolean>>(NONE);
  const trust = view.plan.trustCompany;
  const installment = mode.kind === 'single' ? view.installments.find((i) => i.idx === mode.idx) ?? null : null;
  const aheadIdxs = mode.kind === 'ahead' ? nextLockableIdxs(view.installments, 'trimestral') : null;
  const aheadRows = aheadIdxs ? aheadIdxs.map((idx) => view.installments.find((i) => i.idx === idx)!) : [];

  const action = useAction(
    useCallback(async (): Promise<Receipt[]> => {
      setDone(NONE);
      const onProgress = (step: PayStep) => setDone((d) => ({ ...d, [step]: true }));
      if (mode.kind === 'single') return [await api.pay(view.plan.id, mode.idx, onProgress)];
      return api.payAhead(view.plan.id, onProgress);
    }, [mode, view.plan.id]),
  );

  const start = async () => {
    setPhase('progress');
    const r = await action.run();
    if (r) setPhase('done');
  };

  const close = () => {
    if (action.busy) return;
    onClose(phase === 'done');
  };

  const title = mode.kind === 'single' ? t('comprador.pay.title', { n: installment?.number ?? mode.idx + 1 }) : t('comprador.payAhead.title');

  let confirm;
  if (mode.kind === 'single' && installment) {
    const broken = installment.cellState === 'roto';
    const locked = installment.status === 'locked' && installment.lockedRate != null;
    const amount = broken ? ceilUsd(installment.copDue + (installment.breakCostCop ?? 0), view.spot) : installment.usdShown;
    confirm = (
      <div>
        <dl>
          <Row
            label={t('comprador.pay.amount')}
            value={<span className="text-3xl">{f.usd(amount)}</span>}
            hint={
              <>
                {f.cop(installment.copDue)} · {locked ? t('comprador.pay.rateLocked', { rate: f.rate(installment.lockedRate!) }) : t('comprador.pay.rateToday', { rate: f.rate(view.spot) })}
                {broken && <> · {t('comprador.pay.breakIncluded', { cop: f.cop(installment.breakCostCop ?? 0) })}</>}
              </>
            }
          />
          <Row label={t('comprador.pay.source')} value={t('comprador.pay.sourceValue')} />
          <Row label={t('comprador.pay.destination')} value={t('comprador.pay.destinationValue', { ref: view.plan.encargoRef, trust })} />
        </dl>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button label={t('common.cancel')} variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button label={t('comprador.pay.confirmHint', { n: installment.number })} data-testid="pay-confirm" onClick={() => void start()}>
            {t('comprador.pay.confirm')}
          </Button>
        </div>
      </div>
    );
  } else if (mode.kind === 'ahead') {
    const total = aheadRows.reduce((a, r) => a + ceilUsd(r.copDue, view.spot), 0);
    confirm = (
      <div>
        <p className="text-ink-700">{t('comprador.payAhead.explain', { rate: f.rate(view.spot) })}</p>
        {aheadRows.length === 0 ? (
          <div className="mt-3">
            <ErrorState error={new ApiError('NOTHING_TO_PAY_AHEAD')} compact />
          </div>
        ) : (
          <dl className="mt-2">
            <Row
              label={t('comprador.payAhead.covers')}
              value={
                <ul className="space-y-0.5 text-sm">
                  {aheadRows.map((r) => (
                    <li key={r.idx} className="flex justify-between gap-4">
                      <span>{t('comprador.lock.coverRow', { n: r.number, date: f.date(r.dueDate) })}</span>
                      <span className="tabular">{f.usd(ceilUsd(r.copDue, view.spot))}</span>
                    </li>
                  ))}
                </ul>
              }
            />
            <Row label={t('comprador.payAhead.estimate')} value={<span className="text-2xl">{f.usd(total)}</span>} hint={f.cop(aheadRows.reduce((a, r) => a + r.copDue, 0))} />
            <Row label={t('comprador.pay.source')} value={t('comprador.pay.sourceValue')} />
            <Row label={t('comprador.pay.destination')} value={t('comprador.pay.destinationValue', { ref: view.plan.encargoRef, trust })} />
          </dl>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button label={t('common.cancel')} variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button label={t('comprador.payAhead.confirmHint')} data-testid="pay-ahead-confirm" disabled={aheadRows.length === 0} onClick={() => void start()}>
            {t('comprador.payAhead.confirm')}
          </Button>
        </div>
      </div>
    );
  }

  const current = STEPS.find((s) => !done[s]);
  // The step list stays mounted in the done phase (above the receipt) so the final "Entregado"
  // state is actually seen rather than replaced in the same render as the receipt.
  const stepsList = (
    <ol aria-label={t('comprador.pay.progressLabel')} className={phase === 'done' ? 'grid gap-2 sm:grid-cols-3' : 'mt-3 space-y-2'}>
        {STEPS.map((s) => {
          const isDone = done[s];
          const isCurrent = !isDone && s === current && action.busy;
          const label = t(`comprador.pay.steps.${s}`, { trust });
          const state = isDone ? t('comprador.pay.stepDone') : isCurrent ? t('comprador.pay.stepCurrent') : t('comprador.pay.stepPending');
          return (
            <li
              key={s}
              data-testid={`pay-step-${s}`}
              data-done={isDone ? 'true' : 'false'}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${isDone ? 'border-brand-200 bg-brand-50 text-brand-800' : isCurrent ? 'border-brand-500 bg-white text-ink-900' : 'border-ink-200 bg-white text-ink-500'}`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current" aria-hidden="true">
                {isDone ? <CheckIcon /> : isCurrent ? <SpinnerIcon className="h-4 w-4" /> : null}
              </span>
              <span className="font-medium">{label}</span>
              <span className="ml-auto text-xs">{state}</span>
            </li>
          );
        })}
      </ol>
  );
  const progress = (
    <div>
      <p className="text-ink-700">{t('comprador.pay.processing')}</p>
      {stepsList}
      {action.status === 'error' && (
        <div className="mt-3">
          <ErrorState error={action.error} compact />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button label={t('common.cancel')} variant="secondary" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button label={t('comprador.pay.retry')} onClick={() => void start()}>
              {t('common.retry')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const result = action.result ?? [];
  const finished = (
    <div>
      <div className="mb-4">{stepsList}</div>
      {mode.kind === 'single' && result[0] ? (
        <ReceiptView receipt={result[0]} trust={trust} variant="full" withTestIds />
      ) : (
        <div>
          <p role="status" className="font-semibold text-brand-800">
            {t('comprador.payAhead.done', { count: result.length })}
          </p>
          <p className="text-sm text-ink-500">{t('comprador.payAhead.doneHint')}</p>
          <ol className="mt-3 divide-y divide-ink-200">
            {result.map((r) => (
              <li key={r.id} className="py-3">
                <ReceiptView receipt={r} trust={trust} variant="row" />
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button label={t('comprador.receipt.close')} data-testid="receipt-close" onClick={close}>
          {t('comprador.receipt.close')}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal title={title} onClose={close} labelClose={t('common.close')} wide={phase === 'done'}>
      {phase === 'confirm' ? confirm : phase === 'progress' ? progress : finished}
    </Modal>
  );
}
