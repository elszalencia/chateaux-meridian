// The adverse-event state machine, as pure functions that mirror `payment_plan` schema v2 rule for
// rule (contracts/payment_plan/src/lib.rs). Mock mode runs these instead of the contract, and the
// testnet path runs them as a dry run before sending the transaction, so both modes refuse the same
// things with the same error names (`InvalidTransition`, `GraceNotOver`, ...). Nothing here decides
// policy: which transition to request, and when, is the PolicyEngine's job.

import type { Installment, ISODate, PlanGovernance, PlanState, PolicyConfig, PolicyEventKind } from '../domain/types';
import { diffDays } from '../domain/dates';
import { REASONS } from './reasons';

/** Placeholder policy, equal to the contract's `default_policy()` (policy pending). */
export const DEFAULT_POLICY: PolicyConfig = { graceDays: 5, missesBeforeDefault: 3, penaltyBps: 1_000, refundMode: 'full' };

export type InstallmentAction = { kind: 'mark_missed' | 'cure' | 'waive'; planId: string; idx: number; reasonCode: number };
export type PlanAction = { kind: 'declare_default' | 'place_hold' | 'lift_hold' | 'cancel_plan' | 'complete_plan'; planId: string; reasonCode: number };
export type RefundAction = { kind: 'refund'; planId: string; amountCents: number; reasonCode: number };
export type FrozenAction = { kind: 'hold_frozen'; planId: string; reasonCode: typeof REASONS.FUNDS_FROZEN.code };
/** Every request the policy layer can make of the contract. */
export type AdverseAction = InstallmentAction | PlanAction | RefundAction | FrozenAction;

export type TransitionErrorName =
  | 'InvalidTransition'
  | 'GraceNotOver'
  | 'DefaultNotReached'
  | 'RefundNotAllowed'
  | 'InsufficientBalance'
  | 'InvalidAmount'
  | 'NotComplete'
  | 'InstallmentNotFound';

/** A transition the contract would refuse; `errorName` matches the contract's `Error` variant. */
export class TransitionError extends Error {
  constructor(public readonly errorName: TransitionErrorName, message?: string) {
    super(message ?? errorName);
    this.name = 'TransitionError';
  }
}

export interface TransitionResult {
  governance: PlanGovernance;
  /** Installments whose status changed (already updated). */
  changed: Installment[];
  from: PlanState;
  to: PlanState;
  idx: number | null;
  amountCents: number | null;
  kind: PolicyEventKind;
}

export function defaultGovernance(planId: string, policy: PolicyConfig = DEFAULT_POLICY): PlanGovernance {
  return {
    id: planId,
    planId,
    state: 'active',
    holdPrev: 'active',
    misses: 0,
    policy: { ...policy },
    reasonCode: null,
    since: null,
    balanceCents: 0,
    refundedCents: 0,
  };
}

/** Whether deposits, locks and releases may run in this state (the contract's `funds_allowed`). */
export function fundsAllowed(state: PlanState): boolean {
  return state === 'active' || state === 'delinquent';
}

/**
 * Applies one action to a plan's governance and installments, or throws the contract's error.
 * Inputs are not mutated.
 */
