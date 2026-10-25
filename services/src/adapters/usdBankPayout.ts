// UsdBankPayout: seller payout option B, a USD transfer to the seller's bank account through the
// corridor's redemption partner. Fully simulated ("(simulado)" in its name): rate 1, partner fee 0
// (the corridor's `feesUsd` is the buyer-side method fee and is charged before the payout, so the
// seller receives the installment to the cent), a partner reference `DSV-TRF-…`, and a status that
// walks `enviado` → `en_transito` → `acreditado` as `partnerStatus` is re-read or as the demo clock
// reaches the expected credit date (0 to 3 business days ahead on the corridor's holiday calendar).
// `failNext()` makes the next transfer land in `error`, for the desk's retry flow.

import type { Corridor } from '../corridors/index';
import type { ISODate, ISODateTime } from '../domain/types';
import { addBusinessDaysIn, compareISO } from '../domain/dates';
import type { OffRampQuote, OffRampQuoteRequest, OffRampStatus, SellerPayoutProvider, SellerPayoutTransfer } from './interfaces';
import { MockRuntime, mockTxHash, shortId } from './mockRuntime';

export const PARTNER_FEE_USD = 0;
const MAX_CREDIT_BUSINESS_DAYS = 3;

interface Transfer extends SellerPayoutTransfer {
  sentAt: ISODate | null;
  reads: number;
}

export interface UsdBankPayoutOptions {
  runtime: MockRuntime;
  corridor: Corridor;
  now?: () => number;
}

export class UsdBankPayout implements SellerPayoutProvider {
  readonly name: string;
  private readonly runtime: MockRuntime;
  private readonly corridor: Corridor;
  private readonly now: () => number;
  private readonly quotes = new Map<string, { usdc: string; usdDelivered: number }>();
  private readonly transfers = new Map<string, Transfer>();
  private failNextTransfer = false;

  constructor(opts: UsdBankPayoutOptions) {
    this.runtime = opts.runtime;
    this.corridor = opts.corridor;
    this.now = opts.now ?? (() => Date.now());
    this.name = `Transferencia USD · ${opts.corridor.partners.payoutPartner} (simulado)`;
  }

  /** The next `transfer` is reported by the partner as `error` (account not found). */
  failNext(): void {
    this.failNextTransfer = true;
  }

  async quote(req: OffRampQuoteRequest): Promise<OffRampQuote> {
    await this.runtime.call('usdBankPayout.quote', 0.3);
    if (req.copTarget != null) throw new Error('UsdBankPayout pays USD; a COP target belongs to the Colombian off-ramp');
    const usdDelivered = req.usdTarget != null ? round2(req.usdTarget) : round2(Number(req.usdc) - PARTNER_FEE_USD);
    const usdc = (usdDelivered + PARTNER_FEE_USD).toFixed(7);
    const quoteId = shortId('qusd', `${usdc}:${this.now()}:${this.quotes.size}`);
    this.quotes.set(quoteId, { usdc, usdDelivered });
    return {
      quoteId,
      rate: 1,
      expiresAt: new Date(this.now() + 10 * 60_000).toISOString() as ISODateTime,
      usdc,
      copDelivered: Math.round(usdDelivered * 100),
      feeUsd: PARTNER_FEE_USD,
      usdDelivered,
    };
  }

  async transfer(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string; today: ISODate }): Promise<SellerPayoutTransfer> {
    await this.runtime.call('usdBankPayout.pay');
    if (!this.quotes.has(args.quoteId)) throw new Error(`unknown quote ${args.quoteId}`);
    const partnerRef = `DSV-TRF-${mockTxHash(`${args.quoteId}:${args.usdc}:${args.beneficiaryRef}:${args.memo}`).slice(0, 10).toUpperCase()}`;
    const fail = this.failNextTransfer;
    this.failNextTransfer = false;
    // 0 to 3 business days ahead, deterministic per reference so a replay lands on the same date.
    const days = fail ? 0 : parseInt(partnerRef.slice(-2), 16) % (MAX_CREDIT_BUSINESS_DAYS + 1);
    const t: Transfer = {
      partnerRef,
      status: fail ? 'error' : 'enviado',
      expectedCreditDate: fail ? null : addBusinessDaysIn(args.today, days, this.corridor.holidays),
      errorDetail: fail ? 'La cuenta destino no fue encontrada por el banco (simulado)' : null,
      sentAt: args.today,
      reads: 0,
    };
    this.transfers.set(partnerRef, t);
    return strip(t);
  }

  track(transfer: SellerPayoutTransfer): void {
    if (this.transfers.has(transfer.partnerRef)) return;
    this.transfers.set(transfer.partnerRef, { ...transfer, sentAt: null, reads: 0 });
  }

  /**
   * One step forward per read while the transfer is in flight, and straight to `acreditado` once
   * the demo clock reaches the expected credit date. `error` and `acreditado` are final.
   */
  async partnerStatus(partnerRef: string, today: ISODate): Promise<SellerPayoutTransfer> {
    await this.runtime.call('usdBankPayout.status', 0.3);
    const t = this.transfers.get(partnerRef);
    if (!t) return { partnerRef, status: 'error', expectedCreditDate: null, errorDetail: 'Referencia desconocida para el banco (simulado)' };
    if (t.status === 'enviado' || t.status === 'en_transito') {
      t.reads += 1;
      if (t.expectedCreditDate && compareISO(today, t.expectedCreditDate) >= 0) t.status = 'acreditado';
      else t.status = t.status === 'enviado' ? 'en_transito' : 'acreditado';
    }
    return strip(t);
  }

  // ---------- OffRampProvider ----------

  async pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<{ txId: string }> {
    const t = await this.transfer({ ...args, today: new Date(this.now()).toISOString().slice(0, 10) });
    return { txId: t.partnerRef };
  }

  async status(txId: string): Promise<OffRampStatus> {
    const t = this.transfers.get(txId);
    if (!t) return 'error';
    return t.status === 'acreditado' ? 'completed' : t.status === 'error' ? 'error' : 'pending';
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function strip(t: Transfer): SellerPayoutTransfer {
  return { partnerRef: t.partnerRef, status: t.status, expectedCreditDate: t.expectedCreditDate, errorDetail: t.errorDetail };
}
