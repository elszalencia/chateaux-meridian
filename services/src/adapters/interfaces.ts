// Provider interfaces. Names are fixed by the scope: LockProvider, HedgeProvider, OnRampProvider,
// OffRampProvider. Stage 1 ships mocks; Stage 2 and 3 plug in the contract, the SDF test anchor and
// a local Anchor Platform behind the same signatures, so UI code never changes.

import type { ISODate, ISODateTime, Tenor } from '../domain/types';

export interface CurveQuote {
  tenor: string;
  date: ISODate;
  rate: number;
}

export interface StripLegRequest {
  dueDate: ISODate;
  usdNotional: number;
}

export interface BookedTrade {
  tradeId: string;
  dueDate: ISODate;
  rate: number;
  banrepRef?: string;
}

export interface Settlement {
  tradeId: string;
  date: ISODate;
  copAmount: number;
  fixing: number;
}

export interface HedgeProvider {
  readonly name: string;
  getCurve(tenors: string[]): Promise<CurveQuote[]>;
  bookStrip(legs: StripLegRequest[]): Promise<BookedTrade[]>;
  getSettlements(from: ISODate, to: ISODate): Promise<Settlement[]>;
}

export type OnRampStatus = 'pending' | 'completed' | 'error';

export interface OnRampProvider {
  readonly name: string;
  /** Starts a USD deposit from the buyer's US bank account (SEP-24 interactive in Stage 3). */
  initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }): Promise<{ depositId: string; status: OnRampStatus }>;
  status(depositId: string): Promise<OnRampStatus>;
}

export type OffRampStatus = 'pending' | 'completed' | 'refunded' | 'error';

/**
 * A quote is requested either by the USDC to sell (locked installments: the USD amount is fixed by
 * the lock) or by the COP the beneficiary must receive (unlocked payments: the trust gets exactly
 * cop_due and the USD leg is sized to cover it). SEP-38 supports both (`sell_amount` / `buy_amount`).
 * A USD-target quote (`usdTarget`) asks a dollar payout rail to deliver exactly that many USD to the
 * seller; the COP providers refuse it, which is how the request type narrows for them.
 */
export type OffRampQuoteRequest =
  | { usdc: string; copTarget?: undefined; usdTarget?: undefined }
  | { copTarget: number; usdc?: undefined; usdTarget?: undefined }
  | { usdTarget: number; usdc?: undefined; copTarget?: undefined };

export interface OffRampQuote {
  quoteId: string;
  rate: number; // COP per USDC (1 for a USD payout rail)
  expiresAt: ISODateTime;
  usdc: string; // USDC to deliver, 7 decimals; for a COP target, the smallest whole-cent amount that covers it
  copDelivered: number; // whole pesos the beneficiary receives; equals copTarget when one was given (minor units for a USD rail)
  /** USD payout rails: the partner fee (0 in the demo) and the USD the seller receives. */
  feeUsd?: number;
  usdDelivered?: number;
}

export interface OffRampProvider {
  readonly name: string;
  quote(req: OffRampQuoteRequest): Promise<OffRampQuote>;
  pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<{ txId: string }>;
  status(txId: string): Promise<OffRampStatus>;
}

// ---------- El Salvador corridor rails ----------

export type CashInReferenceStatus = 'pending' | 'completed' | 'quote_expired' | 'error';

/** What a cash-in network hands back when a reference is issued (the MoneyGram widget session). */
export interface CashInSession {
  sessionId: string;
  referenceNumber: string;
  amountUsd: number;
  feeUsd: number;
  expiresAt: ISODateTime;
  widgetUrl: string;
}

export interface CashInSessionRequest {
  /** The buyer as the network identifies the customer (our buyer id). */
  customerIdentifier: string;
  /** US state of the buyer, or null when unknown (no state rule is applied then). */
  buyerState: string | null;
  amountUsd: number;
  memo: string;
  locale: 'es' | 'en';
  /** Limits of the plan's corridor (config); the provider's own default applies when absent. */
  limits?: { minUsd: number; maxUsd: number; excludedStates: readonly string[]; referenceTtlMinutes: number } | null;
  feeUsd?: number;
}

/**
 * A cash-in network (MoneyGram): the buyer gets a reference and pays cash at a counter; the plan is
 * credited only when the network reports `completed`. It is also an OnRampProvider so the DemoApi
 * can treat it as a rail.
 */
export interface CashInProvider extends OnRampProvider {
  createSession(req: CashInSessionRequest): Promise<CashInSession>;
  referenceStatus(referenceNumber: string): Promise<CashInReferenceStatus>;
  /** Demo control (simulado): the network reports the cash-in; on testnet the stand-in anchor runs the deposit. */
  simulateCompleted(referenceNumber: string): Promise<void>;
  simulateExpired(referenceNumber: string): Promise<void>;
}

/** Partner-side state of a seller payout transfer, as the desk shows it. */
export type SellerPayoutPartnerStatus = 'enviado' | 'en_transito' | 'acreditado' | 'error' | 'transferido';

export interface SellerPayoutTransfer {
  partnerRef: string;
  status: SellerPayoutPartnerStatus;
  /** Option B: the business day the partner commits to credit the seller's account. */
  expectedCreditDate: ISODate | null;
  errorDetail: string | null;
}

/** A payout rail for sellers (option A: hold USDC; option B: USD to a bank), behind OffRampProvider. */
export interface SellerPayoutProvider extends OffRampProvider {
  /** Pays `usdc` to the seller and returns the transfer as the partner first reports it. */
  transfer(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string; today: ISODate }): Promise<SellerPayoutTransfer>;
  /** Re-reads a transfer; option B walks `enviado` → `en_transito` → `acreditado` as the demo clock moves. */
  partnerStatus(partnerRef: string, today: ISODate): Promise<SellerPayoutTransfer>;
  /** Registers a transfer this instance did not create (a seeded payout) so its status can walk too. */
  track(transfer: SellerPayoutTransfer): void;
}

export interface LockQuoteRequest {
  planId: string;
  tenor: Tenor;
  idxs: number[];
  copDues: number[];
  dueDates: ISODate[];
  passThrough: number;
}

export interface LockQuoteResult {
  spot: number;
  fwdRates: number[];
  avgFwd: number;
  points: number;
  lockedRate: number;
  usdPerInstallment: number[];
  curveAsOf: ISODate;
  quoteExpiresAt: ISODateTime;
}

export interface LockProvider {
  readonly name: string;
  /** Prices a lock. The internal provider uses the engine; an external one returns its own rate. */
  quote(req: LockQuoteRequest): Promise<LockQuoteResult>;
  /** Commits the lock (Stage 2: `apply_lock` on-chain). Returns an opaque reference. */
  apply(args: { lockId: string; planId: string; idxs: number[]; lockedRate: number; expiryTs: ISODate }): Promise<{ lockRef: string }>;
  /** Breaks a lock leg (Stage 2: `break_lock`). */
  break(args: { lockId: string; planId: string; idx: number }): Promise<{ ref: string }>;
}

export interface Providers {
  lock: LockProvider;
  hedge: HedgeProvider;
  onRamp: OnRampProvider;
  offRamp: OffRampProvider;
  /** Cash-in network for corridors that list `moneygram_cash`; the DemoApi builds the mock when absent. */
  cashIn?: CashInProvider;
  /** Seller payout rails by option (A: usdc-hold, B: usd-bank-payout); the DemoApi builds the mocks when absent. */
  sellerPayouts?: Partial<Record<'A' | 'B', SellerPayoutProvider>>;
}
