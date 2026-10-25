// ChainLockProvider: the LockProvider for testnet mode. Pricing stays Casa Puente's own (delegated
// to the internal provider: engine + hedge curve); `apply` and `break` are `apply_lock` and
// `break_lock` on the contract through the ChainBridge. DemoApi calls the bridge directly for
// those two so the transaction hashes flow into receipts; this provider keeps the LockProvider
// seam complete for any other caller.

import type { LockProvider, LockQuoteRequest, LockQuoteResult } from '../adapters/interfaces';
import type { ISODate } from '../domain/types';
import { fixedPointRate } from '../lock/engine';
import { demoLockExpiryTs, lockIdBytes, type ChainBridge } from './bridge';

export interface PlanChainRef {
  chainPlanId: number;
  buyerId: string;
}

export class ChainLockProvider implements LockProvider {
  readonly name = 'Chateaux (testnet)';

  constructor(
    private readonly pricing: LockProvider,
    private readonly bridge: ChainBridge,
    private readonly resolve: (planId: string) => Promise<PlanChainRef>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  quote(req: LockQuoteRequest): Promise<LockQuoteResult> {
    return this.pricing.quote(req);
  }

  async apply(args: { lockId: string; planId: string; idxs: number[]; lockedRate: number; expiryTs: ISODate }): Promise<{ lockRef: string }> {
    const ref = await this.resolve(args.planId);
    const r = await this.bridge.applyLock({
      chainPlanId: ref.chainPlanId,
      buyerId: ref.buyerId,
      idxs: args.idxs,
      lockId: lockIdBytes(args.lockId),
      lockedRate: fixedPointRate(args.lockedRate),
      expiryTs: demoLockExpiryTs(this.now()),
    });
    return { lockRef: r.txHash };
  }

  async break(args: { lockId: string; planId: string; idx: number }): Promise<{ ref: string }> {
    const ref = await this.resolve(args.planId);
    const r = await this.bridge.breakLock(ref.chainPlanId, args.idx);
    return { ref: r.txHash };
  }
}
