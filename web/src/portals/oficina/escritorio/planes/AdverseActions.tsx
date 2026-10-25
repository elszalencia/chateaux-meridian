// Adverse-event actions on one plan, offered by the plan's state (the services refuse anything the
// contract rules would refuse, and the refusal shows here). Pause and resume, and the installment
// actions (mark missed, cure, waive), run from the drawer; declaring default and cancelling the plan
// are irreversible and confirm in a modal.

import { useId, useState } from 'react';
import { REASONS, type InstallmentView, type PlanView } from '@chateaux/services';
import { api } from '../../../../app/api';
import { useT } from '../../../../app/i18n';
import { useAction } from '../../../../app/hooks';
import { Button, ErrorState } from '../../../../components/ui';
import { ConfirmModal } from '../../shared/ConfirmModal';
import { DrawerSection } from '../../shared/Drawer';
import { useOT } from '../../shared/i18n';

const HOLD_REASONS = [REASONS.KYC_REVIEW, REASONS.SANCTIONS_REVIEW, REASONS.DISPUTED_PAYMENT, REASONS.ACH_RETURN, REASONS.CNR_LIEN] as const;
const CANCEL_REASONS = [REASONS.BUYER_WITHDRAWAL, REASONS.PROJECT_CANCELLED] as const;

type AdverseAction = Parameters<typeof api.runAdverseAction>[0];
type Irreversible = 'declare_default' | 'cancel_plan';

/** Installment actions the state allows: mark missed past grace, cure or waive a missed one. */
export function installmentActions(i: InstallmentView): ('mark_missed' | 'cure' | 'waive')[] {
  if (i.status === 'missed') return ['cure', 'waive'];
  if ((i.status === 'open' || i.status === 'locked') && i.isLate && !i.lateInGrace && !i.fundedAt) return ['mark_missed'];
  return [];
}

export function AdverseActions({ pv, onDone }: { pv: PlanView; onDone: () => void }) {
  const t = useT();
  const ot = useOT();
  const id = useId();
  const state = pv.governance.state;
  const [holdReason, setHoldReason] = useState<number>(HOLD_REASONS[0].code);
  const [cancelReason, setCancelReason] = useState<number>(CANCEL_REASONS[0].code);
  const [confirm, setConfirm] = useState<Irreversible | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const act = useAction((action: AdverseAction) => api.runAdverseAction(action, ot('actions.detail')));

  const run = async (action: AdverseAction) => {
    setDone(null);
    const r = await act.run(action);
    if (r) {
      setDone(action.kind);
      setConfirm(null);
      onDone();
    }
  };

  const live = state === 'active' || state === 'delinquent';
  const instRows = pv.installments.map((i) => ({ i, actions: installmentActions(i) })).filter((x) => x.actions.length > 0);
  const nothing = !live && state !== 'on_hold' && state !== 'defaulted' && instRows.length === 0;

  return (
    <DrawerSection title={ot('actions.title')} testId="plan-actions">
      <div className="space-y-3">
        {nothing && <p className="text-sm text-ink-700">{ot('actions.none')}</p>}
        {live && (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${id}-hold`} className="block text-xs font-medium uppercase tracking-wide text-ink-500">
                {ot('actions.holdReason')}
              </label>
              <select id={`${id}-hold`} data-testid="hold-reason" value={holdReason} onChange={(e) => setHoldReason(Number(e.target.value))} className="mt-1 min-h-11 rounded-lg border border-ink-300 bg-white px-2 text-sm">
                {HOLD_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {t(`reasons.${r.key}`)}
                  </option>
                ))}
              </select>
            </div>
            <Button label={ot('actions.place_hold')} variant="secondary" busy={act.busy} data-testid="action-place_hold" onClick={() => void run({ kind: 'place_hold', planId: pv.plan.id, reasonCode: holdReason })} />
          </div>
        )}
        {state === 'on_hold' && <Button label={ot('actions.lift_hold')} variant="secondary" busy={act.busy} data-testid="action-lift_hold" onClick={() => void run({ kind: 'lift_hold', planId: pv.plan.id, reasonCode: REASONS.HOLD_CLEARED.code })} />}
        {(live || state === 'on_hold' || state === 'defaulted') && (
          <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
            {(live || state === 'on_hold') && <Button label={ot('actions.declare_default')} variant="danger" size="sm" data-testid="action-declare_default" onClick={() => setConfirm('declare_default')} />}
            <Button label={ot('actions.cancel_plan')} variant="danger" size="sm" data-testid="action-cancel_plan" onClick={() => setConfirm('cancel_plan')} />
          </div>
        )}
        {instRows.length > 0 && (
          <ul className="space-y-2 border-t border-ink-100 pt-3">
            {instRows.map(({ i, actions }) => (
              <li key={i.idx} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{ot('actions.installment', { n: i.number, state: ot(`cell.${i.cellState}`) })}</span>
                <span className="flex gap-2">
                  {actions.map((a) => (
                    <Button
                      key={a}
                      label={ot(`actions.${a}`)}
                      variant="secondary"
                      size="sm"
                      busy={act.busy}
                      data-testid={`action-${a}-${i.idx}`}
                      onClick={() =>
                        void run({ kind: a, planId: pv.plan.id, idx: i.idx, reasonCode: a === 'mark_missed' ? REASONS.GRACE_EXPIRED.code : a === 'cure' ? REASONS.PAID_LATE.code : REASONS.WAIVED_BY_BUILDER.code })
                      }
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {act.status === 'error' && !confirm && <ErrorState error={act.error} compact />}
        {done && (
          <p role="status" data-testid="action-done" className="rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800">
            {ot(`actions.done.${done}`)}
          </p>
        )}
      </div>

      {confirm && (
        <ConfirmModal
          title={ot(`actions.confirm.${confirm}.title`, { name: pv.buyer.name })}
          body={ot(`actions.confirm.${confirm}.body`)}
          confirmLabel={ot(`actions.${confirm}`)}
          busy={act.busy}
          error={act.status === 'error' ? act.error : null}
          onClose={() => {
            setConfirm(null);
            act.resetAction();
          }}
          onConfirm={() =>
            void run(confirm === 'declare_default' ? { kind: 'declare_default', planId: pv.plan.id, reasonCode: REASONS.REPEATED_MISSES.code } : { kind: 'cancel_plan', planId: pv.plan.id, reasonCode: cancelReason })
          }
        >
          {confirm === 'cancel_plan' && (
            <div>
              <label htmlFor={`${id}-cancel`} className="block text-sm font-medium text-ink-700">
                {ot('actions.cancelReason')}
              </label>
              <select id={`${id}-cancel`} value={cancelReason} onChange={(e) => setCancelReason(Number(e.target.value))} className="mt-1 min-h-11 w-full rounded-lg border border-ink-300 bg-white px-2 text-sm">
                {CANCEL_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {t(`reasons.${r.key}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </ConfirmModal>
      )}
    </DrawerSection>
  );
}