export function applyTransition(gov0: PlanGovernance, installments: Installment[], action: AdverseAction, today: ISODate): TransitionResult {
  const gov: PlanGovernance = { ...gov0, policy: { ...gov0.policy } };
  const from = gov.state;
  const changed: Installment[] = [];
  let idx: number | null = null;
  let amountCents: number | null = null;

  const setState = (to: PlanState) => {
    if (gov.state === to) return;
    gov.state = to;
    gov.reasonCode = action.reasonCode;
    gov.since = today;
  };
  const missResolved = () => {
    gov.misses = Math.max(0, gov.misses - 1);
    if (gov.misses === 0 && gov.state === 'delinquent') setState('active');
  };
  const inst = (i: number): Installment => {
    const row = installments.find((x) => x.idx === i);
    if (!row) throw new TransitionError('InstallmentNotFound', `installment ${i}`);
    return { ...row };
  };
  const refuse = (name: TransitionErrorName, why: string): never => {
    throw new TransitionError(name, `${action.kind}: ${why}`);
  };

  switch (action.kind) {
    case 'mark_missed': {
      if (!fundsAllowed(gov.state)) refuse('InvalidTransition', `plan is ${gov.state}`);
      const row = inst(action.idx);
      if (row.status !== 'open' && row.status !== 'broken') refuse('InvalidTransition', `installment is ${row.status}`);
      if (diffDays(row.dueDate, today) < gov.policy.graceDays) refuse('GraceNotOver', `due ${row.dueDate}`);
      row.status = 'missed';
      changed.push(row);
      idx = row.idx;
      gov.misses += 1;
      setState('delinquent');
      break;
    }
    case 'cure': {
      if (!fundsAllowed(gov.state)) refuse('InvalidTransition', `plan is ${gov.state}`);
      const row = inst(action.idx);
      if (row.status !== 'missed') refuse('InvalidTransition', `installment is ${row.status}`);
      row.status = 'open';
      changed.push(row);
      idx = row.idx;
      missResolved();
      break;
    }
    case 'waive': {
      if (gov.state === 'cancelled' || gov.state === 'completed') refuse('InvalidTransition', `plan is ${gov.state}`);
      const row = inst(action.idx);
      const wasMissed = row.status === 'missed';
      if (row.status !== 'open' && row.status !== 'broken' && row.status !== 'missed') refuse('InvalidTransition', `installment is ${row.status}`);
      row.status = 'waived';
      changed.push(row);
      idx = row.idx;
      if (wasMissed) missResolved();
      break;
    }
    case 'declare_default': {
      if (!fundsAllowed(gov.state)) refuse('InvalidTransition', `plan is ${gov.state}`);
      if (gov.misses < gov.policy.missesBeforeDefault) refuse('DefaultNotReached', `${gov.misses} of ${gov.policy.missesBeforeDefault} misses`);
      setState('defaulted');
      break;
    }
    case 'place_hold':
    case 'hold_frozen': {
      if (!fundsAllowed(gov.state)) refuse('InvalidTransition', `plan is ${gov.state}`);
      gov.holdPrev = gov.state;
      setState('on_hold');
      break;
    }
    case 'lift_hold': {
      if (gov.state !== 'on_hold') refuse('InvalidTransition', `plan is ${gov.state}`);
      setState(gov.holdPrev);
      break;
    }
    case 'cancel_plan': {
      if (gov.state === 'cancelled' || gov.state === 'completed') refuse('InvalidTransition', `plan is ${gov.state}`);
      setState('cancelled');
      break;
    }
    case 'refund': {
      if (gov.state !== 'cancelled' && gov.state !== 'defaulted') refuse('RefundNotAllowed', `plan is ${gov.state}`);
      if (!(action.amountCents > 0) || !Number.isInteger(action.amountCents)) refuse('InvalidAmount', String(action.amountCents));
      if (gov.balanceCents < action.amountCents) refuse('InsufficientBalance', `${gov.balanceCents} held`);
      gov.balanceCents -= action.amountCents;
      gov.refundedCents += action.amountCents;
      amountCents = action.amountCents;
      break;
    }
    case 'complete_plan': {
      if (gov.state !== 'active') refuse('InvalidTransition', `plan is ${gov.state}`);
      if (installments.some((i) => i.status !== 'released' && i.status !== 'waived')) refuse('NotComplete', 'unpaid installments');
      if (gov.balanceCents > 0) {
        amountCents = gov.balanceCents;
        gov.refundedCents += gov.balanceCents;
        gov.balanceCents = 0;
      }
      setState('completed');
      break;
    }
  }
  return { governance: gov, changed, from, to: gov.state, idx, amountCents, kind: action.kind };
}
