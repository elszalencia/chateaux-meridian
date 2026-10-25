// Wrappers the testnet server puts around the real on-ramp and off-ramp providers.
//
// JournaledOnRamp records every deposit (anchor id, amounts, the anchor's Stellar payment) so the
// logs, /rails and the month simulation can show them.
//
// JournaledOffRamp does the same for payouts and adapts DemoApi's quote use to SEP-31: DemoApi
// asks one quote for a whole quarter when paying ahead and then pays each installment with its own
// USD amount against that quote id, while a SEP-31 quote is single-use and must match the amount
// sent. When the quote was already used, or was for another amount, the wrapper asks a fresh quote
// for exactly the USDC being paid (same demo-clock curve) and pays against that one.

import type { OffRampProvider, OffRampQuote, OffRampQuoteRequest, OffRampStatus, OnRampProvider, OnRampStatus } from './interfaces';

export interface OnRampEntry {
  at: string;
  buyerId: string;
  memo: string;
  usdAmount: number;
  depositId: string;
  status: OnRampStatus;
  /** Provider-specific fields (SEP-24 id, amounts, anchor payment hash, elapsed ms). */
  detail: Record<string, unknown>;
}

export interface OffRampEntry {
  at: string;
  beneficiaryRef: string;
  memo: string;
  usdc: string;
  quoteId: string;
  requoted: boolean;
  txId: string;
  stellarTxHash: string | null;
  status: OffRampStatus;
}

const LIMIT = 500;
const push = <T>(list: T[], item: T) => {
  list.push(item);
  if (list.length > LIMIT) list.shift();
};

export class JournaledOnRamp implements OnRampProvider {
  readonly entries: OnRampEntry[] = [];

  constructor(readonly inner: OnRampProvider) {}

  get name(): string {
    return this.inner.name;
  }

  async initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }): Promise<{ depositId: string; status: OnRampStatus }> {
    const r = await this.inner.initiateDeposit(args);
    const { depositId, status, ...detail } = r as { depositId: string; status: OnRampStatus } & Record<string, unknown>;
    push(this.entries, { at: new Date().toISOString(), buyerId: args.buyerId, memo: args.memo, usdAmount: args.usdAmount, depositId, status, detail });
    return r;
  }

  status(depositId: string): Promise<OnRampStatus> {
    return this.inner.status(depositId);
  }
}

export class JournaledOffRamp implements OffRampProvider {
  readonly entries: OffRampEntry[] = [];
  private readonly quotes = new Map<string, { usdc: string; used: boolean }>();

  constructor(readonly inner: OffRampProvider) {}

  get name(): string {
    return this.inner.name;
  }

  async quote(req: OffRampQuoteRequest): Promise<OffRampQuote> {
    const q = await this.inner.quote(req);
    this.quotes.set(q.quoteId, { usdc: q.usdc, used: false });
    return q;
  }

  async pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<{ txId: string }> {
    const known = this.quotes.get(args.quoteId);
    let quoteId = args.quoteId;
    const requoted = !known || known.used || Number(known.usdc) !== Number(args.usdc);
    if (requoted) quoteId = (await this.quote({ usdc: args.usdc })).quoteId;
    this.quotes.get(quoteId)!.used = true;
    const r = (await this.inner.pay({ ...args, quoteId })) as { txId: string; stellarTxHash?: string | null; status?: OffRampStatus };
    push(this.entries, {
      at: new Date().toISOString(),
      beneficiaryRef: args.beneficiaryRef,
      memo: args.memo,
      usdc: args.usdc,
      quoteId,
      requoted,
      txId: r.txId,
      stellarTxHash: r.stellarTxHash ?? null,
      status: r.status ?? 'pending',
    });
    return r;
  }

  async status(txId: string): Promise<OffRampStatus> {
    const s = await this.inner.status(txId);
    const e = this.entries.find((x) => x.txId === txId);
    if (e) e.status = s;
    return s;
  }

  /** The latest payout for a beneficiary and memo (DemoApi uses `M<n>` per installment). */
  latest(beneficiaryRef: string, memo: string): OffRampEntry | undefined {
    for (let k = this.entries.length - 1; k >= 0; k -= 1) {
      const e = this.entries[k]!;
      if (e.beneficiaryRef === beneficiaryRef && e.memo === memo) return e;
    }
    return undefined;
  }
}
