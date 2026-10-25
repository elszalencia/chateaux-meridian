// GovernanceProvider: the contract-facing seam for adverse events, one method per `payment_plan`
// function (mark_missed, cure, waive, declare_default, place_hold, lift_hold, hold_frozen,
// cancel_plan, refund, complete_plan). Testnet mode implements it over the chain bridge; mock mode
// uses MockGovernanceProvider below, which checks the same rules as the contract (a dry run of
// `applyTransition` on the stored state) and returns a mock transaction reference. Providers never
// write the store: `performAdverseAction` does that after the provider succeeded.

import type { ISODate } from '../domain/types';
import type { Store } from '../store/Store';
import { mockTxHash } from '../adapters/mockRuntime';
import { TransitionError, applyTransition, defaultGovernance, type AdverseAction } from './transitions';
import { REASONS } from './reasons';

export interface ProviderRef {
  /** Transaction hash on chain; a mock reference in mock mode. */
  ref: string;
}

export interface InstallmentCall {
  planId: string;
  idx: number;
  reasonCode: number;
  evidence: string;
}

export interface PlanCall {
  planId: string;
  reasonCode: number;
  evidence: string;
}

export interface GovernanceProvider {
  readonly name: string;
  markMissed(c: InstallmentCall): Promise<ProviderRef>;
  cure(c: InstallmentCall): Promise<ProviderRef>;
  waive(c: InstallmentCall): Promise<ProviderRef>;
  declareDefault(c: PlanCall): Promise<ProviderRef>;
  placeHold(c: PlanCall): Promise<ProviderRef>;
  liftHold(c: PlanCall): Promise<ProviderRef>;
  /** Permissionless on chain: records a hold only when the issuer has frozen a party. */
  holdFrozen(c: { planId: string; evidence: string }): Promise<ProviderRef>;
  cancelPlan(c: PlanCall): Promise<ProviderRef>;
  refund(c: PlanCall & { amountCents: number }): Promise<ProviderRef>;
  completePlan(c: PlanCall): Promise<ProviderRef>;
}

/**
 * A provider failure with the contract's error name (`AssetFrozen`, `NotFrozen`, `InvalidTransition`,
 * ...). Testnet implementations map `ChainError.errorName` onto this.
 */
export class GovernanceProviderError extends Error {
  constructor(public readonly errorName: string, message?: string, public readonly cause?: unknown) {
    super(message ?? errorName);
    this.name = 'GovernanceProviderError';
  }
}

/** Calls the provider method that matches an action. */
export function dispatch(p: GovernanceProvider, action: AdverseAction, evidence: string): Promise<ProviderRef> {
  switch (action.kind) {
    case 'mark_missed':
      return p.markMissed({ planId: action.planId, idx: action.idx, reasonCode: action.reasonCode, evidence });
    case 'cure':
      return p.cure({ planId: action.planId, idx: action.idx, reasonCode: action.reasonCode, evidence });
    case 'waive':
      return p.waive({ planId: action.planId, idx: action.idx, reasonCode: action.reasonCode, evidence });
    case 'declare_default':
      return p.declareDefault({ planId: action.planId, reasonCode: action.reasonCode, evidence });
    case 'place_hold':
      return p.placeHold({ planId: action.planId, reasonCode: action.reasonCode, evidence });
    case 'lift_hold':
      return p.liftHold({ planId: action.planId, reasonCode: action.reasonCode, evidence });
    case 'hold_frozen':
      return p.holdFrozen({ planId: action.planId, evidence });
    case 'cancel_plan':
      return p.cancelPlan({ planId: action.planId, reasonCode: action.reasonCode, evidence });
    case 'refund':
      return p.refund({ planId: action.planId, amountCents: action.amountCents, reasonCode: action.reasonCode, evidence });
    case 'complete_plan':
      return p.completePlan({ planId: action.planId, reasonCode: action.reasonCode, evidence });
  }
}

export interface MockGovernanceOptions {
  store: Store;
  today: () => Promise<ISODate> | ISODate;
  /** Plans whose USDC the issuer has "frozen" in this simulation (exercises the AssetFrozen path). */
  frozenPlans?: Set<string>;
}

export class MockGovernanceProvider implements GovernanceProvider {
  readonly name = 'mock-governance';
  readonly frozenPlans: Set<string>;
  private seq = 0;

  constructor(private readonly opts: MockGovernanceOptions) {
    this.frozenPlans = opts.frozenPlans ?? new Set();
  }

  private async check(action: AdverseAction): Promise<ProviderRef> {
    const store = this.opts.store;
    const gov = (await store.get('plan_governance', action.planId)) ?? defaultGovernance(action.planId);
    const rows = (await store.all('installments')).filter((i) => i.planId === action.planId);
    const frozen = this.frozenPlans.has(action.planId);
    if (action.kind === 'hold_frozen' && !frozen) throw new GovernanceProviderError('NotFrozen');
    if (action.kind === 'lift_hold' && frozen) throw new GovernanceProviderError('AssetFrozen');
    if ((action.kind === 'refund' || action.kind === 'complete_plan') && frozen) throw new GovernanceProviderError('AssetFrozen');
    try {
      applyTransition(gov, rows, action, await this.opts.today());
    } catch (e) {
      if (e instanceof TransitionError) throw new GovernanceProviderError(e.errorName, e.message, e);
      throw e;
    }
    this.seq += 1;
    return { ref: mockTxHash(`${action.kind}:${action.planId}:${this.seq}`) };
  }

  markMissed(c: InstallmentCall) {
    return this.check({ kind: 'mark_missed', planId: c.planId, idx: c.idx, reasonCode: c.reasonCode });
  }
  cure(c: InstallmentCall) {
    return this.check({ kind: 'cure', planId: c.planId, idx: c.idx, reasonCode: c.reasonCode });
  }
  waive(c: InstallmentCall) {
    return this.check({ kind: 'waive', planId: c.planId, idx: c.idx, reasonCode: c.reasonCode });
  }
  declareDefault(c: PlanCall) {
    return this.check({ kind: 'declare_default', planId: c.planId, reasonCode: c.reasonCode });
  }
  placeHold(c: PlanCall) {
    return this.check({ kind: 'place_hold', planId: c.planId, reasonCode: c.reasonCode });
  }
  liftHold(c: PlanCall) {
    return this.check({ kind: 'lift_hold', planId: c.planId, reasonCode: c.reasonCode });
  }
  holdFrozen(c: { planId: string; evidence: string }) {
    return this.check({ kind: 'hold_frozen', planId: c.planId, reasonCode: REASONS.FUNDS_FROZEN.code });
  }
  cancelPlan(c: PlanCall) {
    return this.check({ kind: 'cancel_plan', planId: c.planId, reasonCode: c.reasonCode });
  }
  refund(c: PlanCall & { amountCents: number }) {
    return this.check({ kind: 'refund', planId: c.planId, amountCents: c.amountCents, reasonCode: c.reasonCode });
  }
  completePlan(c: PlanCall) {
    return this.check({ kind: 'complete_plan', planId: c.planId, reasonCode: c.reasonCode });
  }
}
