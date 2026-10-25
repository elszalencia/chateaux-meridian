// InternalLockProvider: Chateaux's own lock pricing, built on the engine and the hedge curve.
// An external lock provider (a later model) implements the same LockProvider interface and returns
// its own rate; nothing above this layer changes. `apply` and `break` become `apply_lock` and
// `break_lock` contract calls in Stage 2.

import type { ISODate } from '../domain/types';
import type { HedgeProvider, LockProvider, LockQuoteRequest, LockQuoteResult } from './interfaces';
import { MockRuntime, shortId } from './mockRuntime';
import { priceLock, quoteExpiresAt } from '../lock/engine';

const TENORS: ('1M' | '2M' | '3M')[] = ['1M', '2M', '3M'];

export class InternalLockProvider implements LockProvider {
  readonly name = 'Chateaux (interno)';

  constructor(
    private readonly runtime: MockRuntime,
    private readonly hedge: HedgeProvider,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async quote(req: LockQuoteRequest): Promise<LockQuoteResult> {
    this.runtime.guard('lock.quote');
    const curve = await this.hedge.getCurve(['spot', ...TENORS]);
    const spot = curve.find((p) => p.tenor === 'spot');
    if (!spot) throw new Error('curve has no spot');
    // Leg k of the lock prices off tenor k (1M, 2M, 3M), in due-date order.
    const fwdRates = req.idxs.map((_, k) => {
      const tenor = TENORS[k];
      const point = curve.find((p) => p.tenor === tenor);
      if (!point) throw new Error(`curve has no ${tenor}`);
      return point.rate;
    });
    const pricing = priceLock(req.copDues, { spot: spot.rate, fwdRates, passThrough: req.passThrough });
    const curveAsOf: ISODate = spot.date;
    return {
      spot: spot.rate,
      fwdRates,
      avgFwd: pricing.avgFwd,
      points: pricing.points,
      lockedRate: pricing.lockedRate,
      usdPerInstallment: pricing.legs.map((l) => l.usdDueRounded),
      curveAsOf,
      quoteExpiresAt: quoteExpiresAt(this.now()),
    };
  }

  async apply(args: { lockId: string; planId: string; idxs: number[]; lockedRate: number; expiryTs: ISODate }): Promise<{ lockRef: string }> {
    await this.runtime.call('lock.apply');
    return { lockRef: shortId('lock', `${args.planId}:${args.lockId}:${args.idxs.join(',')}`) };
  }

  async break(args: { lockId: string; planId: string; idx: number }): Promise<{ ref: string }> {
    await this.runtime.call('lock.break', 0.5);
    return { ref: shortId('brk', `${args.planId}:${args.lockId}:${args.idx}`) };
  }
}
