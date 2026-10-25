// UsdcHold: seller payout option A. The seller keeps the released USDC at its custody provider's
// address instead of cashing out to a bank. Mock: the transfer to that address is recorded here.
// Testnet: `release_spot` already paid the corridor's payee, so this provider records the hand-off
// reference only; nothing more moves. Either way the transfer reports `transferido` at once, rate
// 1 and no fee, so paid − fee = to seller holds to the cent.

import type { ISODate, ISODateTime } from '../domain/types';
import type { OffRampQuote, OffRampQuoteRequest, OffRampStatus, SellerPayoutProvider, SellerPayoutTransfer } from './interfaces';
import { MockRuntime, mockTxHash, shortId } from './mockRuntime';

export interface UsdcHoldOptions {
  runtime: MockRuntime;
  now?: () => number;
  /** Testnet: the release already paid the payee, so the hand-off is a record, not a transfer. */
  onChain?: boolean;
}

export interface UsdcHoldRecord extends SellerPayoutTransfer {
  providerAddress: string;
  usdc: string;
  memo: string;
}

export class UsdcHold implements SellerPayoutProvider {
  readonly name: string;
  private readonly runtime: MockRuntime;
  private readonly now: () => number;
  private readonly quotes = new Map<string, string>();
  private readonly records = new Map<string, UsdcHoldRecord>();

  constructor(opts: UsdcHoldOptions) {
    this.runtime = opts.runtime;
    this.now = opts.now ?? (() => Date.now());
    this.name = opts.onChain ? 'USDC en custodia del vendedor (testnet)' : 'USDC en custodia del vendedor (simulado)';
  }

  async quote(req: OffRampQuoteRequest): Promise<OffRampQuote> {
    await this.runtime.call('usdcHold.quote', 0.2);
    if (req.copTarget != null) throw new Error('UsdcHold holds USDC; a COP target belongs to the Colombian off-ramp');
    const usdDelivered = req.usdTarget != null ? Math.round(req.usdTarget * 100) / 100 : Math.round(Number(req.usdc) * 100) / 100;
    const usdc = usdDelivered.toFixed(7);
    const quoteId = shortId('qhold', `${usdc}:${this.now()}:${this.quotes.size}`);
    this.quotes.set(quoteId, usdc);
    return { quoteId, rate: 1, expiresAt: new Date(this.now() + 10 * 60_000).toISOString() as ISODateTime, usdc, copDelivered: Math.round(usdDelivered * 100), feeUsd: 0, usdDelivered };
  }

  async transfer(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string; today: ISODate }): Promise<SellerPayoutTransfer> {
    await this.runtime.call('usdcHold.transfer', 0.5);
    if (!this.quotes.has(args.quoteId)) throw new Error(`unknown quote ${args.quoteId}`);
    const partnerRef = `USDC-HOLD-${mockTxHash(`${args.quoteId}:${args.usdc}:${args.beneficiaryRef}:${args.memo}`).slice(0, 10).toUpperCase()}`;
    const rec: UsdcHoldRecord = { partnerRef, status: 'transferido', expectedCreditDate: null, errorDetail: null, providerAddress: args.beneficiaryRef, usdc: args.usdc, memo: args.memo };
    this.records.set(partnerRef, rec);
    return { partnerRef, status: 'transferido', expectedCreditDate: null, errorDetail: null };
  }

  track(transfer: SellerPayoutTransfer): void {
    if (this.records.has(transfer.partnerRef)) return;
    this.records.set(transfer.partnerRef, { ...transfer, providerAddress: '', usdc: '', memo: '' });
  }

  async partnerStatus(partnerRef: string): Promise<SellerPayoutTransfer> {
    const rec = this.records.get(partnerRef);
    if (!rec) return { partnerRef, status: 'error', expectedCreditDate: null, errorDetail: 'Referencia desconocida (simulado)' };
    return { partnerRef, status: rec.status, expectedCreditDate: null, errorDetail: rec.errorDetail };
  }

  /** The recorded hand-off (mock: the transfer to the provider address). */
  record(partnerRef: string): UsdcHoldRecord | undefined {
    const rec = this.records.get(partnerRef);
    return rec ? { ...rec } : undefined;
  }

  // ---------- OffRampProvider ----------

  async pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<{ txId: string }> {
    const t = await this.transfer({ ...args, today: new Date(this.now()).toISOString().slice(0, 10) });
    return { txId: t.partnerRef };
  }

  async status(txId: string): Promise<OffRampStatus> {
    return this.records.has(txId) ? 'completed' : 'error';
  }
}
