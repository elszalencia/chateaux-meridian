// ChainGovernanceProvider: the policy layer's GovernanceProvider over the `payment_plan` contract
// on testnet. Each method is one contract call through ChainClient (operator-signed; `hold_frozen`
// is permissionless on chain and the operator only pays for it). Plans are addressed by their app
// id and mapped to chain ids through the demo state; a plan with no chain id (seed plans that are
// never put on chain) goes to the fallback provider, the mock that checks the same rules on the
// store. Contract failures surface as GovernanceProviderError with the contract's error name, so
// the daily job records `action_failed: <name>` and reacts to `AssetFrozen` exactly as in mock mode.

import type { ChainClient } from './client';
import { ChainError, type TxResult } from './submit';
import {
  GovernanceProviderError,
  type GovernanceProvider,
  type InstallmentCall,
  type PlanCall,
  type ProviderRef,
} from '../policy/GovernanceProvider';

/** Evidence hashes travel as 64 hex characters; on chain they are the 32 raw bytes. */
export function evidenceBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new GovernanceProviderError('InvalidArgument', `evidence must be a SHA-256 hex digest, got ${hex.slice(0, 16)}…`);
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** USD cents → stroops (7 decimals). */
export const centsToStroops = (cents: number): bigint => BigInt(Math.round(cents)) * 100_000n;

export interface ChainGovernanceOptions {
  client: ChainClient;
  /** App plan id → chain plan id, read on every call so a reset's new plans are picked up. */
  chainPlans: () => Promise<Record<string, number>>;
  /** Provider for plans that are not on chain. */
  fallback: GovernanceProvider;
}

export class ChainGovernanceProvider implements GovernanceProvider {
  readonly name = 'payment_plan (testnet)';

  constructor(private readonly opts: ChainGovernanceOptions) {}

  private async call(planId: string, local: () => Promise<ProviderRef>, run: (chainId: number) => Promise<TxResult<unknown>>): Promise<ProviderRef> {
    const chainId = (await this.opts.chainPlans())[planId];
    if (chainId == null) return local();
    try {
      const r = await run(chainId);
      return { ref: r.txHash };
    } catch (e) {
      if (e instanceof ChainError) throw new GovernanceProviderError(e.errorName, e.message, e);
      throw e;
    }
  }

  markMissed(c: InstallmentCall) {
    return this.call(c.planId, () => this.opts.fallback.markMissed(c), (id) => this.opts.client.markMissed(id, c.idx, c.reasonCode, evidenceBytes(c.evidence)));
  }
  cure(c: InstallmentCall) {
    return this.call(c.planId, () => this.opts.fallback.cure(c), (id) => this.opts.client.cure(id, c.idx, c.reasonCode, evidenceBytes(c.evidence)));
  }
  waive(c: InstallmentCall) {
    return this.call(c.planId, () => this.opts.fallback.waive(c), (id) => this.opts.client.waive(id, c.idx, c.reasonCode, evidenceBytes(c.evidence)));
  }
  declareDefault(c: PlanCall) {
    return this.call(c.planId, () => this.opts.fallback.declareDefault(c), (id) => this.opts.client.declareDefault(id, c.reasonCode, evidenceBytes(c.evidence)));
  }
  placeHold(c: PlanCall) {
    return this.call(c.planId, () => this.opts.fallback.placeHold(c), (id) => this.opts.client.placeHold(id, c.reasonCode, evidenceBytes(c.evidence)));
  }
  liftHold(c: PlanCall) {
    return this.call(c.planId, () => this.opts.fallback.liftHold(c), (id) => this.opts.client.liftHold(id, c.reasonCode, evidenceBytes(c.evidence)));
  }
  holdFrozen(c: { planId: string; evidence: string }) {
    return this.call(c.planId, () => this.opts.fallback.holdFrozen(c), (id) => this.opts.client.holdFrozen(id, evidenceBytes(c.evidence)));
  }
  cancelPlan(c: PlanCall) {
    return this.call(c.planId, () => this.opts.fallback.cancelPlan(c), (id) => this.opts.client.cancelPlan(id, c.reasonCode, evidenceBytes(c.evidence)));
  }
  refund(c: PlanCall & { amountCents: number }) {
    return this.call(c.planId, () => this.opts.fallback.refund(c), (id) => this.opts.client.refund(id, centsToStroops(c.amountCents), c.reasonCode, evidenceBytes(c.evidence)));
  }
  completePlan(c: PlanCall) {
    return this.call(c.planId, () => this.opts.fallback.completePlan(c), (id) => this.opts.client.completePlan(id, c.reasonCode, evidenceBytes(c.evidence)));
  }
}
