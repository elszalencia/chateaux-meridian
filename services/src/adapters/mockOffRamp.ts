// MockOffRampProvider: the Colombian payout leg (Stage 3: SEP-38 quote + SEP-31 transfer against a
// local Anchor Platform). The mock converts at the scripted spot of the current demo month, so the
// anchor rate equals the NDF fixing and seeded rows are the only ones with a basis difference.
// A quote by COP target sizes the USDC leg to the cent so the beneficiary gets exactly that COP.

import type { ISODateTime } from '../domain/types';
import type { OffRampProvider, OffRampQuote, OffRampQuoteRequest, OffRampStatus } from './interfaces';
import { roundCop, usdToCoverCop } from '../lock/engine';
import { MockRuntime, mockTxHash, shortId, spotAtOffset } from './mockRuntime';

export class MockOffRampProvider implements OffRampProvider {
  readonly name = 'Fidudavivienda via anchor (simulado)';
  private readonly quotes = new Map<string, { rate: number; expiresAt: ISODateTime }>();
  private readonly payments = new Map<string, OffRampStatus>();

  constructor(private readonly runtime: MockRuntime) {}

  async quote(req: OffRampQuoteRequest): Promise<OffRampQuote> {
    await this.runtime.call('offRamp.quote', 0.5);
    const rate = spotAtOffset(this.runtime.clockOffset());
    const byCop = req.copTarget != null;
    const usdc = byCop ? usdToCoverCop(req.copTarget, rate).toFixed(7) : req.usdc;
    const copDelivered = byCop ? roundCop(req.copTarget) : roundCop(Number(usdc) * rate);
    const quoteId = shortId('q38', `${usdc}:${byCop ? req.copTarget : ''}:${Date.now()}`);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.quotes.set(quoteId, { rate, expiresAt });
    return { quoteId, rate, expiresAt, usdc, copDelivered };
  }

  rateOf(quoteId: string): number | undefined {
    return this.quotes.get(quoteId)?.rate;
  }

  async pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<{ txId: string }> {
    await this.runtime.call('offRamp.pay');
    if (!this.quotes.has(args.quoteId)) throw new Error(`unknown quote ${args.quoteId}`);
    const txId = mockTxHash(`${args.quoteId}:${args.usdc}:${args.beneficiaryRef}:${args.memo}`);
    this.payments.set(txId, 'completed');
    return { txId };
  }

  async status(txId: string): Promise<OffRampStatus> {
    await this.runtime.call('offRamp.status', 0.3);
    return this.payments.get(txId) ?? 'error';
  }
}
