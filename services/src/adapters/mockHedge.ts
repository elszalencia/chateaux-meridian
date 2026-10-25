// MockHedgeProvider: "Davivienda (simulado)". Serves the scripted curve, books one NDF per leg
// instantly with a trade id and a BanRep reference, and settles at the scripted fixing (spot of the
// settlement month). It never holds state of its own: booked trades are read back from the store
// through `tradeSource`, so a demo reset leaves nothing stale behind.

import type { HedgeTrade, ISODate } from '../domain/types';
import type { BookedTrade, CurveQuote, HedgeProvider, Settlement, StripLegRequest } from './interfaces';
import { MockRuntime, curveAtOffset, spotAtOffset } from './mockRuntime';
import { compareISO, diffDays } from '../domain/dates';
import { ndfSettlement } from '../lock/engine';

export const HEDGE_PROVIDER_LABEL = 'Davivienda (simulado)';

export interface MockHedgeOptions {
  runtime: MockRuntime;
  baseDate: ISODate;
  tradeSource: () => Promise<HedgeTrade[]>;
  /** Next sequence number for trade ids; persisted by the API so ids stay unique across reloads. */
  nextSeq: () => number;
}

export class MockHedgeProvider implements HedgeProvider {
  readonly name = HEDGE_PROVIDER_LABEL;

  constructor(private readonly opts: MockHedgeOptions) {}

  async getCurve(tenors: string[]): Promise<CurveQuote[]> {
    await this.opts.runtime.call('hedge.getCurve', 0.5);
    const curve = curveAtOffset(this.opts.runtime.clockOffset(), this.opts.baseDate);
    return curve.filter((p) => tenors.includes(p.tenor)).map((p) => ({ tenor: p.tenor, date: p.date, rate: p.rate }));
  }

  async bookStrip(legs: (StripLegRequest & { fwdRate?: number })[]): Promise<BookedTrade[]> {
    await this.opts.runtime.call('hedge.bookStrip');
    const curve = curveAtOffset(this.opts.runtime.clockOffset(), this.opts.baseDate);
    const today = curve[0]!.asOf;
    return legs.map((leg) => {
      const seq = this.opts.nextSeq();
      const months = Math.max(1, Math.min(3, Math.round(diffDays(today, leg.dueDate) / 30)));
      const tenor = (`${months}M`) as '1M' | '2M' | '3M';
      const rate = leg.fwdRate ?? curve.find((p) => p.tenor === tenor)!.rate;
      return {
        tradeId: `DAV-NDF-${leg.dueDate.slice(0, 4)}-${String(seq).padStart(4, '0')}`,
        dueDate: leg.dueDate,
        rate,
        banrepRef: `BR-DER-${leg.dueDate.slice(0, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`,
      };
    });
  }

  async getSettlements(from: ISODate, to: ISODate): Promise<Settlement[]> {
    await this.opts.runtime.call('hedge.getSettlements', 0.5);
    const trades = await this.opts.tradeSource();
    const offset = this.opts.runtime.clockOffset();
    return trades
      .filter((t) => compareISO(t.dueDate, from) >= 0 && compareISO(t.dueDate, to) <= 0)
      .map((t) => {
        const fixing = t.fixing ?? spotAtOffset(offset);
        return { tradeId: t.id, date: t.dueDate, copAmount: ndfSettlement(t.rate, fixing, t.usdNotional), fixing };
      });
  }
}
