// Every adverse transition and every refusal of the pure state machine, checked against the same
// rules and error names as contracts/payment_plan/src/test_adverse.rs, plus the evidence hash.
import { describe, expect, it } from 'vitest';
import type { Installment, InstallmentStatus, PlanGovernance } from '../domain/types';
import { addMonths } from '../domain/dates';
import { TransitionError, applyTransition, defaultGovernance, type AdverseAction } from './transitions';
import { evidenceHash, sha256Hex } from './evidence';
import { REASONS, reasonInfo } from './reasons';

const PLAN = 'plan-t';
const START = '2026-01-20';

function rows(statuses: InstallmentStatus[]): Installment[] {
  return statuses.map((status, idx) => ({
    id: `${PLAN}:${idx}`,
    planId: PLAN,
    idx,
    dueDate: addMonths(START, idx),
    copDue: 4_093_125,
    status,
    lockId: null,
    lockedRate: null,
    usdDue: null,
    lockExpiry: null,
    releasedTx: null,
    releasedAt: null,
    receiptId: null,
    breakCostCop: null,
  }));
}

function gov(patch: Partial<PlanGovernance> = {}): PlanGovernance {
  return { ...defaultGovernance(PLAN), ...patch };
}

function refused(g: PlanGovernance, r: Installment[], a: AdverseAction, today: string): string {
  try {
    applyTransition(g, r, a, today);
  } catch (e) {
    expect(e).toBeInstanceOf(TransitionError);
    return (e as TransitionError).errorName;
  }
  throw new Error('expected a refusal');
}

const R = REASONS;

describe('evidence hash', () => {
  it('is standard SHA-256', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('a'.repeat(1000))).toHaveLength(64);
  });

  it('does not depend on key order and changes with any field', () => {
    const a = evidenceHash({ planId: PLAN, kind: 'mark_missed', idx: 3 });
    expect(evidenceHash({ idx: 3, kind: 'mark_missed', planId: PLAN })).toBe(a);
    expect(evidenceHash({ planId: PLAN, kind: 'mark_missed', idx: 4 })).not.toBe(a);
  });

  it('reason catalogue resolves known and unknown codes', () => {
    expect(reasonInfo(304).key).toBe('fundsFrozen');
    expect(reasonInfo(999).key).toBe('unknown');
    expect(reasonInfo(null).key).toBe('none');
  });
});

describe('mark_missed, cure and waive', () => {
  const r = rows(['released', 'open', 'locked', 'broken', 'open', 'open']);
  const due1 = r[1]!.dueDate;

  it('waits for the calendar grace floor, then marks missed and makes the plan delinquent', () => {
    const a: AdverseAction = { kind: 'mark_missed', planId: PLAN, idx: 1, reasonCode: R.GRACE_EXPIRED.code };
    expect(refused(gov(), r, a, addMonths(START, 1).replace(/-20$/, '-24'))).toBe('GraceNotOver');
    const out = applyTransition(gov(), r, a, due1.replace(/-20$/, '-25'));
    expect(out.changed[0]!.status).toBe('missed');
    expect(out.governance).toMatchObject({ state: 'delinquent', misses: 1, reasonCode: 100 });
    expect(out.from).toBe('active');
    expect(r[1]!.status).toBe('open'); // inputs are not mutated
  });

  it('refuses locked, paid and already-missed installments', () => {
    const today = '2026-12-31';
    expect(refused(gov(), r, { kind: 'mark_missed', planId: PLAN, idx: 2, reasonCode: 100 }, today)).toBe('InvalidTransition');
    expect(refused(gov(), r, { kind: 'mark_missed', planId: PLAN, idx: 0, reasonCode: 100 }, today)).toBe('InvalidTransition');
    expect(refused(gov(), r, { kind: 'mark_missed', planId: PLAN, idx: 99, reasonCode: 100 }, today)).toBe('InstallmentNotFound');
    // A broken installment can be marked missed.
    expect(applyTransition(gov(), r, { kind: 'mark_missed', planId: PLAN, idx: 3, reasonCode: 100 }, today).changed[0]!.status).toBe('missed');
  });

  it('cure reopens a missed installment and the plan is active again when no misses remain', () => {
    const m = rows(['missed', 'missed', 'open']);
    const g = gov({ state: 'delinquent', misses: 2 });
    const one = applyTransition(g, m, { kind: 'cure', planId: PLAN, idx: 0, reasonCode: R.PAID_LATE.code }, '2026-06-01');
    expect(one.governance).toMatchObject({ state: 'delinquent', misses: 1 });
    expect(one.changed[0]!.status).toBe('open');
    const two = applyTransition(one.governance, [one.changed[0]!, m[1]!, m[2]!], { kind: 'cure', planId: PLAN, idx: 1, reasonCode: 101 }, '2026-06-01');
    expect(two.governance).toMatchObject({ state: 'active', misses: 0, reasonCode: 101 });
    expect(refused(g, m, { kind: 'cure', planId: PLAN, idx: 2, reasonCode: 101 }, '2026-06-01')).toBe('InvalidTransition');
  });

  it('waive accepts open, broken and missed installments and resolves a miss', () => {
    const m = rows(['open', 'broken', 'missed', 'released', 'locked']);
    const g = gov({ state: 'delinquent', misses: 1 });
    expect(applyTransition(g, m, { kind: 'waive', planId: PLAN, idx: 0, reasonCode: 102 }, '2026-06-01').governance.state).toBe('delinquent');
    expect(applyTransition(g, m, { kind: 'waive', planId: PLAN, idx: 1, reasonCode: 102 }, '2026-06-01').changed[0]!.status).toBe('waived');
    expect(applyTransition(g, m, { kind: 'waive', planId: PLAN, idx: 2, reasonCode: 102 }, '2026-06-01').governance).toMatchObject({ state: 'active', misses: 0 });
    expect(refused(g, m, { kind: 'waive', planId: PLAN, idx: 3, reasonCode: 102 }, '2026-06-01')).toBe('InvalidTransition');
    expect(refused(g, m, { kind: 'waive', planId: PLAN, idx: 4, reasonCode: 102 }, '2026-06-01')).toBe('InvalidTransition');
    expect(refused(gov({ state: 'cancelled' }), m, { kind: 'waive', planId: PLAN, idx: 0, reasonCode: 102 }, '2026-06-01')).toBe('InvalidTransition');
  });
});

describe('plan-level transitions', () => {
  const r = rows(['released', 'missed', 'missed', 'missed', 'open']);
  const today = '2026-08-01';

  it('declare_default needs the policy misses and an active or delinquent plan', () => {
    expect(refused(gov({ state: 'delinquent', misses: 2 }), r, { kind: 'declare_default', planId: PLAN, reasonCode: 110 }, today)).toBe('DefaultNotReached');
    const out = applyTransition(gov({ state: 'delinquent', misses: 3 }), r, { kind: 'declare_default', planId: PLAN, reasonCode: 110 }, today);
    expect(out.governance).toMatchObject({ state: 'defaulted', reasonCode: 110, since: today });
    expect(refused(out.governance, r, { kind: 'declare_default', planId: PLAN, reasonCode: 110 }, today)).toBe('InvalidTransition');
  });

  it('place_hold remembers the state and lift_hold restores it; blocked plans refuse marking', () => {
    const held = applyTransition(gov({ state: 'delinquent', misses: 1 }), r, { kind: 'place_hold', planId: PLAN, reasonCode: R.KYC_REVIEW.code }, today);
    expect(held.governance).toMatchObject({ state: 'on_hold', holdPrev: 'delinquent', reasonCode: 300 });
    expect(refused(held.governance, r, { kind: 'place_hold', planId: PLAN, reasonCode: 300 }, today)).toBe('InvalidTransition');
    expect(refused(held.governance, r, { kind: 'mark_missed', planId: PLAN, idx: 4, reasonCode: 100 }, '2027-01-01')).toBe('InvalidTransition');
    expect(refused(held.governance, r, { kind: 'cure', planId: PLAN, idx: 1, reasonCode: 101 }, today)).toBe('InvalidTransition');
    const lifted = applyTransition(held.governance, r, { kind: 'lift_hold', planId: PLAN, reasonCode: R.HOLD_CLEARED.code }, today);
    expect(lifted.governance.state).toBe('delinquent');
    expect(refused(lifted.governance, r, { kind: 'lift_hold', planId: PLAN, reasonCode: 310 }, today)).toBe('InvalidTransition');
  });

  it('hold_frozen is a hold with reason 304', () => {
    const out = applyTransition(gov(), r, { kind: 'hold_frozen', planId: PLAN, reasonCode: R.FUNDS_FROZEN.code }, today);
    expect(out.governance).toMatchObject({ state: 'on_hold', holdPrev: 'active', reasonCode: 304 });
  });

  it('cancel_plan works from any state but cancelled or completed', () => {
    for (const state of ['active', 'delinquent', 'defaulted', 'on_hold'] as const) {
      expect(applyTransition(gov({ state }), r, { kind: 'cancel_plan', planId: PLAN, reasonCode: 200 }, today).governance.state).toBe('cancelled');
    }
    expect(refused(gov({ state: 'cancelled' }), r, { kind: 'cancel_plan', planId: PLAN, reasonCode: 200 }, today)).toBe('InvalidTransition');
    expect(refused(gov({ state: 'completed' }), r, { kind: 'cancel_plan', planId: PLAN, reasonCode: 200 }, today)).toBe('InvalidTransition');
  });

  it('refund only on cancelled or defaulted plans, positive, within the held balance, conserving funds', () => {
    const refund = (amountCents: number): AdverseAction => ({ kind: 'refund', planId: PLAN, amountCents, reasonCode: R.REFUND.code });
    expect(refused(gov({ balanceCents: 1000 }), r, refund(500), today)).toBe('RefundNotAllowed');
    const c = gov({ state: 'cancelled', balanceCents: 1000 });
    expect(refused(c, r, refund(0), today)).toBe('InvalidAmount');
    expect(refused(c, r, refund(12.5), today)).toBe('InvalidAmount');
    expect(refused(c, r, refund(1001), today)).toBe('InsufficientBalance');
    const out = applyTransition(c, r, refund(400), today);
    expect(out.governance).toMatchObject({ balanceCents: 600, refundedCents: 400, state: 'cancelled' });
    expect(out.amountCents).toBe(400);
    expect(out.governance.balanceCents + out.governance.refundedCents).toBe(c.balanceCents + c.refundedCents);
    expect(applyTransition(gov({ state: 'defaulted', balanceCents: 1 }), r, refund(1), today).governance.refundedCents).toBe(1);
  });

  it('complete_plan needs every installment paid or waived and returns the leftover', () => {
    const done = rows(['released', 'waived', 'released']);
    expect(refused(gov(), rows(['released', 'open']), { kind: 'complete_plan', planId: PLAN, reasonCode: 500 }, today)).toBe('NotComplete');
    expect(refused(gov({ state: 'delinquent' }), done, { kind: 'complete_plan', planId: PLAN, reasonCode: 500 }, today)).toBe('InvalidTransition');
    const out = applyTransition(gov({ balanceCents: 250 }), done, { kind: 'complete_plan', planId: PLAN, reasonCode: 500 }, today);
    expect(out.governance).toMatchObject({ state: 'completed', balanceCents: 0, refundedCents: 250 });
    expect(out.amountCents).toBe(250);
  });
});
